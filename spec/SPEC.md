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

`SID_COOKIE_DOMAIN` has no default. Prebid.js's `sharedIdSystem` writes its cookie on the highest domain it can set one on (the registrable domain), so cookies from the worker must use the same `Domain`, or the browser holds two cookies of the same name and the page and the worker each see a different ID. A deployment without the setting MUST NOT set cookies: an implementation answers every request with a 500, or refuses to start, and logs the setting's name.

| Setting | | |
| --- | --- | --- |
| `SID_BASE_PATH` | [`/_sid`] | Path prefix for all routes. |
| `SID_COOKIE_NAME` | [`_pubcid`] | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes the SharedID cookie on, which is the `Domain` attribute: normally the registrable domain, `example.com`. `host-only` for no `Domain` attribute. |
| `SID_MAX_AGE_DAYS` | [`365`] | Cookie lifetime in days, 1 to 400. |
| `SID_CREATE` | [`true`] | Mint an ID when the request has none. |
| `SID_RECOVERY_COOKIE` | [`_pubcid_sv`] | Name of the `HttpOnly` recovery copy; `none` disables it. |
| `SID_OPTOUT_COOKIE` | [`_pubcid_optout`] | Opt-out cookie, also read by Prebid.js. |
| `SID_VENDOR_ID` | [publisher mode] | The publisher's own TCF vendor ID (1 to 65535), for vendor mode; see [Consent](#consent). |
| `SID_ALLOWED_ORIGINS` | [none] | Comma-separated origins allowed to read `/v1` with credentials. |
| `SID_SYNC_CACHE_SECONDS` | [`86400`] | Private browser cache lifetime of a successful sync response. |
| `SID_MODULES` | [none] | Comma-separated module names to run, in order; see [Modules](#modules). |
| `SID_SYNC_MODULES` | [the modules in `SID_MODULES` that run on `/sync`] | Comma-separated names of the modules to run on `/sync`, or `none`; see [Modules on `/sync`](#modules-on-sync). |
| `SID_MODULE_CONFIG` | [`{}`] | JSON object of per-module settings, keyed by module name. |
| `SID_MODULE_SECRETS` | [`{}`] | JSON object of per-module secrets (strings), keyed by module name. Set as a platform secret; MUST NOT appear in responses, errors or logs. |
| `SID_MODULE_TIMEOUT_MS` | [`50`] | Time limit for each module. |
| `SID_SKIP_BOTS` | [off] | `verified`, `declared` or `likely`: set no SharedID for bots this sure or surer; see [Skipping bots](#skipping-bots). |
| `SID_SKIP_BOTS_SCORE` | [off] | 1 to 99: set no SharedID when the traffic score is at or below it; see [Skipping bots](#skipping-bots). |
| `SID_HOSTS` | [one site] | JSON object from hostname to that site's settings, for several sites from one deployment; see [Several sites](#several-sites). |

The three cookie names (`SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE`, `SID_OPTOUT_COOKIE`) MUST all differ. Invalid configuration MUST fail every request with a 5xx rather than set cookies.

### Several sites

One deployment can serve several sites (a hosting company's, say) with `SID_HOSTS`: a JSON object whose keys are hostnames and whose values are objects of `SID_*` settings, which apply on top of the deployment's own for requests to that host. `SID_MODULE_CONFIG` may be an object; every other value is a string. `SID_HOSTS`, `SID_MODULE_SECRETS` and `SID_BASE_PATH` can't be set per host: the base path is what the platform routes by, which is the deployment's.

- The request's host is the hostname of its URL, lower-cased, without the port or a trailing dot. Keys are compared the same way; a key listed twice, or one that isn't a hostname, is invalid configuration.
- Each host's settings are validated as a deployment's are, at start-up: one invalid host fails the deployment. `SID_COOKIE_DOMAIN` is required of each host (set there, or inherited); the deployment's own settings needn't name one.
- With `SID_HOSTS` set (even to `{}`), a request for a host it doesn't list MUST get a 404 and no cookies, unless the platform supplies settings for that host. On Cloudflare for SaaS, a custom hostname's metadata can: the object under its `sharedid` key is that site's settings, applied like an entry of `SID_HOSTS` (which takes precedence). Invalid metadata fails that host's requests with a 5xx.
- Without `SID_HOSTS`, every request uses the deployment's settings, or the platform's for its host.

## Routes

All routes are under `SID_BASE_PATH`; a trailing slash is accepted. Any other path MUST get `404`. Methods other than `GET` and `HEAD` (and `OPTIONS` on `/v1`) MUST get `405` with an `Allow` header.

| Route | Response |
| --- | --- |
| `GET /sync?id=pubcid:<id>` | `200`, the 43-byte 1×1 GIF (`Content-Type: image/gif`), with the ID cookies and the cookies of the [modules that run on `/sync`](#modules-on-sync). |
| `GET /v1` | `200`, JSON payload v1, with the ID cookies. |
| `GET /optout` | `204`. Sets the opt-out cookie (`1`, script-readable, `SID_MAX_AGE_DAYS`) and expires the ID cookies. |
| `GET /optin` | `204`. Expires the opt-out cookie. |

Every response carries `Cache-Control`: `no-store`, except a successful sync that set an ID, which MAY be `private, max-age=SID_SYNC_CACHE_SECONDS` so a browser doesn't re-sync on every page view. Module cookies don't change this, but a module that ran on the sync can make it `no-store` (`noStore`); the cache also limits how often modules run on `/sync` (see [Modules on `/sync`](#modules-on-sync)).

### The `id` parameter

Prebid.js's `sharedIdSystem` calls `pixelUrl` with `id=pubcid:<id>`, percent-encoding the value before building the URL, so it arrives as `pubcid%253A<id>` (or `pubcid%3A<id>`). Implementations MUST accept the value after up to three rounds of percent-decoding, and MUST ignore it without the `pubcid:` prefix.

## The ID

A valid ID matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Minted IDs are random UUID v4s, never derived from the IP address or other request data. (Opt-in modules may set separate IP-derived IDs, such as the [`ec` module](modules/ec.md)'s cookie, and vendor modules that declare it; the SharedID is unaffected.)

For `/sync` and `/v1`, when storage is allowed, the ID is the first of:

1. the **recovery cookie**, if valid. Only the worker writes it, so when it differs from the script-readable cookie, that cookie was capped or cleared and re-minted by the page, and the original is restored;
2. the **SharedID cookie**, if valid. This adopts existing IDs when the worker is first deployed, so nobody's ID is reset;
3. the **`id` parameter** (`/sync` only), if valid. On a first visit Prebid.js calls `pixelUrl` before writing its own cookie;
4. a **new ID**, if `SID_CREATE` is true.

## Cookies

When an ID is chosen, the response sets:

- `SID_COOKIE_NAME=<id>; Max-Age=<SID_MAX_AGE_DAYS × 86400>; Expires=<…>; Path=/; [Domain=…;] SameSite=Lax; Secure` — not `HttpOnly`, because Prebid.js reads it;
- unless disabled, `SID_RECOVERY_COOKIE=<id>` with the same attributes plus `HttpOnly`.

**Duplicates.** A browser sends several cookies with the same name when they were set with different `Domain` attributes, such as a host-only `_pubcid` written before `SID_COOKIE_DOMAIN` was set (by Prebid.js, or by an implementation's earlier host-only default) next to the domain cookie. The `Cookie` header doesn't say which is which; browsers list cookies with the same path oldest first. The ID is chosen from the **first** value of each cookie. When `SID_COOKIE_DOMAIN` is a domain and the request carries more than one `SID_COOKIE_NAME` (or `SID_RECOVERY_COOKIE`) cookie, the response, besides setting the chosen ID on the domain, MUST delete the host-only copy of that cookie: an empty value, `Max-Age=0` and no `Domain` (keeping `HttpOnly` for the recovery copy). That deletion doesn't touch the domain cookie, so the browser is left with one.

`Secure` is set on https requests, and on plain http requests for a public hostname: a public site seen over http means TLS ended in front of the implementation (a proxy or load balancer), and the visitor is on https. It MUST be omitted only for plain http in local development, where browsers would drop a `Secure` cookie: the host is `localhost`, an IP address, or a name under a suffix reserved for local or private use (`.localhost`, `.test`, `.local`, `.internal`, `.example`, `.invalid`), ignoring a trailing dot (`app.test.` is local). This applies to module cookies too.

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

`ortb2.device.ext.traffic` describes the traffic: whether it comes from a bot, through what kind of proxy, and whether it's the site's own staff. Several sources report to it: modules (the [`bot` module](modules/bot.md), and others such as user agent or IP intelligence modules) and the platform itself (its [traffic verdict](#platform-traffic-verdict)). The implementation merges their reports; no source writes the field directly.

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

The verdict is the merged signal of the platform and the modules that run on the route: on `/v1`, the platform and the modules in `SID_MODULES`; on `/sync`, the platform and the [modules that run on `/sync`](#modules-on-sync), whose reports count only for this decision. When the platform's verdict alone qualifies, modules get no SharedID in their context; when a module's report makes it qualify, modules have already run with it, but it's still neither set nor returned.

### CORS

When the `Origin` header is in `SID_ALLOWED_ORIGINS`, `/v1` responses carry `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`, and a preflight (`OPTIONS`) gets `204` with `Access-Control-Allow-Methods: GET, HEAD`. Other origins get no CORS headers. Responses always carry `Vary: Origin`. Implementations MUST NOT send `Access-Control-Allow-Origin: *`.

## Modules

A module has:

- a `name` (`^[a-z][a-z0-9-]{0,63}$`), used in `SID_MODULES` and `SID_MODULE_CONFIG`;
- optionally `purposes` (TCF purposes it needs publisher consent for when GDPR applies) and `gvlid` (its IAB vendor ID);
- optionally `routes`, the routes it runs on: a non-empty list of `v1` and `sync` without repeats, defaulting to `v1` only (see [Modules on `/sync`](#modules-on-sync));
- a `run(context)` function returning `{ eids?, ortb2?, cookies?, traffic?, noStore? }` or nothing (`traffic`: see [Traffic signal](#traffic-signal); `noStore`: see [Modules on `/sync`](#modules-on-sync)).

The context has the request, its URL and cookies, the platform information (see [Platform information](#platform-information)), the SharedID (when storage is allowed), whether the browser opted out, the consent signals, and the module's configuration and secrets.

The context also has the worker's **storage decision** for the request, `storage`: `{ allowed: true }`, or `{ allowed: false, reason }` with the same reason as `X-SharedID-Status` (`opt-out`, `gpc`, `coppa` or `tcf: …`; see [Opt-out and consent](#opt-out-and-consent)). A module that stores or extends an identifier SHOULD do so only when `storage.allowed` is true.

A module's `cookies` are set on the response (of `/v1`, or `/sync`) with `Path=/`, `SameSite=Lax`, `Secure` as for the ID cookies (above), the module's `Domain` (else `SID_COOKIE_DOMAIN`; none when the module marks the cookie host-only), `Max-Age` (0 deletes) and `HttpOnly` as given. A module MUST NOT set the worker's own cookie names; a malformed or reserved cookie makes the module an `error`, and none of its output is used. A module that returns only cookies reports `empty`.

A module that sets cookies SHOULD also declare the deletions for opt-out. `{basePath}/optout` deletes the ones the browser sent along with the ID cookies, for every installed module (whether or not it's in `SID_MODULES`), so an opt-out takes effect at once and not only on the next `/v1` call.

Modules work only from what the worker has; by default they make no network calls. The worker:

- on `/v1`, runs the modules listed in `SID_MODULES`, in order, reporting unknown names, and modules whose `routes` leave out `v1`, as `skipped`;
- when GDPR applies, skips a module whose `purposes` don't all have publisher consent, and (until vendor consent is decoded) any module with a `gvlid`;
- stops waiting for a module after `SID_MODULE_TIMEOUT_MS`;
- isolates failures: a module that throws or times out is reported and left out, and the rest of the payload is returned.

### Modules on `/sync`

Prebid.js calls `/sync` (its `pixelUrl`) on page views without any page code, so modules that only maintain cookies, like [`reflect`](modules/reflect.md) and [`ec`](modules/ec.md), or report to the [traffic signal](#traffic-signal), like [`bot`](modules/bot.md), also run there. Modules that return data (`ip`, `geo`, `ua`) don't, since `/sync` returns an image.

- **Which modules:** without `SID_SYNC_MODULES`, every installed module in `SID_MODULES` whose `routes` include `sync`. With it, the modules it lists, which MUST all be in `SID_MODULES` (otherwise the configuration is invalid); `none` runs none. A listed module that isn't installed, or whose `routes` leave out `sync`, is reported `skipped` and doesn't run. Modules run in `SID_MODULES` order, whatever the order in `SID_SYNC_MODULES`.
- **The same context as on `/v1`:** the request, its cookies, the platform information, the SharedID, whether the browser opted out, the consent signals, the storage decision, and the module's configuration and secrets. Consent skips, the time limit and failure isolation work as on `/v1`.
- **Cookies and traffic reports only:** the cookies of each module that succeeded are set, after the same checks as on `/v1`, and its traffic report joins the platform's verdict for [Skipping bots](#skipping-bots); its `eids` and `ortb2` (apart from a traffic report in `ortb2.device.ext.traffic`) are ignored, and the merged signal isn't returned. A module that fails, times out or returns a bad cookie or report sets and reports nothing.
- **Otherwise the response is unchanged:** status `200`, the GIF, and the same headers and `Cache-Control`, plus the module cookies and, when any module was selected to run, `X-SharedID-Modules`: each module's name and status (as in `ext.modules`, without reasons), in order, such as `X-SharedID-Modules: reflect=empty, ec=ok, bot=empty`. It MUST NOT contain cookie names, values or error details.
- **Caching:** a successful sync that set an ID is still cached privately for `SID_SYNC_CACHE_SECONDS` (one day by default), so from `/sync` a browser runs these modules about once per cache lifetime at most. A response served from the browser's cache sets no cookies. A lower `SID_SYNC_CACHE_SECONDS` runs them more often, for more requests; `0` runs them on every call.
- **`noStore`:** a module whose result has `noStore: true` needs to see every sync (the [`clickid`](modules/clickid.md) module reads the landing page from the `Referer`, and a browser reuses a cached sync for any page). When a module that succeeded on `/sync` returns it, the response MUST be `Cache-Control: no-store`; its status, body and other headers are unchanged. It's ignored from a module that fails, times out or returns a bad cookie or report, and on other routes, whose responses are `no-store` already. A `noStore` that isn't a boolean makes the module an `error`.

### Platform information

Each platform adapter fills the platform information from values the platform itself sets, which visitors can't forge: on Cloudflare `CF-Connecting-IP` and `request.cf`; behind CloudFront the `CloudFront-Viewer-Address` (`ip:port`), `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` headers, accepted only when the origin can be reached through CloudFront alone. On Vercel, `x-real-ip` (else the first `x-forwarded-for` entry) and the `x-vercel-ip-*` geolocation headers, which Vercel's proxy sets and overwrites; they're trusted only on Vercel (the same code run elsewhere is configured to ignore them). Vercel reports no metro code. Behind Azure Front Door, `X-Azure-ClientIP`, and the location from headers a Front Door rule overwrites on every request (Front Door's `{geo_country}`; it has no other location data), accepted only when the function app can be reached through that Front Door profile alone (its `X-Azure-FDID`). An adapter whose platform changes cookie values in transit (Azure Functions percent-encodes some of them) leaves out a cookie it can't set unchanged, rather than set a different value. Behind Google Cloud's external Application Load Balancer, the `X-Forwarded-For` entry the load balancer appends for the client (the second-to-last; the first is the visitor's own), and the location from the backend service's custom request headers (`{client_region}`, `{client_region_subdivision}`, `{client_city}`, `{client_city_lat_long}`), which overwrite a visitor's copies; accepted only when the function can be reached through the load balancer alone (ingress). It has no metro code, postal code or time zone. The Node.js server, with its proxy trusted, takes the client IP from the first `X-Forwarded-For` entry, or from the client-IP header it's configured with (the proxy's own, such as `CloudFront-Viewer-Address` as `ip:port`, `Fastly-Client-IP` or `True-Client-IP`, for a proxy that appends to `X-Forwarded-For`; no client IP when that header is missing or isn't an IP address), and the location from Cloudflare's visitor location headers or the headers it's configured with, all of which only that proxy may set. A value the platform doesn't provide is left out, never guessed. The EU flag means the country is one of the 27 EU member states (the meaning of Cloudflare's `isEUCountry`), and is unknown when the country is.

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

### Module specifications

Each module's behaviour is specified in its own file under [`modules/`](modules), named after the module:

<!-- generated:spec-modules:start -->
- [The `bot` module](modules/bot.md)
- [The `clickid` module](modules/clickid.md)
- [The `dbip` module](modules/dbip.md)
- [The `ec` module](modules/ec.md)
- [The `geo` module](modules/geo.md)
- [The `ip` module](modules/ip.md)
- [The `maxmind` module](modules/maxmind.md)
- [The `reflect` module](modules/reflect.md)
- [The `ua` module](modules/ua.md)
<!-- generated:spec-modules:end -->

## Versioning

The payload carries `v`, and the route is versioned (`/v1`). Changes that would break a consumer of v1 get a new version and route.
