# Development

```text
spec/                          the specification: SPEC.md, and modules/<name>.md for each module
conformance/                   HTTP cases every implementation must pass, and their runner
docs/                          the topic docs linked from the README
packages/
  core/                        the platform-neutral handler, consent, cookies and module interface
  adapters/                    deployable platform packages, one folder per platform; rules for all of them in AGENTS.md
  modules/                     modules maintained by this project, built into every adapter (opt-in ones aside)
    all/                       @sharedid-edge/modules: the built-in list the adapters import
  vendor-modules/              modules contributed and maintained by vendors, opt-in at build time
e2e/                           unmodified Prebid.js against the worker, in Chromium, Firefox, WebKit and real Safari
  sgtm/                        SharedID Edge beside Google's sGTM image (docker compose), the sGTM integration's tests
website/                       sharedid.dev: this Markdown, published with VitePress
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
- `npm run test:snippet -w @sharedid-edge/cloudflare`: the Cloudflare Snippet against the Worker. The Snippet is the one build that validates its settings when it's built and ships them parsed, without the validators (to fit 32 KB); every other build validates them at run time. This builds Snippets for the conformance cases' configurations and others, checks each answers exactly as the Worker with the same settings, and that invalid settings fail the Snippet build with the Worker's message. See the [Cloudflare adapter's `AGENTS.md`](../packages/adapters/cloudflare/AGENTS.md).
- `npm run conformance`: the conformance suite against the Node.js server; `npm run conformance:wrangler` runs it against the Worker under `wrangler dev`, `npm run conformance:lambda` against the bundled Lambda handler behind a local stand-in for CloudFront, `npm run conformance:lambda-aws-emulator` against it deployed to [AWS Emulator](https://github.com/aws/aws-emulator) (which must be running; see the [Lambda adapter's README](../packages/adapters/aws-lambda/README.md#on-aws-emulator)), `npm run conformance:vercel` against the bundled Vercel adapter behind a local stand-in for Vercel's proxy, `npm run conformance:azure` against the bundled Azure Functions app behind a local stand-in for Front Door and the Functions host, `npm run conformance:gcp` against the real Functions Framework serving the bundled Cloud Run function, behind a local stand-in for Google Cloud's load balancer, `npm run conformance:akamai` against the bundled EdgeWorker in a V8 context of its own, behind a local stand-in for Akamai EdgeWorkers, and `npm run conformance:fastly` against the compiled Fastly Compute package in [Viceroy](https://github.com/fastly/Viceroy), Fastly's local runtime (it needs the Viceroy binary; see the [Fastly adapter's README](../packages/adapters/fastly/README.md#testing-without-a-fastly-account)). See [`conformance/AGENTS.md`](../conformance/AGENTS.md).
- In `e2e/`: `npm ci && npx playwright install && npm test` runs unmodified Prebid.js against the worker in three browsers. On a Mac, `npm run test:safari` runs the core tests in real Safari through `safaridriver`, as CI's `e2e-safari` job does on a macOS runner; it needs remote automation enabled and an `/etc/hosts` entry (see [Real Safari](../e2e/AGENTS.md#real-safari)).
- In `e2e/sgtm/`: the server-side GTM integration's tests, against Google's real tagging server image in a docker compose stack beside SharedID Edge's Node.js server. They need Docker and a Tag Manager server container with the committed export imported, so they're not in `npm test`: `npm run test:sgtm` in `e2e/`, with the stack up. CI's `e2e-chromium` job checks the container export and the compose file; [`e2e-sgtm.yml`](../.github/workflows/e2e-sgtm.yml) runs the tests from `main` once the `SGTM_CONTAINER_CONFIG` secret is set. See [`e2e/sgtm/README.md`](../e2e/sgtm/README.md).

None of this needs a Cloudflare, AWS, Vercel, Azure, Google Cloud, Akamai or Fastly account. Separately, four live-test workflows deploy to this project's own accounts after every merge to `main` and nightly, never from a pull request, and run `verify-deployment`, conformance and the browser tests against the deployment: [Cloudflare](../packages/adapters/cloudflare/README.md#live-tests), on the `sharedid.dev` test zone; [AWS](../packages/adapters/aws-lambda/README.md#live-tests), a Lambda function behind a real CloudFront distribution, which also checks the headers CloudFront passes (`scripts/check-cloudfront.ts`); and the [upstream operator and Cloudflare for SaaS](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-saas-workflow) (`e2e-upstream.yml`), an upstream operator's endpoint behind publishers on Cloudflare and CloudFront, and custom hostnames of a SaaS zone, which also checks forged headers, direct calls to the endpoint and unlisted hostnames (`scripts/check-live-site.ts`); and [Vercel](../packages/adapters/vercel/README.md#live-tests) (`e2e-vercel.yml`), the Next.js example on two projects' `*.vercel.app` hostnames, which also checks that Vercel replaces forged client IP and `x-vercel-ip-*` headers (`check-live-site`). With the AWS role, each also requests its sites from a function in Frankfurt, the [EU visitor](../packages/adapters/aws-lambda/README.md#the-eu-visitor), for GDPR decided by a real visitor's location (`scripts/check-eu-visitor.ts`). All four run on every merge; the AWS and upstream-operator ones first ran green on 17 November 2026. The Vercel workflow skips until the `VERCEL_TOKEN` secret and the `VERCEL_ORG_ID` and `VERCEL_SCOPE` variables are set; the repository isn't connected to Vercel, so it's the only thing that deploys there. The upstream-operator workflow's CloudFront publisher reuses the AWS workflow's role, with a second policy and the `PUBLISHER_ROUTE53_ZONE_ID` variable ([setting it up](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-saas-workflow)). None of them runs on pull requests, by design: a pull request's code would run with the deploy credentials ([#154](https://github.com/patmmccann/sharedid-edge/issues/154)).

[How SharedID Edge is verified](verification.md) says, for every deployment, which of these covers it (live, emulated, simulated, or only the vendor's documentation), what each proves, and where to inspect the results. A pull request that changes how something is verified updates it.

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
  "forwards": ["*.fps.goog"],         // a forwarding module's hosts, as in its code; its README starts with the disclosure box
  "optIn": true,                       // project modules only: not built in; added at build time like a vendor module
  "export": "exampleModule",           // vendor and opt-in modules only, required: the module's export, for <package>#<export>
  "network": "none",                   // vendor modules only, required: "none", or the hosts it may reach
  "buildCredentials": ["EXAMPLE_LICENSE_KEY"], // vendor modules only: env variables its build reads (never shipped)
  "ipDerived": true                    // vendor modules (and ec) only, if its ID uses the IP or other request data
}

// an adapter
"sharedidEdge": {
  "kind": "adapter",
  "platform": "Cloudflare Workers",
  "summary": "Where it runs, in one line (Markdown)."
}
```

