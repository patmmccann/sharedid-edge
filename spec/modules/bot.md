# The `bot` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `bot`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, on `v1` and `sync` (its `routes`), and reports to the [traffic signal](../SPEC.md#traffic-signal) (status `ok` when it reports something, else `empty`). It doesn't repeat the [platform's verdict](../SPEC.md#platform-traffic-verdict), which is merged on its own, and doesn't recognize crawlers by user agent.

- **Settings,** `SID_MODULE_CONFIG.bot`, both optional:
  - `missingHeaders` (boolean, default `false`): report `bot: true, botKind: likely` when the user agent claims to be a browser (it starts with `Mozilla/5.0 (`) and the request lacks headers browsers send:
    - an `Accept-Language` header that's missing or empty; or
    - all of `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, when the request URL is https (or the host is `localhost`, `127.0.0.1` or `[::1]`) and the user agent is a version that sends them: `Chrome/` 80 or later; else `Firefox/` 90 or later, but not `FxiOS/`; else `Version/` 17 or later followed by `Safari/`, but not with `CriOS`, `FxiOS`, `EdgiOS` or `Android`.
  - `internalCookie` (a cookie name): report `internal: true` when the request carries that cookie with a non-empty value.

  Any other key, or a wrong type, makes the module an `error`.
- **Secret,** `SID_MODULE_SECRETS.bot.internalToken` (optional, at least 16 characters): the internal cookie then counts only when its value is the token. Any other key, or a shorter token, makes the module an `error`.
- **Consent:** as for every traffic report, it runs and reports whatever the consent signals say.
- On `/sync`, its report counts towards [Skipping bots](../SPEC.md#skipping-bots), so a likely bot gets no ID from Prebid.js's `pixelUrl` call when `SID_SKIP_BOTS` would deny it one on `/v1`.
- It MUST NOT store or log anything about the request.
