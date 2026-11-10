# @sharedid-edge/core

The platform-neutral part of [SharedID Edge](../../README.md): the request handler that sets the Prebid SharedID as a server-set first-party cookie, the consent checks, and the module interface. It uses only web-standard APIs (`Request`, `Response`, `URL`, `crypto`) and has no runtime dependencies, so every adapter bundles the same code.

Most publishers don't use this package directly: deploy one of the adapters instead ([Cloudflare](../adapters/cloudflare/README.md), [Node.js](../adapters/node/README.md), [AWS Lambda](../adapters/aws-lambda/README.md)). Use it to write an adapter for another platform, or a module.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';

const handler = createHandler({ config: resolveConfig(env), modules: builtInModules });

// Per request: the platform fills in what only it knows, such as the connecting address.
const response = await handler(request, { clientIp: '192.0.2.1', country: 'DE', isEU: true });
```

- `resolveConfig(env)` reads the `SID_*` settings (the main README's [Configuration reference](../../README.md#configuration-reference)) and throws `ConfigError` on an invalid one.
- `createHandler(options)` returns `(request, platform?) => Promise<Response>`. It answers the routes under `SID_BASE_PATH` and returns a 404 for any other path, so send it only that path and serve the rest of the site as before.
- `PlatformInfo` carries what the platform knows about the visitor: `clientIp`, `isEU` and location fields. Fill location with `locationInfo`, which drops empty and invalid values the same way on every platform. Only use data the platform itself sets; see [`packages/adapters/AGENTS.md`](../adapters/AGENTS.md).
- For an adapter's plumbing around the handler: `splitHeaders(response.headers)` gives each `Set-Cookie` separately (for platforms that keep one value per header name) and the other headers; `logRequestFailure(error)` logs a failed request without its message, which may hold request data; and `handlerOrMisconfigured(build, misconfigured)` builds the handler, or logs a `ConfigError` and returns your handler that answers every request with a 500.
- `defineModule`, `EdgeModule`, `ModuleContext` and `ModuleRoute` are the module interface (`EdgeModule.routes` chooses `/v1`, `/sync` or both); see [Adding a module](../../README.md#adding-a-module) and [`packages/modules/AGENTS.md`](../modules/AGENTS.md).

The exact behaviour (routes, cookies, consent, responses) is in [`spec/SPEC.md`](../../spec/SPEC.md), and the [conformance suite](../../conformance/AGENTS.md) checks it against every adapter.
