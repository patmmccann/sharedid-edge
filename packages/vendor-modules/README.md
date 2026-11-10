# Vendor modules

This folder is for [SharedID Edge](../../README.md) modules contributed and maintained by vendors: IP intelligence databases, bot detection, device databases and other data a publisher licenses from a third party. The project's own modules (`ip`, `ec`, `geo`, `reflect`) are in [`../modules/`](../modules/AGENTS.md) and are built into every adapter; vendor modules aren't.

There are no vendor modules yet. The rules below are in full in [AGENTS.md](AGENTS.md).

## For publishers: using a vendor module

Vendor modules are **opt-in at build time**. Add the module to the list your build passes to the handler, then turn it on with `SID_MODULES`:

```ts
import { builtInModules } from '@sharedid-edge/modules';
import { exampleModule } from '@sharedid-edge/module-example';

const modules = [...builtInModules, exampleModule];
```

Each vendor module's README says what it needs (usually an account or licence with the vendor, and a scheduled job that refreshes its data) and what it sends back.

## For vendors: contributing a module

1. **Open an issue first** describing the data, where it comes from, what the module returns, and whether it makes network calls or forwards anything.
2. **Add a package folder** here, `packages/vendor-modules/<vendor>/`, published as `@sharedid-edge/module-<vendor>`. Copy the shape of a project module such as [`../modules/ip`](../modules/ip/README.md): `package.json`, `tsconfig.json` (extending `../../../tsconfig.base.json` and referencing `../../core`), `src/`, `test/`, `README.md` and `AGENTS.md`. The workspace glob picks it up; run `npm install`, then `node scripts/check-projects.mjs --write` to add it to the `tsc -b` build.
3. **Follow the rules** in [AGENTS.md](AGENTS.md). In short:
   - declare your IAB `gvlid`, or explain why the module acts for the publisher;
   - network calls only under the vendor plugin rules in prebid/prebid-server#5064 (opt-in, a strict timeout, caching), and data updates only in scheduled jobs, never during requests;
   - no licensed data in the repository;
   - secrets only through `SID_MODULE_SECRETS`;
   - bot and proxy verdicts through the shared traffic signal;
   - core's privacy lines apply: GPC, COPPA, opt-out and consent.
4. **Forwarding** requests or data to any service is off by default, enabled per deployment with an explicit list of destination hosts, preferably to a service on the same platform and network, and **disclosed at the top of your README** in a clearly marked box: what is sent, to which host, when, and under which consent conditions. See [Forwarding requests or data](AGENTS.md#forwarding-requests-or-data).
5. **Name a maintainer** for your folder in [`.github/CODEOWNERS`](../../.github/CODEOWNERS). You review changes to your module and answer its issues.
6. **Document it** to the project's module README standard (turning it on, the response with JSON examples when it returns data and when it doesn't, consent rules, settings and secrets, troubleshooting), and add a row to the main README's module table, marked as a vendor module.

## Checks

Your code is linted with the root rules plus [`eslint.config.js`](eslint.config.js) (no `console`, no network globals, no Node.js built-ins) and type-checked with everything else in the main CI job. Your tests run in the separate `vendor-modules` job, one line per vendor, so a failure in one module doesn't block changes elsewhere. Run them locally with:

```sh
npm run build
npm run lint
npm run test:vendor-modules
```
