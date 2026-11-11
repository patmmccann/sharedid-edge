# @sharedid-edge/cloudflare

SharedID Edge as a **Cloudflare Worker**: the `/_sid/*` routes on your own site, answered at Cloudflare's edge, never reaching your origin. This page is the adapter's full guide: the deployment walkthrough and the reference.

## Contents

- [Architecture](#architecture)
- [Worker or Snippet?](#worker-or-snippet)
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

## Worker or Snippet?

On a Pro, Business or Enterprise plan, SharedID Edge can also run as a [Cloudflare Snippet](https://developers.cloudflare.com/rules/snippets/): the same code and the same `request.cf` data, but included in the plan at no extra cost, where a Worker past the free tier (100,000 requests a day) is billed per request. In exchange a Snippet has hard limits: 32 KB of code, 5 ms of CPU, no environment variables and no secrets. The Snippet build bundles your settings into the file and checks its size.

| | Worker (the default, this page) | Snippet |
| --- | --- | --- |
| Plans | Every plan, Free included | Pro, Business, Enterprise |
| Cost | Free up to 100,000 requests a day, then Workers Paid ($5 a month and usage) | Included in the plan |
| Modules | Every module | Those that fit in 32 KB (below); never `ec` |
| Secrets (`SID_MODULE_SECRETS`) | Yes (`wrangler secret`) | No: anything in a Snippet is readable by whoever can see it |
| Changing a setting | Edit `wrangler.jsonc` (or the dashboard) and redeploy | Edit the configuration file, rebuild, and paste or upload the new file |
| Deploying | `npm run deploy`, with versions and rollbacks | The dashboard, the API or Terraform; no versions, rollbacks or logs |

Pick the Snippet when you're on a paid plan, your modules fit, and you don't need `ec`. Pick the Worker otherwise, or if you want to change settings without rebuilding.

### What fits in a Snippet

The size limit is checked on the minified file, before gzip (the bytes you deploy): Cloudflare doesn't say whether its 32 KB is measured compressed, so the build takes the safe reading. Sizes today:

| `SID_MODULES` | Minified | Fits? |
| --- | --- | --- |
| none (SharedID only) | about 22 KB | Yes |
| `reflect` | about 28 KB | Yes |
| `ip,geo,bot` | about 29 KB | Yes |
| `ip,reflect` | about 29 KB | Yes |
| `ua` (the default parser: isbot, the bot flag only) | about 30 KB | Yes |
| `ua` with Bowser (`"parser": "bowser"`) | about 64 KB | No: Bowser alone is about 33 KB. Use the default parser, or the Worker |
| `ip,geo,reflect,bot,ua` | about 42 KB | No: drop `ua` and `reflect`, or use the Worker |

The User-Agent parser is part of the size: the `ua` module bundles only `isbot` by default, and Bowser (the Worker's [Bowser build](#build)) only when `SID_MODULE_CONFIG` sets `{"ua":{"parser":"bowser"}}`. The build prints which one it bundled. You don't need to work this out: the build prints the size of each part, and when the result is over 32 KB it writes nothing, lists the modules by size, and names a set that fits.

### The 5 ms CPU limit

SharedID Edge is far under it. The handler does no I/O: it reads cookies and headers, maybe mints a UUID, and writes cookies. Measured on a laptop, with every module that fits a Snippet:

- a request takes about 0.03 to 0.05 ms typically, and under 0.3 ms at the 99th percentile;
- the first request after the Snippet loads takes about 1 to 1.5 ms;
- loading the Snippet (parsing it and validating the baked-in settings) takes about 2.5 to 3 ms, once per isolate, not per request. Cloudflare doesn't say whether that counts against the first request's 5 ms.

The geo module adds about 0.2 to 0.5 ms the first time it sees a time zone, and about 0.01 ms after that. Every build times 300 requests and prints the median and the 99th percentile, warning when the 99th percentile is over half the limit. These are estimates on the build machine; a live Snippet hasn't been measured yet ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)).

### Build and deploy the Snippet

1. Build the repository (`npm ci && npm run build`, as in [Build](#build)).
2. Copy `snippet.config.example.json` to `snippet.config.json` in this folder and set your values: the same `SID_*` settings as the Worker's `vars` ([Configuration](../../../docs/configuration.md)), with `SID_COOKIE_DOMAIN` required and `SID_MODULE_CONFIG` as JSON or a string. Keys starting with `$` are comments.
3. Run `npm run build:snippet -w @sharedid-edge/cloudflare`. It validates the settings as a deployment would, bundles only the modules in `SID_MODULES`, checks the size, smoke-tests the result (a first sync sets the cookie, `/v1` reports no module errors), and writes `dist-snippet/snippet.js` and the rule expression to `dist-snippet/snippet.rule.txt`. It replaces only those two files, so `--out` can point anywhere. It prints the trade-offs above on every build.
4. In the dashboard, go to **Rules > Snippets**, create a snippet, and paste `dist-snippet/snippet.js` (or upload it with the API or Terraform).
5. Set its **snippet rule** to your hostname and the base path, for example `(http.host eq "www.example.com" and starts_with(http.request.uri.path, "/_sid/"))`: the rule decides which requests run the Snippet, as the Worker's route does. Don't set it wider: a Snippet that answers every request takes your site offline.
6. Verify as for the Worker ([Verify](#verify)), and turn it on in Prebid.js ([step 5](#5-turn-it-on-in-prebidjs)).

To change a setting or update SharedID Edge, edit `snippet.config.json` or pull the new version, rebuild, and replace the Snippet's code. Don't run the Worker's route and the Snippet on the same paths.

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
    "SID_COOKIE_DOMAIN": "example.com",    // required: the domain Prebid.js writes _pubcid on (or "host-only")
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

#### Hosting companies

A host that serves its customers' sites through [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) already answers `www.publisher.example` from its own zone, as a custom hostname. That's the IP rule met for every hosted site: a Worker on that zone's `/_sid/*` answers from the same Cloudflare addresses as the pages, and the publisher changes nothing. Each publisher still needs its own settings, `SID_COOKIE_DOMAIN` at least, and one deployment has one configuration, so the Worker has to be picked per hostname.

**With [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)** (a paid add-on), one Worker per publisher, picked by a dispatch Worker:

1. Create a dispatch namespace, for example `sharedid`, and **put it in trusted mode** before deploying into it. Namespaces are untrusted by default, and in untrusted mode Workers get no [`request.cf`](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/). Without it, SharedID Edge loses the visitor's location, `isEU` and Bot Management data. An EU visitor whose request carries no `gdpr` flag or TC string would then get cookies, where the location would have ruled them out ([Consent](../../../docs/consent.md)). Turn it on with the API (Cloudflare documents no Wrangler command or dashboard setting for it):

   ```sh
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/sharedid" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"name": "sharedid", "trusted_workers": true}'
   ```

   Workers deployed into the namespace before that keep running without `request.cf` until you redeploy them. In trusted mode, the namespace's Workers also share one Cache API space; SharedID Edge doesn't use the Cache API, so that doesn't affect it, but check before putting other Workers in the same namespace.
2. For each publisher, deploy this package's Worker into it, with that publisher's `vars` and no `routes`: `npx wrangler deploy --dispatch-namespace sharedid --name <publisher> -c <publisher>.jsonc`. Name it as you like; the dispatch Worker looks it up.
3. Deploy a dispatch Worker on your SaaS zone, with the route `*/_sid/*` (the base path, if you changed `SID_BASE_PATH`) and the namespace bound as `DISPATCHER`. It picks the publisher's Worker from the hostname, using the custom hostname's [custom metadata](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/custom-metadata/) (`request.cf.hostMetadata`, which your Cloudflare account team enables, on subdomain-style custom hostnames) or a Workers KV map:

   ```js
   export default {
     async fetch(request, env) {
       const host = new URL(request.url).hostname;
       const name = request.cf?.hostMetadata?.sharedid ?? (await env.SHAREDID_HOSTS.get(host));
       // A hostname without SharedID Edge: answer nothing, as the Worker does outside its routes.
       if (name === null || name === undefined) return new Response(null, { status: 404 });
       return env.DISPATCHER.get(name).fetch(request);
     }
   };
   ```

4. Verify each hostname with `npm run verify-deployment -- --site https://www.publisher.example` ([Verify](#verify)): it checks that the endpoint shares the site's IP addresses and that the cookies are server-set and `Secure`.

Pass the incoming `request` on as it is, so the publisher's Worker gets the visitor's `CF-Connecting-IP`, and, in a trusted namespace (step 1), `request.cf`. To check, call `/_sid/v1` on a hosted site with the `geo` module on: `device.geo` should show your own location. Updating SharedID Edge means redeploying each publisher's Worker into the namespace; a script over your list of publishers does it.

**With one shared Worker,** configured per hostname, without Workers for Platforms: deploy this Worker once, on your SaaS zone's `*/_sid/*` route, and give each site its settings in one of two ways ([Several sites from one deployment](../../../docs/configuration.md#several-sites-from-one-deployment)):

- **Custom hostname metadata** (your Cloudflare account team enables it): put the site's settings under a `sharedid` key when you create or update its custom hostname, and set `"SID_HOSTS": "{}"` in the Worker's `vars`, so a hostname without them gets nothing. Adding or changing a site is an API call, with no redeploy:

  ```sh
  curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/custom_hostnames/$HOSTNAME_ID" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    --data '{"custom_metadata": {"sharedid": {"SID_COOKIE_DOMAIN": "pub-a.example"}}}'
  ```

  Metadata reaches the Worker within about 30 seconds. Invalid settings in one site's metadata fail that site's requests with a 500, not the others'.
- **`SID_HOSTS`** in the Worker's `vars`: every site's hostname and settings in one JSON value. Simpler, but adding a site is a redeploy.

Every site shares the Worker's modules and `SID_MODULE_SECRETS`. Verify each hostname with `verify-deployment`, as in step 4 above.

**With Snippets:** there's no Snippets for Platforms. Snippets are per zone (25, 50 or 300 by plan), their configuration is fixed at build time ([Worker or Snippet?](#worker-or-snippet)), and Cloudflare doesn't document whether snippet rules on a SaaS zone run for custom hostnames. So one Snippet per publisher soon runs out. One Snippet for all of them can carry `SID_HOSTS` in its configuration file (the build smoke-tests the first site and bundles every site's modules), but it can't read custom hostname metadata, and whether it runs for custom hostnames at all is untested ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)). Use a Worker for now.

**If the publisher's own zone is on Cloudflare too** (their proxied hostname is a CNAME to yours, "orange-to-orange"), their zone handles the request first. A SharedID Edge route of theirs on `/_sid/*` would answer instead of yours, so agree which of you runs it.

Not yet tested on a live SaaS zone; [#110](https://github.com/patmmccann/sharedid-edge/issues/110) tracks that.

#### Sales houses

A sales house (an ad network representing many publishers, without hosting their sites) can run SharedID Edge for them, but not from its own domain. The endpoint has to answer on each publisher's site hostname, from the site's IP addresses. A CNAME from `sid.publisher.example` to you doesn't do it: the addresses differ from the site's, and Safari caps the cookies (`verify-deployment` reports it). Workers for Platforms doesn't change that. It helps you manage many Workers in your own account, but they still have to be reached on the publisher's hostname.

**When the publisher is on Cloudflare,** run it in their account:

- The publisher creates an API token for you, limited to their zone: **Workers Scripts: Edit** and **Workers Routes: Edit** for a Worker, or **Snippets: Edit** for a Snippet.
- **A Worker:** you deploy one per publisher, on `www.publisher.example/_sid/*`, with that publisher's `vars`, as in [Deploying for many publishers](#deploying-for-many-publishers). It runs on any plan, and the Workers bill is the publisher's (free up to 100,000 requests a day).
- **A Snippet,** on Pro or higher: build one per publisher from a configuration file (`SID_COOKIE_DOMAIN` and the rest; [Build and deploy the Snippet](#build-and-deploy-the-snippet)), then upload it and its rule through the API or Terraform. It's included in the publisher's plan at no extra cost. Changing a setting means rebuilding and re-uploading, and `ec` isn't available.
- Updating SharedID Edge is a rebuild and redeploy per publisher; a script over your publisher list does it.

**When the publisher isn't on Cloudflare,** their CDN or proxy can pass `/_sid/*` to an endpoint you run. CloudFront, Fastly, Akamai and nginx can all route a path to another origin. The browser still sees their hostname and addresses, so the cookies are first-party. The visitor's cookies travel with the request, so the TC string cookie, opt-out and the recovery cookie reach you. Consent also depends on the visitor's country, which needs the publisher's CDN to pass it on (below). Two things to get right:

- **The visitor's country decides consent, not just the `geo` module.** Without a `gdpr` signal, GDPR applies when the request comes from the EU, and if the country is unknown, storage is allowed ([Consent](../../../docs/consent.md)). Behind a CDN that isn't Cloudflare, nothing knows the visitor's country unless the publisher's CDN passes it on. So an EU visitor without a TC string would get cookies they shouldn't.
  - **This Worker** isn't suited to this setup. Behind another CDN, `CF-Connecting-IP` and `request.cf` describe the CDN's edge server, not the visitor. Its country is usually close to the visitor's, but not reliably enough for consent.
  - **The [Node.js server](../node/README.md)** with `SID_TRUST_PROXY` takes the client IP from `X-Forwarded-For`, and the location from Cloudflare-named headers (`cf-ipcountry` and the rest). The publisher's CDN must set `cf-ipcountry` to the visitor's country from its own geolocation, overwriting any copy the visitor sent: CloudFront's `CloudFront-Viewer-Country` in a CloudFront Function, Fastly's `client.geo.country_code`, Akamai's EdgeScape country. Trust those headers only from the publisher's proxy, and make sure the endpoint can't be reached any other way.
  - **Check it** before going live: call `/_sid/v1` through the publisher's site from an EU location without a TC string. It should set no cookie.
- **Settings per publisher:** `SID_COOKIE_DOMAIN` differs for each, and a deployment has one configuration, so run one endpoint per publisher. For example, one Node.js process each, which the publisher's proxy reaches by its own hostname or path.

Either way, nothing changes on the page: Prebid.js's SharedID `pixelUrl` stays `/_sid/sync` on the publisher's own site ([Configure Prebid.js](../../../docs/prebid.md)). [#111](https://github.com/patmmccann/sharedid-edge/issues/111) tracks testing the proxied setup end to end, and trusted forwarded headers beyond the Node.js server.

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

Some things can only be checked on Cloudflare's real edge: a Worker route on the site's own proxied hostname (which gives the cookies the site's IP addresses, the [Safari rule](#architecture)), real `request.cf` data, and the bundle in the real runtime. The [Live tests workflow](../../../.github/workflows/e2e-cloudflare.yml) checks them on this project's test zone, `sharedid.dev`, after every merge to `main`, nightly (for changes on Cloudflare's side and new browser versions), and on demand from the Actions tab. It never runs on pull requests, which stay account-free. Runs don't overlap, since they deploy to the same Workers: when several merges land during a run, the next run tests the newest.

It deploys three Workers:

| Worker | Route | What |
| --- | --- | --- |
| `sharedid-edge-e2e` | `e2e.sharedid.dev/_sid/*` | This package's `e2e` environment in `wrangler.jsonc`: no pixel caching, and `reflect` with `uid1` and `_ga`, as in the local browser tests |
| `sharedid-edge-e2e-site` | `e2e.sharedid.dev/*` | The test page and a Prebid.js bundle of a typical publisher setup (`e2e/bundle-prebid.ts`: consent, storage control, SharedID and other modules, at the version `e2e/package.json` pins), as static assets ([`e2e/site/`](../../../e2e/site/wrangler.jsonc)). The more specific `/_sid/*` route wins, as on a publisher's site. |
| `sharedid-edge-conformance` | `conformance.sharedid.dev/_sid/*` | The `conformance` environment: the default configuration |

Then it runs `npm run verify-deployment -- --site https://e2e.sharedid.dev`, the conformance suite's default-configuration cases against `https://conformance.sharedid.dev/_sid`, and the Playwright tests in [`e2e/`](../../../e2e/AGENTS.md) against `https://e2e.sharedid.dev` (`E2E_BASE_URL`) in Chromium, Firefox and WebKit. A failing run, after a merge or overnight, opens an issue, or comments on the open one.

Setting it up on another zone (a fork, say):

1. Add the zone to a Cloudflare account, proxied. For each test hostname, add a proxied `AAAA` record with the content `100::`: the Workers answer every request, so no origin is needed.
2. Change the hostnames and `zone_name` in the `env` section of `wrangler.jsonc`, `e2e/site/wrangler.jsonc` and the workflow.
3. Create an API token with **Workers Scripts: Edit** on the account, and **Workers Routes: Edit** and **Zone: Read** on the zone. Under **My Profile → API Tokens**, the *Edit Cloudflare Workers* template has these. An account-owned token (the account's **API Tokens**) calls the zone a *domain*: the route permissions need a policy for the domain, not the account.
4. Add the token and the account ID as the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow fails at once, saying so, when either is missing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route doesn't match: check the hostname in `routes`, and that the hostname is proxied (orange cloud). |
| `500 SharedID Edge is misconfigured` | A `SID_*` value is invalid. `wrangler tail` shows which. |
| Every request gets a 500 | `SID_COOKIE_DOMAIN` is empty: it's required (`wrangler tail` shows the message). |
| Cookies set but not sent back | `SID_COOKIE_DOMAIN` doesn't cover the page's host, or the site isn't on https. |
| `geo` returns nothing precise | Consent rules out precise location, or the visitor's location isn't known to that precision. Check `ext.modules.geo`. |
| `verify-deployment` says the IPs differ | The endpoint is answered somewhere other than your site's Cloudflare hostname (for example a CNAME to another domain). Safari will cap its cookies. |
