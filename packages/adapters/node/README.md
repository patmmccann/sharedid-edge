# @sharedid-edge/node

SharedID Edge as a **Node.js HTTP server**, for self-hosting behind the web server or load balancer that already serves your site. It's also used for local development and as a conformance target. This page is the full guide. The other platforms are listed under [Pick your platform](../../../README.md#pick-your-platform).

## Contents

- [Architecture](#architecture)
- [Build and run](#build-and-run)
- [Deploy behind your proxy](#deploy-behind-your-proxy)
- [Configuration and secrets](#configuration-and-secrets)
- [Platform data: what the server knows about each request](#platform-data-what-the-server-knows-about-each-request)
- [Built-in modules](#built-in-modules)
- [Using it as a library](#using-it-as-a-library)
- [Verify](#verify)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ──► www.example.com (your proxy: nginx, a load balancer, or a CDN)
              ├─ /_sid/*  ──► this server (e.g. 127.0.0.1:8787) ──► response with Set-Cookie
              └─ anything else ──► your application, as before
```

- **Same host and IPs:** the server must answer on your site's own hostname and IP addresses. That's why it sits behind the proxy that serves your pages, routed by path. Safari caps cookies set by servers whose IP doesn't match the site's.
- **Stateless:** it stores nothing and logs nothing about requests. It writes one line at start-up, and an error's name (never request data) if a request fails.
- **Contents:** `src/index.ts` (`createNodeServer`: converts Node's request and response to fetch `Request`/`Response`, and fills `PlatformInfo`) and `src/cli.ts` (the `sharedid-edge-node` command, configured from the environment).

## Build and run

```sh
npm ci
npm run build
PORT=8787 SID_COOKIE_DOMAIN=example.com SID_PUBLIC_ORIGIN=https://www.example.com SID_TRUST_PROXY=true node packages/adapters/node/dist/cli.js
# sharedid-edge listening on http://127.0.0.1:8787/_sid/
```

## Deploy behind your proxy

Forward `/_sid/` to the server, and make sure nothing caches it. With nginx:

```nginx
location /_sid/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, don't append: the server takes the first entry
    proxy_cache off;
}
```

- **Overwrite `X-Forwarded-For`:** use `$remote_addr`, not `$proxy_add_x_forwarded_for`. Appending keeps whatever the visitor sent first, and that's the entry the server trusts.
- **No shared cache:** neither a CDN nor `proxy_cache` may store `/_sid/` responses; they carry per-visitor cookies.
- **Pass the visitor's country on.** Without a `gdpr` signal, GDPR applies when the visitor is in the EU, and the server knows that only from its location headers. With no country, GDPR's scope is unknown and storage is allowed, so an EU visitor without a TC string would get cookies ([Consent](../../../docs/consent.md)). It also feeds the `geo` module.
  - **Behind Cloudflare,** with an origin running this server: enable Cloudflare's **"Add visitor location headers"** managed transform. Cloudflare sends `cf-ipcountry`, `cf-ipcity` and the rest, which the server reads with `SID_TRUST_PROXY` by default.
  - **Behind another CDN,** point `SID_LOCATION_HEADERS` at the CDN's own headers. CloudFront: `{"country":"cloudfront-viewer-country","regionCode":"cloudfront-viewer-country-region"}`, with those headers added to the origin request policy. Fastly or Akamai: a header your configuration sets from `client.geo.country_code` or EdgeScape's country.
  - Either way, the proxy must **overwrite** these headers on every request, and only it may reach the server, or visitors could send them themselves.
  - **Check it** from an EU location without a TC string: `/_sid/sync` should set no cookie.
- **Process management:** run it under systemd, in a container, or with another process manager, like any Node.js service. It needs Node.js 24 or later.

## Configuration and secrets

From the environment:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | Listening port. |
| `HOST` | `127.0.0.1` | Listening address. Keep it local behind a proxy. |
| `SID_PUBLIC_ORIGIN` | `http://<Host header>` | Your public origin, for example `https://www.example.com`. TLS ends at your proxy, so the server sees http; cookies are `Secure` anyway for a public hostname (see [Secure cookies](../../../docs/configuration.md#secure-cookies)), so this is optional. Set it to make request URLs, and so what modules see, match the visitor's. |
| `SID_TRUST_PROXY` | `false` | Trust the proxy's headers: the client IP from the first `X-Forwarded-For` entry, and the location from `SID_LOCATION_HEADERS`. Only behind a proxy that overwrites them. |
| `SID_LOCATION_HEADERS` | Cloudflare's visitor location headers (`cf-ipcountry` and the rest) | JSON: location field → the request header it comes from, for a proxy other than Cloudflare, like `{"country":"cloudfront-viewer-country"}`. Fields: `country`, `regionCode`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent`; a field left out isn't read. Needs `SID_TRUST_PROXY=true`. An invalid value is a configuration error. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), or `host-only`. Without it the server doesn't start. |
| `SID_*` | | Every other core setting, as in the [Configuration reference](../../../docs/configuration.md). |
| `SID_MODULE_PACKAGES` | none | Opt-in modules to add to the built-in ones, comma-separated, each `<package>#<export>`, like `@sharedid-edge/module-ec#ecModule`: `ec` and [vendor modules](../../vendor-modules/README.md). Each package must be installed next to the server. A missing package or export stops the server at start-up. |
| `SID_MODULE_SECRETS` | `{}` | Module secrets, such as the `ec` passphrase. Supply it from your secret store (systemd `LoadCredential`, a container secret, and so on), not a committed file. |

Invalid settings stop the server at start-up with `Configuration error: …`.

## Platform data: what the server knows about each request

| `PlatformInfo` | Without `SID_TRUST_PROXY` | With `SID_TRUST_PROXY=true` (the default headers; `SID_LOCATION_HEADERS` replaces them) |
| --- | --- | --- |
| `clientIp` | The socket's remote address (your proxy's, if there is one) | The first `X-Forwarded-For` entry |
| `country`, `region` | none | `cf-ipcountry`, `cf-region-code` |
| `city`, `postalCode`, `metroCode` | none | `cf-ipcity` (UTF-8 decoded), `cf-postal-code`, `cf-metro-code` |
| `latitude`, `longitude` | none | `cf-iplatitude`, `cf-iplongitude` |
| `timezone`, `continent` | none | `cf-timezone`, `cf-ipcontinent` |
| `isEU` | none | From the country: one of the 27 EU member states. Without a `gdpr` parameter, it decides whether GDPR applies |
| `traffic` | none | none: there is no platform bot verdict; the `bot` module and other modules still report to the traffic signal |

Core's `locationInfo` validates the values the same way for every adapter, dropping empty, `XX`/`T1` and out-of-range ones. IPv4 clients on a dual-stack socket appear as `::ffff:192.0.2.1`, which the `ip` module reports as IPv4.

## Built-in modules

The CLI builds in `ip`, `geo`, `reflect`, `bot` and `ua`, from the list every adapter shares ([`@sharedid-edge/modules`](../../modules/all/README.md)). They do nothing until listed in `SID_MODULES`. See the [Modules](../../../docs/modules.md).

The server isn't bundled, so its `ua` module always has [Bowser](../../modules/ua/README.md#full-parsing-with-bowser) (from `@sharedid-edge/modules/bowser`): `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns on full `User-Agent` parsing with no build step.

## Using it as a library

```ts
import { createNodeServer } from '@sharedid-edge/node';
import { resolveConfig } from '@sharedid-edge/core';
import { ipModule } from '@sharedid-edge/module-ip';

createNodeServer({
  config: resolveConfig(process.env),
  modules: [ipModule],
  trustProxy: true,
  publicOrigin: 'https://www.example.com'
}).listen(8787, '127.0.0.1');
```

`createNodeServer` returns a plain `node:http` `Server`. Repeated `Set-Cookie` headers are sent separately.

The conversion is exported too, for platforms that hand you Node.js requests (or Express's, like Google Cloud's Functions Framework, which [`@sharedid-edge/gcp-functions`](../gcp-functions/README.md) uses): `toWebRequest(req, origin)` builds a `Request` with that origin, `sendWebResponse(res, response, method)` writes a `Response` with each `Set-Cookie` separate, and `utf8(value)` re-decodes a header value Node.js read as Latin-1.

## Verify

```sh
npm run verify-deployment -- --site https://www.example.com
curl -s https://www.example.com/_sid/v1 | jq .
```

Locally, `npm run conformance` runs the whole conformance suite against this server.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Cookies aren't `Secure` | The server sees a local host (`localhost`, an IP address, or a `.test`/`.local` name): the proxy isn't passing the public `Host`. Pass it, or set `SID_PUBLIC_ORIGIN` to your https origin. |
| `ip` returns your proxy's address | Set `SID_TRUST_PROXY=true`, and have the proxy overwrite `X-Forwarded-For`. |
| `geo` returns nothing | No location headers reach the server (Cloudflare's, or those in `SID_LOCATION_HEADERS`), or `SID_TRUST_PROXY` is off. |
| EU visitors without consent get cookies | The server doesn't know their country: pass it on (see [Deploy behind your proxy](#deploy-behind-your-proxy)). |
| Visitors share one ID or one cookie | Something caches `/_sid/` responses. Turn caching off for that path. |
| `verify-deployment` says the IPs differ | `/_sid/` is served from a different host or IP than your pages. Route it through the same proxy. |
