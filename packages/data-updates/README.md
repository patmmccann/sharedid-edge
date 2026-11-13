# @sharedid-edge/data-updates

Refresh IP databases and other shared reference data on a scheduler, without downloading anything while answering a visitor. This package is opt-in; existing bundled modules and default adapters keep working as before.

The [deployment guide](../../docs/data-updates.md) covers Cloudflare Cron Triggers with R2 or KV, a separate AWS Lambda update function with an EventBridge schedule and S3, and a Node.js cron command with private files. It also shows how request workers load the stored snapshot.

## How it works

1. A scheduled job downloads a configured source with the deployer's credentials, transforms it and validates the result.
2. It hashes a versioned JSON body with SHA-256 and writes it under `<source>/<hash>.json`, then atomically publishes `<source>/current.json`. A failed update leaves the last published data usable.
3. Identical content isn't written again. A successful unchanged download or HTTP 304 updates only the small manifest's freshness timestamp.
4. The request adapter periodically loads the manifest from private deployment storage. It downloads a body only when its hash changes, checks the hash and format, and validates the data. A failed read keeps the previous in-memory copy.
5. A module reads that in-memory copy. It never downloads, reads storage, or keeps visitor data. Old or missing data reports `stale: true`; an optional expiry stops old data contributing.

Run only one updater per source and prefix. The storage contract requires atomic replacement of each object; distributed compare-and-swap is not part of it. R2 and S3 provide strongly consistent object reads. With eventually consistent KV, a reader may temporarily see a manifest before its body and keeps its old copy until the next poll.

## Entry points

| Import | Exports and purpose |
| --- | --- |
| `@sharedid-edge/data-updates` | `refreshData`, `runUpdates`, `SnapshotCache`, `readSnapshot`, `snapshotModule`, `updateSecrets`, `sha256`, and their types. Web APIs only. |
| `@sharedid-edge/data-updates/country` | `dbipSource`, `maxmindSource`: country database download and conversion, for the scheduled job only. |
| `@sharedid-edge/data-updates/ip-module` | `countrySnapshotModule`, `validateCountrySnapshot`: in-memory country lookups, with the existing `fill`/`replace` and consent rules. |
| `@sharedid-edge/data-updates/cloudflare` | `r2Store`, `kvStore`, `scheduledUpdate`. Structural binding types; no Cloudflare runtime package. |
| `@sharedid-edge/data-updates/aws` | `s3Store`, using the AWS SDK and the function's execution role. Import only in AWS entry points. |
| `@sharedid-edge/data-updates/node` | `fileStore`: private local files, atomic replacement and restrictive file modes. |

The executable is `sharedid-edge-update <sources.mjs> --dir <directory>`. The trusted local module exports an array of `UpdateSource` definitions. Install this package before using its executable with `npx`; it is not a separate package named `sharedid-edge-update`.

## Settings and secrets

`runUpdates(sources, { store, secrets, timeoutMs, fetch, now })` runs the explicitly supplied sources sequentially so two large databases aren't downloaded into the same isolate at once. The default download timeout is 30 seconds (configurable up to 300 seconds); injected `fetch` and `now` support tests. Sources must respect the signal while reading or transforming large downloads. The included sources bound compressed downloads to 64 MiB and checksum responses to 4 KiB.

`updateSecrets(process.env.SID_MODULE_SECRETS)` reads a JSON object of per-source string secret maps. The included MaxMind source uses `{"maxmind":{"accountId":"…","licenseKey":"…"}}`; DB-IP needs none. Only the download callback receives these values. Source URLs are fixed vendor URLs. Redirects are followed explicitly (HTTPS only, at most five hops), stripping Authorization whenever the origin changes for both the database and checksum. Signed redirect URLs are not stored. Neither credentials nor exception messages enter reports or snapshots.

`SnapshotCache(store, name, validate, pollMs = 60000, now = Date.now)` coalesces concurrent reloads. `reload()` returns `false` on a missing, invalid or unavailable snapshot and retains the last good copy. It doesn't run a timer: call it from adapter setup or background work. Initial storage reads may add latency at cold start; vendor downloads and database conversion never run there.

`snapshotModule({ definition, snapshot, create, maxAgeMs, expireAfterMs?, now? })` preserves the declared module identity, routes and consent requirements. `create(data)` returns a `run` callback compiled from shared data, rebuilt only when the content hash changes. A stale copy may still contribute. At `expireAfterMs` it contributes nothing and reports `stale`. Do not store a request or anything derived from one in `create`'s closure.

## Other reference data

`UpdateSource<T>` supports validated lists as well as databases. Define a `name`, `download(context)`, `decode(bytes)` and `validate(unknown)`. The data must be JSON-serializable. Set a `variant` when transformation options or schemas change, so an old ETag cannot skip reconversion. `download` returns `{bytes, etag?, url?}`, or `undefined` for an unchanged conditional download; a first-boot `undefined` fails. The URL is only the public resource identity for conditional requests and must contain no secrets. `decode` and `validate` must reject unsupported versions, malformed or unusable data. A new list source needs its own validator and an in-memory lookup module; this package doesn't replace the `ua` module's compiled `isbot` dependency automatically.

## Data and licence

No real database is included. The tests generate small MMDB files containing documentation addresses only. The included sources retain the attribution you pass from `DBIP_ATTRIBUTION` or `MAXMIND_ATTRIBUTION`; each vendor's [DB-IP](../vendor-modules/dbip/README.md#data-and-licence) or [MaxMind guide](../vendor-modules/maxmind/README.md) still governs its data. Keep storage private, restrict the updater to its own prefix, and remove superseded objects according to the licence; content-addressed bodies are retained until you remove them. Never delete a currently referenced body. Configure an expiry as well as a stale threshold when required.

Cloudflare Snippets cannot use this package: no scheduler, secrets or storage bindings, and too little memory for databases. Default request bundles do not import the updater or its AWS SDK.

## Tests

```sh
npm run build
npm run test -w @sharedid-edge/data-updates
```

Tests exercise publication failures, unchanged downloads, timeouts, hash validation, cache refresh, stale/expired modules, consent, both address families, MaxMind authentication/checksums, storage bindings and the local command without a cloud account.
