# packages/data-updates

Scheduled reference-data updates (issue #30). User guide: [README.md](README.md) and [the deployment recipes](../../docs/data-updates.md). This is an opt-in package, not a module or a dependency of default adapters.

- `snapshot.ts`, `update.ts` and `module.ts` use web APIs only. Keep Node, AWS SDK and vendor MMDB conversion out of the default entry point's imports. Platform entry points are separate.
- An update source is trusted deployment code with a stable name, a download callback, a decoder and a validator. Only its download callback gets secrets, a bounded signal and fetch. Never pass request context to it. New download sources need fake-fetch tests, including authentication and invalid input.
- Snapshot bodies are JSON, versioned and addressed by SHA-256. Write the body before publishing `current.json`; an invalid download or failed write must leave the old manifest usable. An unchanged body isn't rewritten. Successful revalidation updates only the small manifest's `checkedAt`. Never execute downloaded JavaScript.
- One scheduled writer per source and storage prefix. Node's command excludes overlapping local processes with a directory lock; AWS jobs use reserved concurrency 1. R2 is preferred over eventually consistent KV; failed or temporarily unavailable reads retain the in-memory copy.
- Runtime modules read only `SnapshotCache.current`. Adapters reload private storage outside module execution, optionally in background work. Neither downloads nor storage reads belong in a module's `run`. Caches hold only shared data and compiled lookups, never visitor data.
- `stale` is a module result flag and an optional core report flag; statuses remain unchanged. Missing, old or expired snapshots report it; stale usable data may contribute. Consent, errors and timeout handling still belong to core. `expireAfterMs` stops using old data when a licence requires it.
- Credentials come from `SID_MODULE_SECRETS`. Errors and reports contain fixed messages and source names only. MaxMind uses Basic authentication and validates its separate SHA-256 download; never add credentials to URLs, manifests or logs.
- Unit tests fake fetch and storage. The Node command is also run as a subprocess against local fixture data. No vendor data, key or cloud account is needed in CI. Preserve strict TypeScript and lint rules.
