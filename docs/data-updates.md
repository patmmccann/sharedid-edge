# Scheduled data updates

Use [@sharedid-edge/data-updates](../packages/data-updates/README.md) to refresh shared reference data separately from visitor requests. Existing build-time DB-IP and MaxMind modules remain available; a scheduled snapshot module is an opt-in replacement, not an additional module with the same name.

The concrete sources here are DB-IP Lite country and MaxMind GeoLite2 Country. Other lists use the same update interface with their own validator and in-memory lookup. The `ua` module's compiled crawler detector is unchanged.

## Shared source configuration

After `npm ci && npm run build`, create `updates.mjs` in your deployment project:

```js
import { dbipSource, maxmindSource } from '@sharedid-edge/data-updates/country';
import { DBIP_ATTRIBUTION } from '@sharedid-edge/module-dbip';
import { MAXMIND_ATTRIBUTION } from '@sharedid-edge/module-maxmind';

export default [
  dbipSource({ attribution: DBIP_ATTRIBUTION }),
  maxmindSource({ attribution: MAXMIND_ATTRIBUTION })
];
```

Remove sources you don't want. Only these explicitly configured sources can download. MaxMind needs the deployer's own account and licence key, in the updater's `SID_MODULE_SECRETS` secret:

```json
{"maxmind":{"accountId":"your-account-id","licenseKey":"your-licence-key"}}
```

The source receives no visitor data. DB-IP downloads this month's free release, falling back to last month's on 404 only. MaxMind authenticates with Basic authentication and checks the vendor's SHA-256 checksum before converting the archive. Both validate the MMDB database type and resulting country ranges, retain attribution, and publish JSON data rather than executable code.

## Cloudflare: Cron Triggers and R2

Create a private R2 bucket (`npx wrangler r2 bucket create sharedid-reference-data`) and a separate update Worker whose `update-worker.mjs` is:

```js
import sources from './updates.mjs';
import { updateSecrets } from '@sharedid-edge/data-updates';
import { r2Store, scheduledUpdate } from '@sharedid-edge/data-updates/cloudflare';

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduledUpdate(sources, {
      store: r2Store(env.SID_DATA),
      secrets: updateSecrets(env.SID_MODULE_SECRETS),
      timeoutMs: 120000
    }));
  }
};
```

