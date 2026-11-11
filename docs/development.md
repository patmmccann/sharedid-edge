# Development

```text
spec/                          the specification: SPEC.md, and modules/<name>.md for each module
conformance/                   HTTP cases every implementation must pass, and their runner
docs/                          the topic docs linked from the README
packages/
  core/                        the platform-neutral handler, consent, cookies and module interface
  adapters/                    deployable platform packages, one folder per platform; rules for all of them in AGENTS.md
  modules/                     modules maintained by this project, built into every adapter
    all/                       @sharedid-edge/modules: the built-in list the adapters import
  vendor-modules/              modules contributed and maintained by vendors, opt-in at build time
e2e/                           unmodified Prebid.js against the worker, in Chromium, Firefox and WebKit
scripts/                       verify-deployment, the type checks, the repo checks below, and the docs generator
```

The adapters are listed under [Pick your platform](../README.md#pick-your-platform) and the modules in the [module index](modules.md#module-index). Each package has its own `README.md` and `AGENTS.md`. Workspaces, `tsc -b` references and the TypeScript 7 check are derived from these folders, so a new package needs no list edits beyond `node scripts/check-projects.mjs --write`.

## Checks

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
- `npm run check:docs`: the [generated sections](#generated-docs) of the docs are up to date.
- `npm run check:duplication`: no code copied between packages ([jscpd](https://github.com/kucherenko/jscpd)); it lists each clone with its file and line pairs, and writes a report to `.jscpd-report/`. See [Duplication](../AGENTS.md#duplication) for what to do when it fails.

Tests:

- `npm test`: unit tests, including the Worker's tests inside workerd, the Workers runtime. Vendor modules' tests run separately, with `npm run test:vendor-modules`.
- `npm run conformance`: the conformance suite against the Node.js server; `npm run conformance:wrangler` runs it against the Worker under `wrangler dev`, `npm run conformance:lambda` against the bundled Lambda handler behind a local stand-in for CloudFront, `npm run conformance:vercel` against the bundled Vercel adapter behind a local stand-in for Vercel's proxy, `npm run conformance:azure` against the bundled Azure Functions app behind a local stand-in for Front Door and the Functions host, and `npm run conformance:gcp` against the real Functions Framework serving the bundled Cloud Run function, behind a local stand-in for Google Cloud's load balancer. See [`conformance/AGENTS.md`](../conformance/AGENTS.md).
- In `e2e/`: `npm ci && npx playwright install && npm test` runs unmodified Prebid.js against the worker in three browsers.

None of this needs a Cloudflare, AWS, Vercel, Azure or Google Cloud account. Separately, the [Live tests](../packages/adapters/cloudflare/README.md#live-tests) workflow deploys to this project's Cloudflare test zone nightly, from `main` only, and runs `verify-deployment`, conformance and the browser tests against it.

## Generated docs

The lists that every new module or adapter would otherwise edit are generated, so pull requests don't collide on them. `node scripts/docs.mjs --write` rewrites the text between `<!-- generated:<name>:start -->` and `<!-- generated:<name>:end -->` markers, and `npm run check:docs` fails when it's out of date:

| Section | In | From |
| --- | --- | --- |
| `platforms`, `modules` | [README.md](../README.md) | adapters' and modules' `package.json` |
| `module-index` | [docs/modules.md](modules.md#module-index) | modules' `package.json` |
| `settings` | [docs/configuration.md](configuration.md) | `SETTINGS` in [`packages/core/src/config.ts`](../packages/core/src/config.ts) |
| `spec-modules` | [spec/SPEC.md](../spec/SPEC.md#module-specifications) | the files in [`spec/modules/`](../spec/modules) |
| `packages` | [AGENTS.md](../AGENTS.md#layout) | adapters' and modules' `package.json` |

Don't edit between the markers; change the source and run the generator.

### Package metadata

Every package in `packages/adapters/` and `packages/modules/` (and `packages/vendor-modules/`) has a `sharedidEdge` block in its `package.json`:

```jsonc
// a module
"sharedidEdge": {
  "kind": "module",
  "name": "geo",                       // the name in SID_MODULES; the same as the folder
  "title": "the visitor's location as device.geo",
  "summary": "What it adds to the payload, in one line (Markdown).",
  "settings": "`precision`: `precise` (default) or `coarse`",   // a short list, or "none"
  "routes": ["v1"],                    // the module's routes: "v1", and "sync" if it runs there
  "forwards": ["api.example.com"]      // vendor modules only, if it sends data to another service
}

// an adapter
"sharedidEdge": {
  "kind": "adapter",
  "platform": "Cloudflare Workers",
  "summary": "Where it runs, in one line (Markdown)."
}
```

`@sharedid-edge/modules` (`packages/modules/all`), the built-in list, is `{ "kind": "module-list" }`. A project module also needs its specification in `spec/modules/<name>.md`.

## Adding a module

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

Publish it as its own package like [`packages/modules/ip`](../packages/modules/ip), add it to `builtInModules` in [`packages/modules/all`](../packages/modules/all/README.md) (every adapter imports that list), and enable it with `SID_MODULES=continent`. A module that only maintains cookies can also run on `/_sid/sync` with `routes: ['v1', 'sync']`; there only its cookies are used. Modules make no network calls, and a module that throws or runs past its time limit is left out without affecting the rest of the response. See [`packages/modules/AGENTS.md`](../packages/modules/AGENTS.md). A module from a vendor goes in [`packages/vendor-modules/`](../packages/vendor-modules/README.md) instead, and isn't built in.

Its docs are its own: a `README.md` (with its response examples), `spec/modules/<name>.md`, and the `sharedidEdge` block. Then run `node scripts/docs.mjs --write`; don't edit the root README.

## Adding an adapter

An adapter is a new folder in `packages/adapters/`, with its own `package.json` (and `sharedidEdge` block), `tsconfig.json`, `README.md` (including the deployment walkthrough), `AGENTS.md` and `test/`, and a conformance target. See [`packages/adapters/AGENTS.md`](../packages/adapters/AGENTS.md). Run `node scripts/check-projects.mjs --write` and `node scripts/docs.mjs --write`: the platform table in the root README picks it up.

## Roadmap

1. **Done:** specification, conformance suite, the cookie-only worker on Cloudflare, a Node.js server, AWS Lambda, Vercel, Azure Functions and Google Cloud adapters, and the `ip`, `ec`, `geo`, `reflect`, `bot` and `ua` modules, with a shared traffic signal any module can report bots to.
2. **Next:** Prebid.js sending its consent strings (TCF, GPP) to the worker with the sync, so consent no longer depends on the CMP cookie.
3. A Prebid.js RTD module that reads `/_sid/v1`, plus a device type module (`ua`, which also reports declared crawlers to the traffic signal), IP intelligence modules, a Fastly adapter, and Lambda@Edge.
4. Vendor modules, a Rust implementation, and inline mode.
