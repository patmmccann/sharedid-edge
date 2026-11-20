# Configuration reference

All settings are strings, set as Worker `vars` (Cloudflare), environment variables (Node.js, AWS Lambda, Vercel, Google Cloud) or app settings (Azure Functions). Empty means the default. Invalid values make every request fail with a 500 and log the reason, rather than set wrong cookies.

These are the core settings, which every platform reads. The table is generated from `SETTINGS` in [`packages/core/src/config.ts`](../packages/core/src/config.ts) by `node scripts/docs.mjs --write`.

<!-- generated:settings:start -->
| Variable | Default | Description |
| --- | --- | --- |
| `SID_BASE_PATH` | `/_sid` | Path prefix the worker answers under. Must match your route. |
| `SID_COOKIE_NAME` | `_pubcid` | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes the SharedID cookie on, which the worker's cookies must match: normally your registrable domain, `example.com` (Prebid.js picks the highest domain it can set a cookie on). `host-only` for cookies without a `Domain`, when Prebid.js writes them that way (a site served from an IP address, say). `auto` for the domain Prebid.js reports on each sync (`pixelCookieDomain: true`, Prebid.js 11.53.0 or later) when it's the request's host or a parent of it, else host-only: for one deployment serving many sites. See [Cookie domain `auto`](#cookie-domain-auto). Unset, every request gets a 500. |
| `SID_MAX_AGE_DAYS` | `365` | Cookie lifetime in days, 1 to 400 (browsers cap at 400). |
| `SID_CREATE` | `true` | Mint an ID when the request has none. With Prebid.js it always sends one, so this rarely matters. |
| `SID_RECOVERY_COOKIE` | `_pubcid_sv` | Name of the `HttpOnly` recovery copy; `none` to disable it. |
| `SID_OPTOUT_COOKIE` | `_pubcid_optout` | The opt-out cookie; Prebid.js reads `_pubcid_optout`. |
| `SID_VENDOR_ID` | (empty: publisher mode) | Your TCF vendor ID (1 to 65535), for vendor mode. |
| `SID_ALLOWED_ORIGINS` | none | Comma-separated origins (like `https://www.example.com`) allowed to read `/_sid/v1` from script on another origin. |
| `SID_SYNC_CACHE_SECONDS` | `86400` | How long a browser may reuse a sync response (privately). `0` re-syncs on every call. Also limits how often modules run on `/_sid/sync`, except a sync the `clickid` module runs on, which is never cached. |
| `SID_MODULES` | none | Comma-separated modules to run, in order. |
| `SID_SYNC_MODULES` | the modules in `SID_MODULES` that run on `/_sid/sync` | Comma-separated modules to run on `/_sid/sync`, each also in `SID_MODULES`, or `none`. |
| `SID_MODULE_CONFIG` | `{}` | JSON settings per module, keyed by module name. |
| `SID_MODULE_SECRETS` | `{}` | JSON secrets (strings) per module, keyed by module name, e.g. the `ec` passphrase. Set it as a platform secret (`wrangler secret put SID_MODULE_SECRETS`), not in plain settings. |
| `SID_MODULE_TIMEOUT_MS` | `50` | Time limit for each module, 1 to 10000. |
| `SID_SKIP_BOTS` | off | `verified`, `declared` or `likely`: set no SharedID for bots this sure or surer, from the traffic signal. Existing IDs are never deleted. |
| `SID_HOSTS` | none (one site) | Several sites from one deployment: JSON from hostname to that site's `SID_*` settings, which go on top of these, like `{"www.example.com":{"SID_COOKIE_DOMAIN":"example.com"}}`. A host that isn't listed gets a 404 and no cookies. Not `SID_MODULE_SECRETS`. See [Several sites from one deployment](#several-sites-from-one-deployment). |
| `SID_SKIP_BOTS_SCORE` | off | 1 to 99: set no SharedID when the traffic score (Cloudflare Bot Management) is at or below it. |
| `SID_UPSTREAM_SECRETS` | off | Trusted-upstream mode, for an endpoint behind a publisher's CDN (an upstream operator's): a JSON array of the shared secrets the CDN may send in `SID_UPSTREAM_AUTH_HEADER`, each at least 32 characters, like `["<openssl rand -hex 32>"]`. A request without one of them gets a 403 and no cookies; with one, the client IP, location and host come from the CDN's headers. Set it as a platform secret. Cloudflare Worker, AWS Lambda, Fastly Compute and Node.js only. See [Trusted upstream](#trusted-upstream-behind-a-publishers-cdn). |
| `SID_UPSTREAM_AUTH_HEADER` | `x-sid-upstream-auth` | With `SID_UPSTREAM_SECRETS`: the request header the publisher's CDN puts the secret in. |
| `SID_UPSTREAM_HOST_HEADER` | `x-forwarded-host` | With `SID_UPSTREAM_SECRETS`: the request header with the publisher's site hostname, which picks the site in `SID_HOSTS` and decides `Secure`. A missing header keeps the request's own host; one that isn't a single hostname gets a 400. |
| `SID_CLIENT_IP_HEADER` | none | With `SID_UPSTREAM_SECRETS`: the request header with the visitor's IP address, set by the publisher's CDN (`cloudfront-viewer-address` is read as `ip:port`, `x-forwarded-for` as its first entry). Unset, there's no client IP. Some adapters also read it without trusted upstream (Node.js with `SID_TRUST_PROXY`, Google Cloud): see their READMEs. |
| `SID_LOCATION_HEADERS` | none | With `SID_UPSTREAM_SECRETS`, **required**: JSON from location field to the request header the publisher's CDN sets it in, with at least `country`, like `{"country":"x-sid-country","regionCode":"x-sid-region"}`. Fields: `country`, `regionCode`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent`. Some adapters also read it without trusted upstream (Node.js with `SID_TRUST_PROXY`, Azure, Google Cloud): see their READMEs. |
<!-- generated:settings:end -->

