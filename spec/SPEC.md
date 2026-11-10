# SharedID Edge specification, v1

This is the contract every SharedID Edge implementation follows. The conformance suite in [`../conformance`](../conformance) tests it over HTTP; an implementation that passes the suite conforms. Where this document and the suite disagree, fix one of them.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Scope

An implementation runs on the publisher's own domain (normally a route on the CDN that serves the site) and:

- sets and refreshes the SharedID first-party identifier as a **server-set cookie**, compatible with Prebid.js's unmodified `sharedIdSystem` module through its `pixelUrl` parameter;
- returns a JSON payload of the SharedID and the output of **modules**, which add IDs or signals from what the worker already has.

It never forwards requests to the publisher's origin and never adds `Set-Cookie` to cacheable responses.

## Configuration

Implementations read these settings, normally as environment variables. Defaults are in brackets.

| Setting | | |
| --- | --- | --- |
| `SID_BASE_PATH` | [`/_sid`] | Path prefix for all routes. |
| `SID_COOKIE_NAME` | [`_pubcid`] | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | [host-only] | `Domain` attribute, e.g. `.example.com`. |
| `SID_MAX_AGE_DAYS` | [`365`] | Cookie lifetime in days, 1 to 400. |
| `SID_CREATE` | [`true`] | Mint an ID when the request has none. |
| `SID_RECOVERY_COOKIE` | [`_pubcid_sv`] | Name of the `HttpOnly` recovery copy; `none` disables it. |
| `SID_OPTOUT_COOKIE` | [`_pubcid_optout`] | Opt-out cookie, also read by Prebid.js. |
| `SID_VENDOR_ID` | [publisher mode] | The publisher's own TCF vendor ID (1 to 65535), for vendor mode; see [Consent](#consent). |
| `SID_ALLOWED_ORIGINS` | [none] | Comma-separated origins allowed to read `/v1` with credentials. |
| `SID_SYNC_CACHE_SECONDS` | [`86400`] | Private browser cache lifetime of a successful sync response. |
| `SID_MODULES` | [none] | Comma-separated module names to run for `/v1`, in order. |
| `SID_MODULE_CONFIG` | [`{}`] | JSON object of per-module settings, keyed by module name. |
| `SID_MODULE_TIMEOUT_MS` | [`50`] | Time limit for each module. |

The three cookie names (`SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE`, `SID_OPTOUT_COOKIE`) MUST all differ. Invalid configuration MUST fail every request with a 5xx rather than set cookies.

## Routes

All routes are under `SID_BASE_PATH`; a trailing slash is accepted. Any other path MUST get `404`. Methods other than `GET` and `HEAD` (and `OPTIONS` on `/v1`) MUST get `405` with an `Allow` header.

| Route | Response |
| --- | --- |
| `GET /sync?id=pubcid:<id>` | `200`, the 43-byte 1×1 GIF (`Content-Type: image/gif`), with the ID cookies. |
| `GET /v1` | `200`, JSON payload v1, with the ID cookies. |
| `GET /optout` | `204`. Sets the opt-out cookie (`1`, script-readable, `SID_MAX_AGE_DAYS`) and expires the ID cookies. |
| `GET /optin` | `204`. Expires the opt-out cookie. |

Every response carries `Cache-Control`: `no-store`, except a successful sync that set an ID, which MAY be `private, max-age=SID_SYNC_CACHE_SECONDS` so a browser doesn't re-sync on every page view.

### The `id` parameter

Prebid.js's `sharedIdSystem` calls `pixelUrl` with `id=pubcid:<id>`, percent-encoding the value before building the URL, so it arrives as `pubcid%253A<id>` (or `pubcid%3A<id>`). Implementations MUST accept the value after up to three rounds of percent-decoding, and MUST ignore it without the `pubcid:` prefix.

## The ID

A valid ID matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Minted IDs are random UUID v4s, never derived from the IP address or other request data.

For `/sync` and `/v1`, when storage is allowed, the ID is the first of:

1. the **recovery cookie**, if valid. Only the worker writes it, so when it differs from the script-readable cookie, that cookie was capped or cleared and re-minted by the page, and the original is restored;
2. the **SharedID cookie**, if valid. This adopts existing IDs when the worker is first deployed, so nobody's ID is reset;
3. the **`id` parameter** (`/sync` only), if valid. On a first visit Prebid.js calls `pixelUrl` before writing its own cookie;
4. a **new ID**, if `SID_CREATE` is true.

## Cookies

When an ID is chosen, the response sets:

- `SID_COOKIE_NAME=<id>; Max-Age=<SID_MAX_AGE_DAYS × 86400>; Expires=<…>; Path=/; [Domain=…;] SameSite=Lax; Secure` — not `HttpOnly`, because Prebid.js reads it;
- unless disabled, `SID_RECOVERY_COOKIE=<id>` with the same attributes plus `HttpOnly`.

`Secure` is set on https requests. Over plain http (local development only) it MUST be omitted, or browsers drop the cookie.

When storage isn't allowed, no ID cookie is set and existing ID cookies MUST be deleted: each is overwritten with an empty value, `Max-Age=0` and `Expires=Thu, 01 Jan 1970 00:00:00 GMT`, with the same `Path` and `Domain` it was set with. With `SID_COOKIE_DOMAIN`, a host-only copy (no `Domain`) is deleted too, since Prebid.js may have written one.

## Opt-out and consent

Storage is **not allowed** when, in this order:

