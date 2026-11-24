# SharedID Edge specification, v1

This is the contract every SharedID Edge implementation follows. The conformance suite in [`../conformance`](../conformance) tests it over HTTP; an implementation that passes the suite conforms. Where this document and the suite disagree, fix one of them.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Scope

An implementation runs on the publisher's own domain (normally a route on the CDN that serves the site) and:

- sets and refreshes the SharedID first-party identifier as a **server-set cookie**, compatible with Prebid.js's unmodified `sharedIdSystem` module through its `pixelUrl` parameter;
- returns a JSON payload of the SharedID and the output of **modules**, which add IDs or signals from what the worker already has.

It never forwards requests to the publisher's origin and never adds `Set-Cookie` to cacheable responses. It sends nothing to any other host either, except through an opt-in [forwarding module](#forwarding-modules), and then only to the hosts that module declares.

## Configuration

Implementations read these settings, normally as environment variables. Defaults are in brackets.

`SID_COOKIE_DOMAIN` has no default. Prebid.js's `sharedIdSystem` writes its cookie on the highest domain it can set one on (the registrable domain), so cookies from the worker must use the same `Domain`, or the browser holds two cookies of the same name and the page and the worker each see a different ID. A deployment without the setting MUST NOT set cookies: an implementation answers every request with a 500, or refuses to start, and logs the setting's name.

