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
PORT=8787 SID_PUBLIC_ORIGIN=https://www.example.com SID_TRUST_PROXY=true node packages/adapters/node/dist/cli.js
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
- **Behind Cloudflare, with an origin running this server:** enable Cloudflare's **"Add visitor location headers"** managed transform if you want the `geo` module. Cloudflare sends `cf-ipcountry`, `cf-ipcity` and the rest, which the server reads with `SID_TRUST_PROXY`. Make sure only Cloudflare can reach your origin, or visitors could send those headers themselves.
- **Process management:** run it under systemd, in a container, or with another process manager, like any Node.js service. It needs Node.js 24 or later.

## Configuration and secrets

From the environment:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | Listening port. |
| `HOST` | `127.0.0.1` | Listening address. Keep it local behind a proxy. |
| `SID_PUBLIC_ORIGIN` | `http://<Host header>` | Your public origin, for example `https://www.example.com`. TLS ends at your proxy, so set this for cookies to be `Secure`. |
| `SID_TRUST_PROXY` | `false` | Trust the proxy's headers: the client IP from the first `X-Forwarded-For` entry, and location from Cloudflare's visitor location headers. Only behind a proxy that overwrites them. |
| `SID_*` | | Every core setting, as in the [Configuration reference](../../../docs/configuration.md). |
| `SID_MODULE_SECRETS` | `{}` | Module secrets, such as the `ec` passphrase. Supply it from your secret store (systemd `LoadCredential`, a container secret, and so on), not a committed file. |

Invalid settings stop the server at start-up with `Configuration error: …`.

## Platform data: what the server knows about each request

| `PlatformInfo` | Without `SID_TRUST_PROXY` | With `SID_TRUST_PROXY=true` |
| --- | --- | --- |
| `clientIp` | The socket's remote address (your proxy's, if there is one) | The first `X-Forwarded-For` entry |
| `country`, `region` | none | `cf-ipcountry`, `cf-region-code` |
| `city`, `postalCode`, `metroCode` | none | `cf-ipcity` (UTF-8 decoded), `cf-postal-code`, `cf-metro-code` |
| `latitude`, `longitude` | none | `cf-iplatitude`, `cf-iplongitude` |
| `timezone`, `continent` | none | `cf-timezone`, `cf-ipcontinent` |
| `isEU` | none | none: GDPR scope then comes from the `gdpr` parameter |
| `traffic` | none | none: there is no platform bot verdict; the `bot` module and other modules still report to the traffic signal |

Core's `locationInfo` validates the values the same way for every adapter, dropping empty, `XX`/`T1` and out-of-range ones. IPv4 clients on a dual-stack socket appear as `::ffff:192.0.2.1`, which the `ip` module reports as IPv4.

## Built-in modules

The CLI builds in `ip`, `ec`, `geo`, `reflect`, `bot` and `ua`, from the list every adapter shares ([`@sharedid-edge/modules`](../../modules/all/README.md)). They do nothing until listed in `SID_MODULES`. See the [Modules](../../../docs/modules.md).

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
| Cookies aren't `Secure` | `SID_PUBLIC_ORIGIN` isn't set to your https origin. |
| `ip` returns your proxy's address | Set `SID_TRUST_PROXY=true`, and have the proxy overwrite `X-Forwarded-For`. |
| `geo` returns nothing | No Cloudflare location headers reach the server, or `SID_TRUST_PROXY` is off. |
| Visitors share one ID or one cookie | Something caches `/_sid/` responses. Turn caching off for that path. |
| `verify-deployment` says the IPs differ | `/_sid/` is served from a different host or IP than your pages. Route it through the same proxy. |
