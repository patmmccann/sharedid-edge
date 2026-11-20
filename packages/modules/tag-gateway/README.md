# @sharedid-edge/module-tag-gateway

> **⚠ This module forwards data to `*.fps.goog`** (Google's [tag gateway for advertisers](https://developers.google.com/tag-platform/tag-manager/gateway), over the public internet). It's **off unless you add it to your build, list it in `SID_MODULES` and configure a tag.**
>
> - **What is sent:** each request a page makes to the path you configure (`/metrics`, say): the Google tag script and Google's measurement hits, with their path, query and `POST` body; the browser's `Accept`, `Accept-Language`, `Content-Type`, `Origin`, `Referer`, `User-Agent`, `DNT`, `Sec-GPC`, `Sec-CH-*`, `Sec-Fetch-*` and conditional-request headers; Google's own first-party cookies (`_ga`, `_gcl_*`, `FPID` and the others [Google lists](https://business.safety.google/adscookies/)), never the SharedID or any other cookie; the visitor's country and region (`X-Forwarded-Country`, `X-Forwarded-CountryRegion`); and, only when the precise-location rules below allow it, the visitor's full IP address (`X-Forwarded-For`) and coordinates and city (`X-Forwarded-Geolocation`), all taken from your platform, never from the request's own headers.
> - **To which host:** `<your tag ID>.fps.goog` (`g-12345.fps.goog` for `G-12345`), over https. Core refuses any other host.
> - **When:** only for requests to your configured path, never for `/_sid/*` or any other path.
> - **Under which consent conditions:** **nothing at all** is sent with the opt-out cookie, for a COPPA request (`coppa=1`), with Global Privacy Control (unless you set `"gpc": "forward-anonymous"`, which sends everything above *except* the IP address and every location header), on a consent provider's denial (`cmp`, `gpp`), with an unreadable TC string, or where GDPR applies without a TC string whose publisher segment consents to TCF Purposes 1 and 7. The full IP and precise location go only when the [`ip`](../ip/README.md) and [`geo`](../geo/README.md) modules would send them: not with GPC, COPPA, a `us_privacy` opt-out of sale, or a TC string without opt-in to Special Feature 1; never truncated.
> - **Why the public internet:** Google's gateway is only reachable there; there's no co-located alternative. On Cloudflare, prefer [Cloudflare's built-in integration](#on-cloudflare-prefer-the-built-in-integration), which Cloudflare runs for you.
>
> `ext.modules["tag-gateway"].forwards` on `/_sid/v1` says whether this visitor's requests are forwarded, and nothing about them. Nothing is logged or kept.

The `tag-gateway` module for [SharedID Edge](../../../README.md) serves the Google tag (`gtag.js`, or a Tag Manager container) and its measurement requests from a path on your own site, such as `www.example.com/metrics`, by forwarding them to Google's [tag gateway for advertisers](https://developers.google.com/tag-platform/tag-manager/gateway) (formerly "first-party mode"), from the same deployment that answers `/_sid/*`. It's a [forwarding module](../../../spec/SPEC.md#forwarding-modules): the only kind of module that sends anything to another host. Spec: [`spec/modules/tag-gateway.md`](../../../spec/modules/tag-gateway.md).

## Contents

- [On Cloudflare, prefer the built-in integration](#on-cloudflare-prefer-the-built-in-integration)
- [Platforms](#platforms)
- [Turning it on](#turning-it-on)
- [What is forwarded](#what-is-forwarded)
- [Consent and privacy](#consent-and-privacy)
- [Responses](#responses)
- [Caching](#caching)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Google's documentation](#googles-documentation)

## On Cloudflare, prefer the built-in integration

Cloudflare has a [built-in integration](https://blog.cloudflare.com/google-tag-gateway-for-advertisers/) for Google's tag gateway (in the dashboard under the zone's Google tag gateway settings, or set up from Google's Tag Manager), and Google's [setup guide](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual) gives a Cloudflare Snippet for it. Either runs alongside a SharedID Edge Worker or Snippet with nothing to change here. Use one of them unless you need SharedID Edge's consent handling in front of the tag (this module blocks the tag and its hits on opt-out, COPPA, GPC and missing TCF consent; Cloudflare's integration leaves that to Google's Consent Mode).

**Don't overlap the routes.** The integration's path (`/metrics`, say) and the Worker's route (`example.com/_sid/*`) must differ: neither may be inside the other, or one of them never sees its requests. If you turn this module on instead, turn the built-in integration off for that path, and add a Worker route for it (below).

## Platforms

| Platform | Forwarding | Notes |
| --- | --- | --- |
| Cloudflare Worker | yes | Add a route for the path (`example.com/metrics/*`) next to `example.com/_sid/*`. Prefer the [built-in integration](#on-cloudflare-prefer-the-built-in-integration). |
| Cloudflare Snippet | yes | Snippets can make subrequests (Google's own guide uses one). Add the path to the Snippet rule: `starts_with(http.request.uri.path, "/_sid/") or starts_with(http.request.uri.path, "/metrics/")`. A Snippet allows 2 to 5 subrequests by plan; this module makes one per request. |
| Node.js | yes | Route the path to the server in your proxy, as for `/_sid/`. |
| AWS Lambda (function URL behind CloudFront) | yes | Add a CloudFront behaviour for `/metrics/*` to the function's origin, with caching disabled and every viewer header and cookie forwarded, as for `/_sid/*`. CloudFront can also reach the gateway [by itself](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual) (an origin at `G-12345.fps.goog`), without the consent checks here. |
| Vercel | yes | The middleware answers the module's paths too; add them to its `matcher` (`['/_sid/:path*', '/metrics/:path*']`). With a route handler, add a route folder for the path. |
| Google Cloud | yes | Add a URL map path rule for `/metrics/*` to the function's backend. Google's guide also has a native load balancer setup. |
| AWS Lambda@Edge | no | Not supported: a generated response is limited to 40 KB on viewer-request and 1 MB on origin-request, and the adapter doesn't send requests. Use CloudFront's own origin for the gateway, as Google's guide shows. A configuration with this module gets a 500. |
| Azure Functions | no | Not supported: the function's route template covers only `SID_BASE_PATH`. Use Front Door's own origin for the gateway ("Other" in Google's guide). A configuration with this module gets a 500. |
| Akamai EdgeWorkers | no | Not supported: EdgeWorkers has no `fetch` (its own `httpRequest` sub-requests, with limits of their own, aren't wired in the adapter). Use Property Manager's origin rule from Google's guide. A configuration with this module gets a 500. |
| Fastly Compute | no | Not supported: Compute sends requests only to backends declared in the service, which the adapter doesn't configure. Use Fastly's own [Ad Tag Gateway](https://www.fastly.com/documentation/guides/integrations/non-fastly-services/fastly-ad-tag-gateway/) or Google's VCL setup. A configuration with this module gets a 500. |

## Turning it on

1. **Add it to your build,** as `@sharedid-edge/module-tag-gateway#tagGatewayModule` (it's an [opt-in module](../AGENTS.md#opt-in-modules), so the default builds stay as small as they were):

   | Platform | Build |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-tag-gateway#tagGatewayModule`, then `npx wrangler deploy .sharedid-modules/worker.ts` in place of `npm run deploy` (whose build leaves forwarding out). |
   | Cloudflare Snippet | Nothing to add: the Snippet bundles the modules `SID_MODULES` lists. See the [Snippet section](../../adapters/cloudflare/README.md#worker-or-snippet). |
   | AWS Lambda, Vercel, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-tag-gateway#tagGatewayModule` in place of `npm run bundle`. |
   | Node.js | `SID_MODULE_PACKAGES=@sharedid-edge/module-tag-gateway#tagGatewayModule`, with the package installed next to the server. |

2. **Configure the tag and its path.** Pick a path your site doesn't use (Google: not `/`, at most 100 characters), outside `SID_BASE_PATH`. In `wrangler.jsonc`, or your platform's settings:

   ```jsonc
   "vars": {
     "SID_MODULES": "tag-gateway",                // with others: "ip,geo,tag-gateway"
     "SID_MODULE_CONFIG": "{\"tag-gateway\":{\"tags\":[{\"id\":\"GTM-ABCDEF\",\"path\":\"/metrics\"}]}}"
   }
   ```

   One Tag Manager container covers every tag in it. Standalone tags or other containers each need their own path: `{"tags":[{"id":"GTM-ABCDEF","path":"/metrics"},{"id":"G-12345","path":"/ga"}]}`.

3. **Route the path to the deployment** (see [Platforms](#platforms)): `example.com/metrics/*` next to `example.com/_sid/*`.

4. **Load the tag from the path**, as [Google describes](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual): Tag Manager's snippet with `j.src='/metrics/?id='+i+dl`, or `<script async src="/metrics/"></script>` for `gtag.js`. Keep the `<noscript>` snippet on `www.googletagmanager.com`; the gateway doesn't serve it.

5. **Check:**

   ```sh
   curl -s https://www.example.com/metrics/healthy                     # ok
   curl -s 'https://www.example.com/metrics/?validate_geo=healthy'     # ok: the location reached Google
   curl -sI https://www.example.com/metrics/healthy -H 'Sec-GPC: 1' | grep -i x-sharedid-forwarding
   # x-sharedid-forwarding: blocked: gpc
   ```

## What is forwarded

A request under a tag's path goes to `https://<id, lower case>.fps.goog` with the same path (the prefix kept, as Google's guide routes it), query and method (`GET`, `HEAD` or `POST`, with a `POST` body of at most 64 KiB).

| | Sent | From |
| --- | --- | --- |
| `Accept`, `Accept-Language`, `Content-Type`, `Origin`, `Referer`, `User-Agent`, `DNT`, `Sec-GPC`, `Sec-CH-*`, `Sec-Fetch-*`, `If-None-Match`, `If-Modified-Since` | as the browser sent them | the request |
| `Cookie` | only Google's first-party cookies: `_ga`, `_ga_*`, `_gac_*`, `_gat*`, `_gaexp*`, `_gid`, `_gcl_*`, `_dc_gtm_*`, `_opt_*`, `__utm*`, `__gads`, `__gpi`, `__gpi_optout`, `__gsas`, `__eoi`, `FPID`, `FPLC`, `FPAU`, `FPGSID`, `FPGCL*`. [Google drops](https://support.google.com/tagmanager/answer/16960855) any other cookie, so none is sent. | the request |
| `X-Forwarded-Country`, `X-Forwarded-CountryRegion` (`US-CA`) | when the platform knows them, except when forwarding anonymously | the platform's location ([`PlatformInfo`](../../../spec/SPEC.md#platform-information)) |
| `X-Forwarded-For` | the client IP alone, in full, only when the precise-location rules allow it | the platform's client IP |
| `X-Forwarded-Geolocation` (`latlong=37.4,-122.1;city=Mountain View`) | only when the precise-location rules allow it; a city name that isn't plain ASCII is left out | the platform's location |

Every other header is dropped, including the request's own `X-Forwarded-*`, `Forwarded`, `X-Real-IP` and the CDN's client IP and location headers (`CF-*`, `CloudFront-*`, `X-Vercel-*`): the values above come from the platform, which visitors can't forge. These are the headers Google's [location guide](https://support.google.com/tagmanager/answer/17141867) names; without the client IP, Google sees your platform's outbound address instead.

## Consent and privacy

| Visitor | The tag and its hits | Client IP and precise location |
| --- | --- | --- |
| Opt-out cookie (`_pubcid_optout`) | **nothing forwarded** (`blocked: opt-out`) | none |
| COPPA (`coppa=1` on the request) | **nothing forwarded** (`blocked: coppa`) | none |
| Global Privacy Control, `"gpc": "block"` (the default) | **nothing forwarded** (`blocked: gpc`) | none |
| Global Privacy Control, `"gpc": "forward-anonymous"` | forwarded, `anonymous` | **none**, and no country or region either |
| A consent provider denies (`cmp`, `gpp` modules) | **nothing forwarded** | none |
| GDPR applies, no TC string | **nothing forwarded** | none |
| GDPR applies, TC string without publisher consent for Purposes 1 and 7, or invalid | **nothing forwarded** | none |
| GDPR applies, publisher consent for Purposes 1 and 7 | forwarded | only with opt-in to Special Feature 1 |
| `us_privacy` opt-out of sale (`1YY-`) | forwarded | none |
| Otherwise | forwarded | yes |

- **TCF purposes.** The module's purposes are 1 (store and/or access information on a device) and 7 (measure advertising performance): the ones Google's [TCF guide](https://developers.google.com/tag-platform/security/guides/implement-TCF-strings) maps to Consent Mode's `ad_storage` and `ad_user_data`. Google's tags send no `gdpr` parameter on every hit, so the TC string usually comes from the CMP's `euconsent-v2` cookie, which the browser sends with each request to your path. Many CMPs don't write a publisher TC segment: then nothing is forwarded where GDPR applies. Google also says Google Analytics hits from the EEA go to regional endpoints directly, not through the gateway.
- **COPPA** is the signal core reads (`coppa=1`), which Google's tags don't add. On a site directed at children, don't turn this module on.
- **With `"gpc": "forward-anonymous"`,** SharedID Edge adds nothing and strips every client IP and location header, so Google's [Consent Mode](https://developers.google.com/tag-platform/security/concepts/consent-mode) decides what's measured. Then **set `ad_storage` and `ad_user_data` to `denied` for visitors with GPC** before the tag loads, or Google may still store and use their data:

  ```html
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    if (navigator.globalPrivacyControl === true) {
      gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    }
  </script>
  ```

- **Nothing is logged or kept,** and no ID is derived from the requests.

## Responses

**Forwarded:** Google's status, body and headers, with `X-SharedID-Forwarding: forwarded` (or `anonymous`), `Cache-Control` as [below](#caching), and without hop-by-hop, `Content-Encoding`, `Content-Length` or `Access-Control-*` headers.

**Blocked:** nothing is sent to Google, and the page isn't broken:

```http
GET /metrics/?id=GTM-ABCDEF    (the tag script; Sec-Fetch-Dest: script)
HTTP/1.1 200 OK
Content-Type: text/javascript; charset=utf-8
Cache-Control: no-store
X-SharedID-Forwarding: blocked: gpc
                               (empty body: the script loads and does nothing)

GET /metrics/g/collect?v=2&...  (a measurement hit)
HTTP/1.1 204 No Content
Cache-Control: no-store
X-SharedID-Forwarding: blocked: gpc
```

A request counts as the tag script when it has `Sec-Fetch-Dest: script`, or its path after the prefix is empty, `/`, `/gtag/js` or ends in `.js`.

**Errors:** Google unreachable, or more than 10 seconds: `502` with `X-SharedID-Forwarding: error`. Other methods than `GET`, `HEAD` and `POST`: `405`. A `POST` without `Content-Length`: `411`; over 64 KiB: `413`.

**On `/_sid/v1`** the module adds nothing to the payload. Its report says whether this visitor's requests are forwarded:

```json
{ "ext": { "modules": { "tag-gateway": { "ms": 0, "status": "empty", "forwards": true } } } }
```

`forwards` is `false` when they'd be blocked. Invalid settings give `"status": "error"`, and the module answers no path (`404`).

## Caching

Nothing is cached at the edge. Measurement hits and every other response are `Cache-Control: no-store`, whatever Google sends. The tag script keeps Google's `Cache-Control` with `public` turned into `private` and `s-maxage` dropped, so only the visitor's browser keeps it (Google's guide disables CDN caching for the path: CloudFront's `CachingDisabled`). Blocked responses are `no-store`, so a visitor's later consent takes effect at once.

## Settings

`SID_MODULE_CONFIG`'s `tag-gateway` entry. Anything invalid, or an unknown key, makes the module an `error` that owns no path.

| Key | Default | |
| --- | --- | --- |
| `tags` | **required** | 1 to 10 `{ "id", "path" }`: a Google tag or container ID (`G-12345`, `GTM-ABCDEF`, `AW-123456789`) and the path it's served under (`/metrics`: `/` and segments of letters, digits, `.`, `_`, `~` and `-`, no trailing slash, at most 100 characters). Paths must differ and not be inside each other, `SID_BASE_PATH` or another forwarding module's (an overlap with the base path is a configuration error: every request gets a 500). |
| `gpc` | `block` | With Global Privacy Control: `block` forwards nothing; `forward-anonymous` forwards without the client IP or any location header (see [Consent and privacy](#consent-and-privacy)). |

No secrets. With [`SID_HOSTS`](../../../docs/configuration.md#several-sites-from-one-deployment), each site can have its own tags.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/metrics/healthy` is your site's 404 | The path isn't routed to the deployment (a Worker route, CloudFront behaviour, Vercel matcher, URL map rule). |
| `/metrics/healthy` is SharedID Edge's `404 Not found` | `tag-gateway` isn't in `SID_MODULES`, the path in its settings differs, or the settings are invalid (`/_sid/v1` reports `"status": "error"`). |
| Every request gets a 500 | The module's path overlaps `SID_BASE_PATH`, or the platform doesn't support forwarding ([Platforms](#platforms)); the log names the setting. |
| `X-SharedID-Forwarding: blocked: …` | The visitor's privacy signals rule forwarding out; see [Consent and privacy](#consent-and-privacy). |
| `?validate_geo=healthy` isn't `ok` | The platform has no country for the request (Lambda without CloudFront, a Node.js server without `SID_TRUST_PROXY`), or the visitor is forwarded anonymously. |
| `X-SharedID-Forwarding: error` | Google's gateway didn't answer within 10 seconds, or the tag ID is wrong. |

## Google's documentation

- [What is Google tag gateway for advertisers?](https://developers.google.com/tag-platform/tag-manager/gateway)
- [Set up Google tag gateway for advertisers](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual) (last updated 2026-11-06): the endpoint `<tag ID>.fps.goog` with the `Host` header set to it, the path rule `/metrics/*`, all cookies and query strings forwarded, the location headers, CDN caching disabled, and the health checks.
- [How Google tag gateway for advertisers sets location](https://support.google.com/tagmanager/answer/17141867): `X-Forwarded-CountryRegion` (preferred) or `X-Forwarded-Country` and `X-Forwarded-Region`, `X-Forwarded-Geolocation`, and the true client IP in `X-Forwarded-For`.
- [Google tag gateway cookie handling](https://support.google.com/tagmanager/answer/16960855): only Google's first-party cookies are used; others are dropped.
- [Implement TCF strings](https://developers.google.com/tag-platform/security/guides/implement-TCF-strings): TCF purposes and Consent Mode.
