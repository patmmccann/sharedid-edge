# @sharedid-edge/cloudflare

SharedID Edge as a **Cloudflare Worker**: the `/_sid/*` routes on your own site, answered at Cloudflare's edge, never reaching your origin. The main [README](../../README.md#deploy-on-cloudflare) has the short deployment walkthrough. This page is the adapter's full reference.

## Contents

- [Architecture](#architecture)
- [Build](#build)
- [Deploy](#deploy)
- [Configuration and secrets](#configuration-and-secrets)
- [Platform data: what the Worker knows about each request](#platform-data-what-the-worker-knows-about-each-request)
- [Built-in modules](#built-in-modules)
- [Verify](#verify)
- [Local development and tests](#local-development-and-tests)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ──► www.example.com (proxied by Cloudflare)
              ├─ /_sid/*  ──► this Worker (route www.example.com/_sid/*) ──► response with Set-Cookie
              └─ anything else ──► your origin, as before
```

- **Routing:** the Worker runs on a **route** of your own zone, so it answers on your site's hostname and Cloudflare's IP addresses, the same ones that serve your pages. That's what lets Safari treat its cookies as first-party server-set cookies. A `workers.dev` hostname or a CNAME to another domain won't do.
- **Statelessness:** the Worker keeps nothing between requests (no KV, Durable Objects or logs). Workers observability is off in `wrangler.jsonc`.
- **Contents:** `src/index.ts` (the fetch handler, one handler per `env`), `src/platform.ts` (request data into `PlatformInfo`), `src/modules.ts` (the modules built in) and `wrangler.jsonc` (the route and every `SID_*` setting).

## Build

```sh
npm ci
npm run build                                      # compiles core and the modules the Worker bundles
npm run build -w @sharedid-edge/cloudflare         # optional: a dry-run bundle into dist/, to check the size
```

Wrangler bundles `src/index.ts` with the workspace packages at deploy time. The gzipped bundle is checked against a 20 KB budget in CI.

## Deploy

1. **Prerequisites:**
   - your site's hostname is **proxied** (orange cloud) on Cloudflare;
   - an account that can deploy Workers and edit routes on the zone;
   - Node.js 22 or later.
2. **Set the route and settings** in [`wrangler.jsonc`](wrangler.jsonc):

   ```jsonc
   "routes": [{ "pattern": "www.example.com/_sid/*", "zone_name": "example.com" }],
   "workers_dev": false,
   "vars": { "SID_COOKIE_DOMAIN": ".example.com", "SID_MODULES": "ip,geo" }
   ```

   After changing `vars`, run `npm run types -w @sharedid-edge/cloudflare`, which regenerates `worker-configuration.d.ts` (CI checks it's current).
3. **Log in and deploy:**

   ```sh
   npm exec -w @sharedid-edge/cloudflare -- wrangler login     # or set CLOUDFLARE_API_TOKEN
   npm run deploy -w @sharedid-edge/cloudflare
   ```

   An API token for CI needs **Account → Workers Scripts → Edit** and **Zone → Workers Routes → Edit**.
4. **Staging:** use a Wrangler environment on a staging hostname of your own zone (`--env staging`). See the main README's [Staging and previews](../../README.md#staging-and-previews) and [Deploying for many publishers](../../README.md#deploying-for-many-publishers).

## Configuration and secrets

- **Settings:** every setting is a `SID_*` variable, listed in [`wrangler.jsonc`](wrangler.jsonc) and described in the main README's [Configuration reference](../../README.md#configuration-reference). An empty string means "use the default".
- **Invalid settings** make every request return `500 SharedID Edge is misconfigured`, rather than setting wrong cookies. The reason is written to the Worker's logs (`wrangler tail`).
- **Secrets** (the `ec` module's passphrase) go in `SID_MODULE_SECRETS`, set as a Worker secret, never in `vars`:

  ```sh
  npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_MODULE_SECRETS
  ```

  For local development, put it in `packages/cloudflare/.dev.vars` (git-ignored).

## Platform data: what the Worker knows about each request

`src/platform.ts` fills `PlatformInfo`, which core and the modules use, from data Cloudflare sets itself. Visitors can't spoof any of it.

| `PlatformInfo` | From | Used by |
| --- | --- | --- |
| `clientIp` | `CF-Connecting-IP` header | `ip`, `ec` |
| `isEU` | `request.cf.isEUCountry` (`"1"` in an EU member state) | GDPR scope when there's no `gdpr` parameter |
| `country` | `request.cf.country` (ISO 3166-1 alpha-2; `XX` and Tor's `T1` are dropped) | `geo` |
| `region` | `request.cf.regionCode` | `geo` |
| `city`, `postalCode`, `metroCode` | `request.cf.city`, `.postalCode`, `.metroCode` | `geo` |
| `latitude`, `longitude` | `request.cf.latitude`, `.longitude` (dropped if not finite or out of range) | `geo` |
| `timezone`, `continent` | `request.cf.timezone`, `.continent` | `geo` |

Core's `locationInfo` validates every location value the same way for all adapters, dropping empty and invalid ones. Location data is available on every Cloudflare plan.

## Built-in modules

[`src/modules.ts`](src/modules.ts) builds in `ip`, `ec`, `geo` and `reflect`. They do nothing until listed in `SID_MODULES`. See the main README's [Modules](../../README.md#modules) and each module's README. To add a module, import it there, and in `packages/node/src/cli.ts` and any other adapter.

## Verify

```sh
npm run verify-deployment -- --site https://www.example.com
```

This checks that `/_sid/*` shares IP addresses with your site, sets `_pubcid` and its `HttpOnly` recovery copy correctly, isn't cached by a shared cache, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie headers
curl -s https://www.example.com/_sid/v1 | jq .                    # the payload; see the main README's Responses
```

## Local development and tests

```sh
npm run dev -w @sharedid-edge/cloudflare          # wrangler dev on http://localhost:8787 (no account needed)
npm test -w @sharedid-edge/cloudflare             # unit tests inside workerd (@cloudflare/vitest-plugin)
npm run conformance:wrangler                      # the conformance suite against wrangler dev
npm run typecheck -w @sharedid-edge/cloudflare    # against the Workers runtime types
```

Over plain http locally, cookies aren't `Secure`. `wrangler dev` fills `request.cf` from Cloudflare's view of your machine; the conformance runner overrides it with fixed values (Miniflare's `MF-CF-Blob` header).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route doesn't match: check the hostname in `routes`, and that the hostname is proxied (orange cloud). |
| `500 SharedID Edge is misconfigured` | A `SID_*` value is invalid. `wrangler tail` shows which. |
| Cookies set but not sent back | `SID_COOKIE_DOMAIN` doesn't cover the page's host, or the site isn't on https. |
| `geo` returns nothing precise | Consent rules out precise location, or the visitor's location isn't known to that precision. Check `ext.modules.geo`. |
| `verify-deployment` says the IPs differ | The endpoint is answered somewhere other than your site's Cloudflare hostname (for example a CNAME to another domain). Safari will cap its cookies. |
