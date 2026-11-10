# packages/module-ip

The `ip` module (`@sharedid-edge/module-ip`): the client's IP address in the `/v1` payload's `ortb2.device.ip` or `ortb2.device.ipv6`, truncated when consent signals require it. See the [spec section](../../spec/SPEC.md#the-ip-module).

It's the pattern for module packages: a separate workspace package depending only on `@sharedid-edge/core`'s public API, registered in `packages/cloudflare/src/modules.ts` and `packages/node/src/cli.ts`, and doing nothing until listed in `SID_MODULES`.

- **Platform-neutral**, like core (`lib: ["ES2023", "WebWorker"]`, no Node or DOM types), and no runtime dependencies besides core: it's bundled into the worker.
- `src/ip.ts` parses, formats (RFC 5952) and truncates addresses without platform APIs. Reject anything that isn't a plain address rather than echo it back; zone IDs aren't accepted.
- `src/index.ts` has the truncation rules (`truncationReason`) and the module. Truncation follows Prebid Server's defaults (IPv4 /24, IPv6 /56) and its triggers (GPC, US privacy opt-out, no TCF Special Feature 1 opt-in, GDPR without a TC string). Changing them is a behaviour change: spec, conformance (`conformance/cases/module-ip.json`), tests, README.
- Never log, store or hash the address, or put it anywhere but the response to the same request.
- Tests in `test/ip.test.ts` cover parsing, truncation and the module through `createHandler`.
