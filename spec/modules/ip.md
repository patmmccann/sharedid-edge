# The `ip` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `ip`; no `purposes`, no `gvlid`, no settings. It runs only when listed in `SID_MODULES`, and on `/v1` only.

- It returns the platform's full client IP address as `ortb2.device.ip` (IPv4) or `ortb2.device.ipv6` (IPv6). An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is IPv4. IPv6 is written in RFC 5952 form.
- It returns **nothing** (status `empty`) when:
  - the request has `Sec-GPC: 1`, or `coppa=1`;
  - the `us_privacy` string opts out of sale (its third character is `Y`);
  - there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data);
  - GDPR applies and there is no TC string;
  - the platform has no client IP, or it isn't a valid address.
- It MUST NOT return a truncated address: a truncated address looks real but is wrong, which is worse than none.
- The address MUST NOT be stored, logged or used to derive an ID.
