# Vendor modules

This folder is for [SharedID Edge](../../README.md) modules contributed and maintained by vendors: IP intelligence databases, bot detection, device databases and other data a publisher licenses from a third party. The project's own modules (`ip`, `geo`, `reflect`, `bot`, `ua`) are in [`../modules/`](../modules/AGENTS.md) and are built into every adapter; vendor modules aren't. The rules below are in full in [AGENTS.md](AGENTS.md).

One module here is maintained by the project rather than a vendor: [`ec`](ec/README.md), IAB Tech Lab's Trusted Server Edge Cookies, ported. It's here because its ID is derived from the visitor's IP address, which the project's own modules never do.

## For publishers: using a vendor module

Vendor modules are **opt-in at build time**: add the module to your build, then turn it on with `SID_MODULES` (and its settings and secrets, as its README says). A module is named as `<package>#<export>`, which its README gives, like `@sharedid-edge/module-ec#ecModule`.

| Platform | Add it |
| --- | --- |
| AWS Lambda, Vercel, Azure Functions, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module <package>#<export>` (repeat `--module` for more), in place of `npm run bundle`. The bundle's size is reported, but the project's 32 KB budget isn't enforced: your platform's limit is what counts. |
| Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module <package>#<export>`, then `npx wrangler deploy .sharedid-modules/worker.ts` in place of `npm run deploy`. |
| Cloudflare Snippet | Not supported: Snippets have 32 KB, 5 ms and no secrets ([AGENTS.md](AGENTS.md#offline-modules-and-build-time-credentials)). |
| Node.js server | `SID_MODULE_PACKAGES=<package>#<export>` (comma-separated for more), with the package installed next to the server. |
| Your own code | Pass the list yourself: `[...builtInModules, exampleModule]`, to `createHandler` or an adapter's `handlerFromEnv(env, modules)`. |

A module listed in `SID_MODULES` but not added is reported as `skipped` (`not installed`) in `ext.modules`, and does nothing.

Each vendor module's README says what it needs (usually an account or licence with the vendor, and a scheduled job that refreshes its data) and what it sends back. The [module index](../../docs/modules.md#module-index) marks each one **offline** (no network calls, checked in CI) or lists the hosts it reaches, and names any licence key its build needs. Set that key in your build's environment: it never ends up in the deployed code, and the bundled adapters' builds fail if it does.

## For vendors: contributing a module

1. **Open an issue first** describing the data, where it comes from, what the module returns, and whether it makes network calls or forwards anything. Offline modules, with the data built in at build time, are the model: see [Offline modules and build-time credentials](AGENTS.md#offline-modules-and-build-time-credentials).
2. **Add a package folder** here, `packages/vendor-modules/<vendor>/`, published as `@sharedid-edge/module-<vendor>`. Copy the shape of a project module such as [`../modules/ip`](../modules/ip/README.md): `package.json`, `tsconfig.json` (extending `../../../tsconfig.base.json` and referencing `../../core`), `src/`, `test/`, `README.md` and `AGENTS.md`. The workspace glob picks it up; run `npm install`, then `node scripts/check-projects.mjs --write` to add it to the `tsc -b` build.
3. **Follow the rules** in [AGENTS.md](AGENTS.md). In short:
   - declare your IAB `gvlid`, or explain why the module acts for the publisher;
   - network calls only under the vendor plugin rules in prebid/prebid-server#5064 (opt-in, a strict timeout, caching), and data updates only in scheduled jobs, never during requests;
   - declare `network`: `"none"` or the hosts you reach; your tests run with the network blocked outside that list, and any attempt fails them;
   - no licensed data in the repository: a licence key is a build-time credential (`buildCredentials`), used to fetch data at build time and never shipped;
   - secrets only through `SID_MODULE_SECRETS`;
   - bot and proxy verdicts through the shared traffic signal;
   - an ID derived from the IP address or other request data is allowed in a vendor module, opt-in, declared with `ipDerived` and disclosed at the top of your README ([IP-derived IDs](AGENTS.md#ip-derived-ids));
   - core's privacy lines apply: GPC, COPPA, opt-out and consent.
4. **Forwarding** requests or data to any service is off by default, enabled per deployment with an explicit list of destination hosts, preferably to a service on the same platform and network, and **disclosed at the top of your README** in a clearly marked box: what is sent, to which host, when, and under which consent conditions. See [Forwarding requests or data](AGENTS.md#forwarding-requests-or-data).
5. **Name a maintainer** for your folder in [`.github/CODEOWNERS`](../../.github/CODEOWNERS). You review changes to your module and answer its issues.
6. **Document it** to the project's module README standard (turning it on, the response with JSON examples when it returns data and when it doesn't, consent rules, settings and secrets, troubleshooting), plus a **Size** section: what your module adds to a bundle, minified and gzipped, for each property set or build option a deployer can choose, so they can fit their platform's limit ([details](AGENTS.md#offline-modules-and-build-time-credentials)). Vendor modules don't run in Cloudflare Snippets, and network ones never can (5 ms, 32 KB, no secrets). and add a `sharedidEdge` block to its `package.json` (see [Development](../../docs/development.md#package-metadata)): the [module index](../../docs/modules.md#module-index) is generated from it, and marks vendor modules.

## Checks

Your code is linted with the root rules plus [`eslint.config.js`](eslint.config.js) (no `console`, no network globals, no Node.js built-ins) and type-checked with everything else in the main CI job. Your tests run in the separate `vendor-modules` job, one line per vendor, so a failure in one module doesn't block changes elsewhere, with the network blocked outside what your `network` declares: any attempt fails the run, even if your code catches the error. Run them locally with:

```sh
npm run build
npm run lint
npm run test:vendor-modules
```
