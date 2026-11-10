# Configuration reference

All settings are strings, set as Worker `vars` (Cloudflare), environment variables (Node.js, AWS Lambda, Vercel, Google Cloud) or app settings (Azure Functions). Empty means the default. Invalid values make every request fail with a 500 and log the reason, rather than set wrong cookies.

These are the core settings, which every platform reads. The table is generated from `SETTINGS` in [`packages/core/src/config.ts`](../packages/core/src/config.ts) by `node scripts/docs.mjs --write`.

<!-- generated:settings:start -->
| Variable | Default | Description |
| --- | --- | --- |
| `SID_BASE_PATH` | `/_sid` | Path prefix the worker answers under. Must match your route. |
| `SID_COOKIE_NAME` | `_pubcid` | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | host-only | `Domain` for the cookies, e.g. `.example.com` to share across subdomains. |
| `SID_MAX_AGE_DAYS` | `365` | Cookie lifetime in days, 1 to 400 (browsers cap at 400). |
| `SID_CREATE` | `true` | Mint an ID when the request has none. With Prebid.js it always sends one, so this rarely matters. |
| `SID_RECOVERY_COOKIE` | `_pubcid_sv` | Name of the `HttpOnly` recovery copy; `none` to disable it. |
| `SID_OPTOUT_COOKIE` | `_pubcid_optout` | The opt-out cookie; Prebid.js reads `_pubcid_optout`. |
| `SID_VENDOR_ID` | (empty: publisher mode) | Your TCF vendor ID (1 to 65535), for vendor mode. |
| `SID_ALLOWED_ORIGINS` | none | Comma-separated origins (like `https://www.example.com`) allowed to read `/_sid/v1` from script on another origin. |
| `SID_SYNC_CACHE_SECONDS` | `86400` | How long a browser may reuse a sync response (privately). `0` re-syncs on every call. Also limits how often modules run on `/_sid/sync`. |
| `SID_MODULES` | none | Comma-separated modules to run, in order. |
| `SID_SYNC_MODULES` | the modules in `SID_MODULES` that run on `/_sid/sync` | Comma-separated modules to run on `/_sid/sync`, each also in `SID_MODULES`, or `none`. |
| `SID_MODULE_CONFIG` | `{}` | JSON settings per module, keyed by module name. |
| `SID_MODULE_SECRETS` | `{}` | JSON secrets (strings) per module, keyed by module name, e.g. the `ec` passphrase. Set it as a platform secret (`wrangler secret put SID_MODULE_SECRETS`), not in plain settings. |
| `SID_MODULE_TIMEOUT_MS` | `50` | Time limit for each module, 1 to 10000. |
| `SID_SKIP_BOTS` | off | `verified`, `declared` or `likely`: set no SharedID for bots this sure or surer, from the traffic signal. Existing IDs are never deleted. |
| `SID_SKIP_BOTS_SCORE` | off | 1 to 99: set no SharedID when the traffic score (Cloudflare Bot Management) is at or below it. |
<!-- generated:settings:end -->

More on some of them: [`SID_VENDOR_ID`](consent.md) (vendor mode), [`SID_MODULES`, `SID_SYNC_MODULES` and `SID_MODULE_CONFIG`](modules.md#choosing-modules), [`SID_SKIP_BOTS`](modules.md#no-sharedid-for-bots).

- **Module settings** go in `SID_MODULE_CONFIG` and `SID_MODULE_SECRETS`, keyed by module name; each module's README lists its own (see the [module index](modules.md#module-index)).
- **Platform settings,** such as the Node.js server's `SID_PUBLIC_ORIGIN` and `SID_TRUST_PROXY`, are in each adapter's README (see [Pick your platform](../README.md#pick-your-platform)).

Routes, under `SID_BASE_PATH`:

| Route | |
| --- | --- |
| `GET /_sid/sync?id=pubcid:<id>` | The `pixelUrl` endpoint: a 1×1 GIF with the cookies, including those of modules that run there. |
| `GET /_sid/v1` | JSON: the SharedID, its eid, and the modules' output. |
| `GET /_sid/optout`, `GET /_sid/optin` | Set or clear the opt-out cookie. |

The full behaviour is in the [specification](../spec/SPEC.md).
