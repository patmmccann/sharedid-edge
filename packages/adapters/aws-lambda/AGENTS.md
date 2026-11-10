# packages/adapters/aws-lambda

The AWS Lambda adapter (`@sharedid-edge/aws-lambda`), for a function URL behind a CloudFront `/_sid/*` behaviour. Users' guide: [README.md](README.md). Read [`../AGENTS.md`](../AGENTS.md) first: the rules for every adapter.

- `src/event.ts`: minimal structural types for payload format 2.0 events and results. Don't add `@types/aws-lambda`; a full event must stay assignable to `LambdaEventV2`.
- `src/handler.ts`: `createLambdaHandler`, event to `Request` and `Response` to result. Keep it a thin adapter; behaviour belongs in core.
- `src/platform.ts`: `PlatformInfo` from the `CloudFront-Viewer-*` headers, and `EU_COUNTRY_CODES` (the 27 member states, matching Cloudflare's `isEUCountry`; update it if EU membership changes, with the Worker in mind).
- `src/env.ts`, `src/lambda.ts`: the deployed entry point; configuration from `process.env` once per cold start, a `ConfigError` gives a 500 handler.
- `scripts/bundle.mjs`: esbuild bundle to `deploy/lambda.mjs`, alone in `deploy/` (the template uploads that directory; `dist/` also has the unbundled `lambda.js`, which Lambda would load first), with its size budget. `template.yaml`: the SAM template.

Rules:

- **Every `Set-Cookie` goes in `cookies[]`**, never into `headers`: Lambda drops repeated headers.
- **Behind CloudFront, trust only `CloudFront-Viewer-*`** for the client IP and location; never `X-Forwarded-For` or `sourceIp` (CloudFront's address). `sourceIp` is used only with `behindCloudFront: false`, and then the CloudFront headers are ignored. Keep that the default.
- Request URLs are https unless `publicOrigin` says otherwise.
- Published like core: ESM, `isolatedDeclarations`, attw-clean (`npm run attw`). It runs on Lambda's Node.js 24 runtime, so Node types are allowed here, unlike core.
- **`template.yaml`** must pass every `SID_*` setting core reads (a unit test checks) and stay valid for `cfn-lint` (CI). The function URL stays `AWS_IAM` with origin access control; the `/_sid/*` behaviour stays `CachingDisabled`; the origin request policy must not forward `Host`.
- **Conformance** without an AWS account: `npm run conformance:lambda` runs the suite against the bundle through `conformance/src/lambda-emulator.ts`.
- **Tests** (`test/lambda.test.ts`) use recorded-style events from `test/events.ts`. Cover IPv4 and IPv6 viewer addresses when the client IP matters.
