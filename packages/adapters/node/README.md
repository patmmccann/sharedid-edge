# @sharedid-edge/node

SharedID Edge as a **Node.js HTTP server**, for self-hosting behind the web server or load balancer that already serves your site. It's also used for local development and as a conformance target. This page is the full guide. The other platforms are listed under [Pick your platform](../../../README.md#pick-your-platform).

## Contents

- [Architecture](#architecture)
- [Build and run](#build-and-run)
- [Deploy behind your proxy](#deploy-behind-your-proxy)
- [Run in a container](#run-in-a-container)
- [Configuration and secrets](#configuration-and-secrets)
- [Platform data: what the server knows about each request](#platform-data-what-the-server-knows-about-each-request)
- [Built-in modules](#built-in-modules)
- [Using it as a library](#using-it-as-a-library)
- [Scheduled data updates](#scheduled-data-updates)
- [Verify](#verify)
- [Live tests](#live-tests)
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
- **Pass the visitor's country on.** Without a `gdpr` signal, GDPR applies when the visitor is in the EU, the rest of the EEA, the UK or Turkey, and the server knows that only from its location headers. With no country, GDPR's scope is unknown and storage is allowed, so such a visitor without a TC string would get cookies ([Consent](../../../docs/consent.md)). It also feeds the `geo` module.
  - **Behind Cloudflare,** with an origin running this server: enable Cloudflare's **"Add visitor location headers"** managed transform. Cloudflare sends `cf-ipcountry`, `cf-ipcity` and the rest, which the server reads with `SID_TRUST_PROXY` by default.
  - **Behind another CDN,** point `SID_LOCATION_HEADERS` at the CDN's own headers (see [Per CDN](#per-cdn)).
  - Either way, the proxy must **overwrite** these headers on every request, and only it may reach the server, or visitors could send them themselves.
  - **Check it** from an EU, EEA, UK or Turkish location without a TC string: `/_sid/sync` should set no cookie.

### Per CDN

Every row needs `SID_TRUST_PROXY=true`, and the server reachable only through the CDN (a firewall or private network, or a secret header the CDN adds and your proxy checks).

| In front | `SID_CLIENT_IP_HEADER` | `SID_LOCATION_HEADERS` | In the CDN's configuration |
| --- | --- | --- | --- |
| nginx, or another proxy that overwrites `X-Forwarded-For` | unset (the first `X-Forwarded-For` entry) | Whatever headers carry the country, if any | `proxy_set_header X-Forwarded-For $remote_addr;` as above |
| Cloudflare | `cf-connecting-ip` (Cloudflare appends to an `X-Forwarded-For` the visitor sent) | unset (Cloudflare's `cf-*` headers) | The "Add visitor location headers" managed transform |
| Amazon CloudFront | `cloudfront-viewer-address` | `{"country":"cloudfront-viewer-country","regionCode":"cloudfront-viewer-country-region"}` | Add `CloudFront-Viewer-Address`, `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` to the behaviour's origin request policy; CloudFront only sends them when the policy includes them |
| Fastly | `fastly-client-ip` | `{"country":"<your header>"}` | Prefer the [Fastly Compute adapter](../fastly/README.md), which needs no server and reads the client address and Fastly's location directly. With this server: in VCL, on the edge, overwrite `Fastly-Client-IP` with `client.ip` (a visitor can send their own) and set your country header from `client.geo.country_code` |
| Akamai | `true-client-ip` | `{"country":"<your header>"}` | Turn on the True Client IP header, with clients not allowed to set it, and set your country header from EdgeScape's country in a property rule |

`SID_CLIENT_IP_HEADER` takes the header's value as an IP address. `CloudFront-Viewer-Address` is read as CloudFront writes it, `ip:port` (`198.51.100.10:46532`, or for IPv6 `2001:db8::1:46532`, the port after the last colon). When the header is missing or isn't a valid IP, the request has no client IP (the `ip` module returns nothing): the server never falls back to `X-Forwarded-For`, which the visitor controls.

These settings are tested against a local stand-in for a CDN that overwrites these headers and appends to `X-Forwarded-For` (`test/proxy.test.ts`), not against the CDNs themselves: after deploying, check `/_sid/v1` with the `ip` and `geo` modules on from a known location.
### Trusted upstream

`SID_TRUST_PROXY` trusts whatever reaches the server, so the server must be reachable only through your proxy. A server that more than one proxy reaches over the internet, such as an upstream operator's behind each publisher's CDN ([SharedID Edge for upstream operators](../../../docs/upstream-operators.md)), uses trusted-upstream mode instead: each CDN sends a shared secret in `X-SID-Upstream-Auth`, and the server trusts the CDN's headers only on requests with one of the secrets in `SID_UPSTREAM_SECRETS`. Anything else gets `403 Forbidden` and no cookies.

```sh
SID_UPSTREAM_SECRETS='["<publisher A secret>","<publisher B secret>"]' \
SID_CLIENT_IP_HEADER=x-sid-client-ip \
SID_LOCATION_HEADERS='{"country":"x-sid-country"}' \
SID_HOSTS='{"www.pub-a.com":{"SID_COOKIE_DOMAIN":"pub-a.com"},"www.pub-b.com":{"SID_COOKIE_DOMAIN":"pub-b.com"}}' \
HOST=0.0.0.0 node packages/adapters/node/dist/cli.js
```

- The client IP and location come only from the headers `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` name, which must start with `x-` (not `X-Forwarded-For`), and `SID_LOCATION_HEADERS` must name the country's. With no client-IP header there's no client IP, never the connection's.
- The site comes from `X-Forwarded-Host` (`SID_UPSTREAM_HOST_HEADER`), or from `Host` when the CDN doesn't send it.
- `SID_TRUST_PROXY` isn't needed, and doesn't change anything for requests with the secret.
- Keep the secrets in your secret manager, not a committed file. Put TLS in front of the server: the secret travels in a header.

- **Process management:** run it under systemd, in a container ([Run in a container](#run-in-a-container)), or with another process manager, like any Node.js service. It needs Node.js 24 or later.
- **Beside server-side Google Tag Manager:** the server and Google's tagging server image can run side by side behind the same proxy; see the [docker-compose example](../../../docs/sgtm.md#both-in-containers-with-docker-compose).

## Run in a container

The image `ghcr.io/patmmccann/sharedid-edge-node` runs this server, for Docker, Kubernetes, Amazon ECS, Google Cloud Run or a VM. It's published for `linux/amd64` and `linux/arm64` on every release, tagged with the version (`1.2.3`, `1.2`, `latest`), with signed build provenance (`gh attestation verify oci://ghcr.io/patmmccann/sharedid-edge-node:<tag> -R patmmccann/sharedid-edge`). Or build it from a checkout:

```sh
docker build -f packages/adapters/node/Dockerfile -t sharedid-edge-node .
```

The same rules apply as outside a container: it answers on your site's own hostname and IP addresses, behind the proxy that serves your pages, which overwrites `X-Forwarded-For` and caches nothing under `/_sid/` ([Deploy behind your proxy](#deploy-behind-your-proxy)). Never publish its port to the internet on a hostname of its own, except as an upstream operator's endpoint in [trusted-upstream mode](#trusted-upstream), with TLS in front.

```sh
docker run -d --name sharedid-edge --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e SID_COOKIE_DOMAIN=example.com \
  -e SID_PUBLIC_ORIGIN=https://www.example.com \
  -e SID_TRUST_PROXY=true \
  ghcr.io/patmmccann/sharedid-edge-node:latest
```

and nginx on the same machine with the snippet above (`proxy_pass http://127.0.0.1:8787;`).

**With docker compose**, [`examples/docker-compose.yml`](examples/docker-compose.yml) runs the image behind nginx on one hostname: [`examples/nginx.conf`](examples/nginx.conf) is the snippet above with the container's name, and everything outside `/_sid/` is your site (static files in `examples/site/` there). `SID_COOKIE_DOMAIN=example.com docker compose up -d` in `examples/`, then `curl -s http://localhost:8080/_sid/v1`. Put TLS in front of nginx, or in it, as for the rest of your site.

What the image does:

| | |
| --- | --- |
| **Listening** | `HOST=0.0.0.0` (every interface of the container, unlike the CLI's `127.0.0.1`), `PORT=8787`. Publish it only to your proxy: `-p 127.0.0.1:8787:8787`, a private network, or the compose network. |
| **Settings** | Every `SID_*` setting from the environment, as above ([Configuration and secrets](#configuration-and-secrets)). |
| **Secrets** | `SID_MODULE_SECRETS_FILE` and `SID_UPSTREAM_SECRETS_FILE` name files holding `SID_MODULE_SECRETS` and `SID_UPSTREAM_SECRETS`, for Docker and Kubernetes secrets (`/run/secrets/<name>`); a trailing newline is dropped. Prefer them to the plain variables, which show in `docker inspect`. |
| **Fails fast** | Invalid settings, or a secret file that can't be read, stop the container at start-up with `Configuration error: …` on stderr and exit code 1, before it listens, so a misconfigured deployment never serves cookies. A restart policy keeps restarting it; `docker logs` shows why. |
| **Health check** | `GET /healthz` on its own port, `HEALTH_PORT=8788`, answers `200 ok` once the server has started (so its settings were valid), and the image's `HEALTHCHECK` calls it. The public port stays exactly SharedID Edge's routes: `/healthz` there is a 404, and a probe never mints an ID. Point Kubernetes' liveness and readiness probes at `httpGet: { path: /healthz, port: 8788 }`; don't route it through your proxy. `HEALTH_PORT=` (empty) turns it off; then run with `--no-healthcheck`. |
| **User** | The official Node.js image's `node` user, `1000:1000`, not root. The server writes nothing, so a read-only root filesystem works (`--read-only`, `readOnlyRootFilesystem: true`), as do `--cap-drop ALL` and `no-new-privileges`. |
| **Stopping** | `SIGTERM` (`docker stop`, a Kubernetes rollout) closes the listeners and exits with 0 once requests in flight finish, within 10 seconds. |
| **Modules** | The built-in modules, with Bowser, and every opt-in module this project ships: `ec`, `cmp`, `gpp`, `encrypted-ip`, `tag-gateway` and the vendor modules `dbip`, `ip2location` and `maxmind`, each off until listed in `SID_MODULE_PACKAGES` and `SID_MODULES` ([Configuration and secrets](#configuration-and-secrets)). A module from elsewhere needs an image of your own: `FROM ghcr.io/patmmccann/sharedid-edge-node`, then install it in `/app` with npm. |
| **Size** | About 60 MB uncompressed, almost all of it the `node:24-alpine` base; the server and its modules are about 2.5 MB. CI fails the build over 100 MB. |
| **Not included** | The [`sharedid-edge-update` command](../../../docs/data-updates.md#nodejs-cron-or-a-systemd-timer) for scheduled data updates, which needs the AWS SDK: run it from its own job. |
| **Labels** | OCI labels with the source repository, version, commit, build date and licence (`Apache-2.0`). |

**Tested:** CI builds the image on every pull request, checks its size, user, start-up failure, health check and `SIGTERM`, runs the whole conformance suite against it behind a real nginx configured with the snippet above (`npm run conformance:docker`, which needs Docker), and runs the browser tests in Chromium, Firefox and WebKit against [`examples/docker-compose.yml`](examples/docker-compose.yml) as written, with nginx serving the test page. See [How SharedID Edge is verified](../../../docs/verification.md).

## Configuration and secrets

From the environment:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | Listening port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the container image) | Listening address. Keep it local behind a proxy. |
| `HEALTH_PORT` | unset (`8788` in the container image) | A second listener answering only `GET /healthz` with `200 ok`, for health checks and probes ([Run in a container](#run-in-a-container)). Must differ from `PORT`. |
| `SID_PUBLIC_ORIGIN` | `http://<Host header>` | Your public origin, for example `https://www.example.com`. TLS ends at your proxy, so the server sees http; cookies are `Secure` anyway for a public hostname (see [Secure cookies](../../../docs/configuration.md#secure-cookies)), so this is optional. Set it to make request URLs, and so what modules see, match the visitor's. |
| `SID_TRUST_PROXY` | `false` | Trust the proxy's headers: the client IP from the first `X-Forwarded-For` entry (or `SID_CLIENT_IP_HEADER`), and the location from `SID_LOCATION_HEADERS`. Only behind a proxy that overwrites them. |
| `SID_CLIENT_IP_HEADER` | unset (`X-Forwarded-For`) | The proxy's own client-IP header, used instead of `X-Forwarded-For` behind a CDN that appends to it: `cloudfront-viewer-address` (read as `ip:port`), `fastly-client-ip`, `true-client-ip`, `cf-connecting-ip`. Its value must be an IP address; a missing or invalid one gives no client IP. Needs `SID_TRUST_PROXY=true` (see [Per CDN](#per-cdn)) or `SID_UPSTREAM_SECRETS` (see [Trusted upstream](#trusted-upstream)). |
| `SID_LOCATION_HEADERS` | Cloudflare's visitor location headers (`cf-ipcountry` and the rest) | JSON: location field → the request header it comes from, for a proxy other than Cloudflare, like `{"country":"cloudfront-viewer-country"}`. Fields: `country`, `regionCode`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent`; a field left out isn't read. Needs `SID_TRUST_PROXY=true`, or `SID_UPSTREAM_SECRETS`, which needs it with `country`. An invalid value is a configuration error. |
| `SID_UPSTREAM_SECRETS`, `SID_UPSTREAM_AUTH_HEADER`, `SID_UPSTREAM_HOST_HEADER` | off, `x-sid-upstream-auth`, `x-forwarded-host` | [Trusted upstream](#trusted-upstream): a JSON array of secrets, from your secret store, and the headers carrying the secret and the site's hostname. |
| `SID_COOKIE_DOMAIN` | **required** | The domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), `host-only`, or [`auto`](../../../docs/configuration.md#cookie-domain-auto). Without it the server doesn't start. |
| `SID_*` | | Every other core setting, as in the [Configuration reference](../../../docs/configuration.md). |
| `SID_MODULE_PACKAGES` | none | Opt-in modules to add to the built-in ones, comma-separated, each `<package>#<export>`, like `@sharedid-edge/module-ec#ecModule`: `ec`, [`cmp`](../../modules/cmp/README.md) (`@sharedid-edge/module-cmp#cmpModule`) and [vendor modules](../../vendor-modules/README.md). Each package must be installed next to the server. A missing package or export stops the server at start-up. |
| `SID_MODULE_SECRETS` | `{}` | Module secrets, such as the `ec` passphrase. Supply it from your secret store (systemd `LoadCredential`, a container secret, and so on), not a committed file. |
| `SID_MODULE_SECRETS_FILE`, `SID_UPSTREAM_SECRETS_FILE` | unset | A file holding `SID_MODULE_SECRETS` or `SID_UPSTREAM_SECRETS` instead, such as a mounted Docker or Kubernetes secret; a trailing newline is dropped. Setting both a variable and its `_FILE`, or naming a file that can't be read, stops the server at start-up. |

Invalid settings stop the server at start-up with `Configuration error: …`.

## Platform data: what the server knows about each request

| `PlatformInfo` | Without `SID_TRUST_PROXY` | With `SID_TRUST_PROXY=true` (the default headers; `SID_LOCATION_HEADERS` replaces them) |
| --- | --- | --- |
| `clientIp` | The socket's remote address (your proxy's, if there is one) | The first `X-Forwarded-For` entry; with `SID_CLIENT_IP_HEADER`, that header instead (the address in `CloudFront-Viewer-Address`'s `ip:port`), or none when it's missing or not an IP address |
| `country`, `region` | none | `cf-ipcountry`, `cf-region-code` |
| `city`, `postalCode`, `metroCode` | none | `cf-ipcity` (UTF-8 decoded), `cf-postal-code`, `cf-metro-code` |
| `latitude`, `longitude` | none | `cf-iplatitude`, `cf-iplongitude` |
| `timezone`, `continent` | none | `cf-timezone`, `cf-ipcontinent` |
| `isEU` | none | From the country: one of the 27 EU member states. Without a `gdpr` parameter, GDPR applies when it's set, or when the country is in Iceland, Liechtenstein, Norway, the UK or Turkey |
| `traffic` | none | none: there is no platform bot verdict; the `bot` module and other modules still report to the traffic signal |

In [trusted-upstream mode](#trusted-upstream), a request with the secret gets its client IP and location from the headers `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` name, and nothing else.

Core's `locationInfo` validates the values the same way for every adapter, dropping empty, `XX`/`T1` and out-of-range ones. IPv4 clients on a dual-stack socket appear as `::ffff:192.0.2.1`, which the `ip` module reports as IPv4.

## Built-in modules

The CLI builds in `ip`, `geo`, `reflect`, `bot`, `ua` and `clickid`, from the list every adapter shares ([`@sharedid-edge/modules`](../../modules/all/README.md)). They do nothing until listed in `SID_MODULES`. See the [Modules](../../../docs/modules.md).

The server isn't bundled, so its `ua` module always has [Bowser](../../modules/ua/README.md#full-parsing-with-bowser) (from `@sharedid-edge/modules/bowser`): `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns on full `User-Agent` parsing with no build step.

**Forwarding modules (opt-in).** [`tag-gateway`](../../modules/tag-gateway/README.md) serves Google's tag gateway from a path on your site, forwarding to Google (its README starts with what it sends, and when). It works here: add it with `SID_MODULE_PACKAGES=@sharedid-edge/module-tag-gateway#tagGatewayModule`, and have your proxy send its path (`/metrics/`) to the server as it does `/_sid/`. With `SID_TRUST_PROXY`, the client IP and location it sends Google come from your proxy's headers, as for the `ip` and `geo` modules. See its [Platforms](../../modules/tag-gateway/README.md#platforms) table.

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

## Scheduled data updates

**Supported, opt-in.** cron or a systemd timer runs `sharedid-edge-update`, which downloads the sources you list into private files, and a custom server entry point reloads them in the background; no request downloads anything. It covers every source the updater has: the country databases (DB-IP Lite, MaxMind GeoLite2), the [`encrypted-ip`](../../modules/encrypted-ip/README.md) module's keys (Google's, Prebid Server hosts'), and the [`ua`](../../modules/ua/README.md#scheduled-crawler-list-updates) module's crawler list (isbot's patterns). The `bot` module uses no list, so it has nothing to update. The standard server command is unchanged until you set this up. Turn it on with [Scheduled data updates: Node.js](../../../docs/data-updates.md#nodejs-cron-or-a-systemd-timer).

## Verify

```sh
npm run verify-deployment -- --site https://www.example.com
curl -s https://www.example.com/_sid/v1 | jq .
```

Locally, `npm run conformance` runs the whole conformance suite against this server.

## Live tests

[`e2e-node-upstream.yml`](../../../.github/workflows/e2e-node-upstream.yml) tests the container image on real infrastructure as an upstream operator's endpoint ([SharedID Edge for upstream operators](../../../docs/upstream-operators.md)), behind a publisher on Cloudflare. Like the other live workflows, it runs only from `main` (every merge, nightly, on demand), never on pull requests. It's for this project's own testing, not a deployment recipe.

```text
Browser ──► e2e.sharedid.dev/node-upstream/          the test page (Workers static assets)
              └─ /node-upstream/_sid/*  ──► the Cloudflare recipe (cloudflare/live/forward.js): shared secret,
                                            X-Forwarded-Host, X-SID-Client-IP, X-SID-Country/Region
                                            ──► Lambda function URL (TLS) ──► this image, unchanged, with AWS Lambda
                                                Web Adapter (live/Dockerfile.lambda), in trusted-upstream mode
```

The hostname is shared with the Cloudflare live tests, which own its root and `/_sid/*`, so this setup lives under `/node-upstream/` (`SID_BASE_PATH=/node-upstream/_sid`), and the browser tests run with `E2E_PATH=/node-upstream` (the page builds its `pixelUrl` from its own path). A second path, `/node-upstream-conformance/_sid/*`, goes to the same image on the default settings for the conformance suite.

[`live/upstream.sh`](live/upstream.sh) builds the image from the commit, adds the adapter, pushes it to the ECR repository `sharedid-node-upstream`, deploys [`live/upstream.yaml`](live/upstream.yaml) (stack `sharedid-node-upstream`: two functions and their public function URLs), then deploys the two forwarding Workers with Wrangler. The workflow then runs:

- [`check-live-site`](../../../docs/verification.md#check-live-site) with `--base-path /node-upstream/_sid`: the visitor's real address and region reach the image through the publisher; forged headers change nothing; the function URL called directly, without the secret or with a forged one, answers `403` with no cookie;
- `verify-deployment` against the publisher (same IP addresses as the page, `Secure` server-set cookies on `sharedid.dev`, not cached);
- the conformance suite's default cases through `/node-upstream-conformance/_sid`;
- the browser tests in Chromium, Firefox and WebKit against `https://e2e.sharedid.dev/node-upstream/`;
- the [EU visitor](../../../docs/verification.md#check-eu-visitor) from Frankfurt.

**Setup** (once): the AWS live tests' OIDC role ([AWS live tests](../aws-lambda/README.md#live-tests)) with [`live/iam-policy.json`](live/iam-policy.json) from this package attached too (ECR, for the `sharedid-*` repositories; `ACCOUNT_ID` replaced), the repository secret `UPSTREAM_SECRET_NODE` (`openssl rand -hex 32`), the Cloudflare secrets the other live workflows use, and the repository variable `NODE_UPSTREAM_LIVE=true`. Until all are set, the workflow skips with a notice naming what's missing. By hand: `NODE_UPSTREAM_SECRETS_DIR=<a private folder> packages/adapters/node/live/upstream.sh`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Cookies aren't `Secure` | The server sees a local host (`localhost`, an IP address, or a `.test`/`.local` name): the proxy isn't passing the public `Host`. Pass it, or set `SID_PUBLIC_ORIGIN` to your https origin. |
| `ip` returns your proxy's address | Set `SID_TRUST_PROXY=true`, and have the proxy overwrite `X-Forwarded-For`. |
| `ip` returns an address the visitor chose (send `X-Forwarded-For: 198.51.100.1` and it comes back), or the CDN's | The CDN appends to `X-Forwarded-For` (CloudFront and Cloudflare do), so its first entry is the visitor's own. Set `SID_CLIENT_IP_HEADER` to the CDN's client-IP header ([Per CDN](#per-cdn)). |
| `ip` returns nothing with `SID_CLIENT_IP_HEADER` set | The header doesn't reach the server (CloudFront: add `CloudFront-Viewer-Address` to the origin request policy), or its value isn't an IP address. |
| `geo` returns nothing | No location headers reach the server (Cloudflare's, or those in `SID_LOCATION_HEADERS`), or `SID_TRUST_PROXY` is off. |
| EU visitors without consent get cookies | The server doesn't know their country: pass it on (see [Deploy behind your proxy](#deploy-behind-your-proxy)). |
| Every request gets `403 Forbidden` | `SID_UPSTREAM_SECRETS` is set, and the request doesn't carry one of its secrets in `X-SID-Upstream-Auth`. |
| Visitors share one ID or one cookie | Something caches `/_sid/` responses. Turn caching off for that path. |
| `verify-deployment` says the IPs differ | `/_sid/` is served from a different host or IP than your pages. Route it through the same proxy. |
| The container exits at once, or keeps restarting | Its settings are invalid: `docker logs` shows `Configuration error: …` (a missing `SID_COOKIE_DOMAIN`, an unreadable `SID_MODULE_SECRETS_FILE`, …). |
| The container stays `unhealthy` | The health check calls `http://127.0.0.1:$HEALTH_PORT/healthz` inside the container: with `HOST` set to one address, or `HEALTH_PORT` empty, it can't. Keep `HOST=0.0.0.0`, or run with `--no-healthcheck`. |
