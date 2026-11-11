# packages/adapters/akamai

The Akamai EdgeWorkers adapter (`@sharedid-edge/akamai`): an EdgeWorker whose `responseProvider` answers the base path on the property that serves the site. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter. Akamai Functions (WebAssembly) is a different product and out of scope here.

- `src/edgeworkers.ts`: minimal structural types for the EdgeWorkers request object, EdgeScape's `userLocation` and the adapter's result. Don't add EdgeWorkers type packages; the platform's objects must stay assignable.
- `src/handler.ts`: `createEdgeWorkerHandler`, request object to `Request` and `Response` to `{ status, headers, body }`. Keep it a thin adapter; behaviour belongs in core.
- `src/platform.ts`: `PlatformInfo` from `request.clientIp` and `request.userLocation` only, through core's `locationWithEU`; `postalCodeFromZip` keeps EdgeScape's `zipCode` only when it names one code.
- `src/env.ts`: settings from the `PMUSER_SID_*` Property Manager variables, read per request (EdgeWorkers hands them over with each request); the handler is rebuilt only when they change. A `ConfigError` gives a 500 handler.
- `src/main.ts`: the deployed entry point. Only `responseProvider`; it never throws, because EdgeWorkers sends a request whose `responseProvider` fails on to the origin. Bodies go to `createResponse` as a byte stream (`streams` built-in module), since a string body is text.
- `src/web.ts`, `src/globals.ts`: EdgeWorkers has no web-platform globals. `globals.ts` is esbuild's `inject` file: every free `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `crypto`, `console`, `setTimeout` and `clearTimeout` in the bundle uses its exports, from EdgeWorkers' built-in modules (`encoding`, `crypto`, `log`) and `web.ts`'s minimal implementations. It writes no globals. `test/web.test.ts` compares `web.ts` with Node.js's classes; extend both when core or a module starts using more of these APIs, or the conformance suite fails on the stand-in.
- `src/builtins.d.ts`: types for the built-in modules the bundle imports.
- `scripts/bundle.mjs`: esbuild bundle to `deploy/main.js` plus `deploy/bundle.json` (the code bundle), alone in `deploy/`, with the size budget. It fails if the bundle imports anything but the built-in modules. `edgeworker-version` is the package version and a hash of `main.js`, since every upload needs a new one.

Rules:

- **Every `Set-Cookie` is its own array entry** in the `createResponse` headers, never joined.
- **Trust only Akamai's own data** for the client IP and location (`request.clientIp`, `request.userLocation`); never request headers.
- **No forwarding.** The EdgeWorker exports `responseProvider` alone and catches every error, so a request on the base path never reaches the origin while the EdgeWorker runs; the README tells deployers to add Site Failover for the cases EdgeWorkers itself fails (limits exceeded).
- **Conformance** without an Akamai account: `npm run conformance:akamai` runs the suite against the bundle through `conformance/src/akamai-emulator.ts`, which loads `deploy/main.js` in a `node:vm` context without web or Node.js globals and provides the built-in modules as documented.
- **Tests** (`test/akamai.test.ts`) use recorded-style request objects from `test/requests.ts`. Cover IPv4 and IPv6 clients when the client IP matters.
- Facts about EdgeWorkers in the README cite Akamai's documentation; what the documentation doesn't say is listed under "What isn't confirmed" rather than assumed.
