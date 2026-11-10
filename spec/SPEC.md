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
| `SID_SKIP_BOTS` | [off] | `verified`, `declared` or `likely`: set no SharedID for bots this sure or surer; see [Skipping bots](#skipping-bots). |
| `SID_SKIP_BOTS_SCORE` | [off] | 1 to 99: set no SharedID when the traffic score is at or below it; see [Skipping bots](#skipping-bots). |

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

A response where storage was denied SHOULD carry `X-SharedID-Status: denied: <reason>`, and one where [`SID_SKIP_BOTS`](#skipping-bots) ruled the ID out `X-SharedID-Status: skipped: bot`. A response that set an ID SHOULD carry `X-SharedID-Source: cookie|recovery|param|minted`.

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
- `ortb2` is the deep merge of the modules' OpenRTB fragments, in module order, plus the [traffic signal](#traffic-signal) as `ortb2.device.ext.traffic`; absent when there's neither.
- `ext.modules` reports each configured module: `status` is `ok`, `empty`, `skipped` (with a `reason`), `error` or `timeout`. Error details MUST NOT be returned, since they may contain request data.

### Traffic signal

`ortb2.device.ext.traffic` describes the traffic: whether it comes from a bot, through what kind of proxy, and whether it's the site's own staff. Several sources report to it: modules (the [`bot` module](#the-bot-module), and others such as user agent or IP intelligence modules) and the platform itself (its [traffic verdict](#platform-traffic-verdict)). The implementation merges their reports; no source writes the field directly.

```json
{ "bot": true, "botKind": "declared", "proxy": "datacenter", "score": 12, "internal": false, "sources": ["platform", "ua"] }
```

| Field | |
| --- | --- |
| `bot` | Boolean: the request comes from a bot. |
| `botKind` | How sure: `verified` (a known good bot the platform verified, such as a search crawler), `declared` (a crawler that names itself in its user agent) or `likely` (a heuristic or a score). A report with a `botKind` is a bot. |
| `proxy` | `datacenter` (a hosting address), `vpn`, `residential` (a residential proxy), `tor` (a Tor exit), or `relay`: a known service carrying people's traffic, such as iCloud Private Relay and other privacy relays, or a verified corporate proxy. |
| `score` | Human-likelihood, an integer from 1 (almost certainly a bot) to 99 (almost certainly human), on Cloudflare Bot Management's scale. |
| `internal` | Boolean: the visitor marked themselves as the site's own staff. |
| `sources` | The sources that reported anything, in order: `platform` first, then module names in `SID_MODULES` order, each once. |

**Merging.** Each source's report has any of the fields above except `sources`, which the implementation sets. Reports with no fields are ignored. The merge is most cautious first:

- `bot` is `true` if any report says `true`, else `false` if any says `false`, else absent;
- `botKind` keeps the strongest claim: `verified`, then `declared`, then `likely`;
- `proxy` keeps the most specific value, in this order: `tor`, `residential`, `relay`, `vpn`, `datacenter`. A data centre is the least specific, since VPNs and relays also use hosting addresses; a source that knows the address is a relay wins over one that only sees a data centre;
- `score` keeps the minimum;
- `internal` is `true` if any report says `true`, else `false` if any says `false`, else absent;
- `sources` is the ordered union.

A relay MUST NOT make the request a bot: `proxy` never sets `bot`. Fields are written in the order of the table. The field is absent when no source reported anything.

**Module reports.** A module reports with `traffic` in its result. A module's own `ortb2.device.ext.traffic` is not merged into the payload as is: it's read as that module's report, like `traffic`, so the merged value is always the implementation's. A report with a field of the wrong type or value (a `botKind`, `proxy` or `score` outside the lists above, or `bot: false` with a `botKind`) makes the module an `error`, and none of its output is used. A module whose only output is a traffic report with at least one field reports `ok`.

**Consent.** The traffic signal describes the traffic, not the person, and helps pages and bidders avoid invalid traffic. It MUST be returned whatever the consent signals say: with GPC, COPPA, opt-out, a US privacy opt-out or denied TCF consent. It MUST NOT be stored or logged.

### Skipping bots

`SID_SKIP_BOTS` and `SID_SKIP_BOTS_SCORE` are off by default. When storage is allowed and the merged traffic signal qualifies, the response sets no ID cookie and returns no `sharedid` or `pubcid.org` eid, and carries `X-SharedID-Status: skipped: bot` (and no `X-SharedID-Source`). The signal qualifies when:

- `SID_SKIP_BOTS` is set and `bot` is `true` with a `botKind` that sure or surer: `verified` skips verified bots only, `declared` verified and declared bots, `likely` every bot. A bot without a `botKind` counts as `likely`;
- or `SID_SKIP_BOTS_SCORE` is set and `score` is at or below it.

`internal` and `proxy` never qualify. Skipping MUST NOT delete existing ID cookies, so a misclassified visitor keeps their ID; they're neither refreshed nor restored either. Consent decides first: when storage isn't allowed, the response is as in [Opt-out and consent](#opt-out-and-consent), with its `denied` status. Other modules' output and cookies follow their own rules.

The verdict is the merged signal of the platform and the modules that run on the route: on `/v1`, the platform and the modules in `SID_MODULES`; on `/sync`, where modules don't run, the platform alone. When the platform's verdict alone qualifies, modules get no SharedID in their context; when a module's report makes it qualify, modules have already run with it, but it's still neither set nor returned.

### CORS

When the `Origin` header is in `SID_ALLOWED_ORIGINS`, `/v1` responses carry `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`, and a preflight (`OPTIONS`) gets `204` with `Access-Control-Allow-Methods: GET, HEAD`. Other origins get no CORS headers. Responses always carry `Vary: Origin`. Implementations MUST NOT send `Access-Control-Allow-Origin: *`.

## Modules

A module has:

- a `name` (`^[a-z][a-z0-9-]{0,63}$`), used in `SID_MODULES` and `SID_MODULE_CONFIG`;
- optionally `purposes` (TCF purposes it needs publisher consent for when GDPR applies) and `gvlid` (its IAB vendor ID);
- a `run(context)` function returning `{ eids?, ortb2?, cookies?, traffic? }` or nothing (`traffic`: see [Traffic signal](#traffic-signal)).

The context has the request, its URL and cookies, the platform information (see [Platform information](#platform-information)), the SharedID (when storage is allowed), whether the browser opted out, the consent signals, and the module's configuration and secrets.

The context also has the worker's **storage decision** for the request, `storage`: `{ allowed: true }`, or `{ allowed: false, reason }` with the same reason as `X-SharedID-Status` (`opt-out`, `gpc`, `coppa` or `tcf: …`; see [Opt-out and consent](#opt-out-and-consent)). A module that stores or extends an identifier SHOULD do so only when `storage.allowed` is true.

A module's `cookies` are set on the `/v1` response with `Path=/`, `SameSite=Lax`, `Secure` over https, the module's `Domain` (else `SID_COOKIE_DOMAIN`), `Max-Age` (0 deletes) and `HttpOnly` as given. A module MUST NOT set the worker's own cookie names; a malformed or reserved cookie makes the module an `error`, and none of its output is used. A module that returns only cookies reports `empty`.

A module that sets cookies SHOULD also declare the deletions for opt-out. `{basePath}/optout` deletes the ones the browser sent along with the ID cookies, for every installed module (whether or not it's in `SID_MODULES`), so an opt-out takes effect at once and not only on the next `/v1` call.

Modules work only from what the worker has; by default they make no network calls. The worker:

- runs the modules listed in `SID_MODULES`, in order, reporting unknown names as `skipped`;
- when GDPR applies, skips a module whose `purposes` don't all have publisher consent, and (until vendor consent is decoded) any module with a `gvlid`;
- stops waiting for a module after `SID_MODULE_TIMEOUT_MS`;
- isolates failures: a module that throws or times out is reported and left out, and the rest of the payload is returned.

Modules run on `/v1` only; `/sync` is unchanged by them.

### Platform information

Each platform adapter fills the platform information from values the platform itself sets, which visitors can't forge: on Cloudflare `CF-Connecting-IP` and `request.cf`; behind CloudFront the `CloudFront-Viewer-Address` (`ip:port`), `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` headers, accepted only when the origin can be reached through CloudFront alone. A value the platform doesn't provide is left out, never guessed. The EU flag means the country is one of the 27 EU member states (the meaning of Cloudflare's `isEUCountry`), and is unknown when the country is.

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
- The passphrase is `SID_MODULE_SECRETS.ec.passphrase`, at least 32 bytes; otherwise the module is an `error`. Withdrawal (below) doesn’t depend on it: an existing `ts-ec` MUST still be deleted when the passphrase is missing or short.
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

### Platform traffic verdict

The platform information MAY carry the platform's own traffic verdict, a report with the fields of the [traffic signal](#traffic-signal) (without `sources`). It's merged first, as source `platform`, on every route, whether or not any module runs, and so it's in the payload even with no modules; a verdict that isn't valid is ignored. Platforms add only what they themselves determined, never a guess:

| Cloudflare `request.cf.botManagement` (Bot Management, an Enterprise add-on) | Report |
| --- | --- |
| `verifiedBot: true` | `bot: true`, `botKind: verified` |
| `score`, an integer from 1 to 99 | `score` (other values, including 0, are left out) |
| `corporateProxy: true` | `proxy: relay` |

Without Bot Management the object is absent, or has no score and false flags, and the platform adds nothing. `request.cf.verifiedBotCategory` isn't in the Workers runtime types, so it isn't read. Other platforms add nothing.

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

### The `reflect` module

Name `reflect`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`. It re-sets first-party cookies that other scripts on the page wrote, so they become server-set cookies with a new lifetime, as the worker does for the SharedID.

- **Settings,** `SID_MODULE_CONFIG.reflect`: `{ "cookies": [ … ], "keeper": { … } }`. `cookies` has 1 to 10 entries, each:
  - `name` (required): a cookie name (an RFC 6265 token, at most 64 characters). It MUST NOT be `_pubcid`, `_pubcid_sv`, `_pubcid_optout`, `ts-ec` or `euconsent-v2`, nor the worker's configured cookie names, and MUST NOT repeat;
  - `maxAgeDays` (required): an integer from 1 to 400;
  - `domain` (optional): a registrable domain without a leading dot, such as `example.com`; the cookie gets `Domain=.<domain>`. Without it, `SID_COOKIE_DOMAIN` applies, else the cookie is host-only;
  - `httpOnly` (optional, default `false`);
  - `deleteOnOptOut` (optional, default `false`);
  - `restore` (optional, default `false`): save the cookie in the keeper cookie and restore it from there (below).

  `keeper` (optional; its defaults apply when it's omitted) configures the keeper cookie:
  - `cookie` (default `_sid_keep`): a cookie name, with the same rules as `name`, and MUST NOT be one of the configured `cookies`;
  - `maxAgeDays` (default `400`): an integer from 1 to 400;
  - `domain` (optional): as for a cookie. Without it, the first `restore` cookie's `domain` applies; without that, `SID_COOKIE_DOMAIN`, else host-only.

  Any other key, a wrong type or an out-of-range value makes the module an `error` on every `/v1` call, with no details.
- **Reflection:** for each configured cookie the request carries, in configuration order, the module sets `<name>=<value>; Max-Age=<maxAgeDays × 86400>; Expires=…; Path=/; [Domain=.<domain>;] SameSite=Lax; [Secure;] [HttpOnly]`. The value MUST be the request's value byte for byte: not decoded, re-encoded, trimmed beyond the `Cookie` header's own whitespace, or otherwise changed. When the name repeats in the `Cookie` header, the first is used.
- A cookie is **not reflected** when its value is empty, longer than 1024 characters, quoted, or contains a character that isn't a cookie-octet (RFC 6265). The other cookies are still reflected.
- **The keeper cookie** holds the last known value of each `restore` cookie. Its value is the base64url encoding (RFC 4648 section 5, without padding) of a JSON object mapping cookie names to values, with keys in configuration order. It's set `HttpOnly`, with the keeper's `maxAgeDays` and `Domain`, and with `Path=/`, `SameSite=Lax` and `Secure` (over https) like the others. Its name and value together MUST NOT exceed 4096 bytes: entries are added in configuration order, and one that would take it over is left out (that cookie is still reflected) while later ones are still tried.
- **Reading the keeper:** its value is read byte for byte, like the other cookies. A value that isn't base64url without padding, isn't a JSON object, or is over 4096 characters counts as empty, and so does each entry whose value isn't a string that could be reflected. It's never an error.
- **Restoring,** on each `/v1` request where storage is allowed, for each `restore` cookie in configuration order:
  - the request carries it with a value that can be reflected: it's reflected, and that value is saved;
  - the request doesn't carry it, and the keeper has a value for it: it's **restored**, set with that value and its own configured attributes as if reflected, and the value stays saved;
  - the request carries it with a value that can't be reflected: it's left alone, and its saved value is dropped;
  - otherwise nothing is saved for it.

  The keeper is then set with the saved values on every such request, which refreshes its expiry. When nothing is left to save and the request carried a keeper, it's deleted. With no `restore` cookie configured, no keeper is set, and one the request carries is deleted.
- **Output:** cookies only, so the status is `empty`. Nothing is added to `eids` or `ortb2`, and neither names nor values are reported.
- **Consent:** the module reflects only when `storage.allowed` is true: not on opt-out, `Sec-GPC: 1`, `coppa=1`, a TC string that doesn't give the SharedID's consent, or GDPR applying without a TC string. It then reflects and restores nothing, and on `/v1` deletes none of the configured cookies, which belong to other scripts. It deletes the keeper cookie, this worker's own store of identifiers, when the request carries it.
- **Opt-out:** `{basePath}/optout` deletes a configured cookie the browser sent only when its `deleteOnOptOut` is `true`, with the configured `Domain` and `HttpOnly`. It always deletes the keeper cookie the browser sent, whatever `deleteOnOptOut` says, and also when `reflect` isn't in `SID_MODULES` or no cookie has `restore` (then at the configured or default name).
- **Attributes:** the worker can't see a cookie's original attributes. If they differ (for example the original is host-only and `domain` is set), the browser keeps two cookies of that name. Configuration SHOULD match the original's `Domain` and `HttpOnly`.
- It runs on `/v1` only, so cookies are reflected and restored only when the page calls `/v1`.

### The `bot` module

Name `bot`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, and reports to the [traffic signal](#traffic-signal) (status `ok` when it reports something, else `empty`). It doesn't repeat the [platform's verdict](#platform-traffic-verdict), which is merged on its own, and doesn't recognize crawlers by user agent.

- **Settings,** `SID_MODULE_CONFIG.bot`, both optional:
  - `missingHeaders` (boolean, default `false`): report `bot: true, botKind: likely` when the user agent claims to be a browser (it starts with `Mozilla/5.0 (`) and the request lacks headers browsers send:
    - an `Accept-Language` header that's missing or empty; or
    - all of `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, when the request URL is https (or the host is `localhost`, `127.0.0.1` or `[::1]`) and the user agent is a version that sends them: `Chrome/` 80 or later; else `Firefox/` 90 or later, but not `FxiOS/`; else `Version/` 17 or later followed by `Safari/`, but not with `CriOS`, `FxiOS`, `EdgiOS` or `Android`.
  - `internalCookie` (a cookie name): report `internal: true` when the request carries that cookie with a non-empty value.

  Any other key, or a wrong type, makes the module an `error`.
- **Secret,** `SID_MODULE_SECRETS.bot.internalToken` (optional, at least 16 characters): the internal cookie then counts only when its value is the token. Any other key, or a shorter token, makes the module an `error`.
- **Consent:** as for every traffic report, it runs and reports whatever the consent signals say.
- It MUST NOT store or log anything about the request.

## Versioning

The payload carries `v`, and the route is versioned (`/v1`). Changes that would break a consumer of v1 get a new version and route.