Its own `wrangler.jsonc` (not the request Worker's config):

```json
{
  "name": "sharedid-edge-data-update",
  "main": "update-worker.mjs",
  "compatibility_date": "2026-11-01",
  "workers_dev": false,
  "limits": { "cpu_ms": 300000 },
  "triggers": { "crons": ["17 */12 * * *"] },
  "r2_buckets": [{ "binding": "SID_DATA", "bucket_name": "sharedid-reference-data" }]
}
```

Set `SID_MODULE_SECRETS` with `npx wrangler secret put SID_MODULE_SECRETS --config wrangler.jsonc`, then deploy this Worker. For the first publication, temporarily use cron `* * * * *`, wait for the trigger configuration to propagate and a successful scheduled run, and verify a `dbip/current.json` or `maxmind/current.json` object before switching request workers; then restore the 12-hour cron and deploy again. No HTTP route is added for updates. Choose a Workers plan with enough scheduled CPU time and memory for the databases; the updater includes conversion code and has a different size/resource profile from the default request bundle.

Bind the same private bucket as `SID_DATA` in the request Worker's config. In a custom request entry point built from this repository, wrap `createWorker` from `packages/adapters/cloudflare/src/worker.ts`:

```js
import { SnapshotCache } from '@sharedid-edge/data-updates';
import { r2Store } from '@sharedid-edge/data-updates/cloudflare';
import { countrySnapshotModule, validateCountrySnapshot } from '@sharedid-edge/data-updates/ip-module';
import { builtInModules } from '@sharedid-edge/modules';
import { createWorker } from './packages/adapters/cloudflare/src/worker.ts';

const byEnvironment = new WeakMap();
export default {
  async fetch(request, env, ctx) {
    let state = byEnvironment.get(env);
    if (!state) {
      const cache = new SnapshotCache(r2Store(env.SID_DATA), 'dbip', validateCountrySnapshot);
      const module = countrySnapshotModule({
        name: 'dbip', snapshot: () => cache.current,
        maxAgeMs: 3 * 86400000, expireAfterMs: 45 * 86400000
      });
      state = { cache, worker: createWorker([...builtInModules, module]) };
      byEnvironment.set(env, state);
    }
    if (!state.cache.current) await state.cache.reload();
    else ctx.waitUntil(state.cache.reload());
    return state.worker.fetch(request, env, ctx);
  }
};
```

Set `SID_MODULES=geo,dbip`, with `mode: replace` only if you intend DB-IP to override the CDN's country. Every isolate loads private storage at first use; subsequent polls run in background work at most once a minute. No module downloads or reads storage. A failed read retains that isolate's last good snapshot. For MaxMind, use source name `maxmind`, `ipservice: 3`, and an expiry consistent with its licence.

KV is also supported: substitute `kvStore(env.SID_DATA)` and a `kv_namespaces` binding in both Workers. KV is eventually consistent, so a new manifest may arrive before its body; the reader keeps its old copy and retries on a later poll. R2 is preferred for large datasets and immediate publication visibility. Keep one scheduled writer per source and bucket/namespace prefix.

## AWS: EventBridge and a separate update function

Create a private S3 bucket, and deploy a separate Node.js 24 function with the updater and its dependencies. Its `update.mjs` entry point is:

```js
import sources from './updates.mjs';
import { runUpdates, updateSecrets } from '@sharedid-edge/data-updates';
import { s3Store } from '@sharedid-edge/data-updates/aws';

export async function handler() {
  const reports = await runUpdates(sources, {
    store: s3Store(process.env.SID_DATA_BUCKET),
    secrets: updateSecrets(process.env.SID_MODULE_SECRETS),
    timeoutMs: 120000
  });
  if (reports.some(report => report.status === 'failed')) {
    throw new Error('Scheduled reference-data update failed');
  }
  return reports;
}
```

Use an EventBridge schedule such as `rate(12 hours)`. For SAM, the update function's resource has this shape; `CodeUri` must contain `update.mjs`, `updates.mjs` and installed production dependencies, or a bundle of them:

```yaml
DataUpdateFunction:
  Type: AWS::Serverless::Function
  Properties:
    CodeUri: update-deploy/
    Handler: update.handler
    Runtime: nodejs24.x
    Timeout: 300
    MemorySize: 1024
    ReservedConcurrentExecutions: 1
    Environment:
      Variables:
        SID_DATA_BUCKET: !Ref ReferenceDataBucket
        SID_MODULE_SECRETS: !Ref UpdateModuleSecrets
    Policies:
      - Statement:
          - Effect: Allow
            Action: s3:ListBucket
            Resource: !GetAtt ReferenceDataBucket.Arn
          - Effect: Allow
            Action: [s3:GetObject, s3:PutObject]
            Resource: !Sub '${ReferenceDataBucket.Arn}/sharedid-data/*'
    Events:
      Refresh:
        Type: Schedule
        Properties:
          Schedule: rate(12 hours)
          Enabled: true
```

`ReferenceDataBucket` is your private bucket; `UpdateModuleSecrets` is a `NoEcho` parameter or a Secrets Manager dynamic reference. Enable S3 Block Public Access and encryption. Only the updater's execution role needs write access and the vendor secret; the request function needs only `s3:GetObject` for `sharedid-data/*`. There is no function URL for the updater. Monitor failed scheduled invocations and configure retries/dead-letter handling for your deployment. Invoke it once and verify the manifest before enabling the request module.

The updater also needs bucket-level `s3:ListBucket` on this dedicated bucket. [S3 returns `NoSuchKey` for a missing object only when the caller has that permission](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html); otherwise it returns `AccessDenied`. On an empty bucket the manifest is missing, so omitting this permission prevents the first publication. Object reads and writes remain restricted to `sharedid-data/*`, and genuine permission errors still fail the update. The read-only request function can retain its object-only permission: a missing or unreadable snapshot keeps its previous cached copy, if any.

In the request function, create a `SnapshotCache(s3Store(bucket), 'dbip', validateCountrySnapshot)` and `countrySnapshotModule` as above. Add it to `createLambdaHandler({ ...settingsFromEnv(process.env), modules: [...builtInModules, module] })`. The exported Lambda handler calls `await cache.reload()` before invoking that handler. The cache checks private S3 at most once a minute, loads the body only for a changed hash, and retains the last good copy on an error. The first load and later manifest polls may add storage latency; they never download from the vendor or transform a database. Keep this cache outside the exported function so warm invocations see updates.

The default SAM template and the default Lambda bundle stay unchanged; use your custom entry point for this opt-in deployment. The update function includes the AWS SDK and MMDB conversion and does not use the default request bundle's 32 KB budget.

## Node.js: cron or a systemd timer

Install `@sharedid-edge/data-updates` and the source modules in your deployment project (or use the workspace install here). Put the `updates.mjs` configuration above in that project. Run the first update as the same service user that will run later jobs:

```sh
npx sharedid-edge-update ./updates.mjs --dir /var/lib/sharedid-edge/data
```

The output is one source name and status (`updated`, `unchanged` or `failed`), never credentials or raw download errors. A failed source gives exit code 1 so cron/systemd monitoring can detect it. Store `SID_MODULE_SECRETS` in a service environment file with restrictive permissions, not in crontab or command arguments.

Example systemd service and timer (replace paths and user with your deployment's):

```ini
# sharedid-edge-update.service
[Unit]
Description=Refresh SharedID Edge reference data

[Service]
Type=oneshot
User=sharedid
WorkingDirectory=/opt/sharedid-edge
EnvironmentFile=/etc/sharedid-edge/update.env
StateDirectory=sharedid-edge
ExecStart=/opt/sharedid-edge/node_modules/.bin/sharedid-edge-update /opt/sharedid-edge/updates.mjs --dir /var/lib/sharedid-edge/data
```

```ini
# sharedid-edge-update.timer
[Unit]
Description=Refresh SharedID Edge data twice a day

[Timer]
OnCalendar=*-*-* 00,12:17:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

Enable it with `systemctl enable --now sharedid-edge-update.timer`. A cron job can call the same executable every 12 hours, using the service's protected environment. The command excludes overlapping local runs with `<directory>/.update-lock`; after a killed/crashed updater, first verify no updater is running, then remove that empty lock directory and run again.

For the request process, use a custom Node entry point:

```js
import { createNodeServer } from '@sharedid-edge/node';
import { builtInModules } from '@sharedid-edge/modules/bowser';
import { settingsFromEnv } from '@sharedid-edge/core';
import { SnapshotCache } from '@sharedid-edge/data-updates';
import { fileStore } from '@sharedid-edge/data-updates/node';
import { countrySnapshotModule, validateCountrySnapshot } from '@sharedid-edge/data-updates/ip-module';

const cache = new SnapshotCache(fileStore('/var/lib/sharedid-edge/data'), 'dbip', validateCountrySnapshot);
await cache.reload();
const module = countrySnapshotModule({
  name: 'dbip', snapshot: () => cache.current,
  maxAgeMs: 3 * 86400000, expireAfterMs: 45 * 86400000
});
setInterval(() => { void cache.reload(); }, 60000).unref();
createNodeServer({
  ...settingsFromEnv(process.env), modules: [...builtInModules, module]
}).listen(8787, '127.0.0.1');
```

Set `SID_COOKIE_DOMAIN` and `SID_MODULES=geo,dbip`. Keep the usual proxy/origin configuration from the [Node guide](../packages/adapters/node/README.md); add its `trustProxy`, `publicOrigin` and other options when your deployment needs them. Files are mode 0600 and created directories mode 0700. If updater and server use different users, give the server read access through an appropriate service group or ACL. Only JSON snapshots cross the process boundary; the command never changes the running server's JavaScript.

## Freshness, failures and licences

`maxAgeMs` measures time since the last successful source check. A 304 or identical valid data keeps the data current. No valid snapshot gives `stale` with no data. Once a cached copy exceeds the age, the response can still contain the last good country:

```json
{"ortb2":{"device":{"geo":{"type":2,"country":"FRA"}}},"ext":{"modules":{"dbip":{"ms":0,"status":"ok","stale":true}}}}
```

At `expireAfterMs`, the module drops its contribution and still reports `stale`. Set this when a licence or accuracy requirement limits how long failed refreshes may use old data. MaxMind's GeoLite terms and the module's [licence section](../packages/vendor-modules/maxmind/README.md) still apply. Keep snapshots private, restrict access by prefix, and remove superseded hash objects within your licence's retention terms. Do not delete a body the current manifest references.

For modules that keep bundled data, `SID_MODULE_CONFIG={"dbip":{"maxAgeDays":45}}` (also `maxmind`) reports `stale` based on the database's publication date, while retaining the last good country. The default leaves this check off. This is separate from the scheduled cache's last-check age and never starts a download.

Check scheduler failures first, then secret names and licence status, then storage permissions. A failed job keeps the current manifest; a failed reader keeps its in-memory copy. Fix the job and run it again, then verify the manifest's `checkedAt` and that the module returns `ok` on a matching address. None of these checks requires sending a real visitor's address to the vendor.
