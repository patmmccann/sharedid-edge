# packages/adapters/node

User documentation is in [README.md](README.md); keep it in step with behaviour changes. Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

A Node.js HTTP server around the core handler (`src/index.ts`, `createNodeServer`) and its CLI (`src/cli.ts`, configured by environment variables). Used for local development, self-hosting behind a reverse proxy, and as a conformance target.

- Converts `IncomingMessage` to `Request` and the `Response` back (each `Set-Cookie` its own header), and fills `PlatformInfo`. The conversion (`toWebRequest`, `sendWebResponse`, `utf8`) is exported and reused by `@sharedid-edge/gcp-functions`; changing it changes that adapter too. The CLI builds in `builtInModules` from `@sharedid-edge/modules`.
- The client IP is the socket address unless `trustProxy` is set; only then is `X-Forwarded-For` used, and the location read from Cloudflare's visitor location headers (`cf-ipcountry`, `cf-region-code`, `cf-ipcity`, …, through core's `locationInfo`). Keep that the default: the headers are client-controlled otherwise. This is the one trust setting the adapter rules allow for.
- `publicOrigin` sets the request URL's origin; without it, it's `http://<Host header>`. Behind TLS termination it's optional: a public `Host` over http already gets `Secure` cookies (core decides, see [Secure cookies](../../../docs/configuration.md#secure-cookies)). It matters when the proxy doesn't pass the public `Host`.
- Tests (`test/server.test.ts`) start a real server on a random port and use `fetch`.
