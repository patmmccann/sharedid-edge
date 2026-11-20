# @sharedid-edge/cloudflare

For opt-in reference-data refreshes, see [Scheduled data updates: Cloudflare](../../../docs/data-updates.md#cloudflare-cron-triggers-and-r2): a separate Cron Worker writes private R2/KV snapshots, and custom request workers load them into memory. The default Worker and Snippet are unchanged.

SharedID Edge as a **Cloudflare Worker**: the `/_sid/*` routes on your own site, answered at Cloudflare's edge, never reaching your origin. This page is the adapter's full guide: the deployment walkthrough and the reference.

## Contents

- [Architecture](#architecture)
- [Worker or Snippet?](#worker-or-snippet)
- [Build](#build)
- [Deploy](#deploy)
- [Configuration and secrets](#configuration-and-secrets)
- [Rate limiting](#rate-limiting)
- [Platform data: what the Worker knows about each request](#platform-data-what-the-worker-knows-about-each-request)
- [Built-in modules](#built-in-modules)
- [Google's tag gateway on the same zone](#googles-tag-gateway-on-the-same-zone)
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
- **Beside server-side Google Tag Manager:** a second route of the zone can forward an sGTM path to the tagging server; see [On Cloudflare](../../../docs/sgtm.md#on-cloudflare).
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
| Behind another CDN ([trusted upstream](#upstream-operators)) | Yes (`SID_UPSTREAM_SECRETS`, a secret) | No: it needs a secret. The build refuses `SID_UPSTREAM_*`, `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` |
| Changing a setting | Edit `wrangler.jsonc` (or the dashboard) and redeploy | Edit the configuration file, rebuild, and paste or upload the new file |
| Deploying | `npm run deploy`, with versions and rollbacks | The dashboard, the API or Terraform; no versions, rollbacks or logs |

Pick the Snippet when you're on a paid plan, your modules fit, and you don't need `ec`. Pick the Worker otherwise, or if you want to change settings without rebuilding.

### What fits in a Snippet

The size limit is checked on the minified file, before gzip (the bytes you deploy): Cloudflare doesn't say whether its 32 KB is measured compressed, so the build takes the safe reading. Sizes today, with `reflect` configured as in `snippet.config.example.json`:

| `SID_MODULES` | Minified | Fits? |
| --- | --- | --- |
| none (SharedID only) | about 19 KB | Yes |
| `clickid` | about 21 KB | Yes |
| [`cmp`](../../modules/cmp/README.md) (consent from a non-TCF CMP's cookie; opt-in elsewhere) | about 22 KB | Yes |
| `ip,clickid` | about 23 KB | Yes |
| `ip,geo,bot` | about 25 KB | Yes |
| `reflect` | about 23 KB | Yes |
| `ua` (the default parser: isbot, the bot flag only) | about 26 KB | Yes |
| `ip,reflect` | about 24 KB | Yes |
| `reflect,clickid` | about 25 KB |
| `ip,geo,reflect,bot,clickid` | about 31 KB | Yes, with little room to spare | Yes |
| `ua` with Bowser (`"parser": "bowser"`) | about 61 KB | No: Bowser alone is about 33 KB. Use the default parser, or the Worker |
| `ip,geo,reflect,bot,ua,clickid` | about 39 KB | No: drop `ua`, or use the Worker |
| [`tag-gateway`](../../modules/tag-gateway/README.md) (Google's tag gateway; a forwarding module) | about 28 KB | Yes |
| `reflect,tag-gateway` | about 32 KB | Just: no room for another module. Use the Worker, or [Cloudflare's built-in integration](../../modules/tag-gateway/README.md#on-cloudflare-prefer-the-built-in-integration) for the tag gateway |

The Snippet ships its settings already validated. The build checks them as the Worker checks its variables (core's settings and each module's `SID_MODULE_CONFIG` entry, with the same error messages), and bundles the result rather than the code that checks it, so the Snippet doesn't carry the validators, their patterns or their error messages. It also leaves out code your settings can't reach: the per-site handling without `SID_HOSTS`, `reflect`'s per-cookie backups and `prefer` comparisons when no cookie uses them, and core's consent-provider code without a module that has one (`cmp`). So the sizes above depend a little on the settings, and the build prints yours. An invalid setting therefore fails the build, never a live request: the build is the only place a Snippet's settings are checked. `npm run test:snippet` (in CI) builds Snippets for the conformance cases' configurations and others, checks each answers exactly as the Worker with the same settings, and checks that invalid settings fail the build with the Worker's message.

The User-Agent parser is part of the size: the `ua` module bundles only `isbot` by default, and Bowser (the Worker's [Bowser build](#build)) only when `SID_MODULE_CONFIG` sets `{"ua":{"parser":"bowser"}}`. The build prints which one it bundled. You don't need to work this out: the build prints the size of each part, and when the result is over 32 KB it writes nothing, lists the modules by size, and names a set that fits.

#### Leaving TCF out

Core's TCF decoder, which reads TC strings, is in every build by default and takes about 1.6 KB of a Snippet (0.6 KB gzipped): 1,649 bytes minified with `snippet.config.example.json`. If the site never needs TCF (it serves no visitors where GDPR applies, or decides consent another way, such as the [`cmp`](../../modules/cmp/README.md) module), `npm run build:snippet -w @sharedid-edge/cloudflare -- --no-tcf` leaves it out. Every build prints the decoder's size, and what `--no-tcf` saves or would save; an over-the-limit build suggests it.

Without the decoder a TC string can't be read, so it's treated as an unreadable one: a request that carries one (from `gdpr_consent` or the `euconsent-v2` cookie) gets no SharedID and loses an existing one, whatever `gdpr` says, with `X-SharedID-Status: denied: tcf: TC string not decoded (build without TCF)`. It never allows more than the default build. If your CMP writes `euconsent-v2`, don't use `--no-tcf`. See [Consent](../../../docs/consent.md).

### The 5 ms CPU limit

SharedID Edge is far under it. The handler does no I/O: it reads cookies and headers, maybe mints a UUID, and writes cookies. Measured on a laptop, with every module that fits a Snippet:

- a request takes about 0.03 to 0.05 ms typically, and under 0.3 ms at the 99th percentile;
- the first request after the Snippet loads takes about 1 to 1.5 ms;
- loading the Snippet takes about 2.5 to 3 ms, once per isolate, not per request (measured when it still validated its settings on load; it now ships them validated, so loading does less). Cloudflare doesn't say whether that counts against the first request's 5 ms.

The geo module adds about 0.2 to 0.5 ms the first time it sees a time zone, and about 0.01 ms after that. Every build times 300 requests and prints the median and the 99th percentile, warning when the 99th percentile is over half the limit. These are estimates on the build machine; a live Snippet hasn't been measured yet ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)).

### Build and deploy the Snippet

1. Build the repository (`npm ci && npm run build`, as in [Build](#build)).
2. Copy `snippet.config.example.json` to `snippet.config.json` in this folder and set your values: the same `SID_*` settings as the Worker's `vars` ([Configuration](../../../docs/configuration.md)), with `SID_COOKIE_DOMAIN` required and `SID_MODULE_CONFIG` as JSON or a string. Keys starting with `$` are comments.
3. Run `npm run build:snippet -w @sharedid-edge/cloudflare`. It validates the settings as a deployment would (and fails, with the setting at fault, when one is invalid), bundles them validated, bundles only the modules in `SID_MODULES`, checks the size, smoke-tests the result (a first sync sets the cookie, `/v1` reports no module errors), and writes `dist-snippet/snippet.js` and the rule expression to `dist-snippet/snippet.rule.txt`. It replaces only those two files, so `--out` can point anywhere. It prints the trade-offs above on every build.
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

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` (`sua`, `devicetype`, `make`, `model`, `os`, `osv`) for Safari, Firefox, TVs and other browsers that send no Client Hints. It isn't in the default bundle, to keep it small. `npm run deploy:bowser -w @sharedid-edge/cloudflare` (in place of `deploy`; it deploys the entry point `src/bowser.ts`; also `dev:bowser`, and `build:bowser` for a dry run into `dist-bowser/`) builds it in, then `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns it on. The cost, minified and gzipped, against the budgets CI checks (32 KB for the default build; 40 KB for the opt-in Bowser build, which adds full User-Agent parsing):

| Bundle | Default (no Bowser) | With Bowser |
| --- | --- | --- |
| Worker (`dist/index.js`, `dist-bowser/bowser.js`) | 20.7 KB | 28.5 KB |

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

[SharedID Edge for hosting companies](../../../docs/hosting-companies.md) is the guide for this, on every platform: choosing a deployment, per-publisher settings and consent, onboarding, verifying and operations. This section has the Cloudflare steps.

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

**Your sites' pages and `*/_sid/*`.** Cloudflare ranks a route's hostname before its path, so a Worker route on one custom hostname (`www.publisher.example/*`, serving that site's pages) wins over `*/_sid/*`, and SharedID Edge never sees that site's requests. Serve the pages from your origin or a `*/*` route (Cloudflare's [Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)), or give such a site its own `www.publisher.example/_sid/*` route to this Worker. The live test below hit this: `/_sid/*` answered 404 until the test site moved from `saas.hotba.be/*` to `*/*`.

**Tested live** with the shared Worker and `SID_HOSTS` ([The upstream-operator and Cloudflare for SaaS setups](#the-upstream-operator-and-cloudflare-for-saas-setups)): a custom hostname whose DNS is on another provider, on a free-plan SaaS zone. `*/_sid/*` on the SaaS zone answers for it, from the zone's Cloudflare addresses, and `request.cf` is the visitor's (address, country, region, city); a custom hostname that isn't in `SID_HOSTS` gets a 404 and no cookies, and the zone's own hostnames with more specific routes keep them. `verify-deployment` and unmodified Prebid.js in three browsers pass there. Custom hostname metadata (it needs the account team), Workers for Platforms and orange-to-orange aren't tested yet; [#135](https://github.com/patmmccann/sharedid-edge/issues/135) tracks them.

#### Upstream operators

An upstream operator (an ad-tech vendor, network or agency that runs one endpoint for many publishers, without hosting their sites) can run SharedID Edge for them, but not from its own domain: the endpoint has to answer on each publisher's site hostname, from the site's IP addresses, or Safari caps the cookies. **[SharedID Edge for upstream operators](../../../docs/upstream-operators.md)** is the full guide: the two models, the architecture, a worked example, the configuration for each publisher CDN (CloudFront, Fastly, Akamai, Cloudflare, nginx and others), secrets and rotation, onboarding, consent, operations and the security model. What's specific to Cloudflare:

**Model A: when the publisher is on Cloudflare,** run it in their account:

- The publisher creates an API token for you, limited to their zone: **Workers Scripts: Edit** and **Workers Routes: Edit** for a Worker, or **Snippets: Edit** for a Snippet.
- **A Worker:** you deploy one per publisher, on `www.publisher.example/_sid/*`, with that publisher's `vars`, as in [Deploying for many publishers](#deploying-for-many-publishers). It runs on any plan, and the Workers bill is the publisher's (free up to 100,000 requests a day).
- **A Snippet,** on Pro or higher: build one per publisher from a configuration file (`SID_COOKIE_DOMAIN` and the rest; [Build and deploy the Snippet](#build-and-deploy-the-snippet)), then upload it and its rule through the API or Terraform. It's included in the publisher's plan at no extra cost. Changing a setting means rebuilding and re-uploading, and `ec` isn't available.
- Updating SharedID Edge is a rebuild and redeploy per publisher; a script over your publisher list does it.

Workers for Platforms doesn't remove the need for this: it helps you manage many Workers in your own account, but they'd still have to be reached on the publisher's hostname.

**Model B: this Worker as the endpoint behind publishers' CDNs,** in **trusted-upstream mode** ([what it does](../../../docs/configuration.md#trusted-upstream-behind-a-publishers-cdn)). Each publisher's CDN sends `/_sid/*` to the Worker, adding a shared secret and the visitor's IP address, country and site hostname; the Worker trusts those only with the secret, and answers anything else with a 403 and no cookies. Behind another CDN, the Worker's own `CF-Connecting-IP` and `request.cf` describe that CDN's edge, so they're ignored in this mode. The Worker runs in every Cloudflare location, so the hop from a publisher's CDN stays short ([Where to run the upstream operator's endpoint](../../../docs/upstream-operators.md#where-to-run-the-upstream-operators-endpoint)).

1. **Give it a hostname of yours,** a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) such as `sid.upstream.example`, instead of `routes`: `"routes": [{ "pattern": "sid.upstream.example", "custom_domain": true }]`.
2. **The secrets,** one per publisher, as a Worker secret, never a var:

   ```sh
   openssl rand -hex 32                       # once per publisher
   npx wrangler secret put SID_UPSTREAM_SECRETS
   # paste: ["<publisher A's secret>","<publisher B's secret>"]
   ```

3. **The vars:** the headers the publishers' CDNs set, and each publisher's site in `SID_HOSTS`, with its cookie domain:

   ```jsonc
   "SID_CLIENT_IP_HEADER": "x-sid-client-ip",
   "SID_LOCATION_HEADERS": "{\"country\":\"x-sid-country\",\"regionCode\":\"x-sid-region\"}",
   "SID_HOSTS": "{\"www.pub-a.com\":{\"SID_COOKIE_DOMAIN\":\"pub-a.com\"},\"www.pub-b.com\":{\"SID_COOKIE_DOMAIN\":\"pub-b.com\"}}"
   ```

   `SID_UPSTREAM_AUTH_HEADER` (`x-sid-upstream-auth`) and `SID_UPSTREAM_HOST_HEADER` (`x-forwarded-host`) can stay at their defaults. `SID_LOCATION_HEADERS` must name the country header. Then deploy, and regenerate the types if you added vars.
4. **Each publisher's CDN** passes `/_sid/*` to the Worker's hostname, uncached, setting `X-SID-Upstream-Auth`, `X-Forwarded-Host`, `X-SID-Client-IP` and `X-SID-Country`: the recipe for each CDN is in [Publisher CDN recipes](../../../docs/upstream-operators.md#publisher-cdn-recipes).
5. **Check:** `curl -sI https://sid.upstream.example/_sid/v1` answers `403`, and for each publisher, `npm run verify-deployment -- --site https://www.pub-a.com` passes ([Verify in the guide](../../../docs/upstream-operators.md#3-verify) has the forged-header and EU checks).

Not the Snippet: it has no secrets, and its build refuses trusted-upstream settings. Nothing changes on the page either way: Prebid.js's SharedID `pixelUrl` stays `/_sid/sync` on the publisher's own site ([Configure Prebid.js](../../../docs/prebid.md)). Trusted-upstream mode is tested against local stand-ins (the conformance suite's `trusted-upstream.json` on the Worker in `wrangler dev`), and live, on an upstream-operator hostname, behind publishers on Cloudflare using the [Cloudflare recipe](../../../docs/upstream-operators.md#cloudflare-the-publishers-zone-your-endpoint-elsewhere) ([What's been verified live](../../../docs/upstream-operators.md#whats-been-verified-live)). Behind CloudFront it's next ([#136](https://github.com/patmmccann/sharedid-edge/issues/136)).

## Configuration and secrets

- **Settings:** every setting is a `SID_*` variable, listed in [`wrangler.jsonc`](wrangler.jsonc) and described in the [Configuration reference](../../../docs/configuration.md). An empty string means "use the default".
- **Invalid settings** make every request return `500 SharedID Edge is misconfigured`, rather than setting wrong cookies. The reason is written to the Worker's logs (`wrangler tail`).
- **Secrets** (the `ec` module's passphrase) go in `SID_MODULE_SECRETS`, set as a Worker secret, never in `vars`:

  ```sh
  npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_MODULE_SECRETS
  ```

  For local development, put it in `packages/adapters/cloudflare/.dev.vars` (git-ignored).
- **Trusted upstream** (an upstream operator's Worker behind publishers' CDNs, [Upstream operators](#upstream-operators) and the [upstream-operator guide](../../../docs/upstream-operators.md)): `SID_UPSTREAM_SECRETS` is a Worker secret too (`wrangler secret put SID_UPSTREAM_SECRETS`), never a var. `SID_UPSTREAM_AUTH_HEADER`, `SID_UPSTREAM_HOST_HEADER`, `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` are vars, and need the secret.

## Rate limiting

Put a WAF rate limiting rule on `/_sid/*` first: a request it blocks never reaches the Worker, so it isn't billed as one. [Abuse protection and cost control](../../../docs/abuse-protection.md#cloudflare) has the rule, and what the Worker refuses by itself (oversized requests get a `414` or `431`).

The Worker can also count requests itself with [rate limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), opt-in. A refused request still runs (and bills) the Worker, but gets a `429` with no cookies before any module runs or an ID is minted. Use them where a WAF rule can't see what to count: behind publishers' CDNs in trusted-upstream mode, where the connecting address is the CDN's, and per site.

| Binding | Counts per | Use |
| --- | --- | --- |
| `SID_RATE_LIMIT_CLIENT` | Client IP: `CF-Connecting-IP`, or in trusted-upstream mode the forwarded `SID_CLIENT_IP_HEADER`; an IPv6 address by its /64. Requests without a client IP aren't counted. | One visitor, or one bot, flooding |
| `SID_RATE_LIMIT_HOST` | Site hostname: the request's, or in trusted-upstream mode `X-Forwarded-Host` | One site's flood not running up the bill for the rest |

Either or both. A request is refused when either is over its limit. `/_sid/optout` and `/_sid/optin` are never counted, and a binding that fails lets the request through. Add them to `wrangler.jsonc` (the commented example there), with limits from your own traffic (Workers analytics: requests per minute at your busiest):

```jsonc
"ratelimits": [
  // Per visitor: generous, since a network's NAT puts many visitors behind one address.
  { "name": "SID_RATE_LIMIT_CLIENT", "namespace_id": "1001", "simple": { "limit": 1800, "period": 60 } },
  // Per site: well above its busiest minute in one location.
  { "name": "SID_RATE_LIMIT_HOST", "namespace_id": "1002", "simple": { "limit": 100000, "period": 60 } }
]
```

`period` is 10 or 60 seconds, and the counts are per Cloudflare location and approximate: a limit is a ceiling for one location, not a global quota. `namespace_id` is any number unique in your account. Then deploy with the rate-limit scripts:

```sh
npm run deploy:rate-limit -w @sharedid-edge/cloudflare          # or deploy:bowser:rate-limit
```

`npm run deploy` (and `dev`, `build`) leave the rate-limit code out of the bundle, so the default Worker pays nothing for it, and **ignore the bindings**: use `deploy:rate-limit` (`dev:rate-limit` locally) whenever they're configured. An entry point generated for opt-in modules (`scripts/module-list.mjs --worker`, deployed with plain `wrangler deploy`) includes it. A variable by one of these names, rather than a binding, is invalid configuration (a `500`). The counters are Cloudflare's, keyed by the address or hostname for the period; the Worker logs and keeps nothing.

## Platform data: what the Worker knows about each request

`src/platform.ts` fills `PlatformInfo`, which core and the modules use, from data Cloudflare sets itself. Visitors can't spoof any of it.

| `PlatformInfo` | From | Used by |
| --- | --- | --- |
| `clientIp` | `CF-Connecting-IP` header | `ip`, and `ec` when added |
| `isEU` | `request.cf.isEUCountry` (`"1"` in an EU member state) | GDPR scope when there's no `gdpr` parameter, with the country: GDPR also applies in Iceland, Liechtenstein, Norway, the UK and Turkey, where `isEUCountry` isn't set |
| `country` | `request.cf.country` (ISO 3166-1 alpha-2; `XX` and Tor's `T1` are dropped) | `geo` |
| `region` | `request.cf.regionCode` | `geo` |
| `city`, `postalCode`, `metroCode` | `request.cf.city`, `.postalCode`, `.metroCode` | `geo` |
| `latitude`, `longitude` | `request.cf.latitude`, `.longitude` (dropped if not finite or out of range) | `geo` |
| `timezone`, `continent` | `request.cf.timezone`, `.continent` | `geo` |
| `traffic` | `request.cf.botManagement`: `verifiedBot` as `bot: true, botKind: verified`, `score` (1 to 99) as `score`, `corporateProxy` as `proxy: relay` | The traffic signal (`ortb2.device.ext.traffic`, source `platform`) and `SID_SKIP_BOTS` |

**In trusted-upstream mode** (`SID_UPSTREAM_SECRETS`), `CF-Connecting-IP` and `request.cf` describe the publisher's CDN, not the visitor, so none of the above is used, Bot Management's verdict included: the client IP and location come from the headers `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` name, on requests carrying the secret ([Upstream operators](#upstream-operators)). Custom hostname metadata isn't read then either: the request arrives on your hostname, and `X-Forwarded-Host` picks the site in `SID_HOSTS`.

Core's `locationInfo` validates every location value the same way for all adapters, dropping empty and invalid ones. Location data is available on every Cloudflare plan. Bot Management is an Enterprise add-on: without it, `request.cf.botManagement` is absent or has no score, and the Worker adds no traffic verdict. `verifiedBotCategory` isn't in the Workers runtime types, so it isn't read.

## Built-in modules

The Worker builds in `ip`, `geo`, `reflect`, `bot`, `ua` and `clickid`, from the list every adapter shares ([`@sharedid-edge/modules`](../../modules/all/README.md)). They do nothing until listed in `SID_MODULES`. See the [Modules](../../../docs/modules.md) and each module's README. To add your own, an opt-in module ([`cmp`](../../modules/cmp/README.md)) or a vendor module, generate an entry point with `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module <package>#<export>` and deploy it with `npx wrangler deploy .sharedid-modules/worker.ts`. Don't import it in `src/index.ts` for `npm run deploy`: the npm scripts build the built-in modules only, and define `globalThis.__SID_NO_CONSENT_HOOKS__` so core's consent-provider code is left out, which would ignore a module like `cmp`. They also define `globalThis.__SID_NO_FORWARDING__`, which leaves out core's code for forwarding modules such as [`tag-gateway`](../../modules/tag-gateway/README.md).

## Google's tag gateway on the same zone

Google's [tag gateway for advertisers](https://developers.google.com/tag-platform/tag-manager/gateway) (formerly "first-party mode") serves the Google tag and its measurement requests from a path on your site, such as `/metrics`. On Cloudflare, use **Cloudflare's built-in integration** (in the zone's dashboard, or set up from Google Tag Manager; see [Cloudflare's announcement](https://blog.cloudflare.com/google-tag-gateway-for-advertisers/)) or the Snippet in [Google's setup guide](https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide?setup=manual). Nothing in this Worker changes: the two run side by side on the same zone, both on your own domain.

**Keep the routes apart.** The gateway's path and the Worker's route must not overlap: `example.com/_sid/*` for the Worker, `/metrics` for the gateway, never a gateway path under `/_sid`, nor a Worker route like `example.com/*` that covers the gateway's path.

If you want SharedID Edge's consent handling in front of the tag (nothing forwarded on opt-out, COPPA, GPC or missing TCF consent), the opt-in [`tag-gateway`](../../modules/tag-gateway/README.md) module serves the gateway from this Worker or Snippet instead: build it in as above, add a route for its path (`example.com/metrics/*`) next to `example.com/_sid/*` (the Snippet build prints a rule that covers both), and turn Cloudflare's integration off for that path. Its README has the details, and the disclosure of what it sends to Google.

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

Then it runs `npm run verify-deployment -- --site https://e2e.sharedid.dev`, the conformance suite's default-configuration cases against `https://conformance.sharedid.dev/_sid`, and the Playwright tests in [`e2e/`](../../../e2e/AGENTS.md) against `https://e2e.sharedid.dev` (`E2E_BASE_URL`) in Chromium, Firefox and WebKit. With the AWS live tests' role (`AWS_E2E_ROLE_ARN`), an `eu-visitor` job then requests `https://e2e.sharedid.dev/_sid` from Frankfurt, through the AWS live tests' [EU visitor](../aws-lambda/README.md#the-eu-visitor), and checks GDPR for a visitor whose `request.cf` is German: without a TC string GDPR applies and nothing is stored, and with consent the ID is set. (No response shows `isEUCountry` itself; GDPR follows from it or from the country, which agree for Germany.) A failing run, after a merge or overnight, opens an issue, or comments on the open one; the next green run on `main` (including a re-run of the failed jobs) comments and closes it.

Setting it up on another zone (a fork, say):

1. Add the zone to a Cloudflare account, proxied. For each test hostname, add a proxied `AAAA` record with the content `100::`: the Workers answer every request, so no origin is needed.
2. Change the hostnames and `zone_name` in the `env` section of `wrangler.jsonc`, `e2e/site/wrangler.jsonc` and the workflow.
3. Create an API token with **Workers Scripts: Edit** on the account, and **Workers Routes: Edit** and **Zone: Read** on the zone. Under **My Profile → API Tokens**, the *Edit Cloudflare Workers* template has these. An account-owned token (the account's **API Tokens**) calls the zone a *domain*: the route permissions need a policy for the domain, not the account.
4. Add the token and the account ID as the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow fails at once, saying so, when either is missing.

### The upstream-operator and Cloudflare for SaaS setups

Two models need domains of their own, so they're set up once by hand, and then redeployed and tested by a workflow of their own ([below](#the-upstream-operator-and-saas-workflow)): an upstream operator's endpoint behind publishers' CDNs ([SharedID Edge for upstream operators](../../../docs/upstream-operators.md), [#136](https://github.com/patmmccann/sharedid-edge/issues/136)) and a hosting company's Cloudflare for SaaS zone ([SharedID Edge for hosting companies](../../../docs/hosting-companies.md), [#135](https://github.com/patmmccann/sharedid-edge/issues/135)). The scripts in [`live/`](live) deploy them from hostnames you pass in. The project runs them with three domains:

| Domain | DNS | Plays |
| --- | --- | --- |
| `saleshouse.dev` | Cloudflare, same account | The upstream operator: `sid.saleshouse.dev`, this Worker in trusted-upstream mode |
| `hotba.be` | Route 53 | Publishers not on Cloudflare: `pub.hotba.be` on CloudFront, forwarding `/_sid/*` to the upstream operator; `saas.hotba.be` and `saas2.hotba.be`, custom hostnames of the SaaS zone |
| `sharedid.dev` | Cloudflare | Publishers on Cloudflare (`saleshouse-pub.sharedid.dev`, `saleshouse-conformance.sharedid.dev`), forwarding with the [Cloudflare recipe](../../../docs/upstream-operators.md#cloudflare-the-publishers-zone-your-endpoint-elsewhere); and the hosting company's SaaS zone |

[`live/upstream.sh`](live/upstream.sh) deploys the upstream operator and its publishers:

- `sharedid-saleshouse`: this Worker on a custom domain, with both publisher CDNs' secrets in `SID_UPSTREAM_SECRETS` (a Worker secret, uploaded with the version), the recipes' header names, and each publisher in `SID_HOSTS`. Each has a cookie domain of its own, and the settings of the `e2e` environment above, so the Playwright tests run against it, except the conformance publisher, on the defaults.
- `sharedid-saleshouse-forward`: [`live/forward.js`](live/forward.js), the Cloudflare recipe's Worker as written, on the Cloudflare publishers' `/_sid/*`.
- The `sharedid-saleshouse-pub` stack ([`live/publisher-cloudfront.yaml`](live/publisher-cloudfront.yaml)), in the AWS test account: the publisher's ACM certificate and Route 53 alias, the test page in a private S3 bucket, and the [CloudFront recipe](../../../docs/upstream-operators.md#amazon-cloudfront)'s origin, behaviour and function. Creating CloudFront Functions needs the `cloudfront:*Function` actions, which the [AWS live tests' policy](../aws-lambda/live/iam-policy.json) doesn't have; [`live/iam-policy.json`](live/iam-policy.json) adds them, and `UO_CLOUDFRONT_FORWARD=false` deploys the site without them.

The Workers, the stack and the test domains keep the `saleshouse` names they were first deployed with (renaming them means removing and redeploying them); `UO_ENDPOINT_WORKER`, `UO_FORWARD_WORKER` and `UO_STACK` choose other names.

[`live/saas.sh`](live/saas.sh) sets up the SaaS zone (its `setup` part): the fallback origin and the custom hostnames (with their CNAME, ownership and certificate TXT records written to Route 53). Its `workers` part deploys `sharedid-saas` (this Worker on `*/_sid/*`, with one of the custom hostnames in `SID_HOSTS`) and `sharedid-saas-site` (the test page on `*/*`). Cloudflare for SaaS has to be enabled on the zone first, in the dashboard (SSL/TLS, Custom Hostnames); the API can't.

```sh
npm ci && npm run build && npm ci --prefix e2e
# the variables each script lists at its top (or --help), then
packages/adapters/cloudflare/live/upstream.sh            # or: upstream.sh workers, upstream.sh cloudfront
packages/adapters/cloudflare/live/saas.sh                   # or: saas.sh setup, saas.sh workers
```

Wrangler deploys the Workers (logged in, or `CLOUDFLARE_API_TOKEN`); the `cf` CLI sets up the SaaS zone, and the AWS CLI the stack and the Route 53 records. The secrets stay in a folder you name outside the repository (`UO_SECRETS_DIR`), and are never printed. The generated Wrangler configurations go in `live/.out/`, so `npx wrangler deploy --config live/.out/endpoint.json` redeploys one Worker. Then, for each publisher hostname:

```sh
npx tsx scripts/check-live-site.ts --site https://<publisher hostname> --cookie-domain <its cookie domain> \
  --endpoint https://<endpoint>          # SaaS: --unlisted https://<unlisted custom hostname> instead of --endpoint
npm run verify-deployment -- --site https://<publisher hostname>
node conformance/dist/run.js --base-url https://<conformance publisher>/_sid
cd e2e && E2E_BASE_URL=https://<publisher hostname> E2E_COOKIE_DOMAIN=<its cookie domain> npx playwright test
```

[`scripts/check-live-site.ts`](../../../scripts/check-live-site.ts) asserts what the manual runs checked with `curl`: `/_sid/v1` has your own address (as two echo services see it) and a country; forged `X-SID-Client-IP`, `X-SID-Country`, `X-SID-Region`, `X-SID-Upstream-Auth`, `X-Forwarded-Host`, `X-Forwarded-For` and `X-Real-IP` change nothing, in `/_sid/v1` or `/_sid/sync` (the cookie stays on the site's domain, and a forged EU country doesn't decide GDPR); `/_sid/sync` sets `_pubcid` with `Domain=<cookie domain>`; with `--endpoint`, the endpoint called directly answers `403` with no cookie, with or without forged headers; with `--unlisted`, a hostname that isn't in `SID_HOSTS` answers `404` with no cookie.

[What's been verified live](../../../docs/upstream-operators.md#whats-been-verified-live) in each guide has the results of the manual runs. To remove everything (the Workers' routes and custom domain go with them):

```sh
npx wrangler delete --name sharedid-saleshouse-forward
npx wrangler delete --name sharedid-saleshouse
npx wrangler delete --name sharedid-saas
npx wrangler delete --name sharedid-saas-site
aws s3 rm s3://sharedid-saleshouse-pub-<account> --recursive
aws cloudformation delete-stack --stack-name sharedid-saleshouse-pub   # the certificate and Route 53 aliases too
```

Then delete the custom hostnames (`cf custom-hostnames delete <id> -z <zone>`) and their records on the publisher's DNS, and the test hostnames' `AAAA 100::` records.

#### The upstream operator and SaaS workflow

The [upstream-operator live tests workflow](../../../.github/workflows/e2e-upstream.yml) redeploys these setups from `main` and runs the checks above: after every merge, nightly, and on demand from the Actions tab. Like the other live workflows, it doesn't run on pull requests, by design ([#154](https://github.com/patmmccann/sharedid-edge/issues/154)): a pull request's code would run with the deploy credentials. Runs don't overlap; of several waiting, only the newest runs. It first ran green on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)), and with the CloudFront publisher too later that day ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44019340421)); [How SharedID Edge is verified](../../../docs/verification.md#live-tests-upstream-operator) has what it passed. Its jobs:

| Job | What |
| --- | --- |
| Which parts are set up | Checks which secrets and variables are set. Without the Cloudflare ones, the run skips with a notice naming them; without the AWS ones, only the CloudFront publisher is skipped, with a notice. |
| Deploy the Workers, check the Cloudflare publisher and SaaS, conformance | `upstream.sh workers` and `saas.sh workers`; then `check-live-site` and `verify-deployment` on `saleshouse-pub.sharedid.dev` (with `--endpoint https://sid.saleshouse.dev`) and on `saas.hotba.be` (with `--unlisted https://saas2.hotba.be`), and the conformance suite's default-configuration cases against `https://saleshouse-conformance.sharedid.dev/_sid` |
| Deploy and check the CloudFront publisher | After the endpoint: `upstream.sh cloudfront` (the stack update, the test page and a cache invalidation), then `check-live-site` and `verify-deployment` on `pub.hotba.be` |
| Prebid.js end to end | The browser tests in Chromium, Firefox and WebKit against `saleshouse-pub.sharedid.dev` (cookie domain `sharedid.dev`), `saas.hotba.be` (`hotba.be`) and, when its job passed, `pub.hotba.be` (`hotba.be`). A failure uploads `playwright-report-upstream-<site>-<browser>`, kept for 7 days. |
| An EU visitor | With `AWS_E2E_ROLE_ARN`, after the Workers' checks: the AWS live tests' [EU visitor](../aws-lambda/README.md#the-eu-visitor) requests `saleshouse-pub.sharedid.dev`, `saas.hotba.be` and, when its job passed, `pub.hotba.be` from Frankfurt (`scripts/check-eu-visitor.ts`): without a TC string, GDPR applies from the real location and nothing is stored; with consent, the ID is set; `geo` reports an EU country. Skipped without the role. |
| Report a failing run | After a merge or overnight, opens "Live upstream-operator tests are failing", or comments on the open one |

What's made once, by hand, and what each run deploys:

| Once (the scripts' `setup` part, or the dashboard) | Every run |
| --- | --- |
| The zones; the test hostnames' `AAAA 100::` records on `sharedid.dev`; Cloudflare for SaaS on `sharedid.dev`, its fallback origin and the custom hostnames `saas.hotba.be` and `saas2.hotba.be` with their Route 53 records (`saas.sh setup`); the `sharedid-saleshouse-pub` stack's first deployment, which creates the certificate and the Route 53 aliases for `pub.hotba.be` (`upstream.sh cloudfront`) | The four Workers (`sharedid-saleshouse` with its custom domain and secrets, `sharedid-saleshouse-forward`, `sharedid-saas`, `sharedid-saas-site`) and their routes; the stack update (the recipe's function and behaviour), the test page in its bucket and a cache invalidation |

So the workflow's credentials need nothing for DNS, certificates or custom hostnames. Setting it up (in this repository, all three steps are done):

1. **The Cloudflare token.** The live tests' `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets ([Live tests](#live-tests)) cover it when `saleshouse.dev` is in the same account (it is) and the token can read it (this repository's token now covers both zones). Edit the token (rolling isn't needed) so it has:
   - **Account · Workers Scripts · Edit**: the four Workers, and `sid.saleshouse.dev`'s custom domain, which is an account-level Workers call;
   - **Zone · Workers Routes · Edit** on `sharedid.dev`: the forwarding Worker's and the SaaS Workers' routes;
   - **Zone · Zone · Read** on `sharedid.dev` and `saleshouse.dev`: Wrangler looks up the zone of each route and custom domain.

   Not needed: DNS, SSL and Certificates, or Custom Hostnames. The custom domain already exists, so a redeploy creates no record; if Wrangler still refuses it with an authentication error, add **Zone · DNS · Edit** on `saleshouse.dev` only.
2. **The upstream secrets.** Repository secrets `UPSTREAM_SECRET_CLOUDFLARE` and `UPSTREAM_SECRET_CLOUDFRONT`: the shared secret each publisher CDN sends, the contents of `upstream-secret-cloudflare` and `upstream-secret-cloudfront` in the manual runs' `UO_SECRETS_DIR`. Set them from the files, so they aren't shown or kept in your shell history: `gh secret set UPSTREAM_SECRET_CLOUDFLARE < "$UO_SECRETS_DIR/upstream-secret-cloudflare"`, and the same for `cloudfront`. Both are needed even without AWS, since the endpoint takes both: a run without the CloudFront one would lock `pub.hotba.be` out. New values (`openssl rand -hex 32`) rotate them; the CloudFront stack then needs redeploying too, which the workflow does when AWS is set up.
3. **AWS, for the CloudFront publisher (optional).** The same role as the [AWS live tests](../aws-lambda/README.md#setting-it-up): the GitHub OIDC provider, and a role whose trust policy ([`live/trust-policy.json`](../aws-lambda/live/trust-policy.json)) allows only runs on `main` of this repository, with the AWS live tests' policy attached. The policy lists both forms of the token's `sub` claim, the classic `repo:patmmccann/sharedid-edge:ref:refs/heads/main` and the immutable `repo:patmmccann@1683175/sharedid-edge@1452979248:ref:refs/heads/main`, which this repository issues; see [Setting it up](../aws-lambda/README.md#setting-it-up) for how to check which one a repository uses. The AWS live tests already run with that role, so what's left here is the second policy and `PUBLISHER_ROUTE53_ZONE_ID`. Attach a second customer-managed policy to the same role, [`live/iam-policy.json`](live/iam-policy.json) from this package with `ACCOUNT_ID` and `HOSTED_ZONE_ID` (the publisher domain's hosted zone) replaced. It adds only what the publisher stack needs beyond the first policy:
   - `PublisherRecords` and `Route53Read`: the Route 53 aliases and certificate validation records in that hosted zone, and waiting for changes;
   - `Certificates`: the publisher's ACM certificate;
   - `CloudFrontFunctions` and `CloudFrontFunctionsList`: the recipe's viewer-request function, on `sharedid-*` functions only.

   The stacks, buckets and distributions are already covered by the first policy (`sharedid-*`). Then set the repository variables `AWS_E2E_ROLE_ARN` (the role's ARN, which also turns on the AWS live tests) and `PUBLISHER_ROUTE53_ZONE_ID` (the same hosted zone ID). Without them, the CloudFront publisher is skipped and the rest runs.

The hostnames are in the workflow's `env`; a fork changes them there, and the trust policy's repository.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route doesn't match: check the hostname in `routes`, and that the hostname is proxied (orange cloud). |
| `500 SharedID Edge is misconfigured` | A `SID_*` value is invalid. `wrangler tail` shows which. |
| Every request gets a 500 | `SID_COOKIE_DOMAIN` is empty: it's required (`wrangler tail` shows the message). |
| Cookies set but not sent back | `SID_COOKIE_DOMAIN` doesn't cover the page's host, or the site isn't on https. |
| `geo` returns nothing precise | Consent rules out precise location, or the visitor's location isn't known to that precision. Check `ext.modules.geo`. |
| `verify-deployment` says the IPs differ | The endpoint is answered somewhere other than your site's Cloudflare hostname (for example a CNAME to another domain). Safari will cap its cookies. |
| Behind a publisher's CDN, every request gets `403 Forbidden` | The CDN doesn't send `X-SID-Upstream-Auth` (or your `SID_UPSTREAM_AUTH_HEADER`) with one of the secrets in `SID_UPSTREAM_SECRETS`, or sends it twice. Check the secret has no quotes or spaces around it. |
| Behind a publisher's CDN, `404 Not found` | `X-Forwarded-Host` is missing, or names a host `SID_HOSTS` doesn't list. |
| Behind a publisher's CDN, `400 Bad request` | `X-Forwarded-Host` isn't one hostname: a CDN appended to one the visitor sent (`a, b`). Have the CDN set it, not append. |
| Behind a publisher's CDN, `ip` or `geo` is empty, or EU visitors get cookies | The CDN doesn't set `X-SID-Client-IP` or `X-SID-Country` (or the headers your settings name). |
| `500` with `SID_UPSTREAM_SECRETS` set | Its value isn't a JSON array of secrets of 32 or more characters, or `SID_LOCATION_HEADERS` doesn't name the country header, or a header name doesn't start with `x-`. `wrangler tail` names the setting, never the secret. |
