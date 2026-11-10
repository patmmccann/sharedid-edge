# Configuration reference

All settings are strings, set as Worker `vars` (Cloudflare), environment variables (Node.js, AWS Lambda, Vercel, Google Cloud) or app settings (Azure Functions). Empty means the default. Invalid values make every request fail with a 500 and log the reason, rather than set wrong cookies.

The core settings, which every platform reads. The table is generated from `SETTINGS` in [`packages/core/src/config.ts`](../packages/core/src/config.ts) by `node scripts/docs.mjs --write`.

<!-- generated:settings:start -->
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
