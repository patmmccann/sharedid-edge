# The `bot` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `bot`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, on `v1` and `sync` (its `routes`), and reports to the [traffic signal](../SPEC.md#traffic-signal) (status `ok` when it reports something, else `empty`). It doesn't repeat the [platform's verdict](../SPEC.md#platform-traffic-verdict), which is merged on its own, and doesn't recognize crawlers by user agent. It reads one fact the platform provides, the JA4 fingerprint, and draws its own conclusion from it.

- **Settings,** `SID_MODULE_CONFIG.bot`, both optional:
  - `missingHeaders` (boolean, default `false`): report `bot: true, botKind: likely` when the user agent claims to be a browser (it starts with `Mozilla/5.0 (`) and the request lacks headers browsers send:
    - an `Accept-Language` header that's missing or empty; or
    - all of `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, when the request URL is https (or the host is `localhost`, `127.0.0.1` or `[::1]`) and the user agent is a version that sends them: `Chrome/` 80 or later; else `Firefox/` 90 or later, but not `FxiOS/`; else `Version/` 17 or later followed by `Safari/`, but not with `CriOS`, `FxiOS`, `EdgiOS` or `Android`.
  - `ja4Mismatch` (boolean, default `false`): report `bot: true, botKind: likely` when the platform information has the client's [JA4 fingerprint](../SPEC.md#platform-information) and it contradicts the browser the user agent claims. Without a JA4 (most platforms), or for a fingerprint or user agent not in the table below, there's no decision. Only TCP fingerprints (`t…`) are judged: over QUIC (`q…`) every browser offers the same three TLS 1.3 cipher suites, so the cipher hash can't tell them apart. The fingerprint's stack is read from its cipher hash (the second part), from FoxIO's public [JA4+ mapping](https://github.com/FoxIO-LLC/ja4/blob/main/ja4plus-mapping.csv):

    | Cipher hash | Stack |
    | --- | --- |
    | `8daaf6152771` | Chromium |
    | `5b57614c22b0` | Firefox |
    | `a09f3c656075` | Safari (Apple's TLS stack) |
    | `85036bcba153`, `c7886603b240` | Python |
    | `9dc949149365`, `e33ad33b3d25`, `cbb2034c60b8`, `8cdfa2d4673b` | Go |

    The claim is read from a user agent that starts with `Mozilla/5.0 (`, on a device other than an iPhone, iPad or iPod (every iOS browser uses Apple's stack, whatever it calls itself):
    - Chromium: `Chrome/` or `Chromium/` followed by a digit (Chrome, Edge, Opera, Samsung Internet, Android WebView, …);
    - Firefox: `Firefox/` followed by a digit, without `Chrome/`;
    - Safari: `Version/` and a version followed by `Safari/`, without `Chrome/`, `Chromium/`, `Android` or `Firefox/`.

    They contradict when the stack is Python or Go and the user agent claims any of the three, or when the stack is another of the three browsers, except a Safari stack with a user agent naming `Macintosh` (iPad browsers asking for desktop sites send a Mac user agent).
  - `internalCookie` (a cookie name): report `internal: true` when the request carries that cookie with a non-empty value.

  Any other key, or a wrong type, makes the module an `error`.
- **Secret,** `SID_MODULE_SECRETS.bot.internalToken` (optional, at least 16 characters): the internal cookie then counts only when its value is the token. Any other key, or a shorter token, makes the module an `error`.
- **Consent:** as for every traffic report, it runs and reports whatever the consent signals say.
- On `/sync`, its report counts towards [Skipping bots](../SPEC.md#skipping-bots), so a likely bot gets no ID from Prebid.js's `pixelUrl` call when `SID_SKIP_BOTS` would deny it one on `/v1`.
- It MUST NOT store or log anything about the request, the JA4 fingerprint included, nor derive an identifier from it.
