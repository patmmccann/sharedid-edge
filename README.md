# SharedID Edge

SharedID Edge is a small open-source edge worker that keeps the [Prebid SharedID](https://docs.prebid.org/identity/sharedid.html) durable. It runs on a route of your own domain (`www.example.com/_sid/*`) on the CDN that already serves your site, and sets the SharedID as a **server-set first-party cookie**, so Safari doesn't cap it at 7 days.

It replaces the [WordPress](https://github.com/prebid/sharedid-wordpress) and [Drupal](https://github.com/prebid/sharedid-drupal) SharedID plugins and the endpoint examples in the SharedID docs: it implements the same `pixelUrl` contract, so Prebid.js needs no code change. Unlike those, it answers at the CDN edge, so your origin sees no extra traffic.

It also has a **module** interface for IDs and signals that are best computed at the edge (connecting IP, geography, bot scores, device data), returned to the page in one JSON response. See the [proposal](https://github.com/prebid/prebid-server/issues/5064) for the background.

- [How it works](#how-it-works)
- [Deploy on Cloudflare](#deploy-on-cloudflare)
- [Deploy on AWS (Lambda and CloudFront)](#deploy-on-aws-lambda-and-cloudfront)
- [Deploy on Vercel](#deploy-on-vercel)
- [Deploy on Google Cloud (Cloud Run functions and Load Balancing)](#deploy-on-google-cloud-cloud-run-functions-and-load-balancing)
- [Configure Prebid.js](#configure-prebidjs)
- [Migrate from the WordPress or Drupal plugin](#migrate-from-the-wordpress-or-drupal-plugin)
- [Consent and opt-out](#consent-and-opt-out)
- [Self-host with Node.js](#self-host-with-nodejs)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

```text
Browser (www.example.com)                       Your CDN, same host: www.example.com/_sid/*
 └─ Prebid.js sharedIdSystem ── pixelUrl ──►  /_sid/sync?id=pubcid:<id>
                                                 ├─ choose the ID (see below)
                                                 └─ Set-Cookie: _pubcid=<id>; Max-Age=31536000; Secure; SameSite=Lax
                                                    Set-Cookie: _pubcid_sv=<id>; …; HttpOnly   (recovery copy)
```

1. Prebid.js's `sharedIdSystem` calls `pixelUrl` with the ID it has (`?id=pubcid:<id>`), on the first visit and, with `extend: true`, on later ones.
2. The worker answers with a 1×1 GIF and sets the ID as a cookie with a one-year lifetime. Cookies set by a first-party server aren't subject to Safari's 7-day cap on cookies written by script.
3. Prebid.js reads the cookie back after the pixel loads, so the server's value wins.
4. The worker also sets an `HttpOnly` copy, `_pubcid_sv`. If Safari caps or clears the script-readable cookie and the page mints a new ID, the next sync restores the original from this copy.

The worker never replaces an existing ID: when you turn it on, it adopts the IDs your visitors already have. It answers only its own routes and never forwards them to your origin, and it never adds cookies to your cacheable pages.

**Why it must run on your site's CDN:** since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days too. A separate service behind a CNAME doesn't work; a route on the CDN that serves `www.example.com` does.

## Deploy on Cloudflare

Full reference: [`packages/adapters/cloudflare/README.md`](packages/adapters/cloudflare/README.md).

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

Edit [`packages/adapters/cloudflare/wrangler.jsonc`](packages/adapters/cloudflare/wrangler.jsonc):

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
    // … every setting is listed in the Configuration reference below
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

```sh
npm run verify-deployment -- --site https://www.example.com
```

This checks, from outside, that:

- the endpoint shares IP addresses with your site (the Safari rule above);
- `/_sid/sync` returns the pixel and sets `_pubcid` (Secure, SameSite=Lax, at least 300 days, readable by script) and the `HttpOnly` recovery copy, adopting the ID it's sent;
- the response isn't served from a shared cache;
- `/_sid/v1` returns the JSON payload.

Options: `--endpoint https://www.example.com/identity` for a different path, `--cookie-name`, `--min-days`.

You can also check by hand: `curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'` should show `200`, `content-type: image/gif` and two `set-cookie` headers.

### 5. Turn it on in Prebid.js

See [Configure Prebid.js](#configure-prebidjs). Deploying the worker changes nothing on your pages until Prebid.js calls it.

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

## Deploy on AWS (Lambda and CloudFront)

If your site is served through Amazon CloudFront, run SharedID Edge as a Lambda function behind a `/_sid/*` behaviour of **your site's own distribution**. Full guide (architecture, the template's options, configuration, troubleshooting): [`packages/adapters/aws-lambda/README.md`](packages/adapters/aws-lambda/README.md).

**Why your own distribution:** since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A behaviour on the distribution that serves `www.example.com` shares its IP addresses; a separate distribution or API endpoint on another hostname doesn't.

### Prerequisites

- An existing CloudFront distribution serving your site over https, and its ID (like `E2ABCDEFGHIJKL`).
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), with credentials that can create Lambda, IAM, CloudWatch Logs and CloudFront resources (`aws configure`).
- Node.js 24 or later and npm.

### 1. Build

```sh
git clone https://github.com/patmmccann/sharedid-edge.git
cd sharedid-edge
npm ci
npm run build
npm run bundle -w @sharedid-edge/aws-lambda    # one file: packages/adapters/aws-lambda/deploy/lambda.mjs
```

### 2. Deploy the function

```sh
cd packages/adapters/aws-lambda
sam deploy --guided
```

Answer the prompts: a stack name (like `sharedid-edge`), your region, `DistributionId` = your distribution's ID, and the `Sid*` settings you need (empty means the default; `SidCookieDomain` = `.example.com` to share the cookie across subdomains). Let SAM save the answers to `samconfig.toml`; later deploys are `sam deploy`.

This creates a Node.js 24 function with a function URL that accepts only requests signed by your distribution (`AWS_IAM` auth and an origin access control), and an origin request policy. The stack's outputs list what step 3 needs.

### 3. Add the `/_sid/*` behaviour to your distribution

In the CloudFront console, on your distribution:

1. **Origins → Create origin:** origin domain = the `OriginDomainName` output (`<id>.lambda-url.<region>.on.aws`), protocol HTTPS only, and origin access control = the stack's (the `OriginAccessControlId` output).
2. **Behaviors → Create behavior:** path pattern `/_sid/*`, that origin, viewer protocol policy *Redirect HTTP to HTTPS*, allowed methods *GET, HEAD, OPTIONS*, cache policy **CachingDisabled**, origin request policy = the stack's (the `OriginRequestPolicyId` output). Make sure it's above any `*` behaviour that would catch `/_sid/*` first.

Wait for the distribution to deploy. To try it on a new distribution instead, deploy with `CreateDistribution=true` (see the [package README](packages/adapters/aws-lambda/README.md#a-new-distribution)).

### 4. Configure

Settings are the function's `SID_*` environment variables (the [Configuration reference](#configuration-reference)), set through the template's parameters: `sam deploy --parameter-overrides SidModules=ip`. Secrets (`SID_MODULE_SECRETS`, for example the `ec` passphrase) go in the `SidModuleSecrets` parameter, which CloudFormation doesn't display; Lambda stores it as an environment variable encrypted at rest. The [package README](packages/adapters/aws-lambda/README.md#secrets) explains why this rather than Secrets Manager. Invalid settings make every request return a 500; the reason is in the function's CloudWatch logs.

### 5. Verify

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks that `/_sid/*` shares the site's IP addresses, sets the cookies correctly, isn't cached, and returns the JSON payload. Then [turn it on in Prebid.js](#configure-prebidjs).

Lambda@Edge (running in CloudFront's edge locations, without a separate origin) is possible future work; see the [package README](packages/adapters/aws-lambda/README.md#lambdaedge).

## Deploy on Vercel

If your site is deployed on Vercel, serve SharedID Edge from a `/_sid/*` route of **the same Vercel project**, as a Next.js route handler (or, for other frameworks, Routing Middleware). Full guide (architecture, middleware, configuration, the platform headers, troubleshooting): [`packages/adapters/vercel/README.md`](packages/adapters/vercel/README.md).

**Why the same project:** since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A route of the project that serves `www.example.com` answers from the same addresses; a separate project on another hostname (`sid.example.com`, `*.vercel.app`) doesn't.

### Prerequisites

- A Next.js (App Router) site deployed on Vercel on your own domain, over https. For other frameworks, see [middleware](packages/adapters/vercel/README.md#deploy-with-middleware).
- Node.js 24 or later and npm.

### 1. Build the bundle

```sh
git clone https://github.com/patmmccann/sharedid-edge.git
cd sharedid-edge
npm ci
npm run build
npm run bundle -w @sharedid-edge/vercel    # packages/adapters/vercel/deploy/sharedid-edge.mjs and .d.mts
```

Copy `sharedid-edge.mjs` and `sharedid-edge.d.mts` into your site's repository, for example into `lib/`.

### 2. Add the route

Create `app/%5Fsid/[...path]/route.ts` in your site. The folder is `%5Fsid`, the URL-encoded `_sid`: Next.js doesn't route folders whose names start with `_`.

```ts
import { handlerFromEnv } from '../../../lib/sharedid-edge.mjs';

export const runtime = 'nodejs';

const handler = handlerFromEnv(process.env);

export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
```

Use Node.js 24 for the project (`"engines": { "node": ">=24" }` in `package.json`).

### 3. Configure and deploy

Settings are the project's environment variables (the [Configuration reference](#configuration-reference)), for example `vercel env add SID_MODULES production`. Add `SID_MODULE_SECRETS` as a **Sensitive** variable (`vercel env add SID_MODULE_SECRETS production --sensitive`). Then deploy as usual (`git push` or `vercel deploy --prod`); environment variable changes need a new deployment. Invalid settings make `/_sid/*` return a 500; the reason is in the function's logs.

### 4. Verify

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks that `/_sid/*` shares the site's IP addresses, sets the cookies correctly, isn't cached, and returns the JSON payload. Then [turn it on in Prebid.js](#configure-prebidjs). The client IP and location come from headers Vercel's proxy sets (`x-real-ip`, `x-vercel-ip-country` and the rest); see [Platform information](packages/adapters/vercel/README.md#platform-information).

## Deploy on Google Cloud (Cloud Run functions and Load Balancing)

If your site is served through Google Cloud's external Application Load Balancer, run SharedID Edge as a Cloud Run function behind a `/_sid/*` path rule of **your site's own URL map**. Full guide (architecture, functions or services, Firebase Hosting, the Terraform, configuration, troubleshooting): [`packages/adapters/gcp-functions/README.md`](packages/adapters/gcp-functions/README.md).

**Why your own load balancer:** since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A path rule on the URL map that serves `www.example.com` shares its IP address; the function's `*.run.app` URL, or another load balancer, doesn't. (Firebase Hosting rewrites don't work: Hosting strips the cookies SharedID Edge needs. See the [package README](packages/adapters/gcp-functions/README.md#firebase-hosting).)

### Prerequisites

- Your site on a global external Application Load Balancer (or the classic one), with a URL map you can edit, on your own domain over https.
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later with Google credentials (`gcloud auth application-default login`), or the gcloud CLI.
- Node.js 24 or later and npm.

### 1. Build

```sh
git clone https://github.com/patmmccann/sharedid-edge.git
cd sharedid-edge
npm ci
npm run build
npm run bundle -w @sharedid-edge/gcp-functions    # the function's source, in packages/adapters/gcp-functions/deploy/
```

### 2. Create the function and its backend service

```sh
cd packages/adapters/gcp-functions/terraform
terraform init
terraform apply -var project=my-project -var region=us-central1 -var sid_cookie_domain=.example.com
```

This creates a Node.js 24 Cloud Run function that only the load balancer can reach (ingress "internal and Cloud Load Balancing"), a serverless network endpoint group, and a backend service with Cloud CDN off that passes the visitor's country, subdivision, city and coordinates as custom request headers.

### 3. Add the path rule

Add a path rule for `/_sid` and `/_sid/*` (the `path_rule_paths` output) to the `backend_service` output, in the path matcher of the host rule that serves your pages: in your URL map's Terraform, or with `gcloud compute url-maps export` and `import` (see the [package README](packages/adapters/gcp-functions/README.md#add-the-path-rule-to-your-url-map)).

### 4. Configure

Settings are the function's `SID_*` environment variables (the [Configuration reference](#configuration-reference)), set through Terraform variables (`-var sid_modules=ip,geo`). `SID_MODULE_SECRETS` comes from Secret Manager (`-var sid_module_secrets_secret=<secret id>`). The client IP is the second-to-last `X-Forwarded-For` entry, which the load balancer writes (the first is the visitor's own); `SID_TRUSTED_HOPS` changes that if another proxy of yours adds one. Invalid settings make every request return a 500; the reason is in the function's logs.

### 5. Verify

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks that `/_sid/*` shares the site's IP addresses, sets the cookies correctly, isn't cached, and returns the JSON payload. Then [turn it on in Prebid.js](#configure-prebidjs).

## Configure Prebid.js

SharedID Edge works with the unmodified `sharedIdSystem` module. Build Prebid.js with `userId` and `sharedIdSystem`, and set `pixelUrl` to the sync route on your own host:

```js
pbjs.setConfig({
  userSync: {
    userIds: [{
      name: 'sharedId',
      params: {
        pixelUrl: '/_sid/sync',   // same host as the page
        extend: true              // re-sync on later visits to refresh the cookie
      },
      storage: {
        type: 'cookie',
        name: '_pubcid',          // must match SID_COOKIE_NAME
        expires: 365
      }
    }]
  }
});
```

- **`extend: true`** makes Prebid.js call `pixelUrl` on later visits too, which refreshes the cookie's lifetime. The response is cached privately by the browser for a day (`SID_SYNC_CACHE_SECONDS`), so a frequent visitor triggers at most about one request a day. Cookie-only modules such as `reflect` and `ec` also run on these calls; see [Modules on `/_sid/sync`](#modules-on-_sidsync).
- **`storage.type` must be `cookie`**, so the page and the worker share the ID. `html5` (localStorage) won't pick up the server's cookie.
- If Prebid.js runs on a different subdomain than the route, set `pixelUrl` to an absolute URL on a host that shares the cookie's domain, and set `SID_COOKIE_DOMAIN`.

**Known Prebid.js issue:** with `extend: true` and `pixelUrl`, `pbjs.getUserIdsAsync()` doesn't resolve on visits after the first, because `sharedIdSystem`'s extend callback never signals completion. Cookies aren't affected, but code that awaits `getUserIdsAsync()` hangs, and with `auctionDelay` above 0 every auction waits the full delay. Until the fix ([prebid/Prebid.js#16135](https://github.com/prebid/Prebid.js/pull/16135)) is released, keep `auctionDelay` at 0 with `extend: true` and `pixelUrl`.

## Responses

Every route is under `SID_BASE_PATH` (`/_sid` by default). None of them reaches your origin.

### `GET /_sid/sync`: the `pixelUrl` endpoint

A 1×1 GIF (`200`, `Content-Type: image/gif`), plus the cookies:

```http
HTTP/1.1 200 OK
Content-Type: image/gif
Cache-Control: private, max-age=86400        (no-store when no ID was set)
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure; HttpOnly
X-SharedID-Source: param
```

Modules that only set cookies (`reflect`, `ec`) or report to the [traffic signal](#bot-bot-and-staff-traffic-signals) (`bot`) also run here, and add their cookies and an `X-SharedID-Modules` header with each one's status. Traffic reports count towards [`SID_SKIP_BOTS`](#no-sharedid-for-bots), as on `/_sid/v1`; anything else they return is ignored. With `SID_COOKIE_DOMAIN=.example.com`, `SID_MODULES=reflect` configured for `uid1` and for `_ga` with `restore`, and a request carrying `_pubcid`, `uid1` and `_ga`:

```http
HTTP/1.1 200 OK
Cache-Control: private, max-age=86400
Content-Length: 43
Content-Type: image/gif
X-Robots-Tag: noindex
X-SharedID-Modules: reflect=empty
X-SharedID-Source: cookie
Set-Cookie: uid1=AbC123xyz; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _ga=GA1.1.1234567890.1700000000; Max-Age=34560000; Expires=Wed, 15 Dec 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAifQ; Max-Age=34560000; Expires=Wed, 15 Dec 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

### `GET /_sid/v1`: the ID and the modules' output

JSON (`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`), with the same cookies as `/sync`. With `SID_MODULES=ip` and an IPv4 visitor:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }
  ],
  "ortb2": { "device": { "ip": "192.0.2.77" } },
  "ext": { "modules": { "ip": { "ms": 0, "status": "ok" } } }
}
```

An IPv6 visitor gets `"ortb2": { "device": { "ipv6": "2001:db8::7" } }` instead.

With `SID_MODULES=ip,geo`, both modules' output is merged into one `device` object. A visitor in Austin, in winter:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }
  ],
  "ortb2": {
    "device": {
      "ip": "192.0.2.77",
      "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -360, "city": "Austin", "zip": "78701", "lat": 30.2713, "lon": -97.7426 }
    }
  },
  "ext": { "modules": { "ip": { "ms": 1, "status": "ok" }, "geo": { "ms": 0, "status": "ok" } } }
}
```

The same request with `Sec-GPC: 1` gets no ID, deletes the ID cookies, and returns no IP:

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "ip": { "ms": 0, "status": "empty" } } }
}
```

With `SID_MODULES=ip,geo`, `geo` still returns the coarse location, without city, postal code or coordinates:

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -360 } } },
  "ext": { "modules": { "ip": { "ms": 1, "status": "empty" }, "geo": { "ms": 0, "status": "ok" } } }
}
```

With the [`bot` module](#bot-bot-and-staff-traffic-signals) (`SID_MODULES=bot`), a request whose browser user agent comes without `Accept-Language` is a likely bot. The **traffic signal** is returned even with `Sec-GPC: 1`, which still rules out the ID:

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "likely", "sources": ["bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

| Field | |
| --- | --- |
| `v` | Payload version, `1`. |
| `sharedid` | The SharedID. Absent when storage isn't allowed (opt-out, GPC, COPPA, consent), or for a bot with `SID_SKIP_BOTS`. |
| `eids` | OpenRTB `user.ext.eids`: the SharedID as `pubcid.org` (`atype` 1), then any IDs from modules. `[]` when there are none. |
| `ortb2` | An OpenRTB 2.x first-party data fragment, merged from every module's output in `SID_MODULES` order, plus the traffic signal in `device.ext.traffic` (which the worker writes from every module's report and, on Cloudflare with Bot Management, the platform's verdict). Absent when there's nothing to return. Pass it to `pbjs.mergeConfig({ ortb2 })`. |
| `ext.modules` | One entry per module in `SID_MODULES`: `ms` (time taken) and `status`: `ok` (it returned data), `empty` (nothing to add, for example consent rules out the IP), `skipped` (with a `reason`, such as `not installed` for a name the worker doesn't have), `error` or `timeout`. Error details are never returned. |

To read `/v1` from a page on another origin, list that origin in `SID_ALLOWED_ORIGINS` and fetch with `credentials: 'include'`. The response then carries `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`; it never carries `*`.

### `GET /_sid/optout` and `GET /_sid/optin`

`204 No Content`. `/optout` sets `_pubcid_optout=1` and deletes the ID cookies; `/optin` deletes `_pubcid_optout`.

### Debugging headers

- `X-SharedID-Source`: where the ID came from: `cookie`, `recovery` (restored from the `HttpOnly` copy), `param` (adopted from Prebid.js's `?id=`) or `minted`.
- `X-SharedID-Status: denied: <reason>`: why no ID was set. The reason is `opt-out`, `gpc`, `coppa` or `tcf: …`.
- `X-SharedID-Status: skipped: bot`: [`SID_SKIP_BOTS`](#no-sharedid-for-bots) ruled the ID out. Nothing was set, and nothing deleted.
- `X-SharedID-Modules` (on `/sync` only): each module that ran there, with its status, as in `ext.modules`: `reflect=empty, ec=ok, bot=ok`. Never cookie names, values or error details. `empty` is the normal status for a module that only sets cookies; `bot` is `ok` when it reported something to the traffic signal, which on `/sync` counts only towards `SID_SKIP_BOTS`.

## Migrate from the WordPress or Drupal plugin

The plugins and SharedID Edge implement the same contract, so switching is a configuration change:

1. Deploy SharedID Edge and verify it, as above. Keep the plugin installed for now.
2. In your Prebid.js configuration, change `pixelUrl` from `/wp-json/pubcid/v1/extend/` (WordPress) or `/pubcid` (Drupal) to `/_sid/sync`.
3. Use the same cookie name as the plugin (its default is `_pubcid`, the same as here), and the same domain setting (`SID_COOKIE_DOMAIN`, the plugin's "Cookie Domain").
4. Once the new `pixelUrl` is live, uninstall the plugin.

Existing visitors keep their IDs: the worker adopts the cookie the plugin set. Two differences:

- **First visits:** the plugins only re-set a cookie that already exists, so a new visitor's first sync sets nothing unless you configured a "Generate Function". SharedID Edge adopts the ID Prebid.js sends with the first sync, so new visitors get a server-set cookie straight away.
- **Consent:** the plugins call a PHP "Consent Function". SharedID Edge checks consent itself; see below.

## Consent and opt-out

**Opt-out.** If the `_pubcid_optout` cookie is present, the worker sets no ID and expires any it finds; Prebid.js checks the same cookie. Link your privacy page to `https://www.example.com/_sid/optout` to opt a browser out, and `/_sid/optin` to undo it.

**Global Privacy Control and COPPA.** A request with `Sec-GPC: 1`, or with `coppa=1` (a site or page directed at children, as in OpenRTB `regs.coppa`), gets no ID, and any ID cookies it carries are deleted. Prebid.js doesn't call `pixelUrl` for COPPA requests, so for sync requests this only matters for other callers. Pages that fetch `/_sid/v1` themselves should add `coppa=1` when it applies.

**TCF.** Whenever a request carries a TCF TC string, the worker checks it before setting the cookie:

- **Publisher mode** (the default). SharedID is your own first-party ID, so the worker reads the **publisher** consents (the TC string's publisher TC segment): it needs consent for Purpose 1 (store and access information on a device), and consent or legitimate interest for at least one of Purposes 2 to 10. Configure your CMP to ask for publisher consent for these purposes, or it won't include a publisher TC segment and no one gets a server cookie.
- **Vendor mode.** If your company is registered as a TCF vendor, set `SID_VENDOR_ID` to your vendor ID. The worker then needs consent for that vendor, consent for Purpose 1, and consent or legitimate interest for at least one of Purposes 2 to 10, all from the vendor part of the TC string instead of the publisher segment.

When GDPR applies and there's no TC string, that counts as no consent: the worker sets nothing and deletes the ID cookies. GDPR applies when Cloudflare places the request in the EU (`request.cf.isEUCountry`; behind CloudFront, `CloudFront-Viewer-Country` is one of the 27 EU member states; on Vercel, `x-vercel-ip-country` is; behind Google Cloud's load balancer, `{client_region}` is), or when the request says so with `gdpr=1`.

The TC string comes from the CMP's `euconsent-v2` cookie, or a `gdpr_consent` parameter. Prebid.js doesn't add consent parameters to `pixelUrl`, so for the sync route **your CMP must store the TC string in the `euconsent-v2` cookie** (check yours: some keep it only in local storage). Without it, EU visitors get no server cookie, which is the safe failure. Sending the consent strings from Prebid.js to the worker is planned.

**Deleting the cookie.** When consent is missing or withdrawn, or with GPC, COPPA or opt-out, the worker deletes the ID cookies it finds: it overwrites each with an empty value, `Max-Age=0` and an `Expires` date in 1970, which browsers treat as a delete. With `SID_COOKIE_DOMAIN` set, it deletes a host-only copy too.

**What's stored and logged.** SharedIDs are random UUIDs, never derived from the IP address or other request data. (The opt-in `ec` module is the exception: see below.) The worker stores nothing server-side and logs nothing about requests (Workers observability is off in the default config).

## Modules

Modules add IDs and signals to `/_sid/v1`, and some maintain cookies on `/_sid/sync` too. They're built into the worker but **none runs until you list it**.

### Choosing modules

Set `SID_MODULES` to a comma-separated list of module names, in the order their output should merge. Pass any settings in `SID_MODULE_CONFIG`, as JSON keyed by module name:

```jsonc
"vars": {
  "SID_MODULES": "ip,geo",              // names, in merge order
  "SID_MODULE_CONFIG": "{}",            // e.g. "{\"geo\":{\"precision\":\"coarse\"}}"
  "SID_MODULE_TIMEOUT_MS": "50"         // each module's time limit
}
```

Then deploy, and check `ext.modules` in the `/_sid/v1` response:

```sh
curl -s https://www.example.com/_sid/v1 | jq .ext.modules
# { "ip": { "ms": 0, "status": "ok" }, "geo": { "ms": 0, "status": "ok" } }
```

- **Unknown names** are reported as `skipped` with reason `not installed`: check the spelling, or that your build includes the module.
- **Failures are contained:** a module that errors or exceeds `SID_MODULE_TIMEOUT_MS` is reported and left out, and the rest of the response is unaffected.
- **Removing a module** from `SID_MODULES` turns it off.

### Modules on `/_sid/sync`

Prebid.js calls `/_sid/sync` (its `pixelUrl`) on page views with `extend: true`, with no code of yours. Modules that only maintain cookies run there too, so they work without the page calling `/_sid/v1`:

| Module | On `/_sid/sync` |
| --- | --- |
| `reflect` | yes: refreshes the cookies you name, and restores them from the keeper |
| `ec` | yes: sets `ts-ec` (or deletes it when consent is withdrawn), as Trusted Server does on page loads |
| `bot` | yes: its report joins the platform's verdict for [`SID_SKIP_BOTS`](#no-sharedid-for-bots), so a likely bot gets no ID from Prebid.js's pixel call either |
| `ip`, `geo` | no: they return data, and `/_sid/sync` returns an image |

- **Same rules as `/_sid/v1`:** the same consent, opt-out, time limit and failure handling. Only the modules' cookies and traffic reports are used; the GIF, status and other headers Prebid.js gets are unchanged, apart from `X-SharedID-Modules` (see [Debugging headers](#debugging-headers)).
- **Choosing:** by default, every module in `SID_MODULES` that supports it runs on `/_sid/sync`. `SID_SYNC_MODULES` overrides that with a list (`"SID_SYNC_MODULES": "reflect"`), or `none`. Each name must also be in `SID_MODULES`, or every request fails with a 500 (a configuration error), so a typo can't go unnoticed; a listed module that doesn't run on `/_sid/sync`, such as `ip`, is reported `skipped`.
- **Daily by default:** the browser caches a successful sync response for `SID_SYNC_CACHE_SECONDS` (`86400`, a day), so these modules run there about once a day per browser. That keeps cookies from expiring, and a visitor whose cookies Safari deleted after 7 days away gets them back on the first page view, since the cache has expired by then. Lower `SID_SYNC_CACHE_SECONDS` to run them more often (`0`: every page view), at the cost of a worker request each time.

Built-in modules:

| Name | Adds | Settings |
| --- | --- | --- |
| [`ip`](packages/modules/ip/README.md) | `ortb2.device.ip` or `ortb2.device.ipv6`: the visitor's full IP address, or nothing when consent rules it out | none |
| [`ec`](packages/modules/ec/README.md) | Trusted Server Edge Cookies: sets `ts-ec` and returns it as `ortb2.user.id`. **IP-derived**; see below | `domain`; secret `passphrase` |
| [`geo`](packages/modules/geo/README.md) | `ortb2.device.geo`: country, region, metro and UTC offset, plus city, postal code and coordinates when consent allows | `precision`: `precise` (default) or `coarse` |
| [`reflect`](packages/modules/reflect/README.md) | Nothing in the payload: re-sets first-party cookies other scripts wrote (such as `uid1` or `_ga`) with the same value and a new expiry, so Safari doesn't cap them, and with `restore`, sets them again from an `HttpOnly` keeper cookie after Safari deletes them | `cookies`, `keeper` |
| [`bot`](packages/modules/bot/README.md) | `ortb2.device.ext.traffic`: a likely bot when a browser lacks headers browsers send, and `internal` for your own staff, merged with other modules' reports and Cloudflare Bot Management. Sent whatever the consent | `missingHeaders`, `internalCookie`; secret `internalToken` |

To build your own, see [Adding a module](#adding-a-module). Modules from vendors (in [`packages/vendor-modules/`](packages/vendor-modules/README.md); none yet) aren't built in: you add them to your build, and any that forwards data to another service says so at the top of its README and is marked "⚠ forwards data to `<host>`" here.

### `ip`: the real client IP

Full documentation: [`packages/modules/ip/README.md`](packages/modules/ip/README.md).

Bid requests made from the page, or relayed by Prebid Server, don't always carry the user's own IP address. The `ip` module returns the address the worker sees, so you can add it to the auction's first-party data. It's built into the worker but **off until you enable it**:

```jsonc
"vars": {
  "SID_MODULES": "ip",
  "SID_ALLOWED_ORIGINS": ""             // only needed if the page fetching /_sid/v1 is on another origin
}
```

`/_sid/v1` then includes `"ortb2": {"device": {"ip": "192.0.2.77"}}` (or `"ipv6"`; see [Responses](#get-_sidv1-the-id-and-the-modules-output) for the whole payload). On the page, merge it into Prebid.js's first-party data before the auction:

```js
fetch('/_sid/v1', { credentials: 'include' })
  .then(response => response.json())
  .then(payload => {
    if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
  })
  .catch(() => {});
```

**Full address or nothing.** The module never sends a truncated address, which would look real but place the user in the wrong network. It sends nothing (`ext.modules.ip.status` is `empty`) when:
- the visitor sends Global Privacy Control, or the request has `coppa=1`;
- a US privacy string opts out of sale;
- a TCF TC string doesn't opt in to Special Feature 1 (precise geolocation);
- GDPR applies and there's no TC string.

**Where the address comes from.** On Cloudflare it's `CF-Connecting-IP`, which Cloudflare sets itself, so visitors can't spoof it. Behind CloudFront it's the address in `CloudFront-Viewer-Address`, which CloudFront sets itself. On Vercel it's `x-real-ip`, which Vercel's proxy sets itself. Behind Google Cloud's load balancer it's the second-to-last `X-Forwarded-For` entry, which the load balancer writes (the first is the visitor's own). With the Node.js server it's the socket address, or with `SID_TRUST_PROXY=true` the first `X-Forwarded-For` entry. Only set that behind a proxy that overwrites the header.

The address is only returned to the browser that sent the request. The worker doesn't store or log it, and SharedIDs are never derived from it. `/_sid/v1` responses are `Cache-Control: no-store`.

### `ec`: Trusted Server Edge Cookies

Full documentation: [`packages/modules/ec/README.md`](packages/modules/ec/README.md).

The `ec` module implements IAB Tech Lab [Trusted Server](https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html) Edge Cookies, for publishers who use Trusted Server or want its identifier. It sets the `ts-ec` cookie, on Prebid.js's `/_sid/sync` calls as well as on `/_sid/v1`, and returns the EC as `ortb2.user.id` in `/_sid/v1`.

> **This ID is derived from the visitor's IP address.** An EC is `HMAC-SHA256(passphrase, IP)` as 64 hex characters, a dot, and 6 random characters. Everyone behind the same IPv4 address, or the same IPv6 /64, gets the same 64-character prefix, and anyone with the passphrase can test which address an EC came from. That's how Trusted Server defines it, and it's why the module is off unless you turn it on. The SharedID itself stays random.

Turn it on with a passphrase of at least 32 bytes, kept as a secret:

```sh
npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_MODULE_SECRETS
# paste: {"ec":{"passphrase":"<at least 32 random bytes, e.g. from openssl rand -hex 32>"}}
```

```jsonc
"vars": {
  "SID_MODULES": "ip,ec",
  "SID_MODULE_CONFIG": "{\"ec\":{\"domain\":\"example.com\"}}"   // the cookie gets Domain=.example.com
}
```

`/_sid/v1` then sets `ts-ec=<id>; Max-Age=31536000; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly` on the first call, and returns:

```json
{ "ortb2": { "user": { "id": "7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc.nZ1GxL" } } }
```

**Behaviour.**
- An existing `ts-ec` is returned as is and isn't refreshed, as in Trusted Server.
- Opt-out (including a visit to `/_sid/optout`), GPC, `coppa=1`, a US privacy opt-out, or a TC string without Purpose 1 consent deletes it.
- An undecodable TC string, or GDPR without a TC string, sets and returns nothing but leaves an existing cookie alone.
- Changing the passphrase changes the prefix for new ECs only.

**Differences from Trusted Server.**
- The EC is set on Prebid.js's `/_sid/sync` calls (about once a day per browser, with the default `SID_SYNC_CACHE_SECONDS`) and on `/_sid/v1`, not on every page load.
- There's no server-side identity graph, partner sync or `/identify` API.
- Consent uses this worker's signals (`gdpr`, the TC string, GPC, `us_privacy`, `coppa`), not Trusted Server's per-country and per-state jurisdiction lists, and GPP isn't decoded yet.

### `geo`: the visitor's location as `device.geo`

Full documentation: [`packages/modules/geo/README.md`](packages/modules/geo/README.md).

Cloudflare geolocates every request, and the Worker already has the result. The `geo` module returns it as OpenRTB 2.6 `ortb2.device.geo`, so the page can give bidders the location the edge sees, without a geolocation script or a call to a geo service. It's **off until you enable it**:

```jsonc
"vars": {
  "SID_MODULES": "ip,geo",               // or just "geo"
  "SID_MODULE_CONFIG": "{}"              // "{\"geo\":{\"precision\":\"coarse\"}}" never sends precise fields
}
```

`/_sid/v1` then includes, for a visitor in Austin in winter (merge it into Prebid.js as shown for `ip`):

```json
{
  "ortb2": {
    "device": {
      "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -360, "city": "Austin", "zip": "78701", "lat": 30.2713, "lon": -97.7426 }
    }
  }
}
```

- **Coarse fields** are always sent when known: `type` (`2`, IP address), `country` (ISO 3166-1 alpha-3), `region` (the ISO 3166-2 subdivision code without its country prefix), `metro` (US DMA) and `utcoffset` (minutes from UTC at the time of the request).
- **Precise fields** (`city`, `zip`, `lat`, `lon`) are sent in full or not at all, never rounded. They're left out under the same rules as the `ip` module's address: GPC, `coppa=1`, a US privacy opt-out, a TC string without opt-in to Special Feature 1 (precise geolocation), or GDPR without a TC string. `"precision": "coarse"` leaves them out always; any other setting makes the module an `error`.
- **Where the location comes from.** On Cloudflare, `request.cf`. With the Node.js server behind Cloudflare, Cloudflare's visitor location headers (`cf-ipcountry`, `cf-region-code`, `cf-ipcity`, …), read only with `SID_TRUST_PROXY=true`.

Like the IP address, the location is only returned to the browser that sent the request, and is never stored or logged.

### `reflect`: keep other first-party cookies durable

Full documentation: [`packages/modules/reflect/README.md`](packages/modules/reflect/README.md).

Scripts on your pages write other first-party cookies with `document.cookie`, such as an ID vendor's `uid1`, and Safari caps those at 7 days just like a script-written `_pubcid`. The `reflect` module sets the cookies you name again from the worker, with the **same value, byte for byte**, and a new expiry, so they become server-set cookies too. It's off until you enable it:

```jsonc
"vars": {
  "SID_MODULES": "reflect",
  "SID_MODULE_CONFIG": "{\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,\"domain\":\"example.com\"}]}}"
}
```

A `/_sid/v1` request carrying `uid1` then gets, alongside the SharedID cookies:

```http
Set-Cookie: uid1=<same value>; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
```

The payload is unchanged apart from `"reflect": { "ms": 0, "status": "empty" }` in `ext.modules`: the module only sets cookies.

- **Match the original's domain and `HttpOnly`.** The worker can't see how a cookie was first set. If the original is host-only and you set `domain` (or the other way round), the browser keeps two cookies of that name. `httpOnly` defaults to `false`, since the script that wrote the cookie usually reads it.
- **Consent:** it reflects only when the worker would set the SharedID: not on opt-out, GPC, `coppa=1`, denied TCF consent, or GDPR without a TC string. It never deletes these cookies on `/_sid/v1`, and on `/_sid/optout` only those you mark `deleteOnOptOut`.
- **On Prebid.js's pixel call too.** It runs on `/_sid/sync`, so with `pixelUrl` and `extend: true` cookies are refreshed and restored on page views with no page code, about once a day per browser (see [Modules on `/_sid/sync`](#modules-on-_sidsync)). Calling `/_sid/v1` works as well.
- Up to 10 cookies, 1 to 400 days each. The SharedID cookies, `ts-ec` and `euconsent-v2` can't be reflected.

**Restoring deleted cookies.** A cookie marked `"restore": true` is also saved in one `HttpOnly` cookie the worker owns, the keeper (`_sid_keep`, base64url of a JSON object, at most 4096 bytes). When Safari has deleted the cookie, the next call (Prebid.js's `/_sid/sync`, or `/_sid/v1`) sets it again from the keeper, as `_pubcid_sv` does for `_pubcid`. For Google Analytics and Ads:

```json
{
  "reflect": {
    "cookies": [
      { "name": "_ga", "maxAgeDays": 400, "domain": "example.com", "restore": true, "prefer": "older" },
      { "name": "_gcl_aw", "maxAgeDays": 90, "domain": "example.com", "restore": true },
      { "name": "_gcl_au", "maxAgeDays": 90, "domain": "example.com", "restore": true, "prefer": "older" }
    ]
  }
}
```

```http
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAiLCJfZ2NsX2F1IjoiMS4xLjk4NzY1NDMyMS4xNzAwMDAwMDAwIn0; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

- **`prefer`** decides which value wins when the page already wrote a new one: `"browser"` (default), `"backup"` (the saved value, always) or `"older"` (the one created first, read from `_ga`'s and `_gcl_au`'s timestamps). With `"older"`, a `_ga` that gtag.js re-minted before the worker was called is replaced by the saved one from the next page view. See [Which value wins](packages/modules/reflect/README.md#which-value-wins-prefer).
- **Call `/_sid/v1` before gtag.js loads** to keep the client ID on the current page view too; otherwise a deleted `_ga` is replaced by a new one before the worker can restore it. Prebid.js's pixel call usually comes after gtag.js: it keeps everything refreshed and restores `_gcl_aw`, and with `"older"` it brings a re-minted `_ga` back from the next page view, but it's too late for the current one. The module's README has the page snippet, and walks through [making `uid1` sticky](packages/modules/reflect/README.md#make-uid1-sticky-and-server-set) and [restoring `_ga`, `_gcl_aw` and `_gcl_au`](packages/modules/reflect/README.md#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au).
- **Consent:** when storage isn't allowed the keeper is deleted (the original cookies are left alone), and `/_sid/optout` always deletes it.

### `bot`: bot and staff-traffic signals

Full documentation: [`packages/modules/bot/README.md`](packages/modules/bot/README.md).

The edge sees each request before any script runs, so it can tell the page whether the traffic looks automated, and the page can skip or flag the auction. Several sources report to one **traffic signal**, `ortb2.device.ext.traffic`, which the worker merges, most cautious first:

- **the platform:** on Cloudflare with Bot Management (an Enterprise add-on), its verified-bot flag, score and corporate-proxy flag, as source `platform`. This needs no module;
- **the `bot` module:** a `likely` bot when a "browser" lacks `Accept-Language` or the `Sec-Fetch-*` headers it always sends (`missingHeaders`), and `internal: true` for your own staff, marked by a cookie (`internalCookie`);
- **other modules,** such as a user agent module reporting crawlers that name themselves (`declared`), or IP intelligence reporting VPNs and data centres.

It's off until you enable it, and each of its signals is opt-in:

```jsonc
"vars": {
  "SID_MODULES": "bot",
  "SID_MODULE_CONFIG": "{\"bot\":{\"missingHeaders\":true,\"internalCookie\":\"its_me\"}}"
}
```

A browser user agent without `Accept-Language` then gets:

```json
{ "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "likely", "sources": ["bot"] } } } } }
```

and Googlebot, on a zone with Bot Management, `{ "bot": true, "botKind": "verified", "score": 1, "sources": ["platform", "bot"] }`.

- **Fields:** `bot`; `botKind` (`verified`, `declared` or `likely`, the strongest claim wins); `proxy` (`datacenter`, `vpn`, `residential`, `tor` or `relay`, the most specific wins; a privacy relay such as iCloud Private Relay is never a bot); `score` (1 bot to 99 human, the lowest wins); `internal`; and `sources`.
- **Consent:** the signal describes the traffic, not the person, so it's returned with GPC, COPPA, opt-out and denied consent too, while the SharedID follows its usual rules. It's never stored or logged.
- **Staff:** set the cookie from an internal page; the page can then skip auctions or mark them as tests. Set `SID_MODULE_SECRETS={"bot":{"internalToken":"…"}}` so only that value counts.

#### No SharedID for bots

`SID_SKIP_BOTS` (off by default) stops the worker setting or returning a SharedID for bots, which inflate ID counts and pollute frequency capping. `verified` skips verified bots, `declared` verified and declared ones, `likely` every bot; `SID_SKIP_BOTS_SCORE=10` also skips scores of 10 or less. A skipped request carries `X-SharedID-Status: skipped: bot`. **Existing IDs are never deleted,** so a misclassified visitor keeps theirs, and internal traffic is never skipped. On `/_sid/sync` the decision is the same: the platform's verdict merged with the reports of the modules that run there (`bot`, and any other in `SID_SYNC_MODULES` that reports traffic).

## Self-host with Node.js

Full reference: [`packages/adapters/node/README.md`](packages/adapters/node/README.md).

If your site isn't on Cloudflare, you can run the same handler as a Node.js server behind the web server or load balancer that serves your site. It must answer on your site's own hostname and IP addresses, for the same reason as above.

```sh
npm ci && npm run build
PORT=8787 \
SID_PUBLIC_ORIGIN=https://www.example.com \
SID_TRUST_PROXY=true \
node packages/adapters/node/dist/cli.js
```

- `SID_PUBLIC_ORIGIN` is the public origin. TLS ends at your proxy, and the cookies need to know they're served over https to be `Secure`.
- `SID_TRUST_PROXY=true` takes the client IP from `X-Forwarded-For`, and the location for the `geo` module from Cloudflare's visitor location headers (`cf-ipcountry` and the rest). Only set it when your proxy overwrites those headers.
- `HOST` defaults to `127.0.0.1`. All the `SID_*` settings apply.

Then forward `/_sid/` to it. For example, with nginx:

```nginx
location /_sid/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_cache off;
}
```

Make sure no cache in front of it (a CDN or nginx's `proxy_cache`) stores `/_sid/` responses; they carry per-visitor cookies. Run it under your process manager (systemd, a container) like any other Node.js service.

## Configuration reference

All settings are strings, set as Worker `vars` (Cloudflare) or environment variables (Node.js, AWS Lambda, Vercel, Google Cloud). Empty means the default. Invalid values make every request fail with a 500 and log the reason, rather than set wrong cookies.

| Variable | Default | Description |
| --- | --- | --- |
| `SID_BASE_PATH` | `/_sid` | Path prefix the worker answers under. Must match your route. |
| `SID_COOKIE_NAME` | `_pubcid` | The SharedID cookie; must match `storage.name` in Prebid.js. |
| `SID_COOKIE_DOMAIN` | host-only | `Domain` for the cookies, e.g. `.example.com` to share across subdomains. |
| `SID_MAX_AGE_DAYS` | `365` | Cookie lifetime in days, 1 to 400 (browsers cap at 400). |
| `SID_CREATE` | `true` | Mint an ID when the request has none. With Prebid.js it always sends one, so this rarely matters. |
| `SID_RECOVERY_COOKIE` | `_pubcid_sv` | Name of the `HttpOnly` recovery copy; `none` to disable it. |
| `SID_OPTOUT_COOKIE` | `_pubcid_optout` | The opt-out cookie; Prebid.js reads `_pubcid_optout`. |
| `SID_VENDOR_ID` | (empty: publisher mode) | Your TCF vendor ID, for vendor mode. |
| `SID_ALLOWED_ORIGINS` | none | Comma-separated origins (like `https://www.example.com`) allowed to read `/_sid/v1` from script on another origin. |
| `SID_SYNC_CACHE_SECONDS` | `86400` | How long a browser may reuse a sync response (privately). `0` re-syncs on every call. Also limits how often modules run on `/_sid/sync`. |
| `SID_MODULES` | none | Comma-separated modules to run, in order. Built in: `ip`, `ec`, `geo`, `reflect`, `bot`. |
| `SID_SYNC_MODULES` | the modules in `SID_MODULES` that run on `/_sid/sync` (`reflect`, `ec`, `bot`) | Comma-separated modules to run on `/_sid/sync`, each also in `SID_MODULES`, or `none`. See [Modules on `/_sid/sync`](#modules-on-_sidsync). |
| `SID_MODULE_CONFIG` | `{}` | JSON settings per module, keyed by module name. |
| `SID_MODULE_SECRETS` | `{}` | JSON secrets per module, e.g. the `ec` passphrase. Set it as a secret (`wrangler secret put SID_MODULE_SECRETS`), not in `vars`. |
| `SID_MODULE_TIMEOUT_MS` | `50` | Time limit for each module. |
| `SID_SKIP_BOTS` | off | `verified`, `declared` or `likely`: set no SharedID for bots this sure or surer, from the [traffic signal](#bot-bot-and-staff-traffic-signals). Existing IDs are never deleted. |
| `SID_SKIP_BOTS_SCORE` | off | 1 to 99: set no SharedID when the traffic score (Cloudflare Bot Management) is at or below it. |

Routes, under `SID_BASE_PATH`:

| Route | |
| --- | --- |
| `GET /_sid/sync?id=pubcid:<id>` | The `pixelUrl` endpoint: a 1×1 GIF with the cookies, including those of modules that run there. |
| `GET /_sid/v1` | JSON: the SharedID, its eid, and the modules' output. |
| `GET /_sid/optout`, `GET /_sid/optin` | Set or clear the opt-out cookie. |

The full behaviour is in the [specification](spec/SPEC.md).

## Troubleshooting

Responses carry two debug headers: `X-SharedID-Source` (`cookie`, `recovery`, `param` or `minted`: where the ID came from) and, when no cookie was set, `X-SharedID-Status` with the reason (for example `denied: opt-out` or `denied: tcf: no consent for purpose 1`).

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route isn't attached or doesn't match: check `routes` in `wrangler.jsonc`, that the hostname is proxied (orange cloud), and `SID_BASE_PATH`. |
| `/_sid/sync` returns the worker's plain `Not found` | The path under `SID_BASE_PATH` is wrong: it must end in `/sync`, `/v1`, `/optout` or `/optin`. |
| No `set-cookie` in the response | See `X-SharedID-Status`. In `tcf` mode, check the `euconsent-v2` cookie exists. |
| Cookie set but gone after a week in Safari | Run `verify-deployment`: the endpoint's IP addresses probably don't match the site's. |
| Cookie not readable by Prebid.js | The cookie name or domain doesn't match Prebid.js's `storage` config, or the page and the route are on hosts the cookie's domain doesn't cover. |
| A 500 with "misconfigured" | A setting is invalid: `npm exec -w @sharedid-edge/cloudflare -- wrangler tail` shows the reason (on AWS, the function's CloudWatch logs; on Vercel, the project's logs; on Google Cloud, the function's logs in Cloud Logging). |
| `getUserIdsAsync()` never resolves | The known Prebid.js issue under [Configure Prebid.js](#configure-prebidjs). |

## Development

```text
spec/                          the specification
conformance/                   HTTP cases every implementation must pass, and their runner
packages/
  core/                        the platform-neutral handler, consent, cookies and module interface
  adapters/                    deployable platform packages; rules for all of them in AGENTS.md
    cloudflare/                the Cloudflare Worker
    node/                      the Node.js server (local development, self-hosting, conformance target)
    aws-lambda/                the AWS Lambda adapter, its bundle and SAM template
    gcp-functions/             the Google Cloud adapter (Cloud Run functions behind Load Balancing) and its Terraform
    vercel/                    the Vercel adapter (Next.js route handler or middleware), its bundle and an example
  modules/                     modules maintained by this project, built into every adapter
    ip/ ec/ geo/ reflect/ bot/ the built-in modules
    all/                       @sharedid-edge/modules: the built-in list the adapters import
  vendor-modules/              modules contributed and maintained by vendors, opt-in at build time
e2e/                           unmodified Prebid.js against the worker, in Chromium, Firefox and WebKit
scripts/                       verify-deployment, the type checks and the repo checks below
```

Each package has its own `README.md` and `AGENTS.md`. Workspaces, `tsc -b` references and the TypeScript 7 check are derived from these folders, so a new package needs no list edits beyond `node scripts/check-projects.mjs --write`.

```sh
npm ci
npm run check        # everything CI runs, except the Workers-runtime and browser suites
```

TypeScript is strict from the start, and CI checks types several ways:

- `npm run build`: every project under the shared strict config (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedDeclarations` and more), including tests.
- `npm run typecheck:ts7`: the same projects with TypeScript 7.
- `npm run typecheck:cloudflare` and `npm run types:check -w @sharedid-edge/cloudflare`: the Worker against the Workers runtime types, and that those types match `wrangler.jsonc`.
- `npm run consumer-types`: the packed `@sharedid-edge/core` type-checked by a strict consumer, for each module resolution and TypeScript version.
- `npm run attw`: the published types resolve correctly.
- `npm run lint`: `typescript-eslint`'s strict type-checked rules.
- `npm run check:projects` and `npm run check:links`: the root `tsconfig.json` references every workspace project, and every relative link and heading anchor in the Markdown files resolves.

Tests:

- `npm test`: unit tests, including the Worker's tests inside workerd, the Workers runtime. Vendor modules' tests run separately, with `npm run test:vendor-modules`.
- `npm run conformance`: the conformance suite against the Node.js server; `npm run conformance:wrangler` runs it against the Worker under `wrangler dev`, `npm run conformance:lambda` against the bundled Lambda handler behind a local stand-in for CloudFront, `npm run conformance:vercel` against the bundled Vercel adapter behind a local stand-in for Vercel's proxy, and `npm run conformance:gcp` against the real Functions Framework serving the bundled Cloud Run function, behind a local stand-in for the load balancer.
- In `e2e/`: `npm ci && npx playwright install && npm test` runs unmodified Prebid.js against the worker in three browsers.

None of this needs a Cloudflare, AWS, Vercel or Google Cloud account.

### Adding a module

A module adds IDs or signals to `/_sid/v1`:

```ts
import { defineModule } from '@sharedid-edge/core';

export const continent = defineModule({
  name: 'continent',
  purposes: [1],              // TCF purposes it needs publisher consent for when GDPR applies
  run({ platform }) {
    return platform.continent === undefined ? undefined : { ortb2: { device: { geo: { ext: { continent: platform.continent } } } } };
  }
});
```

Publish it as its own package like [`packages/modules/ip`](packages/modules/ip), add it to `builtInModules` in [`packages/modules/all`](packages/modules/all/README.md) (every adapter imports that list), and enable it with `SID_MODULES=continent`. A module that only maintains cookies can also run on `/_sid/sync` with `routes: ['v1', 'sync']`; there only its cookies are used. Modules make no network calls, and a module that throws or runs past its time limit is left out without affecting the rest of the response. See [`packages/modules/AGENTS.md`](packages/modules/AGENTS.md). A module from a vendor goes in [`packages/vendor-modules/`](packages/vendor-modules/README.md) instead, and isn't built in.

## Roadmap

1. **Done:** specification, conformance suite, the cookie-only worker on Cloudflare, a Node.js server, AWS Lambda, Vercel and Google Cloud adapters, and the `ip`, `ec`, `geo`, `reflect` and `bot` modules, with a shared traffic signal any module can report bots to.
2. **Next:** Prebid.js sending its consent strings (TCF, GPP) to the worker with the sync, so consent no longer depends on the CMP cookie.
3. A Prebid.js RTD module that reads `/_sid/v1`, plus a device type module (`ua`, which also reports declared crawlers to the traffic signal), IP intelligence modules, a Fastly adapter, and Lambda@Edge.
4. Vendor modules, a Rust implementation, and inline mode.

## License

[Apache-2.0](LICENSE)
