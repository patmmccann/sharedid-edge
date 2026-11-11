# @sharedid-edge/cloudflare

SharedID Edge as a **Cloudflare Worker**: the `/_sid/*` routes on your own site, answered at Cloudflare's edge, never reaching your origin. This page is the adapter's full guide: the deployment walkthrough and the reference.

## Contents

- [Architecture](#architecture)
- [Build](#build)
- [Deploy](#deploy)
- [Configuration and secrets](#configuration-and-secrets)
- [Platform data: what the Worker knows about each request](#platform-data-what-the-worker-knows-about-each-request)
- [Built-in modules](#built-in-modules)
- [Verify](#verify)
- [Local development and tests](#local-development-and-tests)
- [Live tests](#live-tests)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ──► www.example.com (proxied by Cloudflare)
              ├─ /_sid/*  ──► this Worker (route www.example.com/_sid/*) ──► response with Set-Cookie
              └─ anything else ──► your origin, as before
```

- **Routing:** the Worker runs on a **route** of your own zone, so it answers on your site's hostname and Cloudflare's IP addresses, the same ones that serve your pages. That's what lets Safari treat its cookies as first-party server-set cookies. A `workers.dev` hostname or a CNAME to another domain won't do.
- **Statelessness:** the Worker keeps nothing between requests (no KV, Durable Objects or logs). Workers observability is off in `wrangler.jsonc`.
- **Contents:** `src/index.ts` (the fetch handler, one handler per `env`), `src/platform.ts` (request data into `PlatformInfo`) and `wrangler.jsonc` (the route and every `SID_*` setting).

## Build

```sh
npm ci
npm run build                                      # compiles core and the modules the Worker bundles
npm run build -w @sharedid-edge/cloudflare         # optional: a dry-run bundle into dist/, to check the size
```

Wrangler bundles `src/index.ts` with the workspace packages at deploy time. It's minified (`"minify": true` in `wrangler.jsonc`, with source maps uploaded so errors in Cloudflare's logs show the original code), and the gzipped bundle is checked against a 32 KB budget in CI.

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` (`sua`, `devicetype`, `make`, `model`, `os`, `osv`) for Safari, Firefox, TVs and other browsers that send no Client Hints. It isn't in the default bundle, to keep it small. `npm run deploy:bowser -w @sharedid-edge/cloudflare` (in place of `deploy`; it deploys the entry point `src/bowser.ts`; also `dev:bowser`, and `build:bowser` for a dry run into `dist-bowser/`) builds it in, then `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns it on. The cost, minified and gzipped, against the 32 KB budget CI checks for both builds:

| Bundle | Default (no Bowser) | With Bowser |
| --- | --- | --- |
| Worker (`dist/index.js`, `dist-bowser/bowser.js`) | 18.0 KB | 25.8 KB |

## Deploy

### Prerequisites

- Your site's DNS is on Cloudflare, and the hostname you serve pages from (for example `www.example.com`) is **proxied** (orange cloud). Workers routes only run on proxied hostnames.
- A Cloudflare account with permission to deploy Workers and edit routes on the zone. Each sync is one Worker request; the free plan has a daily request limit, so check expected volume against your plan.
- Node.js 24 or later and npm.
- The site is served over https (the cookies are `Secure`).

### 1. Get the code and build it

```sh
git clone https://github.com/patmmccann/sharedid-edge.git
cd sharedid-edge
npm ci
npm run build
```

`npm run build` compiles the shared core package that the worker bundles. Rerun it after updating the code.

### 2. Configure the worker

Edit [`wrangler.jsonc`](wrangler.jsonc):

```jsonc
{
  "name": "sharedid-edge",                 // the Worker's name in your account
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "routes": [
    { "pattern": "www.example.com/_sid/*", "zone_name": "example.com" }
  ],
  "workers_dev": false,                    // no public *.workers.dev URL in production
  "vars": {
    "SID_COOKIE_NAME": "_pubcid",          // must match storage.name in Prebid.js
    "SID_COOKIE_DOMAIN": "",               // e.g. ".example.com" to share across subdomains
    "SID_MAX_AGE_DAYS": "365",
    "SID_VENDOR_ID": ""                    // your TCF vendor ID, only if you are one; see Consent and opt-out
    // … every setting is listed in the Configuration reference
  }
}
```

- **Route:** use the hostname your pages are served from, with the `/_sid/*` path. If your site answers on both `example.com` and `www.example.com`, add a route for each and set `SID_COOKIE_DOMAIN` to `.example.com`, so both hosts share one cookie.
- **Path:** to use something other than `/_sid`, change both the route and `SID_BASE_PATH`.
- **Cookie name:** keep `_pubcid` unless Prebid.js is configured with a different `storage.name`.

After changing `vars`, regenerate the Worker's TypeScript types with `npm run types -w @sharedid-edge/cloudflare` (CI checks they're current).

### 3. Log in and deploy

```sh
npm exec -w @sharedid-edge/cloudflare -- wrangler login   # opens a browser; or set CLOUDFLARE_API_TOKEN
npm run deploy -w @sharedid-edge/cloudflare
```

For CI or a shared machine, create an API token (Cloudflare dashboard → My Profile → API Tokens) with **Account → Workers Scripts → Edit** and **Zone → Workers Routes → Edit** for your zone, and set `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if you have several accounts) instead of logging in.

`wrangler deploy` uploads the Worker and attaches the route. Requests to `www.example.com/_sid/*` are answered by the Worker from then on; everything else on your site is unaffected.

### 4. Verify

Run `npm run verify-deployment -- --site https://www.example.com`; see [Verify](#verify) for what it checks.

### 5. Turn it on in Prebid.js

See [Configure Prebid.js](../../../docs/prebid.md). Deploying the worker changes nothing on your pages until Prebid.js calls it.

### Updating

```sh
git pull
npm ci
npm run build
npm run deploy -w @sharedid-edge/cloudflare
```

### Staging and previews

Before attaching the production route, you can deploy with `"workers_dev": true` and no `routes` to get a `https://sharedid-edge.<your-subdomain>.workers.dev` URL. Cookies set there belong to `workers.dev`, not your site, so use it only to check that the Worker runs. Test the real behaviour on a staging hostname of your own zone (for example a route on `staging.example.com/_sid/*`), using a Wrangler environment (`"env": { "staging": { … } }` in `wrangler.jsonc`, deployed with `--env staging`).

### Deploying for many publishers

A company running SharedID Edge for several publishers can deploy one Worker per publisher, each with its own routes and `vars`, using Wrangler environments (`env.<publisher>`) or separate config files (`wrangler deploy -c publisher-a.jsonc`). Each Worker must run on the zone that serves that publisher's site, so the publisher needs to delegate the route (or the zone) to your Cloudflare account. The IP rule means it can't run on your own domain behind a CNAME.

## Configuration and secrets

- **Settings:** every setting is a `SID_*` variable, listed in [`wrangler.jsonc`](wrangler.jsonc) and described in the [Configuration reference](../../../docs/configuration.md). An empty string means "use the default".
- **Invalid settings** make every request return `500 SharedID Edge is misconfigured`, rather than setting wrong cookies. The reason is written to the Worker's logs (`wrangler tail`).
- **Secrets** (the `ec` module's passphrase) go in `SID_MODULE_SECRETS`, set as a Worker secret, never in `vars`:

  ```sh
  npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_MODULE_SECRETS
  ```

  For local development, put it in `packages/adapters/cloudflare/.dev.vars` (git-ignored).

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
| `traffic` | `request.cf.botManagement`: `verifiedBot` as `bot: true, botKind: verified`, `score` (1 to 99) as `score`, `corporateProxy` as `proxy: relay` | The traffic signal (`ortb2.device.ext.traffic`, source `platform`) and `SID_SKIP_BOTS` |

Core's `locationInfo` validates every location value the same way for all adapters, dropping empty and invalid ones. Location data is available on every Cloudflare plan. Bot Management is an Enterprise add-on: without it, `request.cf.botManagement` is absent or has no score, and the Worker adds no traffic verdict. `verifiedBotCategory` isn't in the Workers runtime types, so it isn't read.

## Built-in modules

The Worker builds in `ip`, `ec`, `geo`, `reflect`, `bot` and `ua`, from the list every adapter shares ([`@sharedid-edge/modules`](../../modules/all/README.md)). They do nothing until listed in `SID_MODULES`. See the [Modules](../../../docs/modules.md) and each module's README. To add your own or a vendor module, import it in `src/index.ts` and pass `[...builtInModules, yourModule]`.

## Verify

```sh
npm run verify-deployment -- --site https://www.example.com
```

This checks, from outside, that:

- the endpoint shares IP addresses with your site (the Safari rule in [Architecture](#architecture));
- `/_sid/sync` returns the pixel and sets `_pubcid` (Secure, SameSite=Lax, at least 300 days, readable by script) and the `HttpOnly` recovery copy, adopting the ID it's sent;
- the response isn't served from a shared cache;
- `/_sid/v1` returns the JSON payload.

Options: `--endpoint https://www.example.com/identity` for a different path, `--cookie-name`, `--min-days`.

By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie headers
curl -s https://www.example.com/_sid/v1 | jq .                    # the payload; see Responses
```

## Local development and tests

```sh
npm run dev -w @sharedid-edge/cloudflare          # wrangler dev on http://localhost:8787 (no account needed)
npm test -w @sharedid-edge/cloudflare             # unit tests inside workerd (@cloudflare/vitest-plugin)
npm run conformance:wrangler                      # the conformance suite against wrangler dev
npm run typecheck -w @sharedid-edge/cloudflare    # against the Workers runtime types
```

Over plain http locally, cookies aren't `Secure`. `wrangler dev` fills `request.cf` from Cloudflare's view of your machine; the conformance runner overrides it with fixed values (Miniflare's `MF-CF-Blob` header).

## Live tests

Some things can only be checked on Cloudflare's real edge: a Worker route on the site's own proxied hostname (which gives the cookies the site's IP addresses, the [Safari rule](#architecture)), real `request.cf` data, and the bundle in the real runtime. The [Live tests workflow](../../../.github/workflows/e2e-cloudflare.yml) checks them nightly, and on demand from the Actions tab, on this project's test zone, `sharedid.dev`. It runs only from `main` and never on pull requests, which stay account-free.

It deploys three Workers:

| Worker | Route | What |
| --- | --- | --- |
| `sharedid-edge-e2e` | `e2e.sharedid.dev/_sid/*` | This package's `e2e` environment in `wrangler.jsonc`: no pixel caching, and `reflect` with `uid1` and `_ga`, as in the local browser tests |
| `sharedid-edge-e2e-site` | `e2e.sharedid.dev/*` | The test page and a Prebid.js bundle with just `sharedIdSystem` (`e2e/bundle-prebid.ts`, the version `e2e/package.json` pins), as static assets ([`e2e/site/`](../../../e2e/site/wrangler.jsonc)). The more specific `/_sid/*` route wins, as on a publisher's site. |
| `sharedid-edge-conformance` | `conformance.sharedid.dev/_sid/*` | The `conformance` environment: the default configuration |

Then it runs `npm run verify-deployment -- --site https://e2e.sharedid.dev`, the conformance suite's default-configuration cases against `https://conformance.sharedid.dev/_sid`, and the Playwright tests in [`e2e/`](../../../e2e/AGENTS.md) against `https://e2e.sharedid.dev` (`E2E_BASE_URL`) in Chromium, Firefox and WebKit. A failing nightly run opens an issue, or comments on the open one.

Setting it up on another zone (a fork, say):

1. Add the zone to a Cloudflare account, proxied. For each test hostname, add a proxied `AAAA` record with the content `100::`: the Workers answer every request, so no origin is needed.
2. Change the hostnames and `zone_name` in the `env` section of `wrangler.jsonc`, `e2e/site/wrangler.jsonc` and the workflow.
3. Create an API token with **Workers Scripts: Edit** on the account, and **Workers Routes: Edit** and **Zone: Read** on the zone. Under **My Profile → API Tokens**, the *Edit Cloudflare Workers* template has these. An account-owned token (the account's **API Tokens**) calls the zone a *domain*: the route permissions need a policy for the domain, not the account.
4. Add the three routes once, on the zone (**Workers Routes → Add route** in the zone's dashboard, or `POST /zones/<zone id>/workers/routes`), each pointing at its Worker name. Wrangler attaches routes through an account-level API call that a token scoped to the zone can't make. When the routes are already in place, `wrangler deploy` leaves them as they are and the deploy succeeds.
5. Add the token and the account ID as the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow fails at once, saying so, when either is missing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route doesn't match: check the hostname in `routes`, and that the hostname is proxied (orange cloud). |
| `500 SharedID Edge is misconfigured` | A `SID_*` value is invalid. `wrangler tail` shows which. |
| Cookies set but not sent back | `SID_COOKIE_DOMAIN` doesn't cover the page's host, or the site isn't on https. |
| `geo` returns nothing precise | Consent rules out precise location, or the visitor's location isn't known to that precision. Check `ext.modules.geo`. |
| `verify-deployment` says the IPs differ | The endpoint is answered somewhere other than your site's Cloudflare hostname (for example a CNAME to another domain). Safari will cap its cookies. |
