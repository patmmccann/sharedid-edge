# packages/adapters/gcp-functions

The Google Cloud adapter (`@sharedid-edge/gcp-functions`), for a Cloud Run function (Functions Framework, Node.js 24) behind a path rule of the site's external Application Load Balancer. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

- `src/handler.ts`: `createGcpHandler`, using `@sharedid-edge/node`'s `toWebRequest` and `sendWebResponse` for the conversion (Express's `req`/`res` are Node's). Don't copy that code here; extend it in `@sharedid-edge/node` if it needs more. Keep it a thin adapter; behaviour belongs in core.
- `src/platform.ts`: `PlatformInfo` from `X-Forwarded-For` (the entry before the last `trustedHops`) or `clientIpHeader`, and the location from the configured custom request headers, through core's `locationInfo`, with `isEU` from core's `EU_COUNTRY_CODES`.
- `src/env.ts`: `handlerFromEnv` and the adapter's own settings, each validated with a `ConfigError`.
- `src/function.ts`: the deployed entry point, which registers `sharedidEdge` with the Functions Framework. `scripts/bundle.mjs` bundles it into `deploy/` with a `package.json` whose one dependency is the Functions Framework (not bundled: the runtime starts it), and checks the size budget.
- `terraform/`: the function, its service account, the serverless NEG and the backend service. It doesn't touch the user's URL map.

Rules:

- **Never the first `X-Forwarded-For` entry:** behind the load balancer it's the visitor's. The client is the entry before the last `trustedHops` (1: `<client>,<load balancer>`).
- **Location only from headers `SID_LOCATION_HEADERS` names**, which the backend service's custom request headers overwrite; no defaults, since unset names are visitor-controlled. `behindLoadBalancer: false` trusts nothing.
- **Terraform keeps** ingress `ALLOW_INTERNAL_AND_GCLB`, Cloud CDN off, the runtime `nodejs24`, every `SID_*` setting core reads plus `SID_TRUSTED_HOPS` and `SID_LOCATION_HEADERS` (a unit test checks), `SID_MODULE_SECRETS` from Secret Manager only, and path rule paths that follow `sid_base_path` (including `/`). CI runs `terraform validate`, without credentials.
- **Firebase Hosting rewrites aren't supported:** Hosting strips every cookie but `__session`. Keep the README's explanation if that changes.
- Published like core: ESM, `isolatedDeclarations`, attw-clean (`npm run attw`).
- **Conformance** without an account: `npm run conformance:gcp` runs the suite against the real Functions Framework serving `deploy/`, behind `conformance/src/gcp-emulator.ts`. The load balancer has no metro, postal code or time zone variable, so the target lists those payload fields as unavailable.
- **Tests** (`test/gcp.test.ts`) serve the function from a real Node.js server. Cover IPv4 and IPv6 clients, and spoofed leading `X-Forwarded-For` entries.
