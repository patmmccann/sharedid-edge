# @sharedid-edge/fastly

[SharedID Edge](../../../README.md) on Fastly: a [Fastly Compute](https://www.fastly.com/documentation/guides/compute/) service, written with Fastly's [JavaScript SDK](https://www.fastly.com/documentation/guides/compute/developer-guides/javascript/), answering `/_sid/*` on the domain that serves your site. No Rust: the SDK compiles the JavaScript bundle to a WebAssembly package. It's the same platform-neutral handler as the Cloudflare Worker and the other adapters, with built-in modules `ip`, `geo`, `reflect`, `bot`, `ua` and `clickid` (`ec` and vendor modules are added at build time), and it passes the same conformance suite, run against the compiled package in Fastly's local runtime.

This is the full guide. The other platforms are listed under [Pick your platform](../../../README.md#pick-your-platform). Sites already on Fastly that would rather run a server can use the [Node.js server](../node/README.md#per-cdn) behind a VCL service instead; this adapter needs no server.

**Status:** built from Fastly's documentation and tested in [Viceroy](https://github.com/fastly/Viceroy), Fastly's local runtime, which runs the real package; not yet on a live Fastly service. [What isn't confirmed](#what-isnt-confirmed) lists what a first deployment should check, chiefly [how `/_sid/*` reaches the service](#routing).

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy](#deploy)
- [Routing](#routing)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Verify](#verify)
- [Platform information](#platform-information)
- [The Compute runtime](#the-compute-runtime)
- [Reusable sandboxes (experimental)](#reusable-sandboxes-experimental)
- [Using it in code](#using-it-in-code)
- [Testing without a Fastly account](#testing-without-a-fastly-account)
- [What isn't confirmed](#what-isnt-confirmed)
- [Troubleshooting](#troubleshooting)
- [Fastly documentation](#fastly-documentation)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
Fastly edge: www.example.com
   ├─ path /_sid/* (routing rule) → the SharedID Edge Compute service
   │     addEventListener('fetch') → event.request, event.client (address, geo)
   │        → settings from the config store sharedid_config, SID_MODULE_SECRETS from the secret store sharedid_secrets
   │        → SharedID Edge handler → Response, every Set-Cookie its own header
   └─ everything else → your site's existing Fastly service, unchanged
```

- **On your site's own domain.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. The Compute service must answer `www.example.com/_sid/*` from the same Fastly addresses as your pages; a separate hostname (`sid.example.com`) doesn't work. [Routing](#routing) covers the two ways to do that.
- **Answered in Compute, never forwarded.** The service has no backends, and the entry point calls [`enforceExplicitBackends()`](https://js-compute-reference-docs.edgecompute.app/docs/fastly:backend/enforceExplicitBackends) at start-up, so even with dynamic backends enabled on the service, `fetch()` has nowhere to go. Every error is answered with a generic 500.
- **Settings from a config store.** Compute has no environment variables for deployment settings: each `SID_*` setting is a key of the same name in a [config store](https://js-compute-reference-docs.edgecompute.app/docs/fastly:config-store/ConfigStore/) linked as `sharedid_config`, and module secrets go in a [secret store](https://js-compute-reference-docs.edgecompute.app/docs/fastly:secret-store/SecretStore/) linked as `sharedid_secrets`. Stores can only be read while handling a request (Fastly runs the code's top level at build time), so they're read with each request.
- **Client IP and location from Fastly, not the visitor.** The client IP is `event.client.address`, the connection's address, and the location is `event.client.geo`, Fastly's geolocation of it. Neither comes from a request header: a Compute service gets `Fastly-Client-IP` and `X-Forwarded-For` as the visitor sent them ("if a client sets this header themselves, we will use it", [Fastly-Client-IP](https://www.fastly.com/documentation/reference/http/http-headers/Fastly-Client-IP/); Fastly "does not modify X-Forwarded-For in Compute services", [X-Forwarded-For](https://www.fastly.com/documentation/reference/http/http-headers/X-Forwarded-For/)), so the adapter reads neither.
- **Nothing cached.** Compute doesn't cache a response the code creates itself, and every response carries `Cache-Control: no-store` or `private` (the tests check it). If a VCL service sits in front ([service chaining](#b-service-chaining-from-your-vcl-service)), it must pass `/_sid/*` without caching.

## Prerequisites

- A Fastly account with Compute, and your site served by Fastly (today, normally a VCL service with `www.example.com`).
- The [Fastly CLI](https://www.fastly.com/documentation/reference/tools/cli/) with an API token (`fastly profile create`). Everything below can also be done in the Fastly control panel.
- Node.js 24 or later and npm, to build.

## Build

From the repository root:

```sh
npm ci
npm run build                              # compiles core and the modules
npm run bundle -w @sharedid-edge/fastly    # writes packages/adapters/fastly/deploy/main.js
npm run wasm -w @sharedid-edge/fastly      # compiles it to packages/adapters/fastly/deploy/main.wasm
```

`deploy/main.js` is one minified ES module whose only imports are Fastly's own modules (`fastly:backend`, `fastly:config-store`, `fastly:secret-store`); CI fails it over the project's 32 KB gzipped budget. `npm run wasm` compiles it with Fastly's JavaScript SDK, [`@fastly/js-compute`](https://www.npmjs.com/package/@fastly/js-compute), pinned to an exact version (4.2.0) in `toolchain/package.json` with its lockfile. The SDK is a separate install of about 500 MB (Wizer, weval and Wasmtime), kept out of the repository's workspace so `npm ci` doesn't fetch it for everyone: the first `npm run wasm` installs it into `toolchain/node_modules` (`npm ci`), and again whenever the pinned version changes. Compiling takes 5 to 40 seconds. The SDK pre-initializes the code ("Wizening") and compiles it ahead of time (weval), so the package is mostly the JavaScript engine (SpiderMonkey, in Fastly's StarlingMonkey runtime):

| Build | Bundle (`main.js`, gzipped) | Package (`main.wasm`) |
| --- | --- | --- |
| Default | 21.7 KB | 16.2 MB (5.1 MB gzipped) |
| With Bowser | 30.1 KB | 19.1 MB (5.7 MB gzipped) |
| With `ec`, `dbip` and `maxmind` (the fixtures) | 24.0 KB | 16.6 MB (5.2 MB gzipped) |

Fastly's limit for a compiled package is [100 MB](https://docs.fastly.com/products/compute-resource-limits); `npm run wasm` fails above it.

**`ec` and vendor modules (opt-in).** The bundle has the built-in modules (`ip`, `geo`, `reflect`, `bot`, `ua`, `clickid`). [`ec`](../../vendor-modules/ec/README.md) (Trusted Server Edge Cookies, whose ID is derived from the IP address) and [vendor modules](../../vendor-modules/README.md) aren't in it: add each with `--module <package>#<export>`, in place of the plain `bundle`, then run `npm run wasm` as above:

```sh
npm run bundle -w @sharedid-edge/fastly -- --module @sharedid-edge/module-ec#ecModule
npm run wasm -w @sharedid-edge/fastly
```

Then list it in `SID_MODULES`, with its settings and secrets (the [`ec` README](../../vendor-modules/ec/README.md#turning-it-on), and [Secrets](#secrets) below). Without `--module`, `SID_MODULES=ec` reports `ec` as `skipped` (`not installed`). The bundle's size is reported but the 32 KB budget isn't enforced with opt-in modules.

**Reusable sandboxes (opt-in, experimental).** `npm run bundle:reusable -w @sharedid-edge/fastly` in place of `bundle` builds the service so one sandbox answers several requests; see [Reusable sandboxes](#reusable-sandboxes-experimental).

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` for Safari, Firefox, TVs and other browsers that send no Client Hints. `npm run bundle:bowser -w @sharedid-edge/fastly` (in place of `bundle`; same `deploy/` folder, then `npm run wasm`) builds it in, and the `SID_MODULE_CONFIG` key `{"ua":{"parser":"bowser"}}` turns it on. `--bowser` and `--module` can be combined.

## Deploy

With the Fastly CLI, after [Build](#build). The commands run in `packages/adapters/fastly`, where `fastly.toml` is.

1. **Create the Compute service** (once), and note its service ID:

   ```sh
   cd packages/adapters/fastly
   fastly service create --name sharedid-edge --type wasm
   ```

2. **Create the stores, add the settings, and link them to the service** (once; the settings can change any time later, see [Configuration](#configuration)). `SID_COOKIE_DOMAIN` is required:

   ```sh
   fastly config-store create --name sharedid_config                 # note the store ID
   fastly config-store-entry create --store-id <config-store-id> --key SID_COOKIE_DOMAIN --value example.com
   fastly config-store-entry create --store-id <config-store-id> --key SID_MODULES --value ip,geo
   fastly service resource-link create --service-id <service-id> --version latest --autoclone \
     --resource-id <config-store-id> --name sharedid_config
   ```

   For module secrets (only with modules that need one, such as `ec`), a secret store linked as `sharedid_secrets`, the same way ([Secrets](#secrets)). The link's name is what the code opens, whatever the store is called.

3. **Pack and deploy the package:**

   ```sh
   fastly compute pack --wasm-binary deploy/main.wasm               # writes pkg/sharedid-edge.tar.gz
   fastly compute deploy --service-id <service-id> --package pkg/sharedid-edge.tar.gz
   ```

   `deploy` uploads the package to a new service version and activates it. Each later build is the same two commands.

4. **Send `/_sid/*` on your site's domain to the service**, without caching it: [Routing](#routing). This is the step to try first on a staging domain.

5. **Check it before your pages use it.** Request the base path on your domain:

   ```sh
   curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie lines
   ```

   A `404` with `content-type: text/plain` from the service means the request reached it outside the base path (check the rule and `SID_BASE_PATH`); your site's own 404 page means the routing rule didn't match.

6. **[Verify](#verify)** with `verify-deployment`, then [turn it on in Prebid.js](../../../docs/prebid.md).

## Routing

The service answers every request it gets: core answers its routes under `SID_BASE_PATH` (`/sync`, `/v1`, `/optout`, `/optin`) and anything else with a 404. What reaches it is decided in front of it, by the rule that sends the base path to it, and that rule must use the same base path:

| `SID_BASE_PATH` | What the rule sends to the Compute service |
| --- | --- |
| `/_sid` (the default) | Paths starting with `/_sid/` |
| A custom path, like `/identity` | Paths starting with `/identity/` |
| `/` | Exactly `/sync`, `/v1`, `/optout` and `/optin` (with or without a trailing `/`), never the whole site |

There are two ways to put the service on your domain.

### A. Request Routing (recommended)

[Request Routing](https://www.fastly.com/documentation/guides/getting-started/domains/working-with-domains/configuring-routing-rules/) ([announcement](https://community.fastly.com/t/one-domain-multiple-services-introducing-request-routing/4442)) sends a domain's requests to different services by path, "without needing to write code in Compute or VCL"; it's free for all customers. In the control panel: **Domains** > **Routing configuration** > **Create configuration**: the path value is the base path (`/_sid/`), the rule's service is the SharedID Edge Compute service, and the **Default Rule** is your site's existing service. Deploy the configuration and link it to `www.example.com`.

With the root base path, the configuration needs the four route paths (Fastly allows up to 20 rules per path and 5 conditions per rule), not `/`: a rule on `/` would take over the site.

This is the clean setup: the Compute service sees the visitor's own connection and the site's `Host`, as a Cloudflare route does. Fastly's documentation doesn't yet say everything it needs, so check it on a staging domain first ([What isn't confirmed](#what-isnt-confirmed)): how the path value matches (a prefix, wildcards), whether a VCL service can be the default with a Compute service for the path, and what `event.client.address` and `event.client.geo` are in the routed service. [Verify](#verify) checks the last one: `verify-deployment` and `/_sid/v1` with the `ip` and `geo` modules show the client IP and location the service sees.

### B. Service chaining from your VCL service

[Service chaining](https://www.fastly.com/documentation/guides/concepts/service-chaining/) is documented and works today: your site's VCL service sends the base path to the Compute service as a backend (the Compute service's domain, such as `sharedid-edge.edgecompute.app`, with its `Host`), with `return(pass)` so nothing is cached. But the Compute service then sees the VCL service's request, not the visitor's: `event.client.address` is a Fastly address, so the `ip` and `geo` modules, and GDPR from the visitor's country, have nothing true to work with, and the `Host` is the Compute service's own. Fastly's guidance for this setup is to trust `Fastly-Client-IP` from the first service; this adapter doesn't read it, since a visitor can set it on a direct request. Until the adapter has a trusted-upstream mode for it (an authenticated first service, the client IP from `Fastly-Client-IP` as the VCL sets it, and the location looked up for that address), use service chaining only without the location and IP modules, with a `gdpr` signal from the page, and with `SID_PUBLIC_ORIGIN=https://www.example.com` so cookies are `Secure` and `SID_HOSTS` sees your host. The VCL condition uses the base path (`req.url.path ~ "^/_sid/"`), and with `/`, exactly the four routes.

A third option, a Compute service that owns the whole domain and forwards everything else to your origin, takes over the site and forwards requests; it's out of scope. Sites that already run their own Compute app on the domain can instead call this package's handler for the base path ([Using it in code](#using-it-in-code)).

## Configuration

Each setting is a key in the config store linked as `sharedid_config`, named as in the [Configuration reference](../../../docs/configuration.md): `SID_COOKIE_DOMAIN` (required), `SID_BASE_PATH`, `SID_MODULES`, `SID_MODULE_CONFIG`, `SID_HOSTS` and the rest, plus `SID_PUBLIC_ORIGIN` (the origin request URLs are built from; leave it unset with Request Routing). A key that isn't there is unset.

```sh
fastly config-store-entry update --store-id <config-store-id> --key SID_MODULES --value ip,geo,ua
```

- **Read with every request,** so a change takes effect as soon as Fastly has propagated it, without deploying. The handler is built from the settings, and rebuilt only when they change, while an instance lives; by default Fastly starts a fresh instance per request, and with [reusable sandboxes](#reusable-sandboxes-experimental) one instance answers several.
- **Invalid settings answer 500.** A missing `SID_COOKIE_DOMAIN`, an invalid value, or no config store linked as `sharedid_config` give `500` `SharedID Edge is misconfigured` on every request, and the log says which setting is wrong, rather than set wrong cookies.
- **Limits** ([Compute resource limits](https://docs.fastly.com/products/compute-resource-limits)): values up to 8,000 characters (so `SID_HOSTS` and `SID_MODULE_CONFIG` must fit), 500 entries per store, 5 stores per account (1 store of 100 entries on trial accounts); characters over 3 bytes in UTF-8 are truncated ([config stores](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-config-stores/)). The service reads 19 keys per request.
- **Not `SID_MODULE_SECRETS`:** a config store isn't for secrets, so the service answers 500 if it finds that key there. It goes in the secret store.

Settings for local runs live in `fastly.toml`'s `[local_server.config_stores.sharedid_config]` ([Testing without a Fastly account](#testing-without-a-fastly-account)); they never reach a deployed service.

## Secrets

`SID_MODULE_SECRETS`, the JSON object of module secrets (such as the `ec` passphrase, `{"ec":{"passphrase":"…"}}`), is the key `SID_MODULE_SECRETS` in a [secret store](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-secret-stores/) linked as `sharedid_secrets`:

```sh
fastly secret-store create --name sharedid_secrets                    # note the store ID
fastly secret-store-entry create --store-id <secret-store-id> --name SID_MODULE_SECRETS --stdin < module-secrets.json
fastly service resource-link create --service-id <service-id> --version latest --autoclone \
  --resource-id <secret-store-id> --name sharedid_secrets
```

The secret store is optional: without one linked, there are no module secrets (and `ec` reports an error and sets nothing). The service reads one secret per request (Fastly allows 5 reads per request; accounts get 10 secrets by default, 64 KB each). Never put secrets in `fastly.toml` outside `[local_server]`, or in the bundle: the build is checked for vendor modules' build-time credentials.

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'      # 200, image/gif, two set-cookie lines, Secure
curl -s  'https://www.example.com/_sid/v1' | jq .                   # the payload
curl -s  'https://www.example.com/_sid/v1' -H 'Cookie: _pubcid=test-id' | jq .sharedid   # "test-id"
```

With `SID_MODULES=ip,geo`, `/_sid/v1` shows the client IP and location the service sees (`ortb2.device.ip` and `geo`, within what consent allows): check they're yours, not a Fastly address. Then [turn it on in Prebid.js](../../../docs/prebid.md).

## Platform information

| `PlatformInfo` | Fastly source | Notes |
| --- | --- | --- |
| `clientIp` | `event.client.address` | The connection's address, IPv4 or IPv6, checked by core's `parseIp`. Never `Fastly-Client-IP` or `X-Forwarded-For`. |
| `country` | `client.geo.country_code` | ISO 3166-1 alpha-2. Core's `locationInfo` drops `XX`, `T1` and anything malformed. |
| `region` | `client.geo.region` | ISO 3166-2 subdivision, like `TX`. |
| `isEU` | from `country` | Core's `locationWithEU`: the 27 EU member states. |
| `city` | `client.geo.city` | |
| `postalCode` | `client.geo.postal_code` | Upper-cased: Fastly gives alphanumeric codes in lowercase. Partial in some countries (Canada's first 3 characters, the UK's outward code). |
| `metroCode` | `client.geo.metro_code` | The US DMA code; `0` (no metro code) is dropped. |
| `latitude`, `longitude` | `client.geo.latitude`, `longitude` | Both or neither; exactly `0,0` is treated as unknown. |
| `continent` | `client.geo.continent` | Two letters, like `NA`. |
| `timezone` | none | Fastly gives a UTC offset (`utc_offset`), not an IANA time zone, so the `geo` module has no `utcoffset` on Fastly. |
| `traffic` | none | Fastly's bot detection (`request.botDetected` and friends) isn't mapped yet. |

`?`, `**` and `--`, which Fastly uses for unknown text values, count as missing. `event.client.geo` is `null` when Fastly has no location for the address; then there's no country, and GDPR applies only with a `gdpr` signal from the page.

## The Compute runtime

The SDK runs the bundle in SpiderMonkey, compiled to WebAssembly, not in V8. Core and the built-in modules need only what it provides: `Request`, `Response`, `Headers` with `getSetCookie()` (every `Set-Cookie` is sent as its own header), `URL`, `TextEncoder`, `atob`/`btoa`, `crypto.randomUUID`, `crypto.subtle` HMAC-SHA-256 (for `ec`), and `setTimeout`, which core's module time limit (`SID_MODULE_TIMEOUT_MS`) uses. Two gaps, neither of which matters today:

- **No `Intl`.** The `geo` module's `utcoffset` uses it, inside a `try`, and Fastly has no IANA time zone anyway. If core or a module starts depending on `Intl`, the Fastly conformance run fails.
- **No `AbortController` or `AbortSignal`.** Nothing here uses them.

**CPU time.** Fastly allows 50 ms of CPU per request. Measured in Viceroy with `vCpuTime()` (`fastly:compute`), on the Bowser build with every built-in module on (`ip`, `geo`, `reflect`, `bot`, `ua` with Bowser, `clickid`) and a Safari `User-Agent`: 7 to 9 ms for `/_sid/v1` and 2 to 3 ms for `/_sid/sync`, plus 2 to 4 ms before the handler runs; that includes reading the stores and building the handler, which a fresh instance does on every request. These are a laptop's numbers in the local runtime, not Fastly's, but far from the limit.

**One instance per request.** Fastly starts a fresh sandbox for each request by default ([Compute](https://www.fastly.com/products/edge-compute) claims microsecond start-up, since the code was initialized at build time). So the handler cache only helps if you opt into sandbox reuse ([Reusable sandboxes](#reusable-sandboxes-experimental)); the measurements above include building it.

## Reusable sandboxes (experimental)

**Off by default.** A build option turns on Fastly's reusable sandboxes, so one sandbox answers several requests in turn rather than one. The settings are still read from the stores with every request, but the handler built from them ([read with every request](#configuration), rebuilt only when they change) is kept for the sandbox's life, and the JavaScript engine has already run the code once.

```sh
npm run bundle:reusable -w @sharedid-edge/fastly   # in place of `bundle`: the same as `bundle -- --reusable-sandbox`
npm run wasm -w @sharedid-edge/fastly
```

It combines with `--bowser` and `--module` (`npm run bundle:reusable -w @sharedid-edge/fastly -- --bowser`). The bundle's entry point is then `src/reusable.ts`, which runs the service as `src/main.ts` does and calls [`setReusableSandboxOptions`](https://js-compute-reference-docs.edgecompute.app/docs/fastly:experimental/setReusableSandboxOptions) from `fastly:experimental` during build-time initialization, the only time the SDK allows it. The default build doesn't import `fastly:experimental` at all, and the bundle script fails if it does. Same 32 KB budget: 21.8 KB gzipped, or 30.3 KB with Bowser.

**The defaults** (`src/sandbox.ts`) bound reuse, since Fastly's own defaults, once `maxRequests` is raised, let a sandbox live as long as the platform keeps it:

| Option | Default | Means |
| --- | --- | --- |
| `maxRequests` | 50 | Requests a sandbox answers before it's recycled (Fastly's default, 1, is no reuse; 0 is no limit). The handler is built once per sandbox, so 50 makes that cost about 2% of what it is without reuse; more would save little and keep a sandbox longer. |
| `betweenRequestTimeoutMs` | 2000 | How long a sandbox waits for its next request before it's recycled. |
| `sandboxTimeoutMs` | 60000 | How long a sandbox may live: after a minute, it's recycled once its current request is answered. |
| `maxMemoryMiB` | 64 | Recycled before the next request above this. Half Fastly's per-sandbox heap; the service uses about 10 MiB in Viceroy. |

Override any of them at build time, as whole numbers: `npm run bundle:reusable -w @sharedid-edge/fastly -- --reusable-sandbox-option maxRequests=20 --reusable-sandbox-option betweenRequestTimeoutMs=1000`. A sandbox is also recycled when a request fails; the SDK [bails out of the reused sandbox](https://github.com/fastly/js-compute-runtime/blob/main/CHANGELOG.md) then.

**What it saves.** Measured in Viceroy 0.22.0 (Fastly's local runtime) on a laptop, with the Bowser build, every built-in module on (`ip`, `geo`, `reflect`, `bot`, `ua` with Bowser, `clickid`) and a Safari `User-Agent`; 36 requests to each route per build, medians. Handler time is from the `fetch` listener to the response, including reading the stores and, when needed, building the handler; vCPU is `vCpuTime()` (whole milliseconds), for the handler and for everything else the sandbox spends on the request. These are local-runtime numbers, not Fastly's:

| Route | Build | Handler time | Handler vCPU | vCPU outside the handler | Mean vCPU per request |
| --- | --- | --- | --- | --- | --- |
| `/_sid/v1` | default (a sandbox per request) | 7.3 ms | 7 ms | 2 ms | 8.7 ms |
| `/_sid/v1` | reusable, a sandbox's first request | 8.3 ms | 8 ms | 2 ms | |
| `/_sid/v1` | reusable, later requests | 4.3 ms | 4 ms | 2 ms | 6.7 ms (all requests) |
| `/_sid/sync` | default | 2.9 ms | 3 ms | 2 ms | 4.8 ms |
| `/_sid/sync` | reusable, a sandbox's first request | 2.9 ms | 2.5 ms | 2 ms | |
| `/_sid/sync` | reusable, later requests | 2.0 ms | 2 ms | 2 ms | 3.7 ms (all requests) |

So a reused sandbox answers `/v1` in about 40% less time, and `/sync` in about 30% less. The saving is smaller than in [Trusted Server](https://github.com/IABTechLab/trusted-server), whose build is heavier: this handler is cheap to build, and most of `/v1` is the modules' own work (Bowser, chiefly), which reuse doesn't change. Viceroy recycles a sandbox after 6 requests whatever `maxRequests` says, as Trusted Server also found, so these are 1 build per 6 requests; on Fastly it would be 1 per up to 50. Viceroy logs `WebAssembly exited with error … exit status 1` when a reused sandbox ends because no next request came (its 6-request limit, or `betweenRequestTimeoutMs`): that's the SDK's exit when the wait for the next request fails, after every response has gone out, and a minimal service with only `setReusableSandboxOptions` logs it too.

**Risks.**

- **Experimental API.** `setReusableSandboxOptions` is in `fastly:experimental` (since SDK 3.40.0; this package pins 4.2.0). Fastly may change or remove it; the SDK is pinned, so an upgrade is deliberate, and `npm run conformance:fastly:reusable` checks the build.
- **State between visitors.** With reuse, anything a module keeps outside a request lives on into the next visitor's request. The project audited core, the built-in modules, the vendor modules and this adapter before adding the option: nothing keeps request data (IP, cookies, consent, IDs, headers, location) between requests, and no module-level regular expression carries `lastIndex`. What does live on: the handler `cachedByEnv` keeps, keyed by the settings (with `SID_MODULE_SECRETS` in that key); each module's parsed configuration and secrets, frozen all the way down on every platform, so a module can't change them for later requests ([Modules](../../../docs/modules.md#choosing-modules), and the [specification](../../../spec/SPEC.md#modules)); lookup tables built from constants (the IP range tables of `dbip` and `maxmind`, the `geo` country table); and the `geo` module's cache of time-zone formatters, keyed by time-zone name, which Fastly never fills since it gives no time zone. The rule for contributors is in `AGENTS.md`. A module that takes longer than `SID_MODULE_TIMEOUT_MS` may still be running when the sandbox takes the next request; no module shares state, so it can't affect it.
- **Not run on a live Fastly service.** How often Fastly gives a reused sandbox the next request, and how its limits interact with these defaults, are under [What isn't confirmed](#what-isnt-confirmed).

**How it's tested.** `npm run conformance:fastly:reusable` builds the three packages with reusable sandboxes and runs the whole suite against them in Viceroy, as `conformance:fastly` does for the default ones; CI runs both. `conformance/src/fastly-checks.ts` sends two visitors in turn, three times (different cookies, click IDs, addresses and locations), checks that the second gets nothing of the first's, and reads Viceroy's log to check that one sandbox answered both in the reusable build, and that each request had its own in the default one. Unit tests do the same through one handler, in core and here.

## Using it in code

The package exports the handler for Compute apps of your own (a site that already runs Compute on its domain, say), to call for requests under the base path:

```js
/// <reference types="@fastly/js-compute" />
import { ConfigStore } from 'fastly:config-store';
import { createStoresHandler } from '@sharedid-edge/fastly';

const BASE_PATH = '/_sid';   // the same as SID_BASE_PATH in the config store
const sharedid = createStoresHandler({ config: () => new ConfigStore('sharedid_config'), secrets: () => undefined });

addEventListener('fetch', event => event.respondWith(
  new URL(event.request.url).pathname.startsWith(`${BASE_PATH}/`) ? sharedid(event.request, event.client) : yourApp(event)
));
```

With the root base path, match exactly core's routes (`/sync`, `/v1`, `/optout`, `/optin`) rather than a prefix.

- `createStoresHandler(stores, modules?)`: what the bundled entry point uses: settings from the stores with each request.
- `createFastlyHandler(options)`: a handler from options you build yourself (`{ config, modules, publicOrigin }`, as core's `createHandler` takes), and `handlerFromEnv(env, modules?)` one from `SID_*` values.
- `platformInfo(event.client)`: the mapping in [Platform information](#platform-information).
- Every handler takes `(request, client)` and resolves to a `Response`; it never throws.

## Testing without a Fastly account

Nothing here needs an account:

- `npm test -w @sharedid-edge/fastly`: unit tests with recorded-style `event.client` objects (`test/clients.ts`, including what Viceroy returns), IPv4 and IPv6, stores, misconfiguration and routing.
- **A local run in Viceroy**, Fastly's local runtime ([testing guide](https://www.fastly.com/documentation/guides/compute/developer-guides/testing/)). Download a [release binary](https://github.com/fastly/Viceroy/releases) (Linux, macOS or Windows), build, and run the package with `fastly.toml`, whose `[local_server]` section has a config store, a secret store and a location for `127.0.0.2`:

  ```sh
  cd packages/adapters/fastly
  viceroy serve -C fastly.toml --addr 127.0.0.1:7676 deploy/main.wasm
  curl -si 'http://127.0.0.1:7676/_sid/sync?id=pubcid:test-id'
  curl -s --interface 127.0.0.2 http://127.0.0.1:7676/_sid/v1        # located in Berlin
  ```

  `fastly compute serve` runs the same Viceroy. Every address without an entry is located in San Francisco.
- `npm run conformance:fastly` (needs Viceroy: `viceroy` on the `PATH` or `VICEROY=/path/to/viceroy`): builds the three packages (default, Bowser, and with the vendor modules), then runs the whole conformance suite against them in Viceroy through `conformance/src/fastly-viceroy.ts`. Viceroy takes the client address from the connection and the location from its own table, as Fastly does, so the relay sends each case's request from the case's client IP and writes the case's location into Viceroy's `fastly.toml` for that address; the case's settings become the config and secret stores. The cases use documentation-range addresses (`192.0.2.77`, `2001:db8:1::77`, …), which must be local: CI does this on Linux with `sudo sysctl -w net.ipv4.ip_nonlocal_bind=1 net.ipv6.ip_nonlocal_bind=1` and `sudo ip route add local 192.0.2.0/24 dev lo` per range (see `.github/workflows/ci.yml`). Elsewhere, the case files that use them (the `ip`, `ec`, `dbip` and `maxmind` modules) fail with a message saying so; the rest pass on any OS. Then `conformance/src/fastly-checks.ts` checks what the shared cases can't: that `X-Forwarded-For` and `Fastly-Client-IP` from the visitor change neither the client IP nor the location (IPv4 and `::1`), that every `Set-Cookie` arrives as its own header, that every response carries `Cache-Control: no-store` or `private`, that a service without its config store answers 500, and that one visitor's request leaves nothing for the next (reading Viceroy's log for whether a sandbox answered both). `npm run conformance:fastly:reusable` does the same with the [reusable-sandbox](#reusable-sandboxes-experimental) packages. One field is reported missing rather than compared: `utcoffset` ([Platform information](#platform-information)). It isn't part of `npm run check`, which builds and size-checks the bundle only, since it needs the Viceroy binary and the SDK; it runs in its own CI job.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

## What isn't confirmed

Built from Fastly's documentation and the SDK's types, and run in Viceroy; not yet on a live service. A first deployment should check:

- **Request Routing** ([Routing](#a-request-routing-recommended)): how a rule's path value matches (a prefix such as `/_sid/`, wildcards), whether a VCL service can be the default with a Compute service for the path, what `event.client.address`, `event.client.geo` and the `Host` are in the routed service, and whether the API, CLI or Terraform can set it up. If the routed service sees a Fastly address rather than the visitor's, Request Routing has the same problem as service chaining.
- **Service chaining**: exactly what `client.address` and `Host` are in the chained Compute service; a trusted-upstream mode for it isn't built.
- **Geolocation conventions** in production: placeholders for unknown values (`?`, `0`, `0,0`), whether `region` ever carries the country prefix, `continent`'s format and the case of `city`. The mapping follows Fastly's reference and what Viceroy returns.
- **Request cookies over HTTP/2**, where a browser may send several `cookie` fields: Fastly doesn't document how it merges them for `event.request.headers.get('cookie')`.
- **Config store reads:** whether the limit of 32 dictionary lookups per request applies to config stores (the service reads 19 keys), and how long an entry change takes to propagate.
- **CPU time** on Fastly's own hosts (measured only in Viceroy) and the start-up cost of the 16 MB package.
- **Reusable sandboxes** on a live service: how often Fastly hands a waiting sandbox the next request, so how much of the [measured saving](#reusable-sandboxes-experimental) is real; whether its own limits recycle sandboxes before the defaults do; and whether a sandbox that ends waiting for a request (the SDK exits with status 1 then, as in Viceroy) shows up as an error in the service's stats or logs.
- **The deployment commands** (`fastly service create`, `config-store`, `resource-link`, `compute pack`, `compute deploy`) follow the CLI reference; they haven't been run against an account here.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `500` `SharedID Edge is misconfigured` on every request | No config store linked as `sharedid_config` (the link's name, not the store's), `SID_COOKIE_DOMAIN` missing, an invalid setting, or `SID_MODULE_SECRETS` in the config store. The service's log names the setting ([log tailing](https://www.fastly.com/documentation/guides/compute/developer-guides/testing/#log-tailing): `fastly log-tail`). |
| `500` `Internal error` | An unexpected failure; the log names only the error's type. Try the package in Viceroy with the same settings. |
| Your site's page, or its 404, for `/_sid/*` | The routing rule doesn't match the path: check the rule's path value and `SID_BASE_PATH` ([Routing](#routing)). |
| The service's `404` (`text/plain`) for a SharedID path | The request reached the service but isn't under `SID_BASE_PATH`: the rule and the setting disagree. |
| `ortb2.device.ip` is a Fastly address, and no `geo` | The service sees another Fastly service's request, not the visitor's: a chained setup ([service chaining](#b-service-chaining-from-your-vcl-service)). |
| No `geo`, or EU visitors still get cookies without a TC string | `event.client.geo` is `null` for the address, or the address isn't the visitor's (see above). Send `gdpr=1` from the page where GDPR applies. |
| Cookies without `Secure` | The request URL isn't `https://` on your domain: a chained service overriding the `Host` to an internal name. Set `SID_PUBLIC_ORIGIN=https://www.example.com`. |
| `ec` reports an error | No secret store linked as `sharedid_secrets`, no `SID_MODULE_SECRETS` key in it, or `ec` not built in (`--module`, [Build](#build)). |
| `npm run wasm` fails installing the SDK | It runs `npm ci` in `toolchain/`; check network access to the npm registry (and, for weval's binary, GitHub), then run it again. |
| `npm run conformance:fastly`: "isn't an address of this machine" | The case's client IP must be a local address ([Testing](#testing-without-a-fastly-account)); on Linux, add the local routes. |

## Fastly documentation

- [JavaScript on Compute](https://www.fastly.com/documentation/guides/compute/developer-guides/javascript/), [reference](https://js-compute-reference-docs.edgecompute.app/docs/), [`@fastly/js-compute` changelog](https://github.com/fastly/js-compute-runtime/blob/main/CHANGELOG.md)
- [Compute resource limits](https://docs.fastly.com/products/compute-resource-limits)
- [Config stores](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-config-stores/), [secret stores](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-secret-stores/)
- [Request Routing](https://www.fastly.com/documentation/guides/getting-started/domains/working-with-domains/configuring-routing-rules/), [service chaining](https://www.fastly.com/documentation/guides/concepts/service-chaining/)
- [`fastly.toml`](https://www.fastly.com/documentation/reference/compute/fastly-toml/), [Viceroy](https://github.com/fastly/Viceroy), [testing Compute locally](https://www.fastly.com/documentation/guides/compute/developer-guides/testing/)
- [Fastly CLI](https://www.fastly.com/documentation/reference/tools/cli/)
