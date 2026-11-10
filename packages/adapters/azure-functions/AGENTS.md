# packages/adapters/azure-functions

The Azure Functions adapter (`@sharedid-edge/azure-functions`), for a function app (Node.js v4 programming model) behind a route of the site's Azure Front Door profile. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

- `src/types.ts`: minimal structural types for `HttpRequest`, `HttpResponseInit` and `Cookie`. The package has no runtime dependency on `@azure/functions`; `src/functions.ts` checks at compile time that its types fit.
- `src/handler.ts`: `createAzureHandler`, `HttpRequest` to `Request` and `Response` to `HttpResponseInit`, and the `X-Azure-FDID` check. Keep it a thin adapter; behaviour belongs in core.
- `src/cookies.ts`: `Set-Cookie` to the v4 `Cookie` shape, and `preservedByHost`.
- `src/platform.ts`: `PlatformInfo` from `X-Azure-ClientIP` and the configured location headers, through core's `locationInfo`, `isEU` from core's `EU_COUNTRY_CODES`.
- `src/env.ts`: `handlerFromEnv`, `routeFromEnv` (the route template follows `SID_BASE_PATH`) and the adapter's own settings, each validated with a `ConfigError`.
- `src/functions.ts`: the deployed entry point, which registers the HTTP function. `scripts/bundle.mjs` bundles it into `deploy/` with `host.json` (empty route prefix) and a `package.json` whose one dependency is `@azure/functions` (not bundled: it needs the worker's `@azure/functions-core`), and checks the size budget.
- `infra/main.bicep` and `infra/frontdoor.bicep`: the function app on Flex Consumption and the Front Door origin, rule set and route.

Rules:

- **Every `Set-Cookie` goes in `cookies[]`**, never into `headers`: the host keeps one value per header name. The host percent-encodes cookie values, so a cookie whose value `preservedByHost` rejects is left out (logging its name only), never sent altered. The conformance target lists the two reflect cases this affects as known limitations; don't add others without a platform reason.
- **Behind Front Door, trust only `X-Azure-ClientIP`** for the client IP, never `X-Forwarded-For` or `X-Azure-SocketIP`, and location only from the headers `SID_LOCATION_HEADERS` names, which a rule must overwrite on every request. `behindFrontDoor: false` trusts nothing.
- **The origin lock stays in the template:** access restrictions defaulting to Deny with the `AzureFrontDoor.Backend` service tag and an `X-Azure-FDID` header filter, and `SID_FRONT_DOOR_ID`. The route stays uncached (no `cacheConfiguration`).
- **The route follows `SID_BASE_PATH`**, in the function (`routeFromEnv`) and in the template (`sidBasePath`), including the root path `/`.
- **`infra/main.bicep`** must pass every `SID_*` setting core reads, plus `SID_FRONT_DOOR_ID` and `SID_LOCATION_HEADERS` (a unit test checks), and build with `az bicep build` (CI, no login).
- Node.js 24: `engines`, the Flex Consumption runtime and esbuild's `node24` target.
- Published like core: ESM, `isolatedDeclarations`, attw-clean (`npm run attw`).
- **Conformance** without an Azure account: `npm run conformance:azure` runs the suite against the bundle through `conformance/src/azure-emulator.ts`.
- **Tests** (`test/azure.test.ts`) build requests with `@azure/functions`' own `HttpRequest` (`test/requests.ts`). Cover IPv4 and IPv6 clients when the client IP matters.