1. the opt-out cookie is present (reason `opt-out`);
2. the request has `Sec-GPC: 1`, Global Privacy Control (reason `gpc`), or is subject to COPPA, signalled by the query parameter `coppa=1` as in OpenRTB `regs.coppa` (reason `coppa`);
3. there is a TC string and it doesn't give the consent below (reason `tcf: …`);
4. GDPR applies and there is no TC string (reason `tcf: GDPR applies and there is no TC string`): that counts as no consent.

When storage isn't allowed, existing ID cookies are deleted (see [Cookies](#cookies)).

### Consent

- **GDPR applies** when the `gdpr` query parameter is `1`, or when it's absent and the platform reports an EU location (on Cloudflare, `request.cf.isEUCountry`). `gdpr=0` means it doesn't apply. With no TC string and no signal, it's unknown, and storage is allowed.
- **The TC string** comes from the `gdpr_consent` query parameter, else the CMP's `euconsent-v2` cookie. When there is one, it is checked whatever `gdpr` says. A string that isn't a valid TCF v2 TC string denies storage (reason `tcf: invalid TC string`).
- **Publisher mode** (the default, `SID_VENDOR_ID` unset). SharedID is the publisher's own first-party ID, so the TC string's **publisher TC segment** (segment type 3) MUST have consent for Purpose 1 (store and access information on a device), and consent or legitimate interest for at least one of Purposes 2 to 10. Reasons: `tcf: no publisher TC segment`, `tcf: no publisher consent for purpose 1`, `tcf: no publisher consent or legitimate interest for any of purposes 2-10`.
- **Vendor mode** (`SID_VENDOR_ID` set, for a publisher registered as a TCF vendor). The core segment's vendor consents MUST include that vendor ID, its purpose consents MUST include Purpose 1, and its purpose consents or purpose legitimate interests MUST include at least one of Purposes 2 to 10. The publisher TC segment isn't used. Reasons: `tcf: no consent for vendor <id>`, `tcf: no vendor consent for purpose 1`, `tcf: no vendor consent or legitimate interest for any of purposes 2-10`.
- Purpose 1 always needs consent; legitimate interest isn't a legal basis for it.
- Implementations need only decode the core segment's version (must be 2), purpose consents (bits 152 to 175), purpose legitimate interests (176 to 199) and vendor consent section (from bit 213, bit field or range encoded), and the publisher TC segment's purpose consents (bits 3 to 26) and legitimate interests (27 to 50).
- `us_privacy`, `gpp`, `gpp_sid` and `coppa` query parameters are read and passed to modules. Modules MUST treat `coppa=1` like GPC.

A response where storage was denied SHOULD carry `X-SharedID-Status: denied: <reason>`. A response that set an ID SHOULD carry `X-SharedID-Source: cookie|recovery|param|minted`.

## Payload v1

`GET /v1` returns `Content-Type: application/json; charset=utf-8`:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "geo": { "country": "USA" } } },
  "ext": { "modules": { "geo": { "ms": 1, "status": "ok" } } }
}
```

- `sharedid` and its `pubcid.org` eid are present only when storage is allowed and an ID was chosen.
- `eids` follows OpenRTB `user.ext.eids`. Module eids follow the SharedID's, in module order.
- `ortb2` is the deep merge of the modules' OpenRTB fragments, in module order; absent when no module returned one.
- `ext.modules` reports each configured module: `status` is `ok`, `empty`, `skipped` (with a `reason`), `error` or `timeout`. Error details MUST NOT be returned, since they may contain request data.

### CORS

When the `Origin` header is in `SID_ALLOWED_ORIGINS`, `/v1` responses carry `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`, and a preflight (`OPTIONS`) gets `204` with `Access-Control-Allow-Methods: GET, HEAD`. Other origins get no CORS headers. Responses always carry `Vary: Origin`. Implementations MUST NOT send `Access-Control-Allow-Origin: *`.

## Modules

A module has:

- a `name` (`^[a-z][a-z0-9-]{0,63}$`), used in `SID_MODULES` and `SID_MODULE_CONFIG`;
- optionally `purposes` (TCF purposes it needs publisher consent for when GDPR applies) and `gvlid` (its IAB vendor ID);
- a `run(context)` function returning `{ eids?, ortb2? }` or nothing.

The context has the request, its URL, the platform information (client IP, country, region, EU flag), the SharedID (when storage is allowed), the consent signals, and the module's configuration.

Modules work only from what the worker has; by default they make no network calls. The worker:

- runs the modules listed in `SID_MODULES`, in order, reporting unknown names as `skipped`;
- when GDPR applies, skips a module whose `purposes` don't all have publisher consent, and (until vendor consent is decoded) any module with a `gvlid`;
- stops waiting for a module after `SID_MODULE_TIMEOUT_MS`;
- isolates failures: a module that throws or times out is reported and left out, and the rest of the payload is returned.

Modules run on `/v1` only; `/sync` is unchanged by them.

### The `ip` module

Name `ip`; no `purposes`, no `gvlid`, no settings. It runs only when listed in `SID_MODULES`.

- It returns the platform's full client IP address as `ortb2.device.ip` (IPv4) or `ortb2.device.ipv6` (IPv6). An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is IPv4. IPv6 is written in RFC 5952 form.
- It returns **nothing** (status `empty`) when:
  - the request has `Sec-GPC: 1`, or `coppa=1`;
  - the `us_privacy` string opts out of sale (its third character is `Y`);
  - there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data);
  - GDPR applies and there is no TC string;
  - the platform has no client IP, or it isn't a valid address.
- It MUST NOT return a truncated address: a truncated address looks real but is wrong, which is worse than none.
- The address MUST NOT be stored, logged or used to derive an ID.

## Versioning

The payload carries `v`, and the route is versioned (`/v1`). Changes that would break a consumer of v1 get a new version and route.
