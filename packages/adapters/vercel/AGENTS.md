# packages/adapters/vercel

The Vercel adapter (`@sharedid-edge/vercel`), for a `/_sid/*` route of the site's own Vercel project: a Next.js route handler (primary) or Routing Middleware. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

- `src/handler.ts`: `createVercelHandler` (a web-standard `Request` to `Response` handler) and `createVercelMiddleware` (the same, `undefined` outside the base path). Keep it a thin adapter; behaviour belongs in core.
- `src/platform.ts`: `PlatformInfo` from `x-real-ip`/`x-forwarded-for` and the `x-vercel-ip-*` headers, through core's `locationInfo`, `isEU` from core's `EU_COUNTRY_CODES`.
- `src/env.ts`: `handlerFromEnv` and `middlewareFromEnv`; configuration from `process.env` once per instance, a `ConfigError` gives a 500 handler.
- `src/bundle.ts` and `scripts/bundle.mjs`: the single-file bundle sites copy, `deploy/sharedid-edge.mjs`, with standalone declarations (`src/bundle.ts` spells out its types, so its `.d.ts` has no imports), built for a neutral platform with its size budget.
- `example/`: a minimal Next.js site, outside the workspace build and lint (its own `package.json`; Next.js is a large install). Keep `example/.env.example` listing every `SID_*` setting (a unit test checks).

Rules:

- **Web-standard only.** The package compiles against `ES2023` and `WebWorker` like core, with no Node types, so it runs on Vercel's Node.js and Edge runtimes alike; the bundle is built with no Node.js built-ins.
- **Trust Vercel's headers only on Vercel** (`behindVercel`, default `true`; `SID_BEHIND_VERCEL=false` elsewhere, which ignores them all). The client IP is `x-real-ip`, then the first `x-forwarded-for` entry; both are set by Vercel's proxy. Never read other client-supplied headers.
- **Every `Set-Cookie` stays separate:** the `Response` goes back to the platform as it is.
- **The route folder is `%5Fsid`:** `_sid` is a private folder in the App Router and isn't routed.
- Published like core: ESM, `isolatedDeclarations`, attw-clean (`npm run attw`).
- **Conformance** without a Vercel account: `npm run conformance:vercel` runs the suite against the bundle through `conformance/src/vercel-emulator.ts`. Vercel has no metro code header, so the target lists `ortb2.device.geo.metro` as unavailable.
- **Tests** (`test/vercel.test.ts`) use Vercel-shaped requests from `test/requests.ts`. Cover IPv4 and IPv6 clients when the client IP matters.
