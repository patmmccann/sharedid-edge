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
- **Or name the CDN's client-IP header.** CDNs such as CloudFront append the connecting address to `X-Forwarded-For` rather than overwrite it, so its first entry is whatever the visitor sent. Set `SID_CLIENT_IP_HEADER` to the CDN's own client-IP header instead (see [Per CDN](#per-cdn)); the server then ignores `X-Forwarded-For`. The client IP feeds the `ip` module and IP-based vendor modules such as `ec`, not consent.
- **No shared cache:** neither a CDN nor `proxy_cache` may store `/_sid/` responses; they carry per-visitor cookies.
- **Pass the visitor's country on.** Without a `gdpr` signal, GDPR applies when the visitor is in the EU, and the server knows that only from its location headers. With no country, GDPR's scope is unknown and storage is allowed, so an EU visitor without a TC string would get cookies ([Consent](../../../docs/consent.md)). It also feeds the `geo` module.
  - **Behind Cloudflare,** with an origin running this server: enable Cloudflare's **"Add visitor location headers"** managed transform. Cloudflare sends `cf-ipcountry`, `cf-ipcity` and the rest, which the server reads with `SID_TRUST_PROXY` by default.
  - **Behind another CDN,** point `SID_LOCATION_HEADERS` at the CDN's own headers (see [Per CDN](#per-cdn)).
  - Either way, the proxy must **overwrite** these headers on every request, and only it may reach the server, or visitors could send them themselves.
  - **Check it** from an EU location without a TC string: `/_sid/sync` should set no cookie.

### Per CDN

Every row needs `SID_TRUST_PROXY=true`, and the server reachable only through the CDN (a firewall or private network, or a secret header the CDN adds and your proxy checks).

| In front | `SID_CLIENT_IP_HEADER` | `SID_LOCATION_HEADERS` | In the CDN's configuration |
| --- | --- | --- | --- |
| nginx, or another proxy that overwrites `X-Forwarded-For` | unset (the first `X-Forwarded-For` entry) | Whatever headers carry the country, if any | `proxy_set_header X-Forwarded-For $remote_addr;` as above |
| Cloudflare | `cf-connecting-ip` (Cloudflare appends to an `X-Forwarded-For` the visitor sent) | unset (Cloudflare's `cf-*` headers) | The "Add visitor location headers" managed transform |
| Amazon CloudFront | `cloudfront-viewer-address` | `{"country":"cloudfront-viewer-country","regionCode":"cloudfront-viewer-country-region"}` | Add `CloudFront-Viewer-Address`, `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` to the behaviour's origin request policy; CloudFront only sends them when the policy includes them |
| Fastly | `fastly-client-ip` | `{"country":"<your header>"}` | In VCL, on the edge, overwrite `Fastly-Client-IP` with `client.ip` (a visitor can send their own) and set your country header from `client.geo.country_code` |
| Akamai | `true-client-ip` | `{"country":"<your header>"}` | Turn on the True Client IP header, with clients not allowed to set it, and set your country header from EdgeScape's country in a property rule |

`SID_CLIENT_IP_HEADER` takes the header's value as an IP address. `CloudFront-Viewer-Address` is read as CloudFront writes it, `ip:port` (`198.51.100.10:46532`, or for IPv6 `2001:db8::1:46532`, the port after the last colon). When the header is missing or isn't a valid IP, the request has no client IP (the `ip` module returns nothing): the server never falls back to `X-Forwarded-For`, which the visitor controls.

These settings are tested against a local stand-in for a CDN that overwrites these headers and appends to `X-Forwarded-For` (`test/proxy.test.ts`), not against the CDNs themselves: after deploying, check `/_sid/v1` with the `ip` and `geo` modules on from a known location.
- **Process management:** run it under systemd, in a container, or with another process manager, like any Node.js service. It needs Node.js 24 or later.

## Configuration and secrets

From the environment:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | Listening port. |
| `HOST` | `127.0.0.1` | Listening address. Keep it local behind a proxy. |
| `SID_PUBLIC_ORIGIN` | `http://<Host header>` | Your public origin, for example `https://www.example.com`. TLS ends at your proxy, so the server sees http; cookies are `Secure` anyway for a public hostname (see [Secure cookies](../../../docs/configuration.md#secure-cookies)), so this is optional. Set it to make request URLs, and so what modules see, match the visitor's. |
| `SID_TRUST_PROXY` | `false` | Trust the proxy's headers: the client IP from the first `X-Forwarded-For` entry (or `SID_CLIENT_IP_HEADER`), and the location from `SID_LOCATION_HEADERS`. Only behind a proxy that overwrites them. |
| `SID_CLIENT_IP_HEADER` | unset (`X-Forwarded-For`) | The proxy's own client-IP header, used instead of `X-Forwarded-For` behind a CDN that appends to it: `cloudfront-viewer-address` (read as `ip:port`), `fastly-client-ip`, `true-client-ip`, `cf-connecting-ip`. Its value must be an IP address; a missing or invalid one gives no client IP. Needs `SID_TRUST_PROXY=true`. See [Per CDN](#per-cdn). |
| `SID_LOCATION_HEADERS` | Cloudflare's visitor location headers (`cf-ipcountry` and the rest) | JSON: location field → the request header it comes from, for a proxy other than Cloudflare, like `{"country":"cloudfront-viewer-country"}`. Fields: `country`, `regionCode`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent`; a field left out isn't read. Needs `SID_TRUST_PROXY=true`. An invalid value is a configuration error. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), or `host-only`. Without it the server doesn't start. |
| `SID_*` | | Every other core setting, as in the [Configuration reference](../../../docs/configuration.md). |
| `SID_MODULE_PACKAGES` | none | Opt-in modules to add to the built-in ones, comma-separated, each `<package>#<export>`, like `@sharedid-edge/module-ec#ecModule`: `ec` and [vendor modules](../../vendor-modules/README.md). Each package must be installed next to the server. A missing package or export stops the server at start-up. |
| `SID_MODULE_SECRETS` | `{}` | Module secrets, such as the `ec` passphrase. Supply it from your secret store (systemd `LoadCredential`, a container secret, and so on), not a committed file. |

Invalid settings stop the server at start-up with `Configuration error: …`.

## Platform data: what the server knows about each request

| `PlatformInfo` | Without `SID_TRUST_PROXY` | With `SID_TRUST_PROXY=true` (the default headers; `SID_LOCATION_HEADERS` replaces them) |
| --- | --- | --- |
| `clientIp` | The socket's remote address (your proxy's, if there is one) | The first `X-Forwarded-For` entry; with `SID_CLIENT_IP_HEADER`, that header instead (the address in `CloudFront-Viewer-Address`'s `ip:port`), or none when it's missing or not an IP address |
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
  clientIpHeader: 'cloudfront-viewer-address', // optional: SID_CLIENT_IP_HEADER
  publicOrigin: 'https://www.example.com'
}).listen(8787, '127.0.0.1');
```

`createNodeServer` returns a plain `node:http` `Server`. Repeated `Set-Cookie` headers are sent separately.

The conversion is exported too, for platforms that hand you Node.js requests (or Express's, like Google Cloud's Functions Framework, which [`@sharedid-edge/gcp-functions`](../gcp-functions/README.md) uses): `toWebRequest(req, origin)` builds a `Request` with that origin, `sendWebResponse(res, response, method)` writes a `Response` with each `Set-Cookie` separate, and `utf8(value)` re-decodes a header value Node.js read as Latin-1. `clientIpFromHeader(name, value)` reads a client-IP header as `clientIpHeader` does.

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
| `ip` returns an address the visitor chose (send `X-Forwarded-For: 198.51.100.1` and it comes back), or the CDN's | The CDN appends to `X-Forwarded-For` (CloudFront and Cloudflare do), so its first entry is the visitor's own. Set `SID_CLIENT_IP_HEADER` to the CDN's client-IP header ([Per CDN](#per-cdn)). |
| `ip` returns nothing with `SID_CLIENT_IP_HEADER` set | The header doesn't reach the server (CloudFront: add `CloudFront-Viewer-Address` to the origin request policy), or its value isn't an IP address. |
| `geo` returns nothing | No location headers reach the server (Cloudflare's, or those in `SID_LOCATION_HEADERS`), or `SID_TRUST_PROXY` is off. |
| EU visitors without consent get cookies | The server doesn't know their country: pass it on (see [Deploy behind your proxy](#deploy-behind-your-proxy)). |
| Visitors share one ID or one cookie | Something caches `/_sid/` responses. Turn caching off for that path. |
| `verify-deployment` says the IPs differ | `/_sid/` is served from a different host or IP than your pages. Route it through the same proxy. |
