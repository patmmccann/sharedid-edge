# @sharedid-edge/vercel

[SharedID Edge](../../../README.md) on Vercel: a `/_sid/*` route of the Vercel project that serves your site, as a Next.js route handler or as Routing Middleware. It's the same platform-neutral handler as the Cloudflare Worker, the Node.js server and the Lambda function, with built-in modules `ip`, `ec`, `geo` and `reflect`, and it passes the same conformance suite.

The main README has a [quick start](../../../README.md#deploy-on-vercel). This is the full guide.

## Contents

- [Architecture](#architecture)
- [Route handler or middleware](#route-handler-or-middleware)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy with a Next.js route handler](#deploy-with-a-nextjs-route-handler)
- [Deploy with middleware](#deploy-with-middleware)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Verify](#verify)
- [Platform information](#platform-information)
- [Using it in code](#using-it-in-code)
- [The example](#the-example)
- [Testing without a Vercel account](#testing-without-a-vercel-account)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
Vercel's CDN and proxy, your project's domain (www.example.com)
   │  sets x-real-ip, x-forwarded-for and the x-vercel-ip-* geolocation headers,
   │  replacing any the visitor sent
   ├─ /_sid/*  → app/%5Fsid/[...path]/route.ts (Node.js 24 or Edge runtime) or Routing Middleware
   │               Request → SharedID Edge handler → Response, each Set-Cookie separate
   └─ *        → the rest of your site, unchanged
```

- **On your site's own deployment and hostname.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A route of the Vercel project that serves `www.example.com` answers from the same addresses as your pages. A separate Vercel project on another hostname (`sid.example.com`, or a `*.vercel.app` URL) doesn't, and Safari would cap its cookies. **Add the route to the project that serves your pages.**
- **Never cached.** The handler sends `Cache-Control: no-store` or `private` on every response, so Vercel's CDN doesn't store them, and route handlers that read the request aren't statically rendered.
- **No forwarding.** The handler answers every `/_sid/*` request itself; nothing is passed to the rest of your site.

## Route handler or middleware

| | Route handler (primary) | Middleware |
| --- | --- | --- |
| For | Next.js (App Router) sites | Any framework on Vercel (Routing Middleware), or Next.js sites that already have `proxy.ts`/`middleware.ts` |
| Runs on | `/_sid/*` only | Requests the matcher selects (`/_sid/:path*`) |
| Runtime | Node.js 24 (`export const runtime = 'nodejs'`), or Edge | Node.js by default |
| File | `app/%5Fsid/[...path]/route.ts` | `middleware.ts`, or `proxy.ts` (Next.js 16) |

**The route handler is the primary way** for Next.js sites: it runs only for `/_sid/*`, adds nothing to other requests, and is one file. Middleware is the way for sites not built with Next.js (Vite, Astro, a static site, other frameworks), whose routing Vercel's Routing Middleware sits in front of, and for Next.js sites that already run middleware and want one entry point. Both use the same handler and behave the same; middleware lets requests outside `/_sid` continue to your site.

**The folder is `%5Fsid`, not `_sid`.** In the Next.js App Router, a folder whose name starts with `_` is a private folder and isn't routed. `%5F` is the URL-encoded underscore, so `app/%5Fsid/[...path]/route.ts` answers `/_sid/sync`, `/_sid/v1`, `/_sid/optout` and `/_sid/optin`. With a different `SID_BASE_PATH`, name the folder after it.

**Node.js or Edge runtime.** The handler uses only web-standard APIs (no Node.js built-ins; the bundle step checks), so it runs on both unchanged. **Use the Node.js runtime** (`export const runtime = 'nodejs'`, the default): Vercel recommends it (Fluid compute), and Next.js 16 deprecates the Edge runtime (`next build` warns "The Edge Runtime is deprecated"). Set the project's Node.js version to 24 (`"engines": { "node": ">=24" }` in your `package.json`, or Project Settings → Build and Deployment → Node.js Version). On Next.js 15 or earlier, `export const runtime = 'edge'` runs it in Vercel's Edge runtime instead, close to the visitor; both were checked with `next build` and `next start` (see [Testing](#testing-without-a-vercel-account)).

## Prerequisites

- A site deployed on Vercel, on your own domain (for example `www.example.com`), served over https.
- Node.js 24 or later and npm, to build the bundle.
- Permission to add files and environment variables to the Vercel project.

## Build

From a clone of this repository:

```sh
npm ci
npm run build                               # compiles core and the modules
npm run bundle -w @sharedid-edge/vercel     # packages/adapters/vercel/deploy/sharedid-edge.mjs and .d.mts
```

The bundle is a single ESM file with no dependencies and no Node.js built-ins (about 15 KB gzipped; minified; the bundle step fails it over 32 KB), with a declaration file next to it. Copy both into your site's repository, for example as `lib/sharedid-edge.mjs` and `lib/sharedid-edge.d.mts`, and commit them. To update, rebuild and copy them again.

The packages aren't on npm yet. Once they are, `npm install @sharedid-edge/vercel` replaces the copy, with the same `handlerFromEnv` and `middlewareFromEnv`.

## Deploy with a Next.js route handler

Add `app/%5Fsid/[...path]/route.ts` (or `src/app/…` if your app lives in `src/`):

```ts
import { handlerFromEnv } from '../../../lib/sharedid-edge.mjs';

export const runtime = 'nodejs';   // or 'edge'; see "Node.js or Edge runtime" above

const handler = handlerFromEnv(process.env);

export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;   // CORS preflights for /_sid/v1
```

Set the [settings](#configuration) as environment variables, then deploy as usual (`git push`, or `vercel deploy --prod`). Other methods get Next.js's own 405.

Make sure no rewrite, redirect or middleware of yours catches `/_sid/*` first.

**Trailing slashes.** Next.js redirects `/_sid/sync/` to `/_sid/sync` (308) before the route runs; with `trailingSlash: true` it's the other way round. Either way the browser follows the redirect and the pixel works, at the cost of a round trip, so set Prebid.js's `pixelUrl` to the form your site uses (`/_sid/sync` by default). `skipTrailingSlashRedirect: true` in `next.config` turns the redirect off, but for the whole site.

## Deploy with middleware

For Routing Middleware (any framework), add `middleware.ts` at the root of the project:

```ts
import { middlewareFromEnv } from './lib/sharedid-edge.mjs';

const sharedId = middlewareFromEnv(process.env);

export const config = { matcher: '/_sid/:path*' };

export default async function middleware(request: Request): Promise<Response | undefined> {
  return sharedId(request);   // undefined: the request continues to your site
}
```

With Next.js 16, the file is `proxy.ts` and continuing needs `NextResponse.next()`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { middlewareFromEnv } from './lib/sharedid-edge.mjs';

const sharedId = middlewareFromEnv(process.env);

export const config = { matcher: ['/_sid/:path*'] };

export async function proxy(request: NextRequest): Promise<Response> {
  return (await sharedId(request)) ?? NextResponse.next();
}
```

If you already have middleware, call `sharedId(request)` first and fall through to your own logic when it returns `undefined`, and add `/_sid/:path*` to your matcher. Keep the matcher narrow: without one, middleware runs on every request, including static files. `middlewareFromEnv` answers only paths under `SID_BASE_PATH`, so a broad matcher doesn't break your site, but it costs an invocation per request.

## Configuration

**Base path.** The route folder and the middleware follow `SID_BASE_PATH`. With the route handler, put the route at the matching folder (`app/<base path>/[...path]/route.ts`, escaping a leading `_` as `%5F`). With the middleware, the `matcher` must cover the base path; with the root base path (`/`) the middleware answers exactly `/sync`, `/v1`, `/optout` and `/optin` and passes everything else to the site, so a broad matcher is safe.

Settings are the project's environment variables, the same `SID_*` variables as everywhere else (see the [configuration reference](../../../README.md#configuration-reference)): Project Settings → Environment Variables, or the CLI:

```sh
vercel env add SID_MODULES production            # e.g. ip,geo
vercel env add SID_COOKIE_DOMAIN production      # e.g. .example.com
```

Environment variables apply to new deployments: redeploy after changing them. `example/.env.example` lists every setting. Use separate values for Preview and Production if you want, but remember that cookies set on a preview URL (`*.vercel.app`) belong to that hostname, not your site.

Two more variables are read only by the Vercel adapter:

| Variable | Default | |
| --- | --- | --- |
| `SID_PUBLIC_ORIGIN` | the request's own origin | The origin of request URLs. On Vercel it's the https URL the visitor asked for, so leave it unset; only its scheme matters (`https` makes cookies `Secure`). |
| `SID_BEHIND_VERCEL` | `true` | `false` when the code isn't running on Vercel (for example `next start` on your own server): the client IP and geolocation headers are then ignored, since anyone could send them. See [Platform information](#platform-information). |

Configuration is read once per instance, when the route or middleware module loads. An invalid setting makes every `/_sid/*` request return `500 SharedID Edge is misconfigured`, and the reason is logged to the function's logs, rather than setting wrong cookies. With middleware, the rest of the site is unaffected.

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) is an environment variable too. Add it as a **Sensitive** environment variable, whose value can't be read back from the dashboard or the CLI after it's saved:

```sh
vercel env add SID_MODULE_SECRETS production --sensitive
# paste: {"ec":{"passphrase":"<openssl rand -hex 32>"}}
```

or tick *Sensitive* when adding it under Project Settings → Environment Variables. Vercel encrypts environment variables at rest. Never put it in `.env` files you commit, or in `vercel.json`. To rotate, change the value and redeploy.

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie
curl -s  'https://www.example.com/_sid/v1' | jq .                # the payload
```

Then [turn it on in Prebid.js](../../../README.md#configure-prebidjs).

## Platform information

The handler gets the client IP and location (`PlatformInfo`) from headers Vercel's proxy sets on every request to a function or middleware:

| Field | Header | Notes |
| --- | --- | --- |
| `clientIp` | `x-real-ip`, else the first `x-forwarded-for` entry | IPv4 or IPv6. Vercel overwrites both with the connecting client's address and doesn't forward an `X-Forwarded-For` the visitor sends. Anything that isn't an IP address is ignored. |
| `country` | `x-vercel-ip-country` | ISO 3166-1 alpha-2, like `FR`. |
| `region` | `x-vercel-ip-country-region` | The subdivision code without the country, like `WA` or `IDF`. |
| `city` | `x-vercel-ip-city` | Percent-decoded (Vercel encodes non-ASCII names, `S%C3%A3o%20Paulo`); dropped if the encoding is invalid. For the `geo` module. |
| `postalCode` | `x-vercel-ip-postal-code` | For the `geo` module. |
| `latitude`, `longitude` | `x-vercel-ip-latitude`, `x-vercel-ip-longitude` | For the `geo` module. Both are needed; out-of-range values are dropped. |
| `timezone` | `x-vercel-ip-timezone` | IANA name, for the `geo` module's `utcoffset`. |
| `continent` | `x-vercel-ip-continent` | `AF`, `AN`, `AS`, `EU`, `NA`, `OC` or `SA`. |
| `metroCode` | none | Vercel has no metro (DMA) code, so the `geo` module never sends `metro` on Vercel. |
| `isEU` | from `country` | `true` for the 27 EU member states (core's `EU_COUNTRY_CODES`, the meaning of Cloudflare's `isEUCountry`), `false` for other countries, unknown without a country. |

Core's `locationInfo` validates the location values the same way as on the other platforms (dropping empty values, `XX`, and out-of-range coordinates).

**The trust model.** These headers are trustworthy because Vercel's proxy computes them from the connecting IP address and replaces any copies the visitor sends, and because the handler is only reachable through that proxy. Vercel documents this for `x-forwarded-for` (and `x-real-ip`, which is identical); the geolocation headers are, per Vercel's documentation, calculated by its proxy. Three consequences:

- **Not on Vercel, nothing is trusted.** If the same code runs elsewhere (`next start` on your own server, another host), anyone could send these headers. Set `SID_BEHIND_VERCEL=false` there: the handler then ignores them and has no client IP or location, as the Node.js server does without `SID_TRUST_PROXY`.
- **A proxy in front of Vercel** (another CDN) makes Vercel see the proxy's address, not the visitor's; Vercel only forwards a client IP from a proxy with its Enterprise trusted-proxy feature. Don't put another CDN in front: it also breaks the Safari IP rule unless that CDN serves the whole site.
- **`x-vercel-forwarded-for`**, which Vercel also sets, isn't needed: `x-real-ip` comes first.

**GDPR.** `isEU` comes from the country. When Vercel sends no country (an unknown location), `isEU` is unknown and GDPR applies only if the page sends `gdpr=1`, as on the other platforms. EEA countries outside the EU (Iceland, Liechtenstein, Norway) and the UK aren't in the list: pages there should send `gdpr=1` (the [consent rules](../../../README.md#consent-and-opt-out)).

## Using it in code

The package exports the pieces, if you want your own entry point (other modules, a different configuration source):

```ts
import { resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createVercelHandler } from '@sharedid-edge/vercel';

const handler = createVercelHandler({
  config: resolveConfig(process.env),
  modules: [...builtInModules, myModule],
  // publicOrigin: 'https://www.example.com',
  // behindVercel: true
});
export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
```

- `createVercelHandler(options)`: `(request: Request) => Promise<Response>`; options are core's `HandlerOptions` plus `publicOrigin` and `behindVercel`.
- `createVercelMiddleware(options)`: `(request: Request) => Promise<Response | undefined>`, `undefined` outside `config.basePath`.
- `handlerFromEnv(env, modules?)` and `middlewareFromEnv(env, modules?)`: what the bundle exports (without the `modules` argument): read the variables above and turn a `ConfigError` into a 500 handler.
- `platformInfo(headers, options?)`, `clientIp(headers)`, `EU_COUNTRY_CODES`.

The bundle (`deploy/sharedid-edge.mjs`) has the built-in modules only. To add a vendor module, build your own entry point like the one above and bundle it with your site.

## The example

[`example/`](example/README.md) is a minimal Next.js site with the route handler, kept out of this repository's build (it has its own `package.json`, and Next.js is a large install). See its README to run it locally.

## Testing without a Vercel account

Nothing here needs an account:

- `npm test -w @sharedid-edge/vercel`: unit tests with requests shaped like the ones Vercel delivers (`test/requests.ts`).
- `npm run conformance:vercel`: bundles the adapter, then runs the whole conformance suite against `deploy/sharedid-edge.mjs` behind a local stand-in for Vercel's proxy (`conformance/src/vercel-emulator.ts`). It turns each HTTP request into a `Request`, drops any `x-real-ip`, `x-forwarded-for` and `x-vercel-*` headers the client sent, and sets them as Vercel would: the client IP from the connection (or, as the conformance cases need, from `X-Forwarded-For` when the case sets `SID_TRUST_PROXY`), and the geolocation headers from the cases' Cloudflare-style location headers, with the city percent-encoded. The cases' metro code has no Vercel header, so the runner checks that `metro` is absent instead.
- The bundle step checks the bundle builds with no Node.js built-ins (as the Edge runtime requires) and fits its size budget.
- [The example](example/README.md) builds with `next build` (Next.js 16) and runs under `next start`. Run by hand, not in CI (Next.js is a large install): the default-configuration conformance cases (`--base-url`) pass on both the Node.js and the Edge runtime, except the trailing-slash case, which gets Next.js's 308 redirect (see [Deploy with a Next.js route handler](#deploy-with-a-nextjs-route-handler)).
- `vercel dev` isn't used: it needs a login, and doesn't set the geolocation headers locally.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

What these don't cover, and a first deployment should check: Vercel's actual header values (for example that `x-vercel-ip-country-region` and `x-vercel-ip-city` arrive as documented, and that a visitor's own copies are replaced), the build and runtimes on Vercel itself rather than `next start`, Routing Middleware (not run locally), and that Vercel's CDN doesn't cache the responses.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route folder is `_sid` (a private folder, not routed) instead of `%5Fsid`, or it isn't under `app/` (or `src/app/`). With middleware: the matcher doesn't cover `/_sid/:path*`, or the file isn't at the project root. |
| `/_sid/sync` returns the plain `Not found` | The path under `SID_BASE_PATH` is wrong: it must end in `/sync`, `/v1`, `/optout` or `/optin`. |
| 405 from Next.js | The method isn't exported from the route file: export `GET`, `HEAD` and `OPTIONS`. |
| 308 redirect on `/_sid/sync/` | Next.js's trailing-slash redirect; see [Trailing slashes](#deploy-with-a-nextjs-route-handler). Harmless, but use `pixelUrl` without the slash. |
| 500 `SharedID Edge is misconfigured` | An invalid setting; the reason is in the function's logs (Project → Logs). Fix it and redeploy. |
| `/_sid/v1` has no `ortb2.device.ip` with `SID_MODULES=ip` | `SID_BEHIND_VERCEL` is `false`, or consent rules it out (`ext.modules.ip.status` is `empty`). |
| EU visitors get cookies without consent, or the reverse | Vercel sent no country (see `X-SharedID-Status`), or the page sends `gdpr=`. |
| A setting change has no effect | Environment variables apply to new deployments: redeploy. |
| Cookie set but gone after a week in Safari | `/_sid/*` isn't served by the project that serves your pages (a separate project or hostname). Run `verify-deployment`. |
| Cookies on a preview URL don't reach the site | Expected: cookies belong to the `*.vercel.app` hostname they were set on. Test on your own domain. |
