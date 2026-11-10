# packages/modules/ip

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes.

The `ip` module (`@sharedid-edge/module-ip`): the client's IP address in the `/v1` payload's `ortb2.device.ip` or `ortb2.device.ipv6`, or nothing when consent signals rule it out. It never sends a truncated address. See the [spec section](../../../spec/modules/ip.md).

It's the pattern for module packages; the rules for all of them are in [`../AGENTS.md`](../AGENTS.md).

- `src/ip.ts` parses and formats (RFC 5952) addresses without platform APIs. Reject anything that isn't a plain address rather than echo it back; zone IDs aren't accepted.
- `src/index.ts` has the module and `omissionReason`, which delegates to core's `preciseLocationDenial` (GPC, COPPA, US privacy opt-out, no TCF Special Feature 1 opt-in, GDPR without a TC string). The `geo` module's precise fields share that rule, so changing it changes both. Don't add truncation: a truncated address is worse than none. Changing the rules is a behaviour change: spec, conformance (`conformance/cases/module-ip.json` and `module-geo.json`), tests, README.
- Never log, store or hash the address, or put it anywhere but the response to the same request.
- Tests in `test/ip.test.ts` cover parsing, the omission rules and the module through `createHandler`.
