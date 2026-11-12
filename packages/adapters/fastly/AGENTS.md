# packages/adapters/fastly

The Fastly Compute adapter (`@sharedid-edge/fastly`): a Compute service, written with Fastly's JavaScript SDK (`@fastly/js-compute`), that answers the base path on the domain that serves the site. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter. Fastly VCL can't run this code; the Node.js server behind a VCL service is the other option on Fastly.

- `src/fastly.ts`: minimal structural types for `event.client` (`ClientInfo`), its geolocation and the `FetchEvent`. Don't add Fastly's type package; the platform's objects must stay assignable.
- `src/platform.ts`: `PlatformInfo` from `event.client` only: the address through core's `parseIp`, and `client.geo` through `locationWithEU`, dropping Fastly's placeholders for unknown values (`?`, `**`, a `0` metro code, `0,0`) and upper-casing postal codes. Never a request header.
- `src/handler.ts`: `createFastlyHandler`, `(request, client)` to core's handler with `PlatformInfo`, and `SID_PUBLIC_ORIGIN` through core's `withPublicOrigin`. Compute hands over a web `Request` and takes a web `Response`, so there's no conversion. It never throws: anything that fails is a generic 500 through `logRequestFailure`.
- `src/env.ts`: settings from the config store linked as `sharedid_config` (one key per name in core's `SETTING_NAMES`), `SID_MODULE_SECRETS` from the secret store linked as `sharedid_secrets` (optional), read per request because stores can't be read during build-time initialization; the handler is rebuilt only when they change (core's `cachedByEnv`, shared with Akamai). A missing config store, invalid settings, or `SID_MODULE_SECRETS` in the config store give the misconfigured 500. The stores are passed in (`Stores`), so the module imports nothing from `fastly:*` and is unit-tested in Node.js.
- `src/main.ts`: the deployed entry point. Calls `enforceExplicitBackends()` at the top level, opens the stores, and registers the `fetch` listener; `respondWith` is called synchronously with a promise that never rejects. Its top level runs at build time (Wizer), so it must not read stores, geolocation or `fastly:env` there.
- `src/builtins.d.ts`: types for the `fastly:*` modules `main.ts` imports.
- `scripts/bundle.mjs`: esbuild bundle to `deploy/main.js` with `fastly:*` external, alone in `deploy/`, with the size budget; it fails if the bundle imports anything but `fastly:*`.
- `scripts/wasm.mjs`: compiles `deploy*/main.js` to `main.wasm` with the SDK pinned in `toolchain/package.json` (exact version, with its own lockfile), installing it there with `npm ci` when it's missing or another version. Reports the size and fails above Fastly's 100 MB package limit.
- `toolchain/`: the SDK's separate install (about 500 MB with Wizer, weval and Wasmtime). Not a workspace package; keep it out of the root install. Upgrade the SDK deliberately: change the exact version, regenerate the lockfile (`npm install` in `toolchain/`), and run `npm run conformance:fastly`.
- `fastly.toml`: the package manifest, and `[local_server]` stand-ins for a local run in Viceroy. Nothing in it reaches a deployed service.

Rules:

- **`package.json`'s `sideEffects` must list the entry point** (`./dist/main.js`, `./deploy*/main.js`). The SDK bundles `deploy/main.js` again with its own esbuild, from inside this package; with `"sideEffects": false` it drops the entry's top level, the `fetch` listener included, and every request fails with a bare exit status 1.
- **Every `Set-Cookie` stays its own header:** return core's `Response` as it is.
- **Trust only Fastly's own data** for the client IP and location (`event.client`), never `Fastly-Client-IP` or `X-Forwarded-For`, which a Compute service gets as the visitor sent them. A trusted-upstream mode for service chaining would be an explicit, off-by-default setting.
- **No forwarding.** The adapter never calls `fetch`, has no backends, and calls `enforceExplicitBackends()`.
- **No caching.** Every response keeps core's `Cache-Control` (`no-store` or `private`); `conformance/src/fastly-checks.ts` checks it.
- **Conformance** without a Fastly account: `npm run conformance:fastly` compiles the packages and runs the suite against them in a pinned Viceroy through `conformance/src/fastly-viceroy.ts` (the cases' client IPs as real source addresses, their locations as Viceroy geolocation entries), then `fastly-checks.ts`. It isn't in `npm run check` (it needs the Viceroy binary and the SDK install); the `conformance-fastly` CI job runs it on Linux. `check` builds and size-checks the bundle.
- **Tests** (`test/fastly.test.ts`) use recorded-style `event.client` objects from `test/clients.ts`, including what Viceroy returns. Cover IPv4 and IPv6 clients when the client IP matters.
- Facts about Fastly in the README cite Fastly's documentation; what the documentation doesn't say, notably how Request Routing behaves, is listed under "What isn't confirmed" rather than assumed.
