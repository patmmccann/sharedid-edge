# Agent guidelines

SharedID Edge keeps the Prebid SharedID cookie durable by setting it from an edge worker on the publisher's own domain. Read [README.md](README.md) for what it does and [spec/SPEC.md](spec/SPEC.md) for the exact behaviour. Folders with their own `AGENTS.md` add rules for that folder; read it, and those of its parent folders, before changing files there.

## Layout

| Folder | What | Notes |
| --- | --- | --- |
| `spec/` | The specification | Behaviour changes start here. |
| `conformance/` | HTTP cases and their runner | The contract; every implementation must pass. |
| `packages/core/` | Platform-neutral handler, consent, cookies, module interface | Published as `@sharedid-edge/core`. Depends on no module. |
| `packages/adapters/` | Deployable platform packages: `cloudflare/` (the Worker), `node/` (Node.js server), `aws-lambda/` (Lambda behind CloudFront, its bundle and SAM template), `vercel/` (a Next.js route handler or Routing Middleware on the site's Vercel project, its bundle and a Next.js example) | Rules for every adapter in [`packages/adapters/AGENTS.md`](packages/adapters/AGENTS.md). Each is a conformance target. |
| `packages/modules/` | Modules this project maintains: `ip/` (client IP), `ec/` (Trusted Server Edge Cookies, IP-derived, opt-in), `geo/` (`ortb2.device.geo`), `reflect/` (re-sets other first-party cookies), `bot/` (bot and staff-traffic signals), and `all/` (`@sharedid-edge/modules`, the built-in list) | Rules and how to write a module in [`packages/modules/AGENTS.md`](packages/modules/AGENTS.md). Published as `@sharedid-edge/module-<name>`; built into every adapter. |
| `packages/vendor-modules/` | Modules contributed and maintained by vendors (none yet) | Extra rules in [`packages/vendor-modules/AGENTS.md`](packages/vendor-modules/AGENTS.md). Opt-in at build time; tested in their own CI job. |
| `e2e/` | Unmodified Prebid.js against the worker in three browsers | Separate install. |
| `scripts/` | Type-check helpers, the repo checks (`check-projects`, `check-links`) and `verify-deployment` | `projects.mjs` derives the project list from the workspace folders. |

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
```

`npm run check` runs them in order. `npm run test:vendor-modules` runs vendor modules' tests, in their own CI job. `npm run conformance:wrangler` runs the conformance suite against `wrangler dev` (slower), `npm run conformance:lambda` and `npm run conformance:vercel` (both also in `check`) against the bundled Lambda handler and Vercel adapter, behind local stand-ins for their platforms, and `e2e/` has the browser tests. None of this needs a Cloudflare, AWS or Vercel account; never add steps that do to pull-request CI.

TypeScript 6.0 is the main compiler because `typescript-eslint` doesn't support 7 yet; `typecheck:ts7` keeps the code working on 7. Call TypeScript 7 as `node node_modules/typescript7/bin/tsc`, since both packages install a `tsc` command.

## Documentation is part of the change

Every pull request that adds or changes something users touch ships its documentation in the same PR. Reviewers should treat missing docs as a blocking gap.

- **Every package has its own `README.md`** (also its npm page). This covers modules, adapters and platform packages alike.
  - **A module's README** covers: turning it on, the response shape with JSON examples (when it returns data, and when it doesn't), consent rules, settings and secrets, and troubleshooting. Models: `packages/modules/ip/README.md` and `packages/modules/ec/README.md`. Vendor modules add the disclosures in [`packages/vendor-modules/AGENTS.md`](packages/vendor-modules/AGENTS.md).
  - **An adapter's README** covers: architecture, build, deploy, configuration and secrets, how platform data maps to `PlatformInfo`, verifying, and troubleshooting.
- **Link it from the main [README.md](README.md):**
  - modules in the built-in modules table and the Modules section;
  - adapters as a self-contained quick start under a "Deploy on …" section.
- **Update the [README.md](README.md) "Responses" section** whenever the shape of a response changes, with real output.
- **Update [spec/SPEC.md](spec/SPEC.md) and the folder's `AGENTS.md`** for behaviour and conventions.
- **Write docs for publishers and their engineers:** what to set, what they'll see, and why. Don't write internal notes.

## Changing behaviour

1. Update [spec/SPEC.md](spec/SPEC.md).
2. Add or change conformance cases in `conformance/cases/` (see [conformance/AGENTS.md](conformance/AGENTS.md)).
3. Implement in `packages/core`, with unit tests.
4. Update the docs: the package's own README.md, [README.md](README.md) (configuration, Responses, Modules), and folder AGENTS.md files. See [Documentation is part of the change](#documentation-is-part-of-the-change).

Behaviour that must not regress, each covered by tests:

- An existing valid ID is never replaced; the `HttpOnly` recovery copy restores a re-minted one.
- The worker answers only its own routes and never forwards requests to the origin.
- Opt-out, Global Privacy Control, COPPA and denied consent delete existing ID cookies and set none.
- The SharedID is random; nothing is derived from the IP address or other request data, and nothing about requests is logged. The one exception is the opt-in `ec` module (`packages/modules/ec`), which implements Trusted Server Edge Cookies as specified: its ID prefix is an HMAC of the client IP. Don't add other IP-derived IDs, and don't make `ec` the default.
- `Access-Control-Allow-Origin` is never `*`.

## Conventions

- ESM only, Node.js 24 or later. Platform-neutral code uses only web-standard APIs (`Request`, `Response`, `URL`, `crypto.randomUUID`).
- Keep the worker small: no runtime dependencies in `@sharedid-edge/core`. Check `npm run build -w @sharedid-edge/cloudflare` (a dry-run bundle) for size when adding code.
- Errors returned to clients never include request data.
- Commit messages: an imperative summary line, then why. Pull requests describe the motivation and the checks run.
- This is a public repository: don't reference private repositories, internal tools or non-public deployments in code, comments, commits or PRs.
