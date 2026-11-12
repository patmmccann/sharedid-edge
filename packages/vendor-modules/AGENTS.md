# packages/vendor-modules

Modules contributed and maintained by vendors: IP intelligence databases (#12), bot detection (#5), device databases (#11) and the like. Each is its own package folder here (`<vendor>/`, published as `@sharedid-edge/module-<vendor>`) with a `package.json`, `tsconfig.json`, `README.md`, `AGENTS.md` and `test/`. Everything in [`../modules/AGENTS.md`](../modules/AGENTS.md) applies; these rules come on top. How to contribute one is in [README.md](README.md).

- **Not built in.** Vendor modules are never in `builtInModules`. A deployer opts in at build time by adding the module to the list they pass to the handler, then lists it in `SID_MODULES`. Don't add one to an adapter.
- **Declare `gvlid`** when the vendor is on the IAB Global Vendor List, or say in the README why the module acts for the publisher instead. Core doesn't run modules with a `gvlid` when GDPR applies until vendor consent is decoded.
- **Declare `network`** in the `sharedidEdge` block: `"none"` (an offline module, the default to aim for) or the hosts it may reach. `npm run test:vendor-modules` enforces it: see [Offline modules and build-time credentials](#offline-modules-and-build-time-credentials).
- **Network calls only under the vendor plugin rules** in prebid/prebid-server#5064: opt-in per deployment, a strict timeout, and cached results. Data updates (databases, lists) happen only in scheduled jobs (#30), never while answering a request. Core has no network wrapper yet, so the lint config blocks `fetch` here until it does.
- **Blocked domains don't rule a vendor out.** A vendor whose domains browsers block (for example, Safari 27's blocklist of identity providers) may still contribute a vendor module. The usual rules apply: `network` declarations, the forwarding disclosure and consent.
- **IP-derived IDs are allowed here,** and only here: see [IP-derived IDs](#ip-derived-ids). `ec` is here for that reason.
- **Declare `export`** in the `sharedidEdge` block: the module's export name (`ecModule`), so deployers can add it as `<package>#<export>` and the conformance suite can build it in.
- **No licensed data in the repo.** Databases and lists the vendor licenses are fetched by the deployer's build or scheduled job with their own credentials (a licence key named in `buildCredentials`); the repo holds only code and small test fixtures you may publish. IP databases share [`@sharedid-edge/ip-ranges`](../ip-ranges/README.md) (an MMDB reader, a compact range table, the country module): use it rather than writing another.
- **Read-only context, nothing kept between requests,** as for every module ([`../modules/AGENTS.md`](../modules/AGENTS.md)): `context.config` and `context.secrets` are frozen all the way down (a write throws and the module reports `error`), and no request data may outlive the request.
- **Secrets only through `SID_MODULE_SECRETS`** (`context.secrets`): never in `SID_MODULE_CONFIG`, code, fixtures, logs, output or error messages. A build-time credential (`buildCredentials`) is for the build only and never ships in the bundle.
- **Bot and proxy verdicts** go through the shared traffic signal (#5) once it exists, not a field of the module's own, so core and other modules can act on them.
- **A named maintainer** for the folder in [`.github/CODEOWNERS`](../../.github/CODEOWNERS), who reviews changes to it and answers its issues: the vendor, or a project maintainer for a port of an open standard (`ec`). A module without an active maintainer can be removed.
- **Docs to the module README standard** ([`../modules/AGENTS.md`](../modules/AGENTS.md#docs)), plus where the data comes from, what the deployer needs (an account, a licence, a scheduled job), and a `sharedidEdge` block in its `package.json`, which lists it in the generated [module index](../../docs/modules.md#module-index), marked as a vendor module.
- **Lint:** [`eslint.config.js`](eslint.config.js) adds rules to the root config for code here: no `console`, no `fetch` or other network globals (until the wrapper above exists), no Node.js built-ins (modules are platform-neutral), no `eval`. A module's build script (`<vendor>/scripts/*.mjs`) runs on Node.js at build time and may download the vendor's data with `fetch`. Lint is a first filter; the network check in the tests is what holds.
- **CI:** types and lint run in the main `checks` job with everything else. Tests run in the separate `vendor-modules` job (`npm run test:vendor-modules`, one line per vendor, with the network checked against `network`), which branch protection can leave not required, so one vendor's failing tests don't block other changes. Test the module through core's `createHandler`, as project modules do. A case file with `"build": ["vendor-modules"]` runs against every target with all the vendor modules added (`conformance/cases/module-ec.json` does): add one for a module whose behaviour is part of the contract.

## Offline modules and build-time credentials

Device and IP databases (51Degrees, WURFL, IP intelligence) work best **offline**: the data is built into the bundle, the module answers from memory, and nothing about the visitor leaves the edge. That's the model this folder is built around.

- **A licence key is a build-time credential.** If the vendor's data needs a key to download, the module's build reads it from an environment variable (`FIFTYONE_DEGREES_LICENSE_KEY`, say), fetches the data, and builds it into the module's output. List the variable in `buildCredentials` in the `sharedidEdge` block, and document it in the README. The key is never needed at runtime and never ships: a Worker's code is readable by everyone on the account, and a Snippet's by anyone who can see the zone's rules.
- **The key check.** `node scripts/check-build-secrets.mjs <bundle>` fails when a bundle contains the value of any `buildCredentials` variable set in the environment, as is or base64-, base64url-, hex- or URI-encoded, without printing it. The bundled adapters run it on every build (`checkBudget` in `scripts/bundle-adapter.mjs`); run it on anything else you deploy.
- **`network: "none"` is checked, not trusted.** `npm run test:vendor-modules` runs each module's tests with [`scripts/no-network.mjs`](../../scripts/no-network.mjs) preloaded. It blocks and records every attempt to reach a host the module didn't declare: `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, DNS, and TCP or TLS connections (so `node:http` and `node:https` too). Loopback is allowed, for a local mock of an API. A run with an attempt fails, even when the module catches the error and its tests pass. So **tests must exercise the module's real code paths**, data loading included: tests that skip the code that would call out prove nothing.
- **Declared hosts** (`network: ["api.vendor.example"]`) are allowed in tests, marked "⚠ network" in the module index, and still follow the vendor plugin rules above (opt-in, a strict timeout, caching). Every host in `forwards` must also be in `network`.
- **Size guidance is part of the README.** Deployers have a size target to fit: a Worker's limits (Cloudflare's [limits page](https://developers.cloudflare.com/workers/platform/limits/), as of November 2026: "Worker size (uncompressed): 64 MiB" on both Workers Free and Paid, "There is no compressed size limit", a startup time of 1 second for the global scope, and 128 MB of memory per isolate; older limits of 3 MB on Free and 10 MB on Paid, compressed, no longer apply), Lambda's, or their own budget. So the README has a **Size** section with what the module adds to a bundle, minified and gzipped, measured with this repo's build:
  - for each build option or property set the deployer can choose (all properties, the ones a typical setup needs, the smallest useful set), so they can trade data for size;
  - with how to measure it themselves (the build command, and the bundle the adapter's size check reports);
  - and the memory it needs at runtime, if the data is unpacked or indexed when the module loads.

  A full device or IP database won't fit a Worker; build in only the properties the module returns. The project's [32 KB gzipped budget](../adapters/AGENTS.md) is for the default bundles: a deployer's build with a vendor module answers to their platform's limit, which is why they need these numbers.
- **Not for Cloudflare Snippets.** Snippets allow 32 KB of code, 2 MB of memory and 5 ms of execution time. Vendor data won't fit in 32 KB with core. A **network** vendor module can never work there:
  - its request waits on a round trip to the vendor, which on its own almost always takes longer than 5 ms. Cloudflare doesn't say whether the limit counts waiting time, and if it does, every request fails;
  - Snippets allow 2 to 5 subrequests by plan;
  - Snippets have no secrets for an API key.

  The Snippet build only bundles the project's modules. Vendor modules are for Workers and the other adapters.

## Forwarding requests or data

A module that forwards anything (requests, IDs, the IP address, signals) to its own or another service must be:

- **Configurable:** off by default, enabled per deployment by an explicit setting that lists the destination hosts. Never an open proxy.
- **Disclosed prominently:** a clearly marked box at the **top** of the module's README stating what is sent, to which host, when, and under which consent conditions. Its `sharedidEdge` block lists the hosts in `forwards`, so its row in the generated module index carries the marker "⚠ forwards data to `<host>`". `ext.modules.<name>` should be able to report that forwarding happened, with no data values.
- **Co-located when possible:** preferably only to services on the same platform and network as the worker: a service bound to the Worker (a Cloudflare service binding), a container on the same host or VPC, or server-side GTM behind the same load balancer. Forwarding over the public internet to a distant third party is the exception, and the README must justify it.
- **Still subject to the privacy lines:** no forwarding when GPC, COPPA, opt-out or consent rule it out.

## IP-derived IDs

Core and the project's modules never derive an ID from the IP address or other request data; the SharedID is random. A vendor module may, because that's often how the vendor's product works, and the vendor maintains it and answers for it. The project's `ec` module is held to the same rules: it ports IAB Tech Lab's open-source Trusted Server Edge Cookies, whose ID prefix is an HMAC of the client IP. A module whose ID uses the IP address, or anything else from the request (headers, the User-Agent, location), in whole or part:

- **Declares it:** `"ipDerived": true` in its `sharedidEdge` block, so its row in the generated module index carries "⚠ IP-derived ID".
- **Is opt-in:** it runs only when the deployer lists it in `SID_MODULES`, and never becomes the default.
- **Is disclosed** in a clearly marked box at the **top** of its README: what the ID is derived from, who behind the same address shares it, and who can link it back (anyone with the key, say). The `ec` README's box is the model.
- **Keeps the SharedID random:** it sets its own cookie or payload field, and never changes `_pubcid`.
- **Still answers to the privacy lines:** no ID when GPC, COPPA, opt-out or consent rule it out, and an existing one is deleted. Declare `gvlid` so TCF vendor consent applies.
- **Logs nothing** about the request, and never returns the IP address itself.
