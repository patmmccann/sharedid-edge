# packages/vendor-modules

Modules contributed and maintained by vendors: IP intelligence databases (#12), bot detection (#5), device databases (#11) and the like. Each is its own package folder here (`<vendor>/`, published as `@sharedid-edge/module-<vendor>`) with a `package.json`, `tsconfig.json`, `README.md`, `AGENTS.md` and `test/`. Everything in [`../modules/AGENTS.md`](../modules/AGENTS.md) applies; these rules come on top. How to contribute one is in [README.md](README.md).

- **Not built in.** Vendor modules are never in `builtInModules`. A deployer opts in at build time by adding the module to the list they pass to the handler, then lists it in `SID_MODULES`. Don't add one to an adapter.
- **Declare `gvlid`** when the vendor is on the IAB Global Vendor List, or say in the README why the module acts for the publisher instead. Core doesn't run modules with a `gvlid` when GDPR applies until vendor consent is decoded.
- **Network calls only under the vendor plugin rules** in prebid/prebid-server#5064: opt-in per deployment, a strict timeout, and cached results. Data updates (databases, lists) happen only in scheduled jobs (#30), never while answering a request. Core has no network wrapper yet, so the lint config blocks `fetch` here until it does.
- **No licensed data in the repo.** Databases and lists the vendor licenses are fetched by the deployer's build or scheduled job with their own credentials; the repo holds only code and small test fixtures you may publish.
- **Secrets only through `SID_MODULE_SECRETS`** (`context.secrets`): never in `SID_MODULE_CONFIG`, code, fixtures, logs, output or error messages.
- **Bot and proxy verdicts** go through the shared traffic signal (#5) once it exists, not a field of the module's own, so core and other modules can act on them.
- **A named maintainer** for the folder in [`.github/CODEOWNERS`](../../.github/CODEOWNERS), who reviews changes to it and answers its issues. A module without an active maintainer can be removed.
- **Docs to the module README standard** ([`../modules/AGENTS.md`](../modules/AGENTS.md#docs)), plus where the data comes from, what the deployer needs (an account, a licence, a scheduled job), and its link in the main README's module table, marked as a vendor module.
- **Lint:** [`eslint.config.js`](eslint.config.js) adds rules to the root config for code here: no `console`, no `fetch` or other network globals (until the wrapper above exists), no Node.js built-ins (modules are platform-neutral), no `eval`.
- **CI:** types and lint run in the main `checks` job with everything else. Tests run in the separate `vendor-modules` job (`npm run test:vendor-modules`, one line per vendor), which branch protection can leave not required, so one vendor's failing tests don't block other changes. Test the module through core's `createHandler`, as project modules do. The conformance suite runs adapters with the built-in modules, so it doesn't cover vendor modules yet.

## Forwarding requests or data

A module that forwards anything (requests, IDs, the IP address, signals) to its own or another service must be:

- **Configurable:** off by default, enabled per deployment by an explicit setting that lists the destination hosts. Never an open proxy.
- **Disclosed prominently:** a clearly marked box at the **top** of the module's README stating what is sent, to which host, when, and under which consent conditions. Its row in the main README's module table carries a visible marker such as "⚠ forwards data to `<host>`". `ext.modules.<name>` should be able to report that forwarding happened, with no data values.
- **Co-located when possible:** preferably only to services on the same platform and network as the worker: a service bound to the Worker (a Cloudflare service binding), a container on the same host or VPC, or server-side GTM behind the same load balancer. Forwarding over the public internet to a distant third party is the exception, and the README must justify it.
- **Still subject to the privacy lines:** no forwarding when GPC, COPPA, opt-out or consent rule it out.
