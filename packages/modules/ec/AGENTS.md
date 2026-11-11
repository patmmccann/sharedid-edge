# packages/modules/ec

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../AGENTS.md`](../AGENTS.md).

The `ec` module (`@sharedid-edge/module-ec`): IAB Tech Lab Trusted Server Edge Cookies (`ts-ec`). See the [spec section](../../../spec/modules/ec.md) and the [Trusted Server guide](https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html).

- **An IP-derived ID, held to the vendor rules.** The prefix is HMAC-SHA256(passphrase, normalized client IP), because that's how Trusted Server defines EC. It's the only project module allowed one: the project treats it as a vendor module (IAB Tech Lab's open-source code, ported) under [IP-derived IDs](../../vendor-modules/AGENTS.md#ip-derived-ids). Keep it opt-in (only via `SID_MODULES`), keep `ipDerived` in its `sharedidEdge` block and the warning at the top of the README, and don't reuse this pattern in core or another project module.
- **Stay faithful to Trusted Server's implementation.** The format, IPv6 /64 normalization, the cookie attributes (`HttpOnly`, one year, `Domain=.{domain}`), no refresh, and format-only validation all follow Trusted Server's code, which differs from its draft spec in places (the spec says not `HttpOnly`, and colon-joined IPv6). If Trusted Server changes, follow its code and note the version.
- **`routes: ['v1', 'sync']`:** like Trusted Server, which sets `ts-ec` on page loads, it runs on Prebid.js's `pixelUrl` calls too. On `/sync` only the cookie (set or withdrawn) is used; `ortb2.user.id` is ignored.
- The passphrase comes from `SID_MODULE_SECRETS` (`context.secrets`). Never return, log or put it in an error message.
- **Web Crypto only:** `crypto.subtle` HMAC, and `crypto.getRandomValues` for the suffix, with rejection sampling to keep it uniform. It uses `parseIp` from `@sharedid-edge/module-ip`.
- **Tests:** `test/ec.test.ts` has HMAC vectors computed independently with Node.js's `crypto`. Keep them independent; don't regenerate them with this module. Conformance cases are in `conformance/cases/module-ec.json`.
