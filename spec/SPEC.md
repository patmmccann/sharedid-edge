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
| `SID_MODULE_SECRETS` | [`{}`] | JSON object of per-module secrets (strings), keyed by module name. Set as a platform secret; MUST NOT appear in responses, errors or logs. |
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

A valid ID matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Minted IDs are random UUID v4s, never derived from the IP address or other request data. (The opt-in [`ec` module](#the-ec-module) sets a separate, IP-derived cookie; the SharedID is unaffected.)

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
  "ortb2": { "device": { "geo": { "type": 2, "country": "USA", "region": "TX" } } },
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
- a `run(context)` function returning `{ eids?, ortb2?, cookies? }` or nothing.

The context has the request, its URL and cookies, the platform information (see [Platform information](#platform-information)), the SharedID (when storage is allowed), whether the browser opted out, the consent signals, and the module's configuration and secrets.

A module's `cookies` are set on the `/v1` response with `Path=/`, `SameSite=Lax`, `Secure` over https, the module's `Domain` (else `SID_COOKIE_DOMAIN`), `Max-Age` (0 deletes) and `HttpOnly` as given. A module MUST NOT set the worker's own cookie names; a malformed or reserved cookie makes the module an `error`, and none of its output is used. A module that returns only cookies reports `empty`.

A module that sets cookies SHOULD also declare the deletions for opt-out. `{basePath}/optout` deletes the ones the browser sent along with the ID cookies, for every installed module (whether or not it's in `SID_MODULES`), so an opt-out takes effect at once and not only on the next `/v1` call.

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

### The `ec` module

Name `ec`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, and implements IAB Tech Lab [Trusted Server Edge Cookies](https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html).

- **The ID is derived from the client IP**, as Trusted Server specifies: `{HMAC-SHA256(passphrase, normalized IP), as 64 lowercase hex}.{6 random characters from A-Za-z0-9}`. Normalization: IPv4 in dotted decimal; IPv6 as its first four hextets, zero-padded lowercase hex without separators (`2001:db8:85a3::1` gives `20010db885a30000`). Clients behind the same IPv4 address or IPv6 /64 share the prefix.
- The passphrase is `SID_MODULE_SECRETS.ec.passphrase`, at least 32 bytes; otherwise the module is an `error`.
- **Cookie:** `ts-ec=<id>; Max-Age=31536000; Path=/; [Domain=.<domain>;] SameSite=Lax; Secure; HttpOnly`, with `domain` from `SID_MODULE_CONFIG.ec.domain`. An existing cookie with a valid format (`^[0-9a-f]{64}\.[A-Za-z0-9]{6}$`) is used as is and not refreshed; an invalid one is replaced.
- **Output:** the EC as `ortb2.user.id`.
- **Consent:**
  - opt-out, `Sec-GPC: 1`, `coppa=1`, a `us_privacy` opt-out of sale, or a TC string without consent for Purpose 1 (core segment) **withdraws**: an existing `ts-ec` is deleted and nothing is returned. `{basePath}/optout` deletes `ts-ec` too;
  - an undecodable TC string, or GDPR applying without a TC string, fails closed: nothing is set, returned or deleted.
- It runs on `/v1` only, so an EC is set only when the page calls `/v1`.

### Platform information

What the platform knows about the request beyond the request itself: the client IP, whether it comes from the EU (on Cloudflare, `request.cf.isEUCountry`), and its location. Every field is optional; a platform that doesn't know a value, or gets one that isn't valid, leaves it out. The location fields:

| Field | | Cloudflare `request.cf` | Visitor location header |
| --- | --- | --- | --- |
| country | ISO 3166-1 alpha-2, upper case; not `XX` (unknown) or `T1` (Tor) | `country` | `cf-ipcountry` |
| region | ISO 3166-2 subdivision code, with or without the country prefix | `regionCode` | `cf-region-code` |
| city | | `city` | `cf-ipcity` |
| postal code | | `postalCode` | `cf-postal-code` |
| metro code | Nielsen DMA code, digits | `metroCode` | `cf-metro-code` |
| latitude, longitude | finite numbers, in range; only as a pair | `latitude`, `longitude` | `cf-iplatitude`, `cf-iplongitude` |
| time zone | IANA name, e.g. `America/Chicago` | `timezone` | `cf-timezone` |
| continent | `AF`, `AN`, `AS`, `EU`, `NA`, `OC` or `SA` | `continent` | `cf-ipcontinent` |

An implementation behind Cloudflare that isn't a Worker (for example the Node.js server, with Cloudflare's "add visitor location headers" managed transform) reads the location from the headers in the last column **only** when configured to trust its proxy (`SID_TRUST_PROXY`), as it does for the client IP in `X-Forwarded-For`: otherwise the client can set them.

### The `geo` module

Name `geo`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`.

It returns the platform's location as the OpenRTB 2.6 `ortb2.device.geo` object:

| `device.geo` | From | |
| --- | --- | --- |
| `type` | | `2` (IP address), whenever any other field is present. |
| `country` | country | ISO 3166-1 **alpha-3** (`USA`), from a bundled table of every assigned code. Codes not in the table are left out. |
| `region` | region | The subdivision code without the country prefix (`US-TX` and `TX` are both `TX`), upper case. |
| `metro` | metro code | A string, as in OpenRTB. |
| `utcoffset` | time zone | The zone's offset from UTC in minutes at the time of the request, so it follows daylight saving time. Left out when the zone is unknown to the runtime. |
| `city` | city | Precise. |
| `zip` | postal code | Precise. |
| `lat`, `lon` | latitude, longitude | Precise; numbers. |

- **Coarse** fields (`type`, `country`, `region`, `metro`, `utcoffset`) are always returned when known.
- **Precise** fields (`city`, `zip`, `lat`, `lon`) are returned in full or not at all; they MUST NOT be rounded or truncated. They're left out under the same conditions as the `ip` module's address:
  - the request has `Sec-GPC: 1`, or `coppa=1`;
  - the `us_privacy` string opts out of sale (its third character is `Y`);
  - there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data);
  - GDPR applies and there is no TC string.
- **Setting:** `SID_MODULE_CONFIG={"geo":{"precision":"coarse"}}` returns only the coarse fields; `"precise"` is the default. Any other value of `precision`, or any other key, is a configuration mistake: the module fails (status `error`) on every request rather than guess.
- When there's no field to return, it returns nothing (status `empty`).
- The location MUST NOT be stored, logged or used to derive an ID.

## Versioning

The payload carries `v`, and the route is versioned (`/v1`). Changes that would break a consumer of v1 get a new version and route.