More on some of them: [`SID_VENDOR_ID`](consent.md) (vendor mode), [`SID_MODULES`, `SID_SYNC_MODULES` and `SID_MODULE_CONFIG`](modules.md#choosing-modules), [`SID_SKIP_BOTS`](modules.md#no-sharedid-for-bots).

- **Module settings** go in `SID_MODULE_CONFIG` and `SID_MODULE_SECRETS`, keyed by module name; each module's README lists its own (see the [module index](modules.md#module-index)).
- **Platform settings,** such as the Node.js server's `SID_PUBLIC_ORIGIN` and `SID_TRUST_PROXY`, are in each adapter's README (see [Pick your platform](../README.md#pick-your-platform)).

Routes, under `SID_BASE_PATH`:

| Route | |
| --- | --- |
| `GET /_sid/sync?id=pubcid:<id>` | The `pixelUrl` endpoint: a 1×1 GIF with the cookies, including those of modules that run there. |
| `GET /_sid/v1` | JSON: the SharedID, its eid, and the modules' output. |
| `GET /_sid/optout`, `GET /_sid/optin` | Set or clear the opt-out cookie. |

The full behaviour is in the [specification](../spec/SPEC.md).

## Secure cookies

Cookies get `Secure` on https, and also when a public hostname arrives over plain http: that only happens when TLS ends in front of the worker (nginx, a load balancer, a CDN), and the visitor is on https. So a deployment behind a TLS-terminating proxy gets `Secure` cookies without any setting. `Secure` is left out only for plain http in local development, where browsers would drop a `Secure` cookie: `localhost`, an IP address, or a name under `.localhost`, `.test`, `.local`, `.internal`, `.example` or `.invalid` (with or without a trailing dot). A site served to visitors over plain http, without TLS anywhere, therefore can't keep SharedID Edge's cookies; serve it over https. `verify-deployment` checks that `_pubcid` is `Secure`.

## Cookie domain `auto`

`SID_COOKIE_DOMAIN=auto` lets Prebid.js say which domain to use, so one deployment can serve many sites without listing each site's domain: one Worker on many routes, a [hosting company](hosting-companies.md), or an [upstream operator](upstream-operators.md). It needs Prebid.js 11.53.0 or later, with `pixelCookieDomain: true` in the `sharedId` params ([Configure Prebid.js](prebid.md#cookie-domain-auto)):

- **What Prebid.js sends.** With `pixelCookieDomain: true`, the `pixelUrl` request carries `cookie_domain`, the domain Prebid.js writes `_pubcid` on: `example.com` on `www.example.com`. Prebid.js finds it by probing which domains the browser lets it set a cookie on, so it's the registrable domain, worked out by the browser's own Public Suffix List. The worker doesn't carry one.
- **What the worker checks.** It uses `cookie_domain` only when it's a hostname (no scheme, port or path; not an IP address; at least two labels) that is the request's host or a parent of it, compared without case or a trailing dot. `example.com` and `www.example.com` are fine for `www.example.com`; `ample.com`, `example.org` and `com` aren't. The `Domain` it sets is the lower-case value.
- **Which host.** The one the request is for: the site's own hostname, as `SID_HOSTS` sees it. Behind a publisher's CDN, in [trusted-upstream mode](#trusted-upstream-behind-a-publishers-cdn), that's the publisher's hostname from `X-Forwarded-Host` (`SID_UPSTREAM_HOST_HEADER`), read only once the secret has checked out, never the endpoint's own. Without trusted-upstream mode, a forwarding header the platform doesn't already trust is never used.
- **Otherwise, host-only.** No `cookie_domain` (Prebid.js before 11.53.0, `pixelCookieDomain` not set, or a page calling `/_sid/v1` without it), or one that fails the check, gives cookies without a `Domain`. On a normal site Prebid.js writes `_pubcid` on the registrable domain, so a host-only copy from the worker would sit next to it as a second `_pubcid`: turn `pixelCookieDomain` on. A page that calls `/_sid/v1` itself can add the same `cookie_domain`.
- **Opt-out and deletions.** `/_sid/optout` and `/_sid/optin` have no `cookie_domain`, so with `auto` they work on the host and every domain above it (`www.example.com`, `example.com`), and so do the deletions for GPC, COPPA and denied consent. A browser ignores a `Domain` that's a public suffix, so those are harmless.
- **Forged values do nothing.** A visitor can put any `cookie_domain` in the URL, but the worker only accepts the host or a parent of it, and the browser refuses a `Domain` that doesn't cover the page's host or is a public suffix (`co.uk`, `github.io`). At worst a forged value fails at the browser, as host-only would have.
- **Shared parent domains: use a fixed domain.** On a multi-tenant host where unrelated sites share a parent that isn't a public suffix (`site-a.platform.example` and `site-b.platform.example`, with `platform.example` not on the Public Suffix List), Prebid.js's probe finds the shared parent, and `auto` would put every site's ID on it. Set `SID_COOKIE_DOMAIN` to each site's own hostname, or `host-only`, there.
- **Per site.** `auto` works deployment-wide and in `SID_HOSTS` (`{"www.pub-a.example":{"SID_COOKIE_DOMAIN":"auto"}}`); a site's own fixed domain wins over a deployment-wide `auto`.
- **Modules.** Module settings that take a cookie domain (`reflect`'s `domain` and `keeper.domain`, `clickid`'s `domain`, `ec`'s `domain`) accept `"auto"` too, with the same rules, whatever `SID_COOKIE_DOMAIN` is. A module cookie without its own `domain` follows `SID_COOKIE_DOMAIN`, `auto` included.
- **Which one it chose.** With `auto`, `/_sid/sync` and `/_sid/v1` answer with `X-SharedID-Cookie-Domain`: the domain, `host-only: no cookie_domain`, or `host-only: cookie_domain not this host or a parent` ([Debugging headers](responses.md#debugging-headers)).

## Several sites from one deployment

A hosting company, or anyone serving several publishers' sites from the same platform account, can run one deployment for all of them ([SharedID Edge for hosting companies](hosting-companies.md) is the guide). `SID_HOSTS` lists each site's hostname with the settings that differ, on top of the deployment's own:

```json
{
  "www.pub-a.example": { "SID_COOKIE_DOMAIN": "pub-a.example" },
  "www.pub-b.example": { "SID_COOKIE_DOMAIN": "pub-b.example", "SID_MODULES": "geo", "SID_ALLOWED_ORIGINS": "https://news.pub-b.example" }
}
```

- **Which site:** the request's hostname, lower-cased, without the port. List every hostname a site answers on (`www.` and the bare domain, say); `SID_COOKIE_DOMAIN` is what makes them share the cookie.
- **Anything else gets a 404,** and no cookies: a hostname that reaches the deployment but isn't listed is answered as if SharedID Edge weren't there. `"SID_HOSTS": "{}"` turns that on with no sites listed, for a deployment whose sites all come from the platform (below).
- **Checked at start-up:** each site's settings are validated like a deployment's, so a mistake in one fails the deployment, naming the hostname. Each site needs `SID_COOKIE_DOMAIN`, its own or the deployment's. With Prebid.js 11.53.0 or later, a deployment-wide [`auto`](#cookie-domain-auto) saves listing each site's domain.
- **What can't vary:** `SID_BASE_PATH` (the route, CloudFront behaviour or middleware in front of the deployment is the same for every site), `SID_MODULE_SECRETS` (secrets stay in the platform's secret store, shared by every site) and `SID_HOSTS` itself. Modules are the deployment's: `SID_MODULES` per site chooses among those built in.
- **On Cloudflare for SaaS,** a custom hostname's [custom metadata](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/custom-metadata/) can carry its settings instead, under a `sharedid` key: `{"sharedid": {"SID_COOKIE_DOMAIN": "pub-a.example"}}`. Adding a site is then an API call, with no redeploy. See the [Cloudflare adapter](../packages/adapters/cloudflare/README.md#hosting-companies).
- **The request URL decides the site,** so each site's own hostname has to reach the handler. The Cloudflare Worker and Snippet see it, and the Node.js server does from the `Host` header your proxy passes. On the other adapters, check before relying on it: request `/_sid/v1` on each hostname, and a 404 means the deployment sees another host. Behind CloudFront, for example, the Lambda function sees its function URL's host unless `X-Forwarded-Host` carries the site's. Behind a publisher's CDN, [trusted-upstream mode](#trusted-upstream-behind-a-publishers-cdn) takes it from the CDN's `X-Forwarded-Host`. `SID_PUBLIC_ORIGIN`, where an adapter has it, replaces every request's host, so leave it unset.

## Trusted upstream: behind a publisher's CDN

An upstream operator can run one endpoint for many publishers, with each publisher's CDN passing `/_sid/*` to it. The browser still sees the publisher's hostname and IP addresses, so the cookies are first-party. Setting it up, with the configuration for each publisher CDN (CloudFront, Fastly, Akamai, Cloudflare, nginx and others), is in [SharedID Edge for upstream operators](upstream-operators.md). What the settings do:

- **The endpoint only trusts requests with the secret.** The publisher's CDN adds a header, `X-SID-Upstream-Auth` by default, holding one of the secrets in `SID_UPSTREAM_SECRETS`. A request without it, or with a wrong or repeated one, gets a `403 Forbidden` and no cookies, whatever its path. Nothing about the request is logged. Without the secret, nobody can call the endpoint directly with a made-up country, IP address or site.
- **Each secret is a JSON array entry,** like `["<first>", "<second>"]`: 32 to 256 letters, digits or `-._~+/=` (`openssl rand -hex 32` makes one). Any of them is accepted for any site, so you can give each publisher its own (and remove one publisher's without touching the others), or add a new secret before removing the old one when you rotate. Keep it in the platform's secret store: a Worker secret, a Lambda parameter that isn't echoed, Fastly's secret store, or the Node.js server's environment. It's never shown in errors or logs.
- **The visitor's IP address and location come from the CDN's headers,** and only those: `SID_CLIENT_IP_HEADER` (one IPv4 or IPv6 address; none when it's missing or anything else) and `SID_LOCATION_HEADERS`, which must name the country's header, since the country decides whether GDPR applies to a request without a TC string ([Consent](consent.md)). The endpoint's own platform data (Cloudflare's `CF-Connecting-IP` and `request.cf`, CloudFront's `CloudFront-Viewer-*`, Fastly's client data) describe the publisher's CDN, so they're ignored, as is the platform's bot verdict.
- **The site comes from `X-Forwarded-Host`** (`SID_UPSTREAM_HOST_HEADER`): its hostname becomes the request's, which picks the publisher's settings in [`SID_HOSTS`](#several-sites-from-one-deployment), is what [`SID_COOKIE_DOMAIN=auto`](#cookie-domain-auto) checks `cookie_domain` against, and makes cookies `Secure` on a public hostname ([Secure cookies](#secure-cookies)). It must be one hostname, with or without a port; anything else, a list included, gets a `400`. A request without it keeps the endpoint's own hostname, which `SID_HOSTS` normally doesn't list, so it gets a 404.
- **Header names** all start with `x-` and differ from each other: a name the endpoint's own platform sets (`cf-connecting-ip`, `cloudfront-viewer-country`, `true-client-ip`) would describe the CDN, and `X-Forwarded-For` is a list proxies append to. The CDN must set these headers on every `/_sid/*` request, overwriting any a visitor sent.
- **The secret header is removed** before modules run, so no module can see or forward it.
- **Where it runs:** the Cloudflare Worker, AWS Lambda, Fastly Compute and the Node.js server. The Cloudflare Snippet build refuses it (a Snippet has no secrets), and so do the Vercel, Azure Functions, Google Cloud and Akamai adapters: setting `SID_UPSTREAM_SECRETS`, `SID_UPSTREAM_AUTH_HEADER` or `SID_UPSTREAM_HOST_HEADER` there makes every request a 500, and the log names the setting.
- **None of these settings can vary by site** in `SID_HOSTS`: they belong to the endpoint.

```json
{
  "SID_UPSTREAM_SECRETS": "[\"<publisher A's secret>\", \"<publisher B's secret>\"]",
  "SID_CLIENT_IP_HEADER": "x-sid-client-ip",
  "SID_LOCATION_HEADERS": "{\"country\":\"x-sid-country\",\"regionCode\":\"x-sid-region\"}",
  "SID_HOSTS": "{\"www.pub-a.com\":{\"SID_COOKIE_DOMAIN\":\"pub-a.com\"},\"www.pub-b.com\":{\"SID_COOKIE_DOMAIN\":\"pub-b.com\"}}"
}
```
