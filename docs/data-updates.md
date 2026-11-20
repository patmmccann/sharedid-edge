# Scheduled data updates

Use [@sharedid-edge/data-updates](../packages/data-updates/README.md) to refresh shared reference data separately from visitor requests. Existing build-time DB-IP and MaxMind modules remain available; a scheduled snapshot module is an opt-in replacement, not an additional module with the same name.

The concrete sources here are DB-IP Lite country, MaxMind GeoLite2 Country, the public keys the [`encrypted-ip`](#encrypted-ip-keys) module encrypts to, and the [crawler User-Agent patterns](#crawler-user-agent-patterns) the `ua` module flags declared bots with. Other lists use the same update interface with their own validator and in-memory lookup. The `bot` module uses no reference list, so it has no source.

## Platforms

Scheduled updates need a scheduler and private storage next to the request worker. Each platform's README has a "Scheduled data updates" section; this table is generated from their `package.json` metadata (`dataUpdates`):

<!-- generated:data-updates-platforms:start -->
| Platform | Supported | How, or what you get instead |
| --- | --- | --- |
| [Akamai EdgeWorkers](../packages/adapters/akamai/README.md#scheduled-data-updates) | No | EdgeWorkers have no scheduled jobs, and there's no storage adapter for EdgeKV. You get the data compiled into your build (isbot's crawler list in `ua`, a vendor module's country database), refreshed by upgrading and rebuilding; `encrypted-ip` keys come from its settings. |
| [AWS (Lambda and CloudFront)](../packages/adapters/aws-lambda/README.md#scheduled-data-updates) | Yes | Lambda behind CloudFront: a separate update function on an EventBridge schedule writes private S3 snapshots, and your request function's entry point loads them. Not Lambda@Edge (no environment or secrets; its settings are baked into the bundle), which keeps the data compiled into it. |
| [Azure (Functions and Front Door)](../packages/adapters/azure-functions/README.md#scheduled-data-updates) | No | No recipe or storage adapter yet for a timer-triggered function and Blob Storage. You get the data compiled into your build (isbot's crawler list in `ua`, a vendor module's country database), refreshed by upgrading and rebuilding; `encrypted-ip` keys come from its settings. |
| [Cloudflare Workers](../packages/adapters/cloudflare/README.md#scheduled-data-updates) | Yes | Workers: a separate update Worker on a Cron Trigger writes private R2 (or KV) snapshots, and your request Worker's entry point loads them. Not the Snippet (no scheduler, secrets or storage bindings), which keeps the data compiled into it. |
| [Fastly Compute](../packages/adapters/fastly/README.md#scheduled-data-updates) | No | Compute has no scheduled jobs, and there's no storage adapter for its KV Store. You get the data compiled into your build (isbot's crawler list in `ua`, a vendor module's country database), refreshed by upgrading and rebuilding; `encrypted-ip` keys come from its settings. |
| [Google Cloud (Cloud Run functions and Load Balancing)](../packages/adapters/gcp-functions/README.md#scheduled-data-updates) | No | No recipe or storage adapter yet for Cloud Scheduler and Cloud Storage. You get the data compiled into your build (isbot's crawler list in `ua`, a vendor module's country database), refreshed by upgrading and rebuilding; `encrypted-ip` keys come from its settings. |
| [Node.js (self-hosted)](../packages/adapters/node/README.md#scheduled-data-updates) | Yes | cron or a systemd timer runs `sharedid-edge-update`, which writes private files, and your server's entry point reloads them in the background. |
| [Vercel](../packages/adapters/vercel/README.md#scheduled-data-updates) | No | No recipe or storage adapter yet for Vercel Cron Jobs and Vercel Blob. You get the data compiled into your build (isbot's crawler list in `ua`, a vendor module's country database), refreshed by upgrading and rebuilding; `encrypted-ip` keys come from its settings. |
<!-- generated:data-updates-platforms:end -->

Where they aren't supported, nothing changes: the modules use the data compiled into the build, as without the updater.

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
            Action: [s3:GetObject, s3:PutObject, s3:DeleteObject]
            Resource: !Sub '${ReferenceDataBucket.Arn}/sharedid-data/*'
    Events:
      Refresh:
        Type: Schedule
        Properties:
          Schedule: rate(12 hours)
          Enabled: true
```

`ReferenceDataBucket` is your private bucket; `UpdateModuleSecrets` is a `NoEcho` parameter or a Secrets Manager dynamic reference. Enable S3 Block Public Access and encryption. Only the updater's execution role needs write access and the vendor secret; the request function needs only `s3:GetObject` for `sharedid-data/*`. There is no function URL for the updater. Monitor failed scheduled invocations and configure retries/dead-letter handling for your deployment. Invoke it once and verify the manifest before enabling the request module.

The updater also needs bucket-level `s3:ListBucket` on this dedicated bucket. [S3 returns `NoSuchKey` for a missing object only when the caller has that permission](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html); otherwise it returns `AccessDenied`. On an empty bucket the manifest is missing, so omitting this permission prevents the first publication. Object reads, writes and deletions (of superseded snapshot bodies) remain restricted to `sharedid-data/*`, and genuine permission errors still fail the update. The read-only request function can retain its object-only permission: a missing or unreadable snapshot keeps its previous cached copy, if any.

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

## Encrypted IP keys

The [`encrypted-ip` module](../packages/modules/encrypted-ip/README.md) encrypts the client IP to each recipient's public key. Deliver those keys with the same updater, rather than in settings, so they follow the recipients' rotations:

```js
import { googleIpKeySource, pbsIpKeySource } from '@sharedid-edge/data-updates/encrypted-ip';

export default [
  googleIpKeySource(),                                                       // source "google-ip-key"
  pbsIpKeySource({ name: 'pbs-example', url: 'https://pbs.example.com/ip_enc_key.json' })   // experimental
];
```

`googleIpKeySource()` downloads [Google's key file](https://www.gstatic.com/real-ip/ip_enc_key.json) for Google Publisher Tag's [publisher-provided IP](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address); `pbsIpKeySource` a Prebid Server host's, from the HTTPS URL its operator publishes ([prebid/prebid-server#5106](https://github.com/prebid/prebid-server/issues/5106), a proposal). They send no credentials and no visitor data. A key file must hold exactly one key, the active one, as Google's does (`kty` `OKP`, `crv` `X25519`, a `kid`, a 32-byte `x`): a file with no key or several, another key type, a private key, or more than 16 KB fails the run, which keeps the previous snapshot. They publish only `{ kid, x }` and the file's `Cache-Control` `max-age` (`no-store` and `no-cache` count as 0).

**Schedule them often.** Google asks that its key be refreshed at least every 24 hours, and sooner when its `Cache-Control` says so: `max-age=3000` (50 minutes) when this was written. Give these sources their own job, every 30 minutes (Cloudflare cron `*/30 * * * *`, EventBridge `rate(30 minutes)`, a systemd timer `OnCalendar=*:0/30`), rather than the databases' 12-hour one. Each run is one small download; an unchanged key only updates the manifest's `checkedAt`.

In the request worker, load each key with a `SnapshotCache` and give it to the module for the recipients its settings list:

```js
import { SnapshotCache } from '@sharedid-edge/data-updates';
import { r2Store } from '@sharedid-edge/data-updates/cloudflare';
import { validateIpKey } from '@sharedid-edge/data-updates/encrypted-ip';
import { createEncryptedIpModule } from '@sharedid-edge/module-encrypted-ip';

const google = new SnapshotCache(r2Store(env.SID_DATA), 'google-ip-key', validateIpKey);
const pbs = new SnapshotCache(r2Store(env.SID_DATA), 'pbs-example', validateIpKey);
const module = createEncryptedIpModule({ keys: { google: () => google.current, pbs: { 'pbs.example.com': () => pbs.current } } });
// Reload the caches as in the recipes above (first use, then background work), and set
// SID_MODULES=encrypted-ip and SID_MODULE_CONFIG={"encrypted-ip":{"google":{},"pbs":{"pbs.example.com":{}}}}.
```

Validating a reloaded snapshot also imports its key into Web Crypto, in the background reload, so requests only do the work each value needs.

The rules follow [Google's guide](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address), counting from the snapshot's last successful check: a key is fresh until its recorded `max-age` (held to 1 minute to 24 hours, an hour without one); past that, the module still encrypts with it and marks that recipient's value `stale: true`, so a failing job shows early; more than 24 hours after the last check, that recipient gets **no value**, since Google promises to decrypt only with keys fetched within 24 hours. With no snapshot yet, that recipient gets no value either. Both make the module report `stale`. See the module's [Keys](../packages/modules/encrypted-ip/README.md#keys).

## Crawler User-Agent patterns

The [`ua` module](../packages/modules/ua/README.md#scheduled-crawler-list-updates) flags crawlers that identify themselves with [isbot](https://github.com/omrilotan/isbot)'s pattern list, compiled into the build. To follow isbot's list between releases, add its source:

```js
import { isbotPatternsSource } from '@sharedid-edge/data-updates/crawlers';

export default [
  isbotPatternsSource()   // source "isbot-patterns"
];
```

It downloads [`src/patterns.json`](https://github.com/omrilotan/isbot/blob/main/src/patterns.json) from isbot's main branch on GitHub (about 3 KB; released under [the Unlicense](https://github.com/omrilotan/isbot/blob/main/LICENSE), public domain), with no credentials and no visitor data, and publishes `{ "patterns": [...] }`. `isbotPatternsSource({ url })` takes another `https:` URL, such as a release tag's copy (`https://raw.githubusercontent.com/omrilotan/isbot/v5.2.3/src/patterns.json`) or your own reviewed mirror, in the same format; `name` gives the source another name. Run it once a day; an unchanged list (ETag or content) only updates the manifest's `checkedAt`.

**A list is checked before it's published**, with the module's own rules (`validateCrawlerPatterns`, the module's `parseCrawlerList`), and again when a request worker loads it: 50 to 10,000 patterns of at most 1,024 characters, no duplicates, each compiling as a case-insensitive regular expression and none matching an empty `User-Agent`, the whole list matching Googlebot, Bingbot, YandexBot, DuckDuckBot, Baiduspider, `facebookexternalhit` and AhrefsBot, and matching no current Chrome, Edge, Safari, Firefox or Samsung Internet `User-Agent`. A download that fails, such as an empty list, a truncated one or a pattern that doesn't compile, fails the run and the previous snapshot stays published, so a bad download can't flag every visitor as a bot or turn detection off. The patterns are regular expressions run on every request's `User-Agent` (at most 512 characters of it): use only a source you trust as you trust the isbot package.

In the request worker, load it and give it to the `ua` module in place of the built-in one:

```js
import { SnapshotCache } from '@sharedid-edge/data-updates';
import { validateCrawlerPatterns } from '@sharedid-edge/data-updates/crawlers';
import { createUaModule } from '@sharedid-edge/module-ua';
import { bowserParser } from '@sharedid-edge/module-ua/bowser';

const crawlers = new SnapshotCache(r2Store(env.SID_DATA), 'isbot-patterns', validateCrawlerPatterns);
const ua = createUaModule({
  bowser: bowserParser,                                   // only in a build with Bowser
  crawlers: { snapshot: () => crawlers.current, maxAgeMs: 3 * 86400000 }
});
const modules = [...builtInModules.filter(module => module.name !== 'ua'), ua];
// Reload the cache as in the recipes above (first use, then background work).
```

Validation also compiles the list, during the reload, so requests only look it up. Until the first snapshot loads, the module uses the compiled-in list and reports `stale`; past `maxAgeMs` it keeps using the snapshot, reported `stale`; past the optional `expireAfterMs` it goes back to the compiled-in list, still `stale`. Its other output never changes. See the module's [Scheduled crawler-list updates](../packages/modules/ua/README.md#scheduled-crawler-list-updates).

## Freshness, failures and licences

`maxAgeMs` measures time since the last successful source check. A 304 or identical valid data keeps the data current. No valid snapshot gives `stale` with no data. Once a cached copy exceeds the age, the response can still contain the last good country:

```json
{"ortb2":{"device":{"geo":{"type":2,"country":"FRA"}}},"ext":{"modules":{"dbip":{"ms":0,"status":"ok","stale":true}}}}
```

At `expireAfterMs`, the module drops its contribution and still reports `stale`. Set this when a licence or accuracy requirement limits how long failed refreshes may use old data. MaxMind's GeoLite terms and the module's [licence section](../packages/vendor-modules/maxmind/README.md) still apply. Keep snapshots private and restrict access by prefix. After each successful publication the updater deletes the replaced `<source>/<hash>.json` body (once the new manifest reads back), retrying a failed deletion on the next run, so storage holds only the current data. That meets MaxMind's requirement to destroy old releases within 30 days of a new one while the job runs at least that often. Remove by hand anything left from a manifest that was unreadable when it was replaced; never delete the body `current.json` references.

A manifest up to 5 minutes ahead of a request host's clock is treated as fresh (normal clock skew between the updater and request hosts); further ahead, readers reject it and keep their copy. If a new snapshot can't be compiled into a lookup, the module keeps answering from its previous one with `stale: true`, or `error` when it has none.

For modules that keep bundled data, `SID_MODULE_CONFIG={"dbip":{"maxAgeDays":45}}` (also `maxmind` and `ip2location`, where either of its two databases counts) reports `stale` based on the database's publication date, while retaining the last good country. The default leaves this check off. This is separate from the scheduled cache's last-check age and never starts a download.

Check scheduler failures first, then secret names and licence status, then storage permissions (including delete). The updater writes fixed messages to stderr when it republishes over an unreadable manifest or can't delete a superseded body. A failed job keeps the current manifest; a failed reader keeps its in-memory copy. Fix the job and run it again, then verify the manifest's `checkedAt` and that the module returns `ok` on a matching address. None of these checks requires sending a real visitor's address to the vendor.
