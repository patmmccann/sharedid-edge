# packages/modules/ec

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../AGENTS.md`](../AGENTS.md).

The `ec` module (`@sharedid-edge/module-ec`): IAB Tech Lab Trusted Server Edge Cookies (`ts-ec`). See the [spec section](../../../spec/modules/ec.md) and the [Trusted Server guide](https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html).

- **This is the one IP-derived ID in the project, on purpose.** The prefix is HMAC-SHA256(passphrase, normalized client IP), because that's how Trusted Server defines EC. Keep it opt-in (only via `SID_MODULES`), keep the warning in the README, and don't reuse this pattern elsewhere.
- **Stay faithful to Trusted Server's implementation.** The format, IPv6 /64 normalization, the cookie attributes (`HttpOnly`, one year, `Domain=.{domain}`), no refresh, and format-only validation all follow Trusted Server's code, which differs from its draft spec in places (the spec says not `HttpOnly`, and colon-joined IPv6). If Trusted Server changes, follow its code and note the version.
- **`routes: ['v1', 'sync']`:** like Trusted Server, which sets `ts-ec` on page loads, it runs on Prebid.js's `pixelUrl` calls too. On `/sync` only the cookie (set or withdrawn) is used; the EID is ignored.
- **Output is an EID, never `ortb2.user.id`:** source `EC_EID_SOURCE` (`ts.iabtechlab.com`, the project's own until IAB Tech Lab registers one), `atype` 1, in both `eids` and `ortb2.user.ext.eids`. `user.id` in Prebid.js first-party data would be every bidder's exchange user ID. This is where we deliberately differ from Trusted Server, which sets `user.id` in requests it builds itself.
- The passphrase comes from `SID_MODULE_SECRETS` (`context.secrets`). Never return, log or put it in an error message.
- **Web Crypto only:** `crypto.subtle` HMAC, and `crypto.getRandomValues` for the suffix, with rejection sampling to keep it uniform. It uses `parseIp` from `@sharedid-edge/module-ip`.
- **Tests:** `test/ec.test.ts` has HMAC vectors computed independently with Node.js's `crypto`. Keep them independent; don't regenerate them with this module. Conformance cases are in `conformance/cases/module-ec.json`.
