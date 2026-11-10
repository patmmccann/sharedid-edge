# packages/node

A Node.js HTTP server around the core handler (`src/index.ts`, `createNodeServer`) and its CLI (`src/cli.ts`, configured by environment variables). Used for local development, self-hosting behind a reverse proxy, and as a conformance target.

- Keep it a thin adapter: convert `IncomingMessage` to `Request` and the `Response` back, and fill `PlatformInfo`. Behaviour belongs in core.
- Every `Set-Cookie` must be written as a separate header (`response.headers.getSetCookie()`); joining them breaks cookies.
- The client IP is the socket address unless `trustProxy` is set; only then is `X-Forwarded-For` used. Keep that the default: the header is client-controlled otherwise.
- `publicOrigin` sets the request URL's origin, which decides whether cookies are `Secure`. Behind TLS termination it must be the https origin.
- Errors return a generic 500 and log only the error's name, never request data.
- Tests (`test/server.test.ts`) start a real server on a random port and use `fetch`.
