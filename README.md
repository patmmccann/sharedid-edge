# SharedID Edge

SharedID Edge is a small open-source edge worker that keeps the [Prebid SharedID](https://docs.prebid.org/identity/sharedid.html) durable. It runs on a route of your own domain (`www.example.com/_sid/*`) on the CDN that already serves your site, and sets the SharedID as a **server-set first-party cookie**, so Safari doesn't cap it at 7 days.

It replaces the [WordPress](https://github.com/prebid/sharedid-wordpress) and [Drupal](https://github.com/prebid/sharedid-drupal) SharedID plugins and the endpoint examples in the SharedID docs: it implements the same `pixelUrl` contract, so Prebid.js needs no code change. Unlike those, it answers at the CDN edge, so your origin sees no extra traffic.

It also has a **module** interface for IDs and signals that are best computed at the edge (connecting IP, geography, bot scores, device data), returned to the page in one JSON response. See the [proposal](https://github.com/prebid/prebid-server/issues/5064) for the background.

- [How it works](#how-it-works)
- [Deploy on Cloudflare](#deploy-on-cloudflare)
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

### Prerequisites

- Your site's DNS is on Cloudflare, and the hostname you serve pages from (for example `www.example.com`) is **proxied** (orange cloud). Workers routes only run on proxied hostnames.
- A Cloudflare account with permission to deploy Workers and edit routes on the zone. Each sync is one Worker request; the free plan has a daily request limit, so check expected volume against your plan.
- Node.js 22 or later and npm.
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

Edit [`packages/cloudflare/wrangler.jsonc`](packages/cloudflare/wrangler.jsonc):

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

- **`extend: true`** makes Prebid.js call `pixelUrl` on later visits too, which refreshes the cookie's lifetime. The response is cached privately by the browser for a day (`SID_SYNC_CACHE_SECONDS`), so a frequent visitor triggers at most about one request a day.
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

Modules don't run on `/sync`.

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

The same request with `Sec-GPC: 1` gets no ID, deletes the ID cookies, and returns no IP:

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "ip": { "ms": 0, "status": "empty" } } }
}
```

| Field | |
| --- | --- |
| `v` | Payload version, `1`. |
| `sharedid` | The SharedID. Absent when storage isn't allowed (opt-out, GPC, COPPA, consent). |
| `eids` | OpenRTB `user.ext.eids`: the SharedID as `pubcid.org` (`atype` 1), then any IDs from modules. `[]` when there are none. |
| `ortb2` | An OpenRTB 2.x first-party data fragment, merged from every module's output in `SID_MODULES` order. Absent when no module returned anything. Pass it to `pbjs.mergeConfig({ ortb2 })`. |
| `ext.modules` | One entry per module in `SID_MODULES`: `ms` (time taken) and `status`: `ok` (it returned data), `empty` (nothing to add, for example consent rules out the IP), `skipped` (with a `reason`, such as `not installed` for a name the worker doesn't have), `error` or `timeout`. Error details are never returned. |

To read `/v1` from a page on another origin, list that origin in `SID_ALLOWED_ORIGINS` and fetch with `credentials: 'include'`. The response then carries `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`; it never carries `*`.

### `GET /_sid/optout` and `GET /_sid/optin`

`204 No Content`. `/optout` sets `_pubcid_optout=1` and deletes the ID cookies; `/optin` deletes `_pubcid_optout`.

### Debugging headers

- `X-SharedID-Source`: where the ID came from: `cookie`, `recovery` (restored from the `HttpOnly` copy), `param` (adopted from Prebid.js's `?id=`) or `minted`.
- `X-SharedID-Status: denied: <reason>`: why no ID was set. The reason is `opt-out`, `gpc`, `coppa` or `tcf: …`.

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

When GDPR applies and there's no TC string, that counts as no consent: the worker sets nothing and deletes the ID cookies. GDPR applies when Cloudflare places the request in the EU (`request.cf.isEUCountry`), or when the request says so with `gdpr=1`.

The TC string comes from the CMP's `euconsent-v2` cookie, or a `gdpr_consent` parameter. Prebid.js doesn't add consent parameters to `pixelUrl`, so for the sync route **your CMP must store the TC string in the `euconsent-v2` cookie** (check yours: some keep it only in local storage). Without it, EU visitors get no server cookie, which is the safe failure. Sending the consent strings from Prebid.js to the worker is planned.

**Deleting the cookie.** When consent is missing or withdrawn, or with GPC, COPPA or opt-out, the worker deletes the ID cookies it finds: it overwrites each with an empty value, `Max-Age=0` and an `Expires` date in 1970, which browsers treat as a delete. With `SID_COOKIE_DOMAIN` set, it deletes a host-only copy too.

**What's stored and logged.** IDs are random UUIDs, never derived from the IP address or other request data. The worker stores nothing server-side and logs nothing about requests (Workers observability is off in the default config).

## Modules

Modules add IDs and signals to `/_sid/v1`. They're built into the worker but **none runs until you list it**.

### Choosing modules

Set `SID_MODULES` to a comma-separated list of module names, in the order their output should merge. Pass any settings in `SID_MODULE_CONFIG`, as JSON keyed by module name:

```jsonc
"vars": {
  "SID_MODULES": "ip",                  // e.g. "ip,geo" once more modules exist
  "SID_MODULE_CONFIG": "{}",            // e.g. "{\"geo\":{\"precision\":\"coarse\"}}"
  "SID_MODULE_TIMEOUT_MS": "50"         // each module's time limit
}
```

Then deploy, and check `ext.modules` in the `/_sid/v1` response:

```sh
curl -s https://www.example.com/_sid/v1 | jq .ext.modules
# { "ip": { "ms": 0, "status": "ok" } }
```

- **Unknown names** are reported as `skipped` with reason `not installed`: check the spelling, or that your build includes the module.
- **Failures are contained:** a module that errors or exceeds `SID_MODULE_TIMEOUT_MS` is reported and left out, and the rest of the response is unaffected.
- **Removing a module** from `SID_MODULES` turns it off.

Built-in modules:

| Name | Adds | Settings |
| --- | --- | --- |
| `ip` | `ortb2.device.ip` or `ortb2.device.ipv6`: the visitor's full IP address, or nothing when consent rules it out | none |

To build your own, see [Adding a module](#adding-a-module).

### `ip`: the real client IP

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

**Where the address comes from.** On Cloudflare it's `CF-Connecting-IP`, which Cloudflare sets itself, so visitors can't spoof it. With the Node.js server it's the socket address, or with `SID_TRUST_PROXY=true` the first `X-Forwarded-For` entry. Only set that behind a proxy that overwrites the header.

The address is only returned to the browser that sent the request. The worker doesn't store or log it, and SharedIDs are never derived from it. `/_sid/v1` responses are `Cache-Control: no-store`.

## Self-host with Node.js

If your site isn't on Cloudflare, you can run the same handler as a Node.js server behind the web server or load balancer that serves your site. It must answer on your site's own hostname and IP addresses, for the same reason as above.

```sh
npm ci && npm run build
PORT=8787 \
SID_PUBLIC_ORIGIN=https://www.example.com \
SID_TRUST_PROXY=true \
node packages/node/dist/cli.js
```

- `SID_PUBLIC_ORIGIN` is the public origin. TLS ends at your proxy, and the cookies need to know they're served over https to be `Secure`.
- `SID_TRUST_PROXY=true` takes the client IP from `X-Forwarded-For`. Only set it when your proxy overwrites that header.
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

All settings are strings, set as Worker `vars` (Cloudflare) or environment variables (Node.js). Empty means the default. Invalid values make every request fail with a 500 and log the reason, rather than set wrong cookies.

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
| `SID_SYNC_CACHE_SECONDS` | `86400` | How long a browser may reuse a sync response (privately). `0` re-syncs on every call. |
| `SID_MODULES` | none | Comma-separated modules to run for `/_sid/v1`, in order. Built in: `ip`. |
| `SID_MODULE_CONFIG` | `{}` | JSON settings per module, keyed by module name. |
| `SID_MODULE_TIMEOUT_MS` | `50` | Time limit for each module. |

Routes, under `SID_BASE_PATH`:

| Route | |
| --- | --- |
| `GET /_sid/sync?id=pubcid:<id>` | The `pixelUrl` endpoint: a 1×1 GIF with the cookies. |
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
| A 500 with "misconfigured" | A setting is invalid: `npm exec -w @sharedid-edge/cloudflare -- wrangler tail` shows the reason. |
| `getUserIdsAsync()` never resolves | The known Prebid.js issue under [Configure Prebid.js](#configure-prebidjs). |

## Development

```text
spec/                 the specification
conformance/          HTTP cases every implementation must pass, and their runner
packages/core/        the platform-neutral handler, consent, cookies and module interface
packages/cloudflare/  the Cloudflare Worker
packages/node/        the Node.js server (local development, self-hosting, conformance target)
e2e/                  unmodified Prebid.js against the worker, in Chromium, Firefox and WebKit
scripts/              verify-deployment, and the type checks below
```

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

Tests:

- `npm test`: unit tests, including the Worker's tests inside workerd, the Workers runtime.
- `npm run conformance`: the conformance suite against the Node.js server; `npm run conformance:wrangler` runs it against the Worker under `wrangler dev`.
- In `e2e/`: `npm ci && npx playwright install && npm test` runs unmodified Prebid.js against the worker in three browsers.

None of this needs a Cloudflare account.

### Adding a module

A module adds IDs or signals to `/_sid/v1`:

```ts
import { defineModule } from '@sharedid-edge/core';

export const geo = defineModule({
  name: 'geo',
  purposes: [1],              // TCF purposes it needs publisher consent for when GDPR applies
  run({ platform }) {
    return platform.country === undefined ? undefined : { ortb2: { device: { geo: { country: platform.country } } } };
  }
});
```

Publish it as its own package like [`packages/module-ip`](packages/module-ip), register it in [`packages/cloudflare/src/modules.ts`](packages/cloudflare/src/modules.ts) (and the Node.js CLI), and enable it with `SID_MODULES=geo`. Modules make no network calls, and a module that throws or runs past its time limit is left out without affecting the rest of the response. See [`packages/core/AGENTS.md`](packages/core/AGENTS.md).

## Roadmap

1. **Done:** specification, conformance suite, the cookie-only worker on Cloudflare, a Node.js server, and the `ip` module.
2. **Next:** Prebid.js sending its consent strings (TCF, GPP) to the worker with the sync, so consent no longer depends on the CMP cookie.
3. A Prebid.js RTD module that reads `/_sid/v1`, plus first-party modules for geography, bot scores and device type, and a Fastly adapter.
4. Vendor modules, a Rust implementation, and inline mode.

## License

[Apache-2.0](LICENSE)
