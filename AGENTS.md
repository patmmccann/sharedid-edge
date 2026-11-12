# Agent guidelines

SharedID Edge keeps the Prebid SharedID cookie durable by setting it from an edge worker on the publisher's own domain. Read [README.md](README.md) for what it does and [spec/SPEC.md](spec/SPEC.md) for the exact behaviour. Folders with their own `AGENTS.md` add rules for that folder; read it, and those of its parent folders, before changing files there.

## Layout

| Folder | What | Notes |
| --- | --- | --- |
| `spec/` | The specification: `SPEC.md`, and `modules/<name>.md` per module | Behaviour changes start here. |
| `docs/` | Topic docs for publishers (Prebid.js, responses, configuration, consent, modules, migrating, troubleshooting, development) | Linked from [README.md](README.md). |
| `conformance/` | HTTP cases and their runner | The contract; every implementation must pass. |
| `packages/core/` | Platform-neutral handler, consent, cookies, module interface | Published as `@sharedid-edge/core`. Depends on no module. |
| `packages/ip-ranges/` | IP range tables, the MMDB reader and the country module that IP database vendor modules share | Published as `@sharedid-edge/ip-ranges`. Not a module; see its [`AGENTS.md`](packages/ip-ranges/AGENTS.md). |
| `packages/adapters/` | Deployable platform packages, one folder per platform (listed below) | Rules for every adapter in [`packages/adapters/AGENTS.md`](packages/adapters/AGENTS.md). Each is a conformance target. |
| `packages/modules/` | Modules this project maintains, one folder per module (listed below), and `all/` (`@sharedid-edge/modules`, the built-in list) | Rules and how to write a module in [`packages/modules/AGENTS.md`](packages/modules/AGENTS.md). Published as `@sharedid-edge/module-<name>`; built into every adapter. |
| `packages/vendor-modules/` | Modules contributed and maintained by vendors (listed below) | Extra rules in [`packages/vendor-modules/AGENTS.md`](packages/vendor-modules/AGENTS.md). Opt-in at build time; tested in their own CI job. |
| `e2e/` | Unmodified Prebid.js against the worker in three browsers | Separate install. |
| `website/` | [sharedid.dev](https://sharedid.dev): the Markdown above, published with VitePress | Separate install. See [The website](docs/development.md#the-website). |
| `scripts/` | Type-check helpers, the repo checks (`check-projects`, `check-links`), the docs generator (`docs.mjs`), the bundled adapters' build and size budget (`bundle-adapter.mjs`), the vendor-module checks (`no-network.mjs`, `check-build-secrets.mjs`) and `verify-deployment` | `projects.mjs` derives the project list from the workspace folders. |

The packages, generated from their `package.json` by `node scripts/docs.mjs --write`:

<!-- generated:packages:start -->
- **Adapters** (`packages/adapters/`): [`akamai/`](packages/adapters/akamai/README.md): Akamai EdgeWorkers; [`aws-lambda/`](packages/adapters/aws-lambda/README.md): AWS (Lambda and CloudFront); [`azure-functions/`](packages/adapters/azure-functions/README.md): Azure (Functions and Front Door); [`cloudflare/`](packages/adapters/cloudflare/README.md): Cloudflare Workers; [`fastly/`](packages/adapters/fastly/README.md): Fastly Compute; [`gcp-functions/`](packages/adapters/gcp-functions/README.md): Google Cloud (Cloud Run functions and Load Balancing); [`node/`](packages/adapters/node/README.md): Node.js (self-hosted); [`vercel/`](packages/adapters/vercel/README.md): Vercel.
- **Modules** (`packages/modules/`): [`bot/`](packages/modules/bot/README.md): bot and staff-traffic signals; [`clickid/`](packages/modules/clickid/README.md): keep ad click IDs from the landing page; [`geo/`](packages/modules/geo/README.md): the visitor's location as `device.geo`; [`ip/`](packages/modules/ip/README.md): the real client IP; [`reflect/`](packages/modules/reflect/README.md): keep other first-party cookies durable; [`ua/`](packages/modules/ua/README.md): device data and the bot flag; and [`all/`](packages/modules/all/README.md): the built-in list.
- **Vendor modules** (`packages/vendor-modules/`): [`dbip/`](packages/vendor-modules/dbip/README.md): DB-IP Lite country; [`ec/`](packages/vendor-modules/ec/README.md): Trusted Server Edge Cookies; [`maxmind/`](packages/vendor-modules/maxmind/README.md): MaxMind GeoLite2 country.
<!-- generated:packages:end -->

## TypeScript is strict, everywhere

- Every project extends [`tsconfig.base.json`](tsconfig.base.json): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`/`Parameters`, `verbatimModuleSyntax`, `isolatedDeclarations` (published packages) and `skipLibCheck: false`. **Don't relax these, per file or per project.** The only exception is `skipLibCheck` in `packages/adapters/cloudflare/test`, for Vitest's own declarations; don't spread it.
- No `any`, no `as any`, no non-null assertions (`!`), no `@ts-ignore`. Use `@ts-expect-error` only in type tests, with a reason. Narrow `unknown` with type guards; cast only where a guard has already checked the shape, and say why.
- Exported functions and constants have explicit types (`isolatedDeclarations` enforces it for published packages).
- Tests are type-checked too: each package's `test/` folder is its own project in the `tsc -b` build.
- Lint is `typescript-eslint`'s `strictTypeChecked` and `stylisticTypeChecked`, plus `strict-boolean-expressions` and `switch-exhaustiveness-check`: compare strings with `=== ''`, don't rely on truthiness.

## Checks

Run before every commit; CI runs all of them:

```sh
npm run build                                   # tsc -b: every project, sources and tests
npm run lint                                    # after the build: typed lint reads the packages' built declarations
npm run typecheck:ts7                           # the same with TypeScript 7
npm run typecheck:cloudflare                    # the Worker against the Workers runtime types
npm run types:check -w @sharedid-edge/cloudflare # worker-configuration.d.ts matches wrangler.jsonc
npm test                                        # unit tests; the Worker's run inside workerd
npm run conformance                             # conformance suite against the Node.js server
npm run consumer-types                          # packed @sharedid-edge/core, strict consumers, each module resolution
npm run attw                                    # published types resolve
npm run check:projects                          # tsconfig.json references every workspace project
npm run check:links                             # relative Markdown links and anchors resolve
npm run check:docs                              # generated doc sections are up to date (node scripts/docs.mjs --write)
npm run check:duplication                       # no code copied between packages (jscpd)
npm run conformance:lambda-aws-emulator         # Lambda bundles on AWS Emulator; start the emulator first (not in check)
npm run conformance:fastly                      # the Fastly Compute package in Viceroy; needs the Viceroy binary (not in check)
```

`npm run check` runs them in order. `npm run test:vendor-modules` runs vendor modules' tests, in their own CI job. `npm run conformance:wrangler` runs the conformance suite against `wrangler dev` (slower), `npm run conformance:lambda`, `npm run conformance:vercel`, `npm run conformance:azure`, `npm run conformance:gcp` and `npm run conformance:akamai` (all also in `check`) against the bundled Lambda handler, Vercel adapter, Azure Functions app, Cloud Run function and Akamai EdgeWorker, behind local stand-ins for their platforms. `npm run conformance:lambda-aws-emulator` (not in `check`, since it needs [AWS Emulator](https://github.com/aws/aws-emulator) running locally, and the AWS CLI; a CI job that isn't required yet) deploys the Lambda bundles to the emulator and runs the suite through its function URL; see the [Lambda adapter's README](packages/adapters/aws-lambda/README.md#on-aws-emulator). `npm run conformance:fastly` (not in `check`, since it needs the [Viceroy](https://github.com/fastly/Viceroy) binary and installs Fastly's JavaScript SDK, about 500 MB, outside the workspace; its own CI job) compiles the Fastly Compute package and runs the suite against it in Viceroy, Fastly's local runtime; `check` builds and size-checks its JavaScript bundle. See the [Fastly adapter's README](packages/adapters/fastly/README.md#testing-without-a-fastly-account). `e2e/` has the browser tests. None of this needs a Cloudflare, AWS, Vercel, Azure, Google Cloud, Akamai or Fastly account (AWS Emulator needs none); never add steps that do to pull-request CI. The one workflow that uses an account, [`e2e-cloudflare.yml`](.github/workflows/e2e-cloudflare.yml) ([Live tests](packages/adapters/cloudflare/README.md#live-tests)), runs only from `main`: on every merge, nightly and on demand.

TypeScript 6.0 is the main compiler because `typescript-eslint` doesn't support 7 yet; `typecheck:ts7` keeps the code working on 7. Call TypeScript 7 as `node node_modules/typescript7/bin/tsc`, since both packages install a `tsc` command.

## Documentation is part of the change

Every pull request that adds or changes something users touch ships its documentation in the same PR. Reviewers should treat missing docs as a blocking gap.

- **Every package has its own `README.md`** (also its npm page). This covers modules, adapters and platform packages alike.
  - **A module's README** covers: turning it on, the response shape with JSON examples (when it returns data, and when it doesn't), consent rules, settings and secrets, and troubleshooting. **Per-module response examples live here,** not in `docs/responses.md`. Models: `packages/modules/ip/README.md` and `packages/vendor-modules/ec/README.md`. Vendor modules add the disclosures in [`packages/vendor-modules/AGENTS.md`](packages/vendor-modules/AGENTS.md).
  - **An adapter's README** covers: architecture, build, the deployment walkthrough (prerequisites to verifying, working without reading anything else), configuration and secrets, how platform data maps to `PlatformInfo`, verifying, and troubleshooting.
- **Where each kind of doc goes:**

  | Doc | Where |
  | --- | --- |
  | What SharedID Edge is, how it works, the platform table, the Prebid.js snippet, the docs index | The root [README.md](README.md). Keep it short: no per-module or per-adapter prose. |
  | Deploying on a platform | That adapter's `README.md` |
  | A module: settings, responses, consent, troubleshooting | That module's `README.md` |
  | Configuring Prebid.js | [`docs/prebid.md`](docs/prebid.md) |
  | Core responses (`/sync`, `/v1`, opt-out, the debugging headers) | [`docs/responses.md`](docs/responses.md) |
  | Core settings | `SETTINGS` in [`packages/core/src/config.ts`](packages/core/src/config.ts); [`docs/configuration.md`](docs/configuration.md) is generated from it |
  | Consent, modules in general, migrating, troubleshooting, development | [`docs/consent.md`](docs/consent.md), [`docs/modules.md`](docs/modules.md), [`docs/migrating.md`](docs/migrating.md), [`docs/troubleshooting.md`](docs/troubleshooting.md), [`docs/development.md`](docs/development.md) |
  | Core behaviour | [spec/SPEC.md](spec/SPEC.md) |
  | A module's behaviour | `spec/modules/<name>.md` |

- **Indexes are generated:** the root README's platform table and module list, the module index in `docs/modules.md`, the settings table in `docs/configuration.md`, the spec's module list and the package list in this file sit between `<!-- generated:<name>:start -->` and `<!-- generated:<name>:end -->` markers. Don't edit them by hand: change the source (a `package.json`'s `sharedidEdge` block, `SETTINGS`, or a file in `spec/modules/`) and run `node scripts/docs.mjs --write`. `npm run check:docs` fails when they're out of date. See [Generated docs](docs/development.md#generated-docs).
- **A new module or adapter adds its own folder,** with a `sharedidEdge` block in its `package.json` ([Package metadata](docs/development.md#package-metadata)), its README, and for a project module `spec/modules/<name>.md`. It doesn't edit the root README or shared tables; the generator lists it.
- **Update the core docs** when core behaviour changes: [`docs/responses.md`](docs/responses.md) whenever the shape of a core response changes, with real output, and `SETTINGS` for a new or changed setting.
- **Update [spec/SPEC.md](spec/SPEC.md) (or `spec/modules/<name>.md`) and the folder's `AGENTS.md`** for behaviour and conventions.
- **Write docs for publishers and their engineers:** what to set, what they'll see, and why. Don't write internal notes.

## Changing behaviour

1. Update [spec/SPEC.md](spec/SPEC.md).
2. Add or change conformance cases in `conformance/cases/` (see [conformance/AGENTS.md](conformance/AGENTS.md)).
3. Implement in `packages/core`, with unit tests.
4. Update the docs: the package's own README.md, the topic doc in [`docs/`](docs) (configuration, responses, consent, modules), and folder AGENTS.md files. See [Documentation is part of the change](#documentation-is-part-of-the-change).

Behaviour that must not regress, each covered by tests:

- An existing valid ID is never replaced; the `HttpOnly` recovery copy restores a re-minted one.
- The worker answers only its own routes and never forwards requests to the origin.
- Opt-out, Global Privacy Control, COPPA and denied consent delete existing ID cookies and set none.
- The SharedID is random, and nothing about requests is logged. Core and the project's own modules derive no ID from the IP address or other request data. IP-derived IDs are for vendor modules, maintained by their vendors under [the vendor rules](packages/vendor-modules/AGENTS.md#ip-derived-ids): opt-in, declared (`ipDerived` in their `sharedidEdge` block) and disclosed. The `ec` module (`packages/vendor-modules/ec`) is one, maintained by the project: IAB Tech Lab's open-source Trusted Server Edge Cookies, ported here as specified, whose ID prefix is an HMAC of the client IP. Don't add IP-derived IDs to core or a project module, and never make one the default.
- `Access-Control-Allow-Origin` is never `*`.

## Conventions

- ESM only, Node.js 24 or later. Platform-neutral code uses only web-standard APIs (`Request`, `Response`, `URL`, `crypto.randomUUID`).
- Keep the worker small: no runtime dependencies in `@sharedid-edge/core`. Check `npm run build -w @sharedid-edge/cloudflare` (a dry-run bundle) for size when adding code.
- Errors returned to clients never include request data.
- **Don't copy code between packages;** factor it into core, a shared package or a conformance helper. If a copy is deliberate, mark it with a jscpd ignore comment and say why. See [Duplication](#duplication).
- Commit messages: an imperative summary line, then why. Pull requests describe the motivation and the checks run.
- This is a public repository: don't reference private repositories, internal tools or non-public deployments in code, comments, commits or PRs.

## Duplication

Copies drift: a fix, such as a security fix, lands in one and not the others. `npm run check:duplication` runs [jscpd](https://github.com/kucherenko/jscpd) with [`.jscpd.json`](.jscpd.json) over `packages/` (sources and build scripts), `conformance/src/` and `scripts/`, leaving out tests, generated files, the Vercel example and vendor modules (independent packages by design). It lists every clone of at least 5 lines and 40 tokens with its file and line pairs, writes a Markdown and HTML report to `.jscpd-report/` (uploaded by CI when the check fails), and fails when duplication is over `threshold`, a percentage of lines. The threshold is `0`: there are no clones today, so any new one fails.

When it fails, factor the code into the right place:

- platform-neutral helpers into core: internal, or exported when adapters or modules need them (adapter plumbing goes in `packages/core/src/adapter.ts`);
- shared build steps into `scripts/` (the bundled adapters use `scripts/bundle-adapter.mjs`);
- emulator plumbing into `conformance/src/emulator.ts`.

If a copy is deliberate (a standalone file that mustn't import, or a module avoiding a dependency), wrap it in `// jscpd:ignore-start` and `// jscpd:ignore-end` with a one-line reason on the start comment.

Don't raise `threshold`, `minTokens` or `minLines` to get a pull request through. Raise the threshold only when a clone is accepted on purpose and an ignore comment doesn't fit (it spans files a comment can't mark, say): set it just above the new measured value, say why in the pull request, and open an issue to remove the copy.
