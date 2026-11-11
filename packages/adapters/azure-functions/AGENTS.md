# packages/adapters/azure-functions

The Azure Functions adapter (`@sharedid-edge/azure-functions`), for a function app (Node.js v4 programming model) behind a route of the site's Azure Front Door profile. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

- `src/types.ts`: minimal structural types for `HttpRequest`, `HttpResponseInit` and `Cookie`. The package has no runtime dependency on `@azure/functions`; `src/functions.ts` checks at compile time that its types fit.
- `src/handler.ts`: `createAzureHandler`, `HttpRequest` to `Request` and `Response` to `HttpResponseInit`, and the `X-Azure-FDID` check. Keep it a thin adapter; behaviour belongs in core.
- `src/cookies.ts`: `Set-Cookie` to the v4 `Cookie` shape, and `preservedByHost`.
- `src/platform.ts`: `PlatformInfo` from `X-Azure-ClientIP` and the configured location headers, through core's `locationInfo`, `isEU` from core's `EU_COUNTRY_CODES`.
- `src/env.ts`: `handlerFromEnv`, `routeFromEnv` (the route template follows `SID_BASE_PATH`) and the adapter's own settings, each validated with a `ConfigError`.
- `src/functions.ts`: the deployed entry point, which registers the HTTP function. `scripts/bundle.mjs` bundles it into `deploy/` with `host.json` (empty route prefix) and a `package.json` whose one dependency is `@azure/functions` (not bundled: it needs the worker's `@azure/functions-core`), and checks the size budget.
- `infra/main.bicep` and `infra/frontdoor.bicep`: the function app on Flex Consumption and the Front Door origin, rule set and route. `infra/basepath.bicep`: `normalizeBasePath` (core's check and normalization of `SID_BASE_PATH`, failing the deployment for an invalid value) and `frontDoorPatterns`, which `frontDoorPatterns` in `src/env.ts` mirrors.
- `local.settings.example.json`: every setting, for Core Tools (`func start`).

Rules:

- **Every `Set-Cookie` goes in `cookies[]`**, with one exception: the host keeps one value per header name. The host percent-encodes `cookies[]` values, so the first cookie whose value `preservedByHost` rejects goes unchanged in `headers['set-cookie']` (the host's `RawScriptResult` appends the headers, then `cookies[]`). A second such cookie in the same response is left out (logging its name only), never sent altered. The emulator models the same order.
- **Behind Front Door, trust only `X-Azure-ClientIP`** for the client IP, never `X-Forwarded-For` or `X-Azure-SocketIP`, and location only from the headers `SID_LOCATION_HEADERS` names, which a rule must overwrite on every request. `behindFrontDoor: false` trusts nothing.
- **The origin lock stays in the template:** access restrictions defaulting to Deny with the `AzureFrontDoor.Backend` service tag and an `X-Azure-FDID` header filter, and `SID_FRONT_DOOR_ID`. The route stays uncached (no `cacheConfiguration`).
- **The route follows `SID_BASE_PATH`**, in the function (`routeFromEnv`) and in the templates (`sidBasePath`, through `normalizeBasePath`), including the root path `/`, where Front Door takes only core's `ROUTES`. Build Front Door patterns only from the normalized path (`/identity/` is `/identity`), and keep `basepath.bicep` and `frontDoorPatterns` in step (a test checks both).
- **`infra/main.bicep` and `local.settings.example.json`** must have every `SID_*` setting core reads, plus `SID_FRONT_DOOR_ID` and `SID_LOCATION_HEADERS` (a unit test checks), and the templates build with `az bicep build` (CI, no login).
- **No backtracking regular expressions on request data:** trim with loops (`routeFor`, the emulator's path).
- Node.js 24: `engines`, the Flex Consumption runtime and esbuild's `node24` target.
- Published like core: ESM, `isolatedDeclarations`, attw-clean (`npm run attw`).
- **Conformance** without an Azure account: `npm run conformance:azure` runs the suite against the bundle through `conformance/src/azure-emulator.ts`.
- **Tests** (`test/azure.test.ts`) build requests with `@azure/functions`' own `HttpRequest` (`test/requests.ts`). Cover IPv4 and IPv6 clients when the client IP matters.
