# Agent guidelines

SharedID Edge keeps the Prebid SharedID cookie durable by setting it from an edge worker on the publisher's own domain. Read [README.md](README.md) for what it does and [spec/SPEC.md](spec/SPEC.md) for the exact behaviour. Folders with their own `AGENTS.md` add rules for that folder; read it before changing files there.

## Layout

| Folder | What | Notes |
| --- | --- | --- |
| `spec/` | The specification | Behaviour changes start here. |
| `conformance/` | HTTP cases and their runner | The contract; every implementation must pass. |
| `packages/core/` | Platform-neutral handler, consent, cookies, module interface | Published as `@sharedid-edge/core`. |
| `packages/cloudflare/` | The Cloudflare Worker | |
| `packages/module-ip/` | The `ip` module: client IP in `ortb2.device` | Published as `@sharedid-edge/module-ip`; the pattern for module packages. |
| `packages/node/` | Node.js server | Local development, self-hosting, conformance target. |
| `e2e/` | Unmodified Prebid.js against the worker in three browsers | Separate install. |
| `scripts/` | Type-check helpers and `verify-deployment` | |

## TypeScript is strict, everywhere

- Every project extends [`tsconfig.base.json`](tsconfig.base.json): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`/`Parameters`, `verbatimModuleSyntax`, `isolatedDeclarations` (published packages) and `skipLibCheck: false`. **Don't relax these, per file or per project.** The only exception is `skipLibCheck` in `packages/cloudflare/test`, for Vitest's own declarations; don't spread it.
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
```

`npm run check` runs them in order. `npm run conformance:wrangler` runs the conformance suite against `wrangler dev` (slower), and `e2e/` has the browser tests. None of this needs a Cloudflare account; never add steps that do to pull-request CI.

TypeScript 6.0 is the main compiler because `typescript-eslint` doesn't support 7 yet; `typecheck:ts7` keeps the code working on 7. Call TypeScript 7 as `node node_modules/typescript7/bin/tsc`, since both packages install a `tsc` command.

## Changing behaviour

1. Update [spec/SPEC.md](spec/SPEC.md).
2. Add or change conformance cases in `conformance/cases/` (see [conformance/AGENTS.md](conformance/AGENTS.md)).
3. Implement in `packages/core`, with unit tests.
4. Update [README.md](README.md) where it affects deploying or configuring.

Behaviour that must not regress, each covered by tests:

- An existing valid ID is never replaced; the `HttpOnly` recovery copy restores a re-minted one.
- The worker answers only its own routes and never forwards requests to the origin.
- Opt-out, Global Privacy Control and denied consent delete existing ID cookies and set none.
- IDs are random; nothing is derived from the IP address or other request data, and nothing about requests is logged.
- `Access-Control-Allow-Origin` is never `*`.

## Conventions

- ESM only, Node.js 22 or later. Platform-neutral code uses only web-standard APIs (`Request`, `Response`, `URL`, `crypto.randomUUID`).
- Keep the worker small: no runtime dependencies in `@sharedid-edge/core`. Check `npm run build -w @sharedid-edge/cloudflare` (a dry-run bundle) for size when adding code.
- Errors returned to clients never include request data.
- Commit messages: an imperative summary line, then why. Pull requests describe the motivation and the checks run.
- This is a public repository: don't reference private repositories, internal tools or non-public deployments in code, comments, commits or PRs.