| Setting | | |
| --- | --- | --- |
| `SID_BASE_PATH` | [`/_sid`] | Path prefix for all routes. |
| `SID_COOKIE_NAME` | [`_pubcid`] | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes the SharedID cookie on, which is the `Domain` attribute: normally the registrable domain, `example.com`. `host-only` for no `Domain` attribute. `auto` for the domain Prebid.js reports per request; see [Cookie domain `auto`](#cookie-domain-auto). |
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
| `SID_UPSTREAM_SECRETS` | [off] | JSON array of shared secrets that turns on [trusted-upstream mode](#trusted-upstream). Set as a platform secret; MUST NOT appear in responses, errors or logs. |
| `SID_UPSTREAM_AUTH_HEADER` | [`x-sid-upstream-auth`] | The request header carrying the secret. |
| `SID_UPSTREAM_HOST_HEADER` | [`x-forwarded-host`] | The request header carrying the site's hostname. |
| `SID_CLIENT_IP_HEADER` | [none] | The request header carrying the visitor's IP address. |
| `SID_LOCATION_HEADERS` | [none] | JSON object from location field to the request header carrying it; MUST name `country` in trusted-upstream mode. |

The three cookie names (`SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE`, `SID_OPTOUT_COOKIE`) MUST all differ. Invalid configuration MUST fail every request with a 5xx rather than set cookies.

### Several sites

One deployment can serve several sites (a hosting company's, say) with `SID_HOSTS`: a JSON object whose keys are hostnames and whose values are objects of `SID_*` settings, which apply on top of the deployment's own for requests to that host. `SID_MODULE_CONFIG` may be an object; every other value is a string. `SID_HOSTS`, `SID_MODULE_SECRETS` and `SID_BASE_PATH` can't be set per host: the base path is what the platform routes by, which is the deployment's.

- The request's host is the hostname of its URL, lower-cased, without the port or a trailing dot. Keys are compared the same way; a key listed twice, or one that isn't a hostname, is invalid configuration.
- Each host's settings are validated as a deployment's are, at start-up: one invalid host fails the deployment. `SID_COOKIE_DOMAIN` is required of each host (set there, or inherited); the deployment's own settings needn't name one.
- With `SID_HOSTS` set (even to `{}`), a request for a host it doesn't list MUST get a 404 and no cookies, unless the platform supplies settings for that host. On Cloudflare for SaaS, a custom hostname's metadata can: the object under its `sharedid` key is that site's settings, applied like an entry of `SID_HOSTS` (which takes precedence). Invalid metadata fails that host's requests with a 5xx.
- Without `SID_HOSTS`, every request uses the deployment's settings, or the platform's for its host.

### Trusted upstream

An endpoint can sit behind a CDN it doesn't run: an upstream operator's endpoint, say, which each publisher's CDN passes `/_sid/*` to on the publisher's own hostname. There the platform's own client IP and location (`CF-Connecting-IP`, `request.cf`, `CloudFront-Viewer-*`) describe the publisher's CDN, not the visitor, and the request's URL has the endpoint's hostname, not the site's. Trusted-upstream mode, on when `SID_UPSTREAM_SECRETS` is set, takes all three from headers the publisher's CDN sets, and only from requests that carry a shared secret.

- **Authentication.** `SID_UPSTREAM_SECRETS` is a JSON array of one or more secrets, each 32 to 256 characters from `A-Z a-z 0-9 - . _ ~ + / =`. A request is authenticated when the `SID_UPSTREAM_AUTH_HEADER` header is exactly one of them, compared in time that doesn't depend on where it differs. A repeated header doesn't match. Every other request MUST get a `403` with no cookies and nothing from the request in the body or logs, whatever its path or host.
- **Platform information** of an authenticated request comes from its headers only: the client IP from `SID_CLIENT_IP_HEADER` (a single IPv4 or IPv6 address; none when it's missing or anything else, and none when the setting is unset), and the location from the headers `SID_LOCATION_HEADERS` names, validated like any platform's, with the EU flag from the country. The platform's own client IP, location and traffic verdict are not used.
- **The site.** The `SID_UPSTREAM_HOST_HEADER` header of an authenticated request becomes the request URL's host, before the configuration is chosen ([Several sites](#several-sites)) and before `Secure` is decided ([Cookies](#cookies)). It MUST be one hostname, optionally with a port, which is dropped; anything else (a list, an IPv6 literal, an invalid name) gets a `400` with no cookies. Without the header the URL keeps its host.
- **The auth header is removed** from the request before modules see it.
- **Configuration.** The header names MUST all differ and start with `x-`, and none may be `x-forwarded-for`, so none can be a header the endpoint's own platform sets. `SID_LOCATION_HEADERS` MUST name the `country` header, which decides whether GDPR applies. `SID_UPSTREAM_AUTH_HEADER`, `SID_UPSTREAM_HOST_HEADER`, `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` without `SID_UPSTREAM_SECRETS` are invalid (an implementation that trusts a proxy without a secret, like the Node.js server's `SID_TRUST_PROXY`, may read the last two then). None of them can be set per host.
- **Without it,** forwarded headers are never trusted for the client IP, location or host, except by an implementation's own documented proxy trust.
- **Where it isn't supported** (a platform without secrets, such as a Cloudflare Snippet, or an adapter that doesn't implement it), setting `SID_UPSTREAM_SECRETS`, `SID_UPSTREAM_AUTH_HEADER` or `SID_UPSTREAM_HOST_HEADER` is invalid configuration, never ignored.

## Routes

All routes are under `SID_BASE_PATH`; a trailing slash is accepted. Any other path MUST get `404`, unless a [forwarding module](#forwarding-modules) in `SID_MODULES` owns it. Methods other than `GET` and `HEAD` (and `OPTIONS` on `/v1`) MUST get `405` with an `Allow` header. `/sync` and `/v1` have [request limits](#request-limits) and may be [rate limited](#rate-limiting).

| Route | Response |
| --- | --- |
| `GET /sync?id=pubcid:<id>` | `200`, the 43-byte 1×1 GIF (`Content-Type: image/gif`), with the ID cookies and the cookies of the [modules that run on `/sync`](#modules-on-sync). |
| `GET /v1` | `200`, JSON payload v1, with the ID cookies. |
| `GET /optout` | `204`. Sets the opt-out cookie (`1`, script-readable, `SID_MAX_AGE_DAYS`) and expires the ID cookies. |
| `GET /optin` | `204`. Expires the opt-out cookie. |

Every response carries `Cache-Control`: `no-store`, except a successful sync that set an ID, which MAY be `private, max-age=SID_SYNC_CACHE_SECONDS` so a browser doesn't re-sync on every page view. Module cookies don't change this, but a module that ran on the sync can make it `no-store` (`noStore`); the cache also limits how often modules run on `/sync` (see [Modules on `/sync`](#modules-on-sync)).

### Request limits

No route takes a request body: implementations MUST NOT read one (an adapter that copies a request leaves it out), so a large body costs nothing before its `405`. The one exception is a `POST` to a [forwarding module](#forwarding-modules)'s path, within the limits given there.

On `/sync` and `/v1`, after the route and method checks and before consent is read, an ID is chosen or any module runs:

- a request whose path and query are longer than **8192 bytes** MUST get `414`;
- one whose `Cookie` header is longer than **16384 bytes** MUST get `431`. A platform or server whose own header limit is lower refuses it first (the Node.js server allows 16 KB for all headers together), with its own response.

Each has no cookies, `Cache-Control: no-store` and nothing from the request in the body. Prebid.js's requests are far smaller; the limits bound the work a crafted request can cause. `/optout` and `/optin` are never refused for size, so opting out always works.

### Rate limiting

Rate limiting belongs to the platform, in front of the worker, which keeps no state of its own. An implementation MAY also offer an opt-in rate limiter wired to a platform's counter (the Cloudflare Worker's rate limiting bindings), asked after the request limits about each request to `/sync` and `/v1` with the site's hostname (the forwarded one in [trusted-upstream mode](#trusted-upstream)) and the client IP from the platform information. When it refuses one:

- the response is `429` with no cookies, `Cache-Control: no-store` and nothing from the request in the body, and no module runs;
- `/optout` and `/optin`, preflights and other methods are never asked about, so opting out always works;
- a limiter that fails lets the request through.

Counters are kept by the platform, for the limiter's window only; the worker logs and keeps nothing.

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

When storage isn't allowed, no ID cookie is set and existing ID cookies MUST be deleted: each is overwritten with an empty value, `Max-Age=0` and `Expires=Thu, 01 Jan 1970 00:00:00 GMT`, with the same `Path` and `Domain` it was set with. With `SID_COOKIE_DOMAIN`, a host-only copy (no `Domain`) is deleted too, since Prebid.js may have written one. With `auto`, they're deleted on every domain they could be on (below).

### Cookie domain `auto`

`SID_COOKIE_DOMAIN=auto` takes the domain from Prebid.js, for a deployment serving many sites (one Worker on many routes, a hosting company, an upstream operator) that can't name one. With `pixelCookieDomain: true` (Prebid.js 11.53.0 or later), `sharedIdSystem` adds `cookie_domain` to its `pixelUrl` request: the domain it writes `_pubcid` on, which it finds by probing which domains the browser lets it set a cookie on, so it is the registrable domain (`example.com` on `www.example.com`) without a Public Suffix List.

- **Setting cookies** (`/sync`, and `/v1`, which a page may call with the same parameter): the cookies' `Domain` is `cookie_domain` when it's valid for the request's host, else none (host-only). Valid means: a hostname of two labels or more, with no scheme, port or path and not an IP address, that compared case-insensitively and without a trailing dot is the host itself or a parent of it at a label boundary (`example.com` for `www.example.com`; not `ample.com`, and not `www.example.com` for `example.com`). An IP address host is always host-only. The `Domain` is the normalized value.
- **The host** is the one the implementation already uses for the request's URL: in trusted-upstream mode, the forwarded host, read only after the secret check (`cookie_domain` is checked against the publisher's site, not the endpoint's own host); otherwise the request's own host, never a forwarding header the implementation doesn't already trust.
- **Deleting cookies, and opt-out:** `/optout` and `/optin` have no `cookie_domain`, and a deletion must reach a cookie set on an earlier request. With `auto`, the opt-out cookie, the ID cookies' deletions (opt-out, and storage not allowed on `/sync` or `/v1`) and `/optin`'s deletion of the opt-out cookie go to the host (no `Domain`) and to the host and each domain above it short of the top-level one (`www.example.com`, `example.com`). A browser refuses a `Domain` that's a public suffix (`co.uk`), so those are no-ops.
- **The duplicate rule** (above) applies when `auto` resolves to a domain.
- **Diagnostics:** with `auto`, `/sync` and `/v1` responses have `X-SharedID-Cookie-Domain`: the domain chosen, `host-only: no cookie_domain`, or `host-only: cookie_domain not this host or a parent`.
- **A module cookie** with `Domain` `auto` (from a module setting such as `"domain": "auto"`) gets the same domain, whatever `SID_COOKIE_DOMAIN` is; its deletions go everywhere, as above, and so do the deletions of module cookies without their own `Domain` under `SID_COOKIE_DOMAIN=auto`: on opt-out, and on `/sync` and `/v1` (when storage isn't allowed, say). A deletion the module marks host-only stays host-only.

A forged `cookie_domain` can't reach another site: it must match the host, and a browser refuses a `Set-Cookie` whose `Domain` doesn't domain-match the page's host or is a public suffix, so the worst a forged value does is what host-only would. Sites that share a parent domain with unrelated sites (a multi-tenant host whose parent isn't on the Public Suffix List) MUST use a fixed domain, since Prebid.js's probe would find the shared parent.

## Opt-out and consent

Storage is **not allowed** when, in this order:

1. the opt-out cookie is present (reason `opt-out`);
2. the request has `Sec-GPC: 1`, Global Privacy Control (reason `gpc`), or is subject to COPPA, signalled by the query parameter `coppa=1` as in OpenRTB `regs.coppa` (reason `coppa`);
3. a [consent provider](#consent-providers) denies it (reason `<module>: …`), whether or not GDPR applies and whether or not there's a TC string;
4. there is a TC string and it doesn't give the consent below (reason `tcf: …`);
5. GDPR applies, there is no TC string, and no consent provider grants storage (reason `tcf: GDPR applies and there is no TC string`): that counts as no consent.

Otherwise it's allowed. When storage isn't allowed, existing ID cookies are deleted (see [Cookies](#cookies)).

### Consent providers

A module MAY be a **consent provider**: it has a `consent(context)` hook that reads a consent signal core doesn't, such as a consent management platform's own cookie (the [`cmp`](modules/cmp.md) module) or the US sections of the GPP string (the [`gpp`](modules/gpp.md) module), and returns one of:

- `{ consent: 'denied', reason }`: the visitor explicitly refused storage;
- `{ consent: 'granted' }`: the visitor explicitly allowed it;
- nothing: the signal is absent, can't be read, or doesn't say (unknown).

A provider MUST return nothing rather than `granted` when in doubt. The rules:

- **Which providers:** those in `SID_MODULES` that have the hook, in `SID_MODULES` order, on `/v1` and `/sync` alike (whatever their `routes` and `SID_SYNC_MODULES`, so both routes decide the same way), before the storage decision and before any module runs. Not on a request with the opt-out cookie, which is denied anyway. The hook gets the request, its URL and cookies, the platform information, the consent signals core read, and the module's configuration; it is synchronous.
- **Combining:** the first denial wins; otherwise any grant; otherwise there is no signal. A hook that throws, or returns anything else, counts as a denial with reason `<module>: error`, so a broken provider can't let an ID through; so does a denial whose reason isn't 1 to 200 printable ASCII characters, which couldn't go in a header.
- **Precedence** (the list above): GPC, COPPA and the opt-out cookie come before any provider. A provider's denial applies everywhere, with or without GDPR and with or without a TC string, and deletes the ID cookies like any denial. A provider's grant only lifts step 5, the denial for want of a TC string where GDPR applies: it never overrides GPC, COPPA, the opt-out cookie, a TC string (valid or not) or another provider's denial. With no signal, the decision is as without providers. So a provider can only add a denial, or allow storage where the worker would otherwise deny it for lack of any signal.
- **The reason** in `X-SharedID-Status` is the provider's, after the module's name: `denied: cmp: cookiebot: marketing`.
- **Other consent rules are unchanged:** modules' declared `purposes` under GDPR still need publisher consent in a TC string, and [precise location](#consent) still needs a TC string's Special Feature 1 where GDPR applies.

### Consent

- **GDPR applies** when the `gdpr` query parameter is `1`, or when it's absent and the visitor's country is a GDPR country, or the platform reports an EU location (on Cloudflare, `request.cf.isEUCountry`). The GDPR countries (`GDPR_COUNTRY_CODES`) are the 27 EU member states, the rest of the EEA (Iceland, Liechtenstein, Norway), the United Kingdom or Turkey (its KVKK is treated as GDPR); not Switzerland. `gdpr=0` means it doesn't apply. With no TC string and no signal, it's unknown, and storage is allowed.
- **The TC string** comes from the `gdpr_consent` query parameter, else the CMP's `euconsent-v2` cookie. When there is one, it is checked whatever `gdpr` says. A string that isn't a valid TCF v2 TC string denies storage (reason `tcf: invalid TC string`).
- **Publisher mode** (the default, `SID_VENDOR_ID` unset). SharedID is the publisher's own first-party ID, so the TC string's **publisher TC segment** (segment type 3) MUST have consent for Purpose 1 (store and access information on a device), and consent or legitimate interest for at least one of Purposes 2 to 10. Reasons: `tcf: no publisher TC segment`, `tcf: no publisher consent for purpose 1`, `tcf: no publisher consent or legitimate interest for any of purposes 2-10`.
- **Vendor mode** (`SID_VENDOR_ID` set, for a publisher registered as a TCF vendor). The core segment's vendor consents MUST include that vendor ID, its purpose consents MUST include Purpose 1, and its purpose consents or purpose legitimate interests MUST include at least one of Purposes 2 to 10. The publisher TC segment isn't used. Reasons: `tcf: no consent for vendor <id>`, `tcf: no vendor consent for purpose 1`, `tcf: no vendor consent or legitimate interest for any of purposes 2-10`.
- Purpose 1 always needs consent; legitimate interest isn't a legal basis for it.
- **Builds without the TCF decoder.** Every default build MUST decode TC strings. An implementation MAY offer a build that leaves the decoder out, for deployments that never need TCF; it MUST be explicit (never the default). Such a build MUST treat a TC string as one it can't read: it denies storage and deletes the ID cookies whatever `gdpr` says (reason `tcf: TC string not decoded (build without TCF)`), and denies precise location; it MUST NOT allow storage the default build would deny. Without a TC string, it decides as every build does (GDPR from the location stays). Conformance: `consent-no-tcf.json`, built `no-tcf`.
- Implementations need only decode the core segment's version (must be 2), purpose consents (bits 152 to 175), purpose legitimate interests (176 to 199) and vendor consent section (from bit 213, bit field or range encoded), and the publisher TC segment's purpose consents (bits 3 to 26) and legitimate interests (27 to 50).
- `us_privacy`, `gpp`, `gpp_sid` and `coppa` query parameters are read and passed to modules. Modules MUST treat `coppa=1` like GPC.
- **GPP's US sections.** Core doesn't decode the GPP string; the opt-in [`gpp`](modules/gpp.md) consent provider does. For each US section (US National and the state sections, GPP section IDs 7 to 27) that `gpp_sid` lists: an opt-out of sale, sharing or targeted advertising, or a known-child field without consent, denies storage and deletes the ID cookies, exactly like GPC (reason `gpp: <section>: …`); a string it can't read for such a section denies too (fail closed); no opt-out changes nothing (it never grants). Sections `gpp_sid` doesn't list, and non-US sections, are ignored. Being a provider's denial, it can't weaken GPC, COPPA, the opt-out cookie or a TC string.

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
- `eip` is the client's IP address encrypted for each configured recipient (the opt-in [`encrypted-ip`](modules/encrypted-ip.md) module): `google`, for Google Publisher Tag's `googletag.setConfig({ ipAddress })`, and `pbs`, an object keyed by Prebid Server host name (lower case, with `:port` when not the default), for Prebid Server's proposed `device.ext.prebid.eip` (experimental). Each value is `{ value, kid?, stale? }`: `value` is unpadded base64url of 67 to 124 characters, `kid` the ID of the recipient key it was encrypted to, `stale: true` when that key is past its refresh time (a key over 24 hours old gives no value). It's kept out of `ortb2`, which pages pass to every bidder, so that each value goes to its recipient alone; absent when there's no value. A module's `eip` with any other field, a value or `kid` of the wrong form, or a host name that isn't one, makes the module an `error`, and none of its output is used. A later module's value for a recipient replaces an earlier one's.
- `ext.modules` reports each configured module: `status` is `ok`, `empty`, `skipped` (with a `reason`), `error` or `timeout`. An optional `stale: true` flag marks missing or old reference data; usable previous data MAY still contribute. A [forwarding module](#forwarding-modules)'s report has `forwards`, `true` or `false`: whether this visitor's requests to its paths are passed on (anonymously included), and nothing about them. Error details MUST NOT be returned, since they may contain request data.

### Traffic signal

`ortb2.device.ext.traffic` describes the traffic: whether it comes from a bot, through what kind of proxy, and whether it's the site's own staff. Several sources report to it: modules (the [`bot` module](modules/bot.md), and others such as user agent or IP intelligence modules) and the platform itself (its [traffic verdict](#platform-traffic-verdict)). The implementation merges their reports; no source writes the field directly.

```json
{ "bot": true, "botKind": "declared", "proxy": "datacenter", "score": 12, "internal": false, "sources": ["platform", "ua"] }
```

| Field | |
| --- | --- |
| `bot` | Boolean: the request comes from a bot. |
| `botKind` | How sure: `verified` (a known good bot the platform verified, such as a search crawler), `declared` (a crawler that names itself in its user agent) or `likely` (a heuristic or a score). A report with a `botKind` is a bot. |
| `proxy` | `datacenter` (a hosting address), `vpn`, `public` (a public or web proxy), `residential` (a residential proxy), `tor` (a Tor exit), or `relay`: a known service carrying people's traffic, such as iCloud Private Relay and other privacy relays, or a verified corporate proxy. |
| `score` | Human-likelihood, an integer from 1 (almost certainly a bot) to 99 (almost certainly human), on Cloudflare Bot Management's scale. |
| `internal` | Boolean: the visitor marked themselves as the site's own staff. |
| `sources` | The sources that reported anything, in order: `platform` first, then module names in `SID_MODULES` order, each once. |

**Merging.** Each source's report has any of the fields above except `sources`, which the implementation sets. Reports with no fields are ignored. The merge is most cautious first:

- `bot` is `true` if any report says `true`, else `false` if any says `false`, else absent;
- `botKind` keeps the strongest claim: `verified`, then `declared`, then `likely`;
- `proxy` keeps the most specific value, in this order: `tor`, `residential`, `relay`, `vpn`, `public`, `datacenter`. A data centre is the least specific, since VPNs, public proxies and relays also use hosting addresses; a source that knows the address is a relay wins over one that only sees a data centre;
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
- optionally `purposes` (TCF purposes it needs consent for when GDPR applies: the publisher's, or with a `gvlid` the vendor's) and `gvlid` (its IAB vendor ID, for a module acting for a TCF vendor);
- optionally `routes`, the routes it runs on: a non-empty list of `v1` and `sync` without repeats, defaulting to `v1` only (see [Modules on `/sync`](#modules-on-sync));
- optionally a `consent(context)` hook, which makes it a [consent provider](#consent-providers);
- optionally `forwarding`, which makes it a [forwarding module](#forwarding-modules);
- optionally `fetching`, the hosts its `run` may send requests to (see [Module requests](#module-requests));
- a `run(context)` function returning `{ eids?, ortb2?, eip?, cookies?, traffic?, noStore?, stale? }` or nothing (`eip`: see [Payload v1](#payload-v1); `traffic`: see [Traffic signal](#traffic-signal); `noStore`: see [Modules on `/sync`](#modules-on-sync); `stale`: see [Scheduled data updates](#scheduled-data-updates)).

The context has the request, its URL and cookies, the platform information (see [Platform information](#platform-information)), the SharedID (when storage is allowed), whether the browser opted out, the consent signals, and the module's configuration and secrets.

The module's configuration and secrets are read-only, all the way down: implementations MUST NOT let a module change them, since they last as long as the worker's configuration does and a change would carry into later requests. A module that tries (in the TypeScript implementation, a write to a frozen object, which throws) fails like any other module error: it's reported as `error` and left out. A worker may answer many requests, from different visitors, with the same modules (a cached handler, or a sandbox reused across requests), so a module MUST NOT keep anything derived from a request (addresses, cookies, consent, IDs, headers, location) beyond that request.

The context also has the worker's **storage decision** for the request, `storage`: `{ allowed: true }`, or `{ allowed: false, reason }` with the same reason as `X-SharedID-Status` (`opt-out`, `gpc`, `coppa`, a consent provider's `<module>: …` or `tcf: …`; see [Opt-out and consent](#opt-out-and-consent)). A module that stores or extends an identifier SHOULD do so only when `storage.allowed` is true.

A module's `cookies` are set on the response (of `/v1`, or `/sync`) with `Path=/`, `SameSite=Lax`, `Secure` as for the ID cookies (above), the module's `Domain` (else `SID_COOKIE_DOMAIN`; none when the module marks the cookie host-only; for `auto`, [the request's](#cookie-domain-auto)), `Max-Age` (0 deletes) and `HttpOnly` as given. A module MUST NOT set the worker's own cookie names; a malformed or reserved cookie makes the module an `error`, and none of its output is used. A module that returns only cookies reports `empty`.

A module that sets cookies SHOULD also declare the deletions for opt-out. `{basePath}/optout` deletes the ones the browser sent along with the ID cookies, for every installed module (whether or not it's in `SID_MODULES`), so an opt-out takes effect at once and not only on the next `/v1` call. When consent skips a module with a `gvlid` (below), on `/v1` or `/sync`, the deletions it declares for the cookies the browser sent are set too, so a vendor's identifier doesn't outlast the vendor's consent.

Modules work only from what the worker has, and make no network calls of their own; a [forwarding module](#forwarding-modules) passes requests on to its declared hosts, and a module with `fetching` sends requests to its declared hosts from `run` ([Module requests](#module-requests)), both through the implementation. The worker:

- on `/v1`, runs the modules listed in `SID_MODULES`, in order, reporting unknown names, and modules whose `routes` leave out `v1`, as `skipped`;
- when GDPR applies, skips a module without a `gvlid` whose `purposes` don't all have consent in the publisher TC segment (reason `tcf: no publisher consent for purpose <n>`); and a module with a `gvlid` (acting for that TCF vendor) unless there's a TC string (`tcf: GDPR applies and there is no TC string`) that can be read (`tcf: invalid TC string`, or the no-TCF build's reason), its core segment's vendor consents include the `gvlid` (`tcf: no consent for vendor <id>`), and its core segment's purpose consents include each of the module's `purposes` (`tcf: no vendor consent for purpose <n>`);
- stops waiting for a module after `SID_MODULE_TIMEOUT_MS`;
- isolates failures: a module that throws or times out is reported and left out, and the rest of the payload is returned.

### Modules on `/sync`

Prebid.js calls `/sync` (its `pixelUrl`) on page views without any page code, so modules that only maintain cookies, like [`reflect`](modules/reflect.md) and [`ec`](modules/ec.md), or report to the [traffic signal](#traffic-signal), like [`bot`](modules/bot.md), also run there. Modules that return data (`ip`, `geo`, `ua`) don't, since `/sync` returns an image.

- **Which modules:** without `SID_SYNC_MODULES`, every installed module in `SID_MODULES` whose `routes` include `sync`. With it, the modules it lists, which MUST all be in `SID_MODULES` (otherwise the configuration is invalid); `none` runs none. A listed module that isn't installed, or whose `routes` leave out `sync`, is reported `skipped` and doesn't run. Modules run in `SID_MODULES` order, whatever the order in `SID_SYNC_MODULES`.
- **The same context as on `/v1`:** the request, its cookies, the platform information, the SharedID, whether the browser opted out, the consent signals, the storage decision, and the module's configuration and secrets. Consent skips, the time limit and failure isolation work as on `/v1`.
- **Cookies and traffic reports only:** the cookies of each module that succeeded are set, after the same checks as on `/v1`, and its traffic report joins the platform's verdict for [Skipping bots](#skipping-bots); its `eids`, `ortb2` (apart from a traffic report in `ortb2.device.ext.traffic`) and `eip` are ignored, and the merged signal isn't returned. A module that fails, times out or returns a bad cookie or report sets and reports nothing.
- **Otherwise the response is unchanged:** status `200`, the GIF, and the same headers and `Cache-Control`, plus the module cookies and, when any module was selected to run, `X-SharedID-Modules`: each module's name and status (as in `ext.modules`, without reasons), in order, such as `X-SharedID-Modules: reflect=empty, ec=ok, bot=empty`. It MUST NOT contain cookie names, values or error details.
- **Caching:** a successful sync that set an ID is still cached privately for `SID_SYNC_CACHE_SECONDS` (one day by default), so from `/sync` a browser runs these modules about once per cache lifetime at most. A response served from the browser's cache sets no cookies. A lower `SID_SYNC_CACHE_SECONDS` runs them more often, for more requests; `0` runs them on every call.
- **`noStore`:** a module whose result has `noStore: true` needs to see every sync (the [`clickid`](modules/clickid.md) module reads the landing page from the `Referer`, and a browser reuses a cached sync for any page). When a module that succeeded on `/sync` returns it, the response MUST be `Cache-Control: no-store`; its status, body and other headers are unchanged. It's ignored from a module that fails, times out or returns a bad cookie or report, and on other routes, whose responses are `no-store` already. A `noStore` that isn't a boolean makes the module an `error`.

### Platform information

Each platform adapter fills the platform information from values the platform itself sets, which visitors can't forge: on Cloudflare `CF-Connecting-IP` and `request.cf`; behind CloudFront the `CloudFront-Viewer-Address` (`ip:port`), `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` headers, accepted only when the origin can be reached through CloudFront alone. On Vercel, `x-real-ip` (else the first `x-forwarded-for` entry) and the `x-vercel-ip-*` geolocation headers, which Vercel's proxy sets and overwrites; they're trusted only on Vercel (the same code run elsewhere is configured to ignore them). Vercel reports no metro code. Behind Azure Front Door, `X-Azure-ClientIP`, and the location from headers a Front Door rule overwrites on every request (Front Door's `{geo_country}`; it has no other location data), accepted only when the function app can be reached through that Front Door profile alone (its `X-Azure-FDID`). An adapter whose platform changes cookie values in transit (Azure Functions percent-encodes some of them) leaves out a cookie it can't set unchanged, rather than set a different value. Behind Google Cloud's external Application Load Balancer, the `X-Forwarded-For` entry the load balancer appends for the client (the second-to-last; the first is the visitor's own), and the location from the backend service's custom request headers (`{client_region}`, `{client_region_subdivision}`, `{client_city}`, `{client_city_lat_long}`), which overwrite a visitor's copies; accepted only when the function can be reached through the load balancer alone (ingress). It has no metro code, postal code or time zone. The Node.js server, with its proxy trusted, takes the client IP from the first `X-Forwarded-For` entry, or from the client-IP header it's configured with (the proxy's own, such as `CloudFront-Viewer-Address` as `ip:port`, `Fastly-Client-IP` or `True-Client-IP`, for a proxy that appends to `X-Forwarded-For`; no client IP when that header is missing or isn't an IP address), and the location from Cloudflare's visitor location headers or the headers it's configured with, all of which only that proxy may set. In [trusted-upstream mode](#trusted-upstream), an authenticated request's information comes from the upstream's headers instead, on every platform, and its country decides whether GDPR applies in the same way. A value the platform doesn't provide is left out, never guessed. The EU flag means the country is one of the 27 EU member states (the meaning of Cloudflare's `isEUCountry`), and is unknown when the country is. It stays EU membership: whether GDPR applies also takes the country code into account (above).

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

**The TLS fingerprint.** The platform information MAY also carry the client's [JA4](https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md) TLS fingerprint (`ja4`), as the platform computed it from the visitor's own TLS connection: the whole `a_b_c` string, such as `t13d1516h2_8daaf6152771_02713d6af862`, with `a` the protocol (`t` TCP, `q` QUIC, `d` DTLS), TLS version, SNI (`d` or `i`), the cipher and extension counts and the ALPN's first and last characters, and `b` and `c` 12 lower-case hex digits each. Anything else is left out. Only from the platform, never from a header a visitor could send:

| Platform | Source |
| --- | --- |
| Cloudflare | `request.cf.botManagement.ja4` (Bot Management, an Enterprise add-on) |
| Fastly Compute | `event.client.tlsJA4` |
| AWS Lambda behind CloudFront | `CloudFront-Viewer-JA4-Fingerprint`, only when configured to say the origin request policy adds it (`SID_CLOUDFRONT_JA4`), so CloudFront sets it |

Other platforms, the Lambda@Edge bundle, a server behind a proxy it trusts, and [trusted-upstream mode](#trusted-upstream) (where the connection is the publisher's CDN's) have none. It's used only by modules that compare it with the request (the [`bot` module](modules/bot.md)'s `ja4Mismatch`): it MUST NOT be stored, logged, returned, or used to derive an identifier.

### Platform traffic verdict

The platform information MAY carry the platform's own traffic verdict, a report with the fields of the [traffic signal](#traffic-signal) (without `sources`). It's merged first, as source `platform`, on every route, whether or not any module runs, and so it's in the payload even with no modules; a verdict that isn't valid is ignored. Platforms add only what they themselves determined, never a guess:

| Cloudflare `request.cf.botManagement` (Bot Management, an Enterprise add-on) | Report |
| --- | --- |
| `verifiedBot: true` | `bot: true`, `botKind: verified` |
| `score`, an integer from 1 to 99 | `score` (other values, including 0, are left out) |
| `corporateProxy: true` | `proxy: relay` |

Without Bot Management the object is absent, or has no score and false flags, and the platform adds nothing. `request.cf.verifiedBotCategory` isn't in the Workers runtime types, so it isn't read. Other platforms add nothing.

### Forwarding modules

A module MAY **forward**: own paths on the site and answer the requests under them by passing them on to a service it names, such as the [`tag-gateway`](modules/tag-gateway.md) module for Google's tag gateway. It's the only way an implementation sends anything to another host. Such a module has `forwarding`, with:

- `hosts`: the hosts it may send requests to, fixed in its code (and listed as `forwards` in its package metadata). Each is a lower-case host name of two labels or more, or `*.` and such a name for any host under it (`*.fps.goog` allows `g-1.fps.goog`, not `fps.goog`);
- `paths(config)`: the path prefixes it owns, from its settings;
- optionally `anonymousOnGpc(config)`: whether, with Global Privacy Control, it forwards anonymously (below) rather than not at all;
- `serve(context)`: answers a request under one of its paths.

**Off by default.** A forwarding module owns paths only when it's listed in `SID_MODULES` and its settings name them. An implementation, or a platform adapter, that can't send requests to another host MUST treat a forwarding module in `SID_MODULES` as invalid configuration (every request gets a 5xx), never ignore it.

**Paths.** A prefix is `/` and one or more segments of `A-Z a-z 0-9 . _ ~ -` joined by `/`, at most 100 characters, with no trailing slash. A request is under a prefix when its path is the prefix or starts with the prefix and `/`. A prefix MUST NOT overlap (be equal to, or a parent or child of) `SID_BASE_PATH` (with the root base path, any of core's routes) or another forwarding module's prefix: that's invalid configuration. A module whose settings are invalid owns no path (its requests get `404`) and its `/v1` report is `error`. With [several sites](#several-sites), each site's settings give its own paths.

**Requests.** On a forwarding module's path, after [trusted upstream](#trusted-upstream)'s check and the choice of the site's settings:

- methods other than `GET`, `HEAD` and `POST` get `405` with `Allow: GET, HEAD, POST`;
- the [request limits](#request-limits) of `/sync` and `/v1` apply (`414`, `431`); the rate limiter isn't asked;
- the **forwarding decision** is made (below), and the module's `serve` is called with the request, its URL and cookies, the matched prefix, the platform information, the consent signals, the decision, and the module's configuration and secrets. No SharedID is chosen and no ID cookie is set or deleted;
- only when the decision forwards, the body of a `POST` is read, up to 65,536 bytes: without `Content-Length` the request gets `411`, with a larger one `413`. Otherwise no body is read.

**The forwarding decision**, in this order:

1. the opt-out cookie is present: blocked (reason `opt-out`);
2. COPPA (`coppa=1`): blocked (`coppa`);
3. a [consent provider](#consent-providers) denies: blocked (`<module>: …`);
4. there's a TC string that is invalid, or isn't decoded (a build without TCF): blocked (`tcf: …`, as for storage);
5. GDPR applies and there's no TC string: blocked (`tcf: GDPR applies and there is no TC string`); a consent provider's grant doesn't lift this, since the request goes to another party;
6. GDPR applies and the module's consent rule for running (see [Modules](#modules): its `purposes` in the publisher TC segment, or with a `gvlid` the vendor's consent and its `purposes` in the core segment) isn't met: blocked (the reasons modules get on `/v1`);
7. Global Privacy Control (`Sec-GPC: 1`): blocked (`gpc`), unless the module's `anonymousOnGpc(config)` is true, when it's forwarded **anonymously**;
8. otherwise forwarded.

**Outbound requests** go only through the implementation (`context.forward`), which MUST refuse, without sending anything:

- any request while the decision is blocked;
- a URL that isn't `https` on the default port, has a user name or password, or whose host isn't one of the module's `hosts`.

It doesn't follow redirects (a `3xx` is returned as is), gives up after 10 seconds, and adds nothing to what the module sends. When forwarding anonymously it also removes every header that carries the client's address or location: `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `Client-IP` and `X-Cluster-Client-IP`. Modules MUST NOT copy the request's own forwarding, client IP or CDN location headers onward; the client IP and location they send come from the platform information, under the consent rules for precise location (see [Consent](#consent)).

**Responses.** The module's response is returned with:

- `X-SharedID-Forwarding`: `forwarded`, `anonymous`, or `blocked: <reason>`; `error` when `serve` throws or an outbound request fails, which gets `502` with nothing from the request in the body;
- `Cache-Control: no-store` added when the module set none;
- hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Proxy-*`), `Content-Encoding` and `Content-Length` removed (the body is decoded), and every `Access-Control-*` header removed: the paths are the site's own, and `Access-Control-Allow-Origin` is never `*`.

A blocked request still gets the module's answer, which SHOULD be one that doesn't break the page (an empty script, a `204`) and MUST NOT carry anything from the other service.

**Reporting.** On `/v1`, a forwarding module in `SID_MODULES` reports `forwards` (see [Payload v1](#payload-v1)): whether the decision above, for this request, forwards. Nothing about forwarded requests is logged or kept.

### Module requests

A module MAY send requests from `run` to hosts it declares, for a vendor module that looks an ID up from the vendor's API (the [`id5`](modules/id5.md) module). It's subject to the vendor plugin rules: opt-in, a strict time limit, cached results. Such a module has `fetching`, with `hosts` as for a forwarding module (fixed in its code, and listed as `network` and `forwards` in its package metadata).

- **Off by default,** like a forwarding module: only when listed in `SID_MODULES`. An implementation or adapter that can't send requests to another host MUST treat such a module in `SID_MODULES` as invalid configuration (every request gets a 5xx).
- **The decision** is the [forwarding decision](#forwarding-modules) for the module, with Global Privacy Control always blocking (there's no anonymous mode). When it's blocked, the module gets no way to send anything (`context.fetch` is absent), on `/v1` and `/sync` alike.
- **Outbound requests** go only through `context.fetch`, with the checks of a forwarding module's `forward` (`https` on the default port, no credentials, a declared host, no redirects followed). It gives up after the module's own limit or four fifths of `SID_MODULE_TIMEOUT_MS`, whichever is shorter (at least 1 ms), so a module whose request runs out of time can still answer, from a cache, before the worker stops waiting for it. The time limit covers reading the answer.
- **The module is responsible for its own privacy rules on top:** what it sends, its own denials and its cache. It MUST NOT send the request's own forwarding, client IP or CDN location headers; a client IP it sends comes from the platform information, under the [precise location](#consent) rules.
- **Reporting.** On `/v1` its report has `forwards`: whether the decision above allows requests for this visitor (not whether one was sent). Nothing about the requests is logged or kept.

### Module specifications

Each module's behaviour is specified in its own file under [`modules/`](modules), named after the module:

<!-- generated:spec-modules:start -->
- **Core modules** (`packages/modules/`):
  - [The `bot` module](modules/bot.md)
  - [The `clickid` module](modules/clickid.md)
  - [The `cmp` module](modules/cmp.md)
  - [The `encrypted-ip` module](modules/encrypted-ip.md)
  - [The `geo` module](modules/geo.md)
  - [The `gpp` module](modules/gpp.md)
  - [The `ip` module](modules/ip.md)
  - [The `reflect` module](modules/reflect.md)
  - [The `tag-gateway` module](modules/tag-gateway.md)
  - [The `ua` module](modules/ua.md)
- **Vendor modules** (`packages/vendor-modules/`):
  - [The `dbip` module](modules/dbip.md)
  - [The `ec` module](modules/ec.md)
  - [The `id5` module](modules/id5.md)
  - [The `ip2location` module](modules/ip2location.md)
  - [The `maxmind` module](modules/maxmind.md)
<!-- generated:spec-modules:end -->

## Scheduled data updates

Data downloads and transformations MUST run outside visitor request handling, on the platform's scheduler or an administrative command. Only explicitly configured sources run, using the deployer's credentials from `SID_MODULE_SECRETS`. No request, IP address, cookie, identifier or other visitor data is sent to an update source or kept in its storage.

An updater MUST validate a download before publishing it. A failed download, validation or publication MUST leave the previous published snapshot usable. Content is addressed by SHA-256; unchanged data MUST NOT be written again. A small manifest MAY record a successful revalidation (including HTTP 304) without rewriting the data. Both data and manifests are versioned. Storage is private to the deployment; it is not an HTTP route of the worker.

Adapters MAY load snapshots from deployment storage (R2, KV, S3 or local files), separately from module execution. These reads never download from the vendor. A module uses only the validated in-memory snapshot and MUST NOT refresh it or make a network call from `run`. Failed storage reads or invalid snapshots keep the last validated in-memory copy. Caches may hold this shared reference data, never visitor data.

A module using scheduled data returns `stale: true` when no snapshot is available or its last successful source check is older than its configured maximum age. Core adds `stale: true` to the module report, preserving its `ok` or `empty` status even when there is no output, and otherwise applies the module's output and consent rules normally. Invalid `stale` values make the module an `error`; a failure or timeout still takes precedence. Deployers MAY configure a later expiry at which old data contributes nothing while remaining `stale` (for example to meet a data licence).

## Versioning

The payload carries `v`, and the route is versioned (`/v1`). Changes that would break a consumer of v1 get a new version and route.
