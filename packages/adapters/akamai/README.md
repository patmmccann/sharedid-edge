# @sharedid-edge/akamai

[SharedID Edge](../../../README.md) on Akamai: an [EdgeWorker](https://techdocs.akamai.com/edgeworkers/docs) on a `/_sid/*` rule of the property that serves your site. It's the same platform-neutral handler as the Cloudflare Worker and the other adapters, with built-in modules `ip`, `geo`, `reflect`, `bot` and `ua` (`ec` and vendor modules are added at build time), and it passes the same conformance suite.

This is the full guide. The other platforms are listed under [Pick your platform](../../../README.md#pick-your-platform). It covers EdgeWorkers, Akamai's JavaScript product; Akamai Functions (WebAssembly) is a different product, not covered here.

**Status:** built from Akamai's documentation and tested against a local stand-in for EdgeWorkers, not yet on a live Akamai property. [What isn't confirmed](#what-isnt-confirmed) lists what a first deployment should check.

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy](#deploy)
- [The property rule](#the-property-rule)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Verify](#verify)
- [How requests map to requests and responses](#how-requests-map-to-requests-and-responses)
- [Base path](#base-path)
- [Platform information](#platform-information)
- [The EdgeWorkers runtime](#the-edgeworkers-runtime)
- [Using it in code](#using-it-in-code)
- [Testing without an Akamai account](#testing-without-an-akamai-account)
- [What isn't confirmed](#what-isnt-confirmed)
- [Troubleshooting](#troubleshooting)
- [Akamai documentation](#akamai-documentation)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
Akamai edge: your site's property (www.example.com)
   ├─ rule "SharedID Edge": path /_sid/*
   │     Caching: No store (required: responseProvider runs only on a cache miss)
   │     Set Variable: PMUSER_SID_CLIENT_IP = {{builtin.AK_CLIENT_REAL_IP}}
   │     EdgeWorkers behavior → the SharedID Edge EdgeWorker
   │        └─ responseProvider(request): request object → Request → SharedID Edge handler → Response
   │                                      → createResponse(status, headers with one entry per Set-Cookie, bytes)
   └─ everything else → your site's origin, unchanged
```

- **On your site's own property.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A rule on the property that serves `www.example.com` answers from the same Akamai edge addresses as your pages; a separate property or hostname doesn't.
- **Answered at the edge, never forwarded.** The EdgeWorker uses only [`responseProvider`](https://techdocs.akamai.com/edgeworkers/docs/event-handler-functions), which "acts as a surrogate origin": it builds the response itself with [`createResponse`](https://techdocs.akamai.com/edgeworkers/docs/create-response). It catches every error and answers it with a 500, because EdgeWorkers [forwards the request to the origin](https://techdocs.akamai.com/edgeworkers/docs/response-orchestration) when `responseProvider` fails. For failures EdgeWorkers itself raises (a resource limit exceeded), add [Site Failover](#when-the-edgeworker-fails).
- **Nothing cached, required.** `responseProvider` runs only when the response isn't in Akamai's cache, and responses carry each visitor's cookies: a cached `/_sid/*` response would hand one visitor's ID to others. So the rule **must** set the *Caching* behavior to *No store* ([The property rule](#the-property-rule)). Every response also carries `Cache-Control: no-store` or `private` (the tests check it), but whether Akamai honours that depends on the property's caching settings, so it's a second line of defence, not the fix.
- **Settings from Property Manager.** EdgeWorkers has no environment variables; the settings are [user-defined variables](https://techdocs.akamai.com/property-mgr/docs/user-defined-vars), `PMUSER_SID_COOKIE_DOMAIN` and so on, which the EdgeWorker reads with [`request.getVariable`](https://techdocs.akamai.com/edgeworkers/docs/request-object).
- **Client IP and location from Akamai, not the visitor.** The client IP comes from `AK_CLIENT_REAL_IP`, which ignores request headers, through a variable the rule sets; the location from EdgeScape's [`request.userLocation`](https://techdocs.akamai.com/edgeworkers/docs/user-location-object), but **not** when the request carries an `X-Forwarded-For` header, because EdgeScape then locates that header's address, which the visitor chooses. See [Location and X-Forwarded-For](#location-and-x-forwarded-for).

## Prerequisites

- An Akamai property serving your site, with EdgeWorkers on your contract, and access to Property Manager and EdgeWorkers in Control Center (an access group with EdgeWorkers permissions).
- The [Akamai CLI](https://github.com/akamai/cli) with the [EdgeWorkers package](https://github.com/akamai/cli-edgeworkers) (`akamai install edgeworkers`) and API credentials in `~/.edgerc`. Everything below can also be done in Control Center instead.
- Node.js 24 or later and npm, to build.

## Build

From the repository root:

```sh
npm ci
npm run build                              # compiles core and the modules
npm run bundle -w @sharedid-edge/akamai    # writes packages/adapters/akamai/deploy/main.js and bundle.json
```

`deploy/` is an EdgeWorkers [code bundle](https://techdocs.akamai.com/edgeworkers/docs/code-bundle-format): `main.js` (one ES module with no imports but EdgeWorkers' built-in modules; about 22 KB gzipped, minified; CI fails it over 32 KB) and `bundle.json`, the manifest. Its `edgeworker-version` is the package version and a hash of `main.js` (like `0.1.0-9a4a742ab489`): every upload needs a new version, and the same code gets the same one. To pack it as a `.tgz` (for `akamai edgeworkers validate`, the sandbox or Control Center):

```sh
tar -czf sharedid-edge.tgz -C packages/adapters/akamai/deploy main.js bundle.json
```

**`ec` and vendor modules (opt-in).** The bundle has the built-in modules (`ip`, `geo`, `reflect`, `bot`, `ua`). [`ec`](../../vendor-modules/ec/README.md) (Trusted Server Edge Cookies, whose ID is derived from the IP address) and [vendor modules](../../vendor-modules/README.md) aren't in it: add each with `--module <package>#<export>`, in place of `npm run bundle -w @sharedid-edge/akamai`:

```sh
npm run bundle -w @sharedid-edge/akamai -- --module @sharedid-edge/module-ec#ecModule
```

Then list it in `PMUSER_SID_MODULES`, with its settings and secrets (the [`ec` README](../../vendor-modules/ec/README.md#turning-it-on), and [Secrets](#secrets) below). Without `--module`, `SID_MODULES=ec` reports `ec` as `skipped` (`not installed`). The bundle's size is reported but the 32 KB budget isn't enforced with opt-in modules; EdgeWorkers' own limit is [512 KB compressed and 1 MB uncompressed](https://techdocs.akamai.com/edgeworkers/docs/limitations). `--bowser` and `--module` can be combined.

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` for Safari, Firefox, TVs and other browsers that send no Client Hints. `npm run bundle:bowser -w @sharedid-edge/akamai` (in place of `bundle`; same `deploy/` folder) builds it in, then `PMUSER_SID_MODULE_CONFIG` `{"ua":{"parser":"bowser"}}` turns it on. The cost, minified and gzipped, against the 32 KB budget CI checks for both builds:

| Bundle | Default (no Bowser) | With Bowser |
| --- | --- | --- |
| EdgeWorker (`deploy/main.js`) | 21.8 KB | 30.2 KB |

The EdgeWorker is about 1.7 KB larger than the Lambda function because it carries its own `Request`, `Response`, `Headers` and `URL` ([The EdgeWorkers runtime](#the-edgeworkers-runtime)).

## Deploy

With the Akamai CLI, from the repository root, after [Build](#build):

1. **Create the EdgeWorker ID** (once). Find your access group and a resource tier, then register:

   ```sh
   akamai edgeworkers list-groups                 # the group with EdgeWorkers permissions
   akamai edgeworkers list-restiers               # Dynamic Compute is the default tier
   akamai edgeworkers register --resourceTierId <tier-id> <group-id> sharedid-edge
   ```

   Note the EdgeWorker ID it returns (a number). The [resource tier](https://techdocs.akamai.com/edgeworkers/docs/resource-tier-limitations) sets the limits per request: `responseProvider` gets 100 ms of CPU and 2 MB of memory on Basic Compute, 200 ms and 4 MB on Dynamic Compute. SharedID Edge needs a few milliseconds; either is enough.

2. **Upload the bundle** as a new version, and **activate it on staging**:

   ```sh
   akamai edgeworkers upload --codeDir packages/adapters/akamai/deploy <edgeworker-id>
   akamai edgeworkers activate <edgeworker-id> STAGING <version>    # <version>: edgeworker-version in deploy/bundle.json
   akamai edgeworkers status <edgeworker-id>                         # wait until the activation is complete
   ```

3. **Add the variables and the rule to your property** in Property Manager: [The property rule](#the-property-rule). Save a new property version and activate it on **staging**.

4. **Test on staging.** Akamai's [staging network](https://techdocs.akamai.com/property-mgr/docs/test-https) answers on your edge hostname with `-staging` before the final `.net` (`www.example.com.edgekey-staging.net` for `www.example.com.edgekey.net`), and its responses carry `X-Akamai-Staging`. Send requests for your hostname to a staging address (resolve it again before each round of testing; it changes):

   ```sh
   STAGING_IP=$(dig +short www.example.com.edgekey-staging.net | tail -1)
   curl -sI --resolve www.example.com:443:$STAGING_IP 'https://www.example.com/_sid/sync?id=pubcid:test-id'
   ```

   Expect `200`, `content-type: image/gif` and two `set-cookie` lines ([Verify](#verify) has more). Or point `www.example.com` at that address in your hosts file and open the site.

5. **Go to production:** activate the same EdgeWorker version on production, then the property version.

   ```sh
   akamai edgeworkers activate <edgeworker-id> PRODUCTION <version>
   ```

6. [Verify](#verify).

To update, build, upload (the new `edgeworker-version` comes from the build), activate on staging, test, and activate on production. The property doesn't change unless you change settings.

**In Control Center instead:** *EdgeWorkers → Create EdgeWorker ID* (name, group, resource tier); open it, *Create version* and upload the `.tgz` from [Build](#build); *Activate version* on staging, then production. The property steps are the same.

## The property rule

In Property Manager, edit a new version of your site's property.

**1. The variables.** Under *Property Variables*, add one variable per setting you set, with the [setting's name](#configuration) after `PMUSER_` (Property Manager adds the prefix: enter `SID_COOKIE_DOMAIN` for `PMUSER_SID_COOKIE_DOMAIN`). At least:

| Variable | Value | Security |
| --- | --- | --- |
| `PMUSER_SID_COOKIE_DOMAIN` | **Required:** the domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), or `host-only`. See [Configure Prebid.js](../../../docs/prebid.md). | Hidden |
| `PMUSER_SID_CLIENT_IP` | **Required:** leave the initial value empty; the rule sets it (below). | Hidden |

Set the value as the variable's initial value. Leave a setting out (or empty) for its default. Use *Hidden* so values don't appear in Akamai's debug headers; not *Sensitive*, which [EdgeWorkers can't read](https://techdocs.akamai.com/edgeworkers/docs/request-object).

**2. The rule.** Add a rule, `SharedID Edge`, near the top of the rule tree so later rules don't change it:

- **Criteria:** *If Path matches one of* `/_sid/*` (your `SID_BASE_PATH` plus `/*`; for `/`, see [Base path](#base-path)).
- **Behaviors,** in this order:
  - **[Caching](https://techdocs.akamai.com/property-mgr/docs/caching-2): *No store*. Required.** Akamai: "serve the content from the origin and clear any versions from the edge cache". `responseProvider` runs only on a cache miss, so with a caching option that stores responses, one visitor's cookies could be served to others. *Bypass cache* also stores nothing new, but leaves older cached copies in place; use *No store*.
  - **[Downstream Cacheability](https://techdocs.akamai.com/property-mgr/docs/downstream-cacheability):** *Pass cacheability headers from origin*, so browsers get the response's own `Cache-Control` (`/_sid/sync` is `private` for `SID_SYNC_CACHE_SECONDS`, the rest `no-store`). Akamai documents that with *No store* it "attempts to prevent downstream caching" with cache-busting headers, which may replace `private, max-age` on `/_sid/sync`: browsers then sync on every call, which is safe, only less efficient.
  - **Set Variable: `PMUSER_SID_CLIENT_IP`. Required.** Create value from: *Expression*, `{{builtin.AK_CLIENT_REAL_IP}}`: the visitor's address as Akamai's edge sees it, where ["request headers are ignored"](https://techdocs.akamai.com/property-mgr/docs/built-vars). Not `AK_CLIENT_IP`, which `X-Forwarded-For` and `Akamai-Client-IP` headers can override. See [Location and X-Forwarded-For](#location-and-x-forwarded-for).
  - **EdgeWorkers:** on, with the EdgeWorker ID from [Deploy](#deploy).
  - **Allow OPTIONS:** only if you set `SID_ALLOWED_ORIGINS`, for CORS preflights on `/_sid/v1` from other origins.
- Don't add behaviors that change the request or response for this path (redirects, header rewrites, compression changes, other EdgeWorkers: only one EdgeWorker runs per request). In particular, don't remove or rewrite `X-Forwarded-For` here: the EdgeWorker needs to see it to know when EdgeScape's location can't be trusted.

**3. Per site,** if the property serves several hostnames with different settings: either set `PMUSER_SID_HOSTS` ([Several sites from one deployment](../../../docs/configuration.md#several-sites-from-one-deployment)), or add child rules matching each hostname with a *Set Variable* behavior for that site's `PMUSER_SID_COOKIE_DOMAIN`.

### Location and X-Forwarded-For

Akamai [documents](https://techdocs.akamai.com/edgeworkers/docs/user-location-object) which address EdgeScape locates for an EdgeWorker: "If the HTTP request contains an `X-Forwarded-For` header, this header will be used to provide the location. Otherwise the connecting IP address will be used." Anyone can send that header. A visitor in the EU who sends `X-Forwarded-For` with a US address would get a US location, `isEU: false`, and cookies without a consent signal, where core would otherwise apply GDPR.

Akamai documents no setting that makes `userLocation` ignore the header (the *X-Forwarded-For* options of the [User Location](https://techdocs.akamai.com/property-mgr/docs/user-loc-data) match and of *Content Targeting - Protection* apply to those features only). So the EdgeWorker guards itself:

- **When the request has an `X-Forwarded-For` header, the EdgeWorker ignores `userLocation`:** no country, no `isEU`, no `geo` data. GDPR then applies when the page says so (`gdpr=1`, or a TC string), as on any platform when the location is unknown. That's the same for every visitor whose request goes through a proxy that adds the header; a visitor can't choose to be outside the EU.
- **The client IP comes from `PMUSER_SID_CLIENT_IP`** (`AK_CLIENT_REAL_IP`, set by the rule). Akamai lets `X-Forwarded-For` and `Akamai-Client-IP` override `AK_CLIENT_IP`, and doesn't document which one `request.clientIp` is. Without the variable, the EdgeWorker uses `request.clientIp` only for requests that carry neither header, and none otherwise.

Don't strip `X-Forwarded-For` with a *Modify Incoming Request Header* behavior to get the location back: Akamai doesn't document whether EdgeScape's lookup happens before or after that behavior, and the EdgeWorker would no longer see the header and know to distrust the location.

### When the EdgeWorker fails

The EdgeWorker answers every request itself, a 500 for its own errors. When EdgeWorkers fails it (a CPU, memory or time limit exceeded, or the EdgeWorker not active), Akamai [sends the request on to your origin](https://techdocs.akamai.com/edgeworkers/docs/response-orchestration), which most likely answers `/_sid/*` with a 404. To answer those at the edge instead, add [Site Failover](https://techdocs.akamai.com/edgeworkers/docs/site-failover) for the rule, following Akamai's [error handling](https://techdocs.akamai.com/edgeworkers/docs/error-handling) guide: store the built-in variable `AK_EDGEWORKERS_RP_STATUS` in a PMUSER variable, and in a following rule match when it's not empty and not `success` or `unimplementedHandler`.

## Configuration

Settings are Property Manager variables named `PMUSER_` plus the `SID_*` setting: `PMUSER_SID_BASE_PATH`, `PMUSER_SID_MODULES`, and so on, the same settings as everywhere else (see the [configuration reference](../../../docs/configuration.md)). JSON settings (`SID_MODULE_CONFIG`, `SID_HOSTS`) are the JSON text as the variable's value.

One more variable is read only by the Akamai adapter:

| Variable | Default | |
| --- | --- | --- |
| `PMUSER_SID_PUBLIC_ORIGIN` | The request's scheme and `Host` | The origin of request URLs. Only its scheme matters, and cookies are `Secure` for a public hostname whatever the scheme (see [Secure cookies](../../../docs/configuration.md#secure-cookies)), so leave it unset. |

EdgeWorkers hands the variables over with each request, so the EdgeWorker reads them on every request and rebuilds its configuration only when they change. A change takes effect with the property version that has it. An invalid setting makes every request return `500 SharedID Edge is misconfigured`, and the reason is logged (see [Troubleshooting](#troubleshooting)), rather than setting wrong cookies.

**Size.** Akamai limits Property Manager variables' total length for EdgeWorkers: 1,024 characters by default, which Dynamic and Enterprise tiers can raise to 4,000 through Akamai ([limits](https://techdocs.akamai.com/edgeworkers/docs/limitations), [July 2025 change](https://techdocs.akamai.com/edgeworkers/changelog/increase-for-property-manager-user-defined-variables)); the documentation describes the limit for variables an EdgeWorker sets, and doesn't say whether it applies to reading. Most deployments set a few short values. Keep `SID_HOSTS` and `SID_MODULE_CONFIG` small, or use per-hostname rules (above) rather than one large `SID_HOSTS`.

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) is `PMUSER_SID_MODULE_SECRETS`, with security **Hidden**:

```json
{"ec":{"passphrase":"<openssl rand -hex 32>"}}
```

Property Manager has no secret store an EdgeWorker can read: `getVariable` can't read variables whose security is *Sensitive*. *Hidden* keeps the value out of Akamai's debug headers (`Pragma: akamai-x-get-extracted-values`), but anyone who can view the property's configuration can read it, so keep property access to the people who deploy it. Akamai's [EdgeKV](https://techdocs.akamai.com/edgekv/docs) store is another place for a secret, which this adapter doesn't read. Without a secret, `ec` reports an error and sets nothing; the built-in modules need none.

To rotate, change the variable and activate the property version.

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'      # 200, image/gif, two set-cookie
curl -s  'https://www.example.com/_sid/v1' | jq .                   # the payload
curl -s  'https://www.example.com/_sid/v1' -H 'Cookie: _pubcid=test-id' | jq .sharedid   # "test-id"
```

Then [turn it on in Prebid.js](../../../docs/prebid.md).

## How requests map to requests and responses

**EdgeWorkers request object to `Request`:**

| Request object | `Request` |
| --- | --- |
| `method` | `method` |
| `scheme`, `host` | The URL's origin: the scheme the visitor used and their `Host` header (`PMUSER_SID_PUBLIC_ORIGIN` replaces it). |
| `url` | The URL's path and query, as sent (not decoded): `?id=pubcid%253A…` reaches the handler unchanged. |
| `getHeaders()` | Headers. Repeated lines are joined with `, `, and `Cookie` lines (HTTP/2 sends one per cookie) with `; `. |
| body | Not read: the handler answers methods other than GET, HEAD and OPTIONS with 405. |

**`Response` to `createResponse(status, headers, body)`:**

| `Response` | `createResponse` |
| --- | --- |
| `status` | `status` |
| Headers except `Set-Cookie` | `headers`, one array per header. `Content-Length` is left to Akamai. |
| Each `Set-Cookie` | One entry in the `set-cookie` array: header values are [arrays of strings](https://techdocs.akamai.com/edgeworkers/docs/create-response), and joining cookies breaks them. A sync sets two (`_pubcid` and `_pubcid_sv`). |
| Body | A `ReadableStream` of the body's bytes (from the `streams` built-in module), so the 43-byte sync GIF stays binary; a string body would be text, and is [limited to 16 KB](https://techdocs.akamai.com/edgeworkers/docs/create-response). Empty for HEAD and 204. |

Unexpected errors return a generic `500 Internal error`; only the error's name is logged, never request data.

## Base path

`PMUSER_SID_BASE_PATH` sets the routes the EdgeWorker answers, and the rule's path match must send it those paths: `/_sid/*` for the default, `/identity/*` for `/identity`. A request the rule sends that isn't one of the routes gets a 404 from the EdgeWorker, never your origin.

**The root base path, `/`, works:** the rule matches only SharedID Edge's own routes, not the whole site. Use *If Path matches one of* these four values, so every other path keeps going to your origin:

```text
/sync
/v1
/optout
/optin
```

## Platform information

The handler gets the client IP and location (`PlatformInfo`) from the request object, which Akamai sets itself:

| Field | From | Notes |
| --- | --- | --- |
| `clientIp` | `PMUSER_SID_CLIENT_IP` (`AK_CLIENT_REAL_IP`), else `request.clientIp` | IPv4 or IPv6; anything else is ignored. `request.clientIp` only when the request has no `X-Forwarded-For` or `Akamai-Client-IP` header ([why](#location-and-x-forwarded-for)). |
| `country` | `userLocation.country` | ISO 3166-1 alpha-2, like `US`. This and the other location fields only when the request has no `X-Forwarded-For` header ([why](#location-and-x-forwarded-for)). |
| `region` | `userLocation.region` | The subdivision code without the country, like `MA`. |
| `city` | `userLocation.city` | As EdgeScape gives it, upper case (`CAMBRIDGE`). For the `geo` module. |
| `postalCode` | `userLocation.zipCode` | Only when it's one code (`02138`, or a Canadian forward sortation area like `M5V`). EdgeScape lists every code an address may be in (`02114+02134-02138`); a list or range isn't one postal code, so then there's none. |
| `metroCode` | `userLocation.dma` | US DMA code, for the `geo` module. |
| `latitude`, `longitude` | `userLocation.latitude`, `.longitude` | For the `geo` module. Both are needed; out-of-range values are dropped. |
| `timezone` | `userLocation.timezone` | For the `geo` module's `utcoffset`, which needs a time zone name the runtime knows (`America/New_York`, `GMT`); others give no `utcoffset`. |
| `continent` | `userLocation.continent` | Two-letter code, like `NA`. |
| `isEU` | from `country` | `true` for the 27 EU member states, `false` for other countries, unknown without a country. |
| `traffic` | none | No bot verdict from the platform (Akamai Bot Manager's score is only available in a different event, `onBotSegmentAvailable`); the `bot` module and other modules still report to the traffic signal. |

Core's `locationInfo` validates the location the same way as on the other platforms (dropping empty values, `XX`, and out-of-range coordinates).

- **`isEU`** comes from a bundled list of the 27 EU member states (`EU_COUNTRY_CODES`), the same meaning as Cloudflare's `request.cf.isEUCountry`. It's EU membership, not the EEA (Iceland, Liechtenstein, Norway) or the UK: pages there should send `gdpr=1` (the [consent rules](../../../docs/consent.md)). When it's `true`, GDPR applies unless the request says `gdpr=0`. Without a country `isEU` is unknown, as on the other platforms.
- **`X-Forwarded-For`** turns the location off, and `PMUSER_SID_CLIENT_IP` decides the client IP: [Location and X-Forwarded-For](#location-and-x-forwarded-for).
- **The `ua` module** reads the visitor's `User-Agent` and User-Agent Client Hints from the request headers, which reach the EdgeWorker unchanged.

## The EdgeWorkers runtime

EdgeWorkers runs JavaScript modules in V8 with ECMAScript's built-ins but [none of the web platform's APIs](https://techdocs.akamai.com/edgeworkers/docs/specifications) (it names the DOM, `XMLHttpRequest` and the Fetch API), and provides others as [built-in modules](https://techdocs.akamai.com/edgeworkers/docs/built-in-modules). Core and the modules use web-standard `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextEncoder`, `atob`/`btoa` and `crypto`, so the bundle brings them (esbuild's `inject`, from `src/globals.ts`), without writing any globals:

| Core uses | In the bundle |
| --- | --- |
| `Request`, `Response`, `Headers`, `URL`, `URLSearchParams` | Minimal implementations in `src/web.ts` of only what SharedID Edge calls (`URLSearchParams.get`, `Headers` `get`/`set`/`append`/`has`/`forEach`/`getSetCookie`, and so on), following the WHATWG standards and tested against Node.js's. `URL` takes absolute URLs with a host; no relative URLs or internationalized domain names. A vendor module that needs more must add it there. |
| `TextEncoder`, `TextDecoder`, `atob`, `btoa` | The [`encoding`](https://techdocs.akamai.com/edgeworkers/docs/encoding) built-in module. |
| `crypto.getRandomValues`, `crypto.subtle` (the `ec` module's HMAC) | The [`crypto`](https://techdocs.akamai.com/edgeworkers/docs/crypto) built-in module. |
| `crypto.randomUUID` (new IDs) | Not documented by EdgeWorkers: a version 4 UUID from `crypto.getRandomValues`, the same format. |
| `console.error` (core's error logs) | The [`log`](https://techdocs.akamai.com/edgeworkers/docs/log) built-in module. |
| `setTimeout` (the module time limit, `SID_MODULE_TIMEOUT_MS`) | The runtime's, if it has one. EdgeWorkers documents none; without it modules aren't cut off at `SID_MODULE_TIMEOUT_MS`, and EdgeWorkers' own time limit for the request applies. The built-in modules don't wait on anything. |
| `Intl.DateTimeFormat` (the `geo` module's `utcoffset`) | V8's, if the runtime includes it; without it, `utcoffset` is left out. |

## Using it in code

The package exports the pieces, for your own entry point (other modules, a different configuration source):

```ts
import { resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createEdgeWorkerHandler } from '@sharedid-edge/akamai';

const handle = createEdgeWorkerHandler({
  config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }),
  modules: [...builtInModules, myModule]
});
// In responseProvider: const { status, headers, body } = await handle(request);
```

- `createEdgeWorkerHandler(options)`: the handler; options are core's `HandlerOptions` plus `publicOrigin`. It returns `{ status, headers, body }` (headers as arrays, the body as bytes) for `createResponse`; `src/main.ts` shows the conversion, the byte stream included.
- `createVariablesHandler(modules?)`: what the bundled entry point uses: settings from the `PMUSER_SID_*` variables, per request. `handlerFromEnv(env, modules?)` builds one from `SID_*` values; `envFromVariables(request)` reads them.
- `platformInfo(request)`, `postalCodeFromZip(zipCode)`.
- `EdgeWorkerRequest`, `EdgeWorkerUserLocation`, `EdgeWorkerResult`: minimal structural types; EdgeWorkers' own objects are assignable.

A custom entry point must be bundled the way `scripts/bundle.mjs` does it, with `src/globals.ts` injected and the built-in modules left as imports.

## Testing without an Akamai account

Nothing here needs an account:

- `npm test -w @sharedid-edge/akamai`: unit tests with recorded-style request objects (`test/requests.ts`), and the `src/web.ts` classes against Node.js's.
- `npm run conformance:akamai`: bundles the EdgeWorker (default, with Bowser, and with the vendor modules), then runs the whole conformance suite against `deploy/main.js` behind a local stand-in for EdgeWorkers (`conformance/src/akamai-emulator.ts`). It loads the bundle as an ES module in a V8 context of its own (`node:vm`), with ECMAScript's globals only (no `URL`, `TextEncoder`, `crypto`, `setTimeout` or fetch), answers its imports with stand-ins for the built-in modules that check their arguments as documented (a `createResponse` status from 100 to 599, header values as strings or arrays of strings, a body that is a string up to 16 KB or a stream of bytes; `crypto` without `randomUUID`), and calls `responseProvider` with a request object: `getHeaders()`, `clientIp`, `userLocation` and `getVariable()` reading `PMUSER_SID_*` from the case's settings (and `PMUSER_SID_CLIENT_IP` as the rule sets it). Then `conformance/src/akamai-checks.ts` checks what the shared cases can't: that a visitor-sent `X-Forwarded-For` turns EdgeScape's location off and doesn't change the client IP, and that every response, 404 and 405 included, carries `Cache-Control: no-store` or `private`.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.
- **Akamai's sandbox** runs your property and EdgeWorker locally against your real configuration (an account is needed): `akamai install sandbox`, `akamai sandbox create --hostname www.example.com`, `akamai sandbox add-edgeworker <edgeworker-id> sharedid-edge.tgz`, `akamai sandbox start`, then send requests for your hostname to it ([Sandbox for EdgeWorkers](https://techdocs.akamai.com/sandbox/docs/test-edgeworkers-functions-sandbox)). After a rebuild, `akamai sandbox update-edgeworker <edgeworker-id> sharedid-edge.tgz`.

## What isn't confirmed

Without a live Akamai test, these come from Akamai's documentation, or are open, and a first deployment should check them:

- **`createResponse` with array header values** writes one header line per entry, so both `Set-Cookie` headers arrive separately. Akamai documents arrays of strings as `createResponse` header values, and its [examples](https://github.com/akamai/edgeworkers-examples) set several cookies on a response with an array (`response.setHeader('Set-Cookie', [...])`), but SharedID Edge hasn't seen it live. `verify-deployment` checks it.
- **A byte stream body** keeps the GIF intact. The documentation says the stream "should consist of bytes of data".
- **`{{builtin.AK_CLIENT_REAL_IP}}` in a *Set Variable* behavior.** Akamai's built-in variables reference notes processing stages for some uses of it; if it comes out empty, the EdgeWorker falls back to `request.clientIp` with the header guard.
- **Whether `request.clientIp` follows `X-Forwarded-For` or `Akamai-Client-IP`.** Undocumented, so it isn't used when either is present.
- **Which web APIs the runtime has.** None are relied on; see [The EdgeWorkers runtime](#the-edgeworkers-runtime). Whether `setTimeout` and `Intl` exist decides whether the module time limit and `utcoffset` work.
- **EdgeScape's `timezone` format.** The documentation's only example is `GMT`; names the runtime doesn't know give no `utcoffset`.
- **`OPTIONS` requests** reaching `responseProvider` with *Allow OPTIONS* on, for CORS preflights.
- **The variable size limit** (above) for reading variables.

Please report what you find in an issue.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's page or a 404 from your origin | The rule doesn't match the path (its criteria don't match `SID_BASE_PATH`), the EdgeWorker isn't active on that network, or it failed: see [When the EdgeWorker fails](#when-the-edgeworker-fails). |
| 500 `SharedID Edge is misconfigured` | An invalid or missing setting, usually `PMUSER_SID_COOKIE_DOMAIN` (missing, or *Sensitive*, which the EdgeWorker can't read). The reason is in the EdgeWorker's [logs](https://techdocs.akamai.com/edgeworkers/docs/log), shown with enhanced debug headers or sent to DataStream 2. |
| 500 `Internal error` | An unexpected error; its name is in the logs. |
| Settings don't take effect | The variable's name must be `PMUSER_` plus the setting, upper case; the property version with it must be active on that network. |
| `/_sid/v1` has no `ortb2.device.ip` with `SID_MODULES=ip` | Consent rules it out (`ext.modules.ip.status` is `empty`; see `X-SharedID-Status`). |
| EU visitors get cookies without consent, or the reverse | No country from EdgeScape (GDPR is then unknown), or the page sends `gdpr=`. See `X-SharedID-Status`. |
| Responses served from cache, or one visitor's cookie on another's response | The rule's *Caching* behavior isn't *No store*, or a later rule overrides it; `responseProvider` doesn't run for a cached response. Check that `X-Cache` is a `TCP_MISS` with `curl -sI -H 'Pragma: akamai-x-cache-on' 'https://www.example.com/_sid/v1'`, and run `verify-deployment`. Purge `/_sid/*` after fixing it. |
| No `geo` data and GDPR undecided for some visitors | Their requests carry `X-Forwarded-For` (from a proxy, or sent by the visitor), so the EdgeWorker ignores EdgeScape's location ([why](#location-and-x-forwarded-for)). Expected. |
| No `ortb2.device.ip` with `SID_MODULES=ip` for requests through a proxy | The rule doesn't set `PMUSER_SID_CLIENT_IP` to `{{builtin.AK_CLIENT_REAL_IP}}`, so the EdgeWorker can't trust `request.clientIp` when `X-Forwarded-For` is present. |
| `/_sid/sync` cached in browsers for longer than `SID_SYNC_CACHE_SECONDS`, or `/_sid/v1` cached at all | Downstream Cacheability replaces the response's `Cache-Control`. |
| Cookie set but gone after a week in Safari | `/_sid/*` is not on the site's own property. Run `verify-deployment`. |
| Two cookies merged into one, or only one set | Something between the EdgeWorker and the browser joins `Set-Cookie` headers. The EdgeWorker sends them as separate entries. |
| `akamai edgeworkers upload` refuses the bundle as a duplicate | The same code was uploaded before: activate that version instead. |

## Akamai documentation

What this adapter relies on, from [techdocs.akamai.com](https://techdocs.akamai.com/edgeworkers/docs):

- [Event handlers](https://techdocs.akamai.com/edgeworkers/docs/event-handler-functions) and [response orchestration](https://techdocs.akamai.com/edgeworkers/docs/response-orchestration): `responseProvider`, and that a failed one is forwarded to the origin.
- [`createResponse`](https://techdocs.akamai.com/edgeworkers/docs/create-response): status, headers as strings or arrays, a string body up to 16 KB or a stream of bytes.
- [Request object](https://techdocs.akamai.com/edgeworkers/docs/request-object): `method`, `scheme`, `host`, `url`, `clientIp`, `getHeaders`, `getVariable` (`PMUSER_` only, not *Sensitive*).
- [User location object](https://techdocs.akamai.com/edgeworkers/docs/user-location-object): EdgeScape's fields and the `X-Forwarded-For` note.
- [Specifications](https://techdocs.akamai.com/edgeworkers/docs/specifications) and [built-in modules](https://techdocs.akamai.com/edgeworkers/docs/built-in-modules): [`encoding`](https://techdocs.akamai.com/edgeworkers/docs/encoding), [`crypto`](https://techdocs.akamai.com/edgeworkers/docs/crypto), [`streams`](https://techdocs.akamai.com/edgeworkers/docs/streams), [`log`](https://techdocs.akamai.com/edgeworkers/docs/log).
- [Resource tiers](https://techdocs.akamai.com/edgeworkers/docs/resource-tier-limitations) and [product limits](https://techdocs.akamai.com/edgeworkers/docs/limitations).
- [Code bundle format](https://techdocs.akamai.com/edgeworkers/docs/code-bundle-format), and the [EdgeWorkers CLI](https://github.com/akamai/cli-edgeworkers) (`register`, `upload`, `activate`, `status`).
- [User-defined variables](https://techdocs.akamai.com/property-mgr/docs/user-defined-vars), [error handling](https://techdocs.akamai.com/edgeworkers/docs/error-handling) and [Site Failover](https://techdocs.akamai.com/edgeworkers/docs/site-failover).
