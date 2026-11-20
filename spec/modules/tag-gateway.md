# The `tag-gateway` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, and for [forwarding modules](../SPEC.md#forwarding-modules) in particular, are there.

Name `tag-gateway`; `purposes` 1 and 7, no `gvlid`. A forwarding module: its `hosts` are `*.fps.goog`. It serves Google's [tag gateway for advertisers](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual) (formerly "first-party mode") from paths on the site, passing each request on to the gateway endpoint of the tag the path is configured for, as Google's guide for "other" CDNs and load balancers describes. It does nothing until it's listed in `SID_MODULES` and configured. On `/v1` it adds nothing (status `empty`), with the `forwards` report of every forwarding module.

## Settings

`SID_MODULE_CONFIG`'s `tag-gateway` entry. An unknown key, or any invalid value, is an error: the module owns no path and reports `error`.

| Key | | |
| --- | --- | --- |
| `tags` | **required** | 1 to 10 objects of `id`, a Google tag or container ID (`G-…`, `GTM-…`, `AW-…`; letters, a `-`, then 1 to 20 letters or digits), and `path`, the prefix it's served under (a [forwarding path](../SPEC.md#forwarding-modules), such as `/metrics`). Paths must differ and not overlap; IDs may repeat. |
| `gpc` | [`block`] | With Global Privacy Control: `block` forwards nothing; `forward-anonymous` forwards anonymously. |

## Forwarding

A request under a tag's `path` is sent to `https://<id, lower case>.fps.goog`, with the request's own path (the prefix kept) and query, and its method (`GET`, `HEAD` or `POST`, with the body of a `POST`).

**Request headers.** Only these of the request's headers are passed on: `Accept`, `Accept-Language`, `Content-Type`, `Origin`, `Referer`, `User-Agent`, `DNT`, `Sec-GPC`, `If-None-Match`, `If-Modified-Since`, and `Sec-CH-*` and `Sec-Fetch-*`. Every other header is dropped: in particular `Host` (the upstream's is the gateway's host), `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, and the CDN's client IP and location headers (`CF-*`, `CloudFront-*`, `X-Vercel-*`, …). The module adds:

- **`Cookie`**: only the request's Google first-party cookies, which [Google says](https://support.google.com/tagmanager/answer/16960855) are the only ones the gateway uses: `_ga`, `_ga_*`, `_gac_*`, `_gat*`, `_gaexp*`, `_gid`, `_gcl_*`, `_dc_gtm_*`, `_opt_*`, `__utm*`, `__gads`, `__gpi`, `__gpi_optout`, `__gsas`, `__eoi`, `FPID`, `FPLC`, `FPAU`, `FPGSID` and `FPGCL*`. The SharedID cookies and every other cookie are left out. No `Cookie` header when there's none.
- **Coarse location**, from the platform information: `X-Forwarded-Country` (ISO 3166-1 alpha-2) and, with a region, `X-Forwarded-CountryRegion` (ISO 3166-2, `US-CA`).
- **The client IP and precise location**, only when core's precise-location rules allow it (the [`ip`](ip.md) module's and the [`geo`](geo.md) module's: not with GPC, COPPA, a `us_privacy` opt-out of sale, a TC string without opt-in to Special Feature 1, or GDPR without a TC string): `X-Forwarded-For`, the platform's client IP alone; and `X-Forwarded-Geolocation`, `latlong=<latitude>,<longitude>` and `city=<city>`, joined with `;`, each when known (a city with characters other than printable ASCII, or a `;` or `,`, is left out). Otherwise neither is sent: never a truncated address or a rounded position.

**Anonymously** (GPC with `"gpc": "forward-anonymous"`): no `X-Forwarded-*` header at all, so no client IP or location of any precision; everything else as above. Google sees the address of the platform's outbound connection, not the visitor's.

**Responses.** The gateway's status, body and headers, after core's changes, with `Cache-Control`:

- for the **tag script** (a request with `Sec-Fetch-Dest: script`, or whose path after the prefix is empty, `/`, `/gtag/js`, or ends in `.js`): the gateway's `Cache-Control` with `public` replaced by `private` and `s-maxage` removed, so only the visitor's browser may keep it; `no-store` when the gateway sends none;
- for everything else (**measurement hits**, health checks): `no-store`, whatever the gateway says.

## Privacy

The [forwarding decision](../SPEC.md#forwarding-modules) decides whether anything is sent. When it blocks, nothing is sent, and the module answers:

- the tag script: `200`, `Content-Type: text/javascript; charset=utf-8`, an empty body, so the page's script element loads and the tag doesn't run;
- anything else: `204`;

each with `Cache-Control: no-store` and `X-SharedID-Forwarding: blocked: <reason>`.

Its TCF purposes are 1 (store and/or access information on a device) and 7 (measure advertising performance), the purposes [Google maps](https://developers.google.com/tag-platform/security/guides/implement-TCF-strings) to Consent Mode's `ad_storage` and `ad_user_data`. Where GDPR applies, the publisher TC segment must consent to both.

Nothing about the requests is logged or kept, and no ID is derived from them.
