# The `reflect` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `reflect`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`. It re-sets first-party cookies that other scripts on the page wrote, so they become server-set cookies with a new lifetime, as the worker does for the SharedID.

- **Settings,** `SID_MODULE_CONFIG.reflect`: `{ "cookies": [ … ], "keeper": { … } }`. `cookies` has 1 to 10 entries, each:
  - `name` (required): a cookie name (an RFC 6265 token, at most 64 characters). It MUST NOT be `_pubcid`, `_pubcid_sv`, `_pubcid_optout`, `ts-ec` or `euconsent-v2`, nor the worker's configured cookie names, and MUST NOT repeat;
  - `maxAgeDays` (required): an integer from 1 to 400;
  - `domain` (optional): a registrable domain without a leading dot, such as `example.com`; the cookie gets `Domain=.<domain>`. Without it, `SID_COOKIE_DOMAIN` applies, else the cookie is host-only;
  - `httpOnly` (optional, default `false`);
  - `deleteOnOptOut` (optional, default `false`);
  - `restore` (optional, default `false`): save the cookie in the keeper cookie and restore it from there (below);
  - `prefer` (optional, default `"browser"`; only with `restore: true`): which value wins when the request carries the cookie and the keeper also has a value for it: `"browser"`, `"backup"` or `"older"` (below);
  - `format` (optional; only with `prefer: "older"`): the value's format, `"ga"`, `"gcl_au"` or `"gcl_aw"`. Without it, the format comes from the name: `_ga` is `"ga"`, `_gcl_au` is `"gcl_au"` and `_gcl_aw` is `"gcl_aw"`. `prefer: "older"` on any other name without `format` is invalid.

  `keeper` (optional; its defaults apply when it's omitted) configures the keeper cookie:
  - `cookie` (default `_sid_keep`): a cookie name, with the same rules as `name`, and MUST NOT be one of the configured `cookies`;
  - `maxAgeDays` (default `400`): an integer from 1 to 400;
  - `domain` (optional): as for a cookie. Without it, the first `restore` cookie's `domain` applies; without that, `SID_COOKIE_DOMAIN`, else host-only.

  Any other key, a wrong type or an out-of-range value makes the module an `error` on every call, with no details.
- **Reflection:** for each configured cookie the request carries, in configuration order, the module sets `<name>=<value>; Max-Age=<maxAgeDays × 86400>; Expires=…; Path=/; [Domain=.<domain>;] SameSite=Lax; [Secure;] [HttpOnly]`. The value MUST be the request's value byte for byte: not decoded, re-encoded, trimmed beyond the `Cookie` header's own whitespace, or otherwise changed. When the name repeats in the `Cookie` header, the first is used.
- A cookie is **not reflected** when its value is empty, longer than 1024 characters, quoted, or contains a character that isn't a cookie-octet (RFC 6265). The other cookies are still reflected.
- **The keeper cookie** holds the last known value of each `restore` cookie. Its value is the base64url encoding (RFC 4648 section 5, without padding) of a JSON object mapping cookie names to values, with keys in configuration order. It's set `HttpOnly`, with the keeper's `maxAgeDays` and `Domain`, and with `Path=/`, `SameSite=Lax` and `Secure` (over https) like the others. Its name and value together MUST NOT exceed 4096 bytes: entries are added in configuration order, and one that would take it over is left out (that cookie is still reflected) while later ones are still tried.
- **Reading the keeper:** its value is read byte for byte, like the other cookies. A value that isn't base64url without padding, isn't a JSON object, or is over 4096 characters counts as empty, and so does each entry whose value isn't a string that could be reflected. It's never an error.
- **Restoring,** on each `/v1` or `/sync` request where storage is allowed, for each `restore` cookie in configuration order:
  - the request carries it, the keeper has a value for it, and the **backup wins** (below): it's **restored** over the request's value, set with the saved value and its own configured attributes as if reflected, and the saved value stays saved;
  - the request carries it with a value that can be reflected: it's reflected, and that value is saved;
  - the request doesn't carry it, and the keeper has a value for it: it's **restored**, set with that value and its own configured attributes as if reflected, and the value stays saved;
  - the request carries it with a value that can't be reflected: it's left alone, and its saved value is dropped;
  - otherwise nothing is saved for it.

  Whether the backup wins over a value the request carries depends on `prefer`:
  - `"browser"`: never. The request's value is current (the behaviour above).
  - `"backup"`: always, whatever the request's value is, including one that can't be reflected.
  - `"older"`: when both values parse in the cookie's `format` and the saved value's creation time is strictly earlier than the request's. On equal times, or when either value doesn't parse, the request's value wins, as with `"browser"`. A value parses when it matches its format exactly, with the creation time `<t>` as exactly 10 decimal digits (Unix seconds) no later than 86400 seconds after the worker's current time:
    - `"ga"`: `GA1.<d>.<n>.<t>`, where `<d>` is 1 or 2 digits not starting with `0` and `<n>` is 1 to 20 digits (the Google Analytics `_ga` cookie, `GA1.1.…` or `GA1.2.…`);
    - `"gcl_au"`: `1.<d>.<n>.<t>`, with `<d>` and `<n>` as for `"ga"` (the Google conversion linker's `_gcl_au`);
    - `"gcl_aw"`: `GCL.<t>.<c>`, where `<c>` is one or more of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-` (the Google Ads click cookie `_gcl_aw`; `<t>` is the click's time).

  Values are compared and copied, never changed: a restored value is the saved value byte for byte.

  The keeper is then set with the saved values on every such request, which refreshes its expiry. When nothing is left to save and the request carried a keeper, it's deleted. With no `restore` cookie configured, no keeper is set, and one the request carries is deleted.
- **Output:** cookies only, so the status is `empty`. Nothing is added to `eids` or `ortb2`, and neither names nor values are reported.
- **Consent:** the module reflects only when `storage.allowed` is true: not on opt-out, `Sec-GPC: 1`, `coppa=1`, a TC string that doesn't give the SharedID's consent, or GDPR applying without a TC string. It then reflects and restores nothing, and deletes none of the configured cookies, which belong to other scripts. It deletes the keeper cookie, this worker's own store of identifiers, when the request carries it.
- **Opt-out:** `{basePath}/optout` deletes a configured cookie the browser sent only when its `deleteOnOptOut` is `true`, with the configured `Domain` and `HttpOnly`. It always deletes the keeper cookie the browser sent, whatever `deleteOnOptOut` says, and also when `reflect` isn't in `SID_MODULES` or no cookie has `restore` (then at the configured or default name).
- **Attributes:** the worker can't see a cookie's original attributes. If they differ (for example the original is host-only and `domain` is set), the browser keeps two cookies of that name. Configuration SHOULD match the original's `Domain` and `HttpOnly`.
- Its `routes` are `v1` and `sync`: Prebid.js's `/sync` call on page views reflects, saves and restores cookies without the page calling `/v1`, as often as the sync response's browser cache allows (see [Modules on `/sync`](../SPEC.md#modules-on-sync)).