`@sharedid-edge/modules` (`packages/modules/all`), the built-in list, is `{ "kind": "module-list" }`. A project module also needs its specification in `spec/modules/<name>.md`.

## The website

[sharedid.dev](https://sharedid.dev) is this repository's Markdown, published as it is with [VitePress](https://vitepress.dev): the root README, `docs/`, `spec/`, and every adapter's and module's README. Nothing is copied. `website/.vitepress/config.mts` lists the published files and their URLs, and builds the sidebar from the same `package.json` metadata as the generated tables, so a new adapter or module appears there without an edit: project modules under **Core modules**, those in `packages/vendor-modules/` under **Vendor modules**, and their specifications in the same two groups under **Specification** (as in the spec's generated module list). AGENTS.md files and the rest of the repository aren't published.

- **Write links for GitHub,** as relative links between files. The site turns a link to a published page into a site URL, and any other link (a source file, an AGENTS.md, a folder without a README) into a link to the file on GitHub.
- **A dead link fails the build,** and so does a link to a heading that isn't there (`website/check-anchors.mjs`). Headings get GitHub's anchors, so `#modules-on-_sidsync` works on both. The `website` job in CI builds the site on every pull request, without an account.
- **VitePress upgrades:** the site pins a VitePress 2 prerelease to use a patched Vite. Update it deliberately and run `npm ci && npm run build` in `website/` to check pages and heading links. Inline code stays literal, including `{{…}}` examples; Vue components such as the adoption chart live in the theme.
- **Renaming or moving a page** changes its URL: add the old URL to `REDIRECTS` in `website/.vitepress/config.mts`, which writes them to the build's `_redirects` so the old URL answers with a 301 to the new one.
- **Locally:** `cd website && npm ci && npm run dev` serves it with live reload (on `localhost:5173`). `npm run build && npm run preview` serves the production build.
- **The adoption chart** on the home page (`website/.vitepress/theme/AdoptionChart.vue`) shows SharedID's share of Prebid.js User ID module detections from [OpenSincera](https://open.sincera.io)'s `mapping_modules`. `adoption.data.ts` fetches the numbers at build time with the `SINCERA_API_KEY` repository secret, which only the deploy job has, and puts only the counts in the page. Pull requests and local builds use `website/adoption-snapshot.json`, as does a deploy whose request fails. Update the snapshot now and then so previews stay close.
- **Deploying:** [`website.yml`](../.github/workflows/website.yml) builds and deploys it on every merge to `main` and weekly (refreshing the chart's numbers), as a static-assets Worker (`website/wrangler.jsonc`) on the `sharedid.dev/*` route, with the same Cloudflare secrets as the [live tests](../packages/adapters/cloudflare/README.md#live-tests).

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

Publish it as its own package like [`packages/modules/ip`](../packages/modules/ip), add it to `builtInModules` in [`packages/modules/all`](../packages/modules/all/README.md) (every adapter imports that list), and enable it with `SID_MODULES=continent`. A module that only maintains cookies can also run on `/_sid/sync` with `routes: ['v1', 'sync']`; there only its cookies are used. Modules make no network calls (a [forwarding module](../packages/modules/AGENTS.md#forwarding-modules) passes requests on to its declared hosts through core), and a module that throws or runs past its time limit is left out without affecting the rest of the response. See [`packages/modules/AGENTS.md`](../packages/modules/AGENTS.md). A module from a vendor goes in [`packages/vendor-modules/`](../packages/vendor-modules/README.md) instead, and isn't built in.

Its docs are its own: a `README.md` (with its response examples), `spec/modules/<name>.md`, and the `sharedidEdge` block. Then run `node scripts/docs.mjs --write`; don't edit the root README.

### Opt-in project modules

Some modules the project maintains shouldn't make every build bigger: they serve fewer deployments, or carry more code than their use justifies by default. Such a module lives in `packages/modules/<name>` like the others, with `"optIn": true` and its `"export"` in the `sharedidEdge` block, and **isn't** in `builtInModules`. A deployer adds it at build time as `<package>#<export>`, exactly as an [`ec` or vendor module](../packages/vendor-modules/README.md) (`--module @sharedid-edge/module-cmp#cmpModule`), then lists it in `SID_MODULES`. The Cloudflare Snippet bundles only the modules `SID_MODULES` names, so a Snippet can bundle one without the opt-in step (add it to the Snippet build's `MODULES`). [`cmp`](../packages/modules/cmp/README.md) is one.

- Everything else is a project module's: its tests run in `npm test`, its specification is in `spec/modules/<name>.md`, and it follows [`packages/modules/AGENTS.md`](../packages/modules/AGENTS.md).
- `node scripts/docs.mjs` checks the built-in list (`packages/modules/all/src/index.ts`) imports every project module but the opt-in ones, and marks the opt-in ones "opt-in build" in the [module index](modules.md#module-index).
- The conformance suite's opt-in build (case files with `"build": ["vendor-modules"]`, `--vendor-modules`) adds the opt-in project modules along with the vendor modules, so their case files use that build.

## Adding an adapter

An adapter is a new folder in `packages/adapters/`, with its own `package.json` (and `sharedidEdge` block), `tsconfig.json`, `README.md` (including the deployment walkthrough), `AGENTS.md` and `test/`, and a conformance target. See [`packages/adapters/AGENTS.md`](../packages/adapters/AGENTS.md). Run `node scripts/check-projects.mjs --write` and `node scripts/docs.mjs --write`: the platform table in the root README picks it up.

## Roadmap

1. **Done:** specification, conformance suite, the cookie-only worker on Cloudflare, a Node.js server, AWS Lambda (regional, and Lambda@Edge), Vercel, Azure Functions and Google Cloud adapters, and the `ip`, `ec`, `geo`, `reflect`, `bot` and `ua` modules, with a shared traffic signal any module can report bots to.
2. **Next:** Prebid.js sending its consent strings (TCF, GPP) to the worker with the sync, so consent no longer depends on the CMP cookie.
3. A Prebid.js RTD module that reads `/_sid/v1`, plus a device type module (`ua`, which also reports declared crawlers to the traffic signal), IP intelligence modules, and a Fastly adapter.
4. Vendor modules, a Rust implementation, and inline mode.
