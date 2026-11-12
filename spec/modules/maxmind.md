# The `maxmind` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and merging in `SID_MODULES` order, are there.

Name `maxmind`; no `purposes`, no `gvlid`; `routes` `v1` only. A vendor module ([`packages/vendor-modules/maxmind`](../../packages/vendor-modules/maxmind/README.md)), added at build time, that runs only when listed in `SID_MODULES`. It looks the client IP up in a country table built at build time from MaxMind's GeoLite2 Country database (its `country`, not `registered_country`), downloaded with the deployer's MaxMind credentials, and makes no network calls. The credentials are used only by the build and MUST NOT be in the bundle.

- **Lookup:** the client IP (`PlatformInfo.clientIp`, IPv4, IPv6, or IPv4-mapped IPv6 as IPv4) in the bundled table. IPv4 results MUST equal the database's. IPv6 is keyed by the address's first 64 bits: a /64 that the database splits between countries takes the country of its first address. A missing or unparsable client IP, an address without data, or a country code with no ISO 3166-1 alpha-3 equivalent (such as `XK`) is a miss: the module returns nothing (`empty`).
- **Output:** `{ "device": { "geo": { "type": 2, "country": <ISO 3166-1 alpha-3>, "ipservice": 3 } } }`, merged into `ortb2`. `ipservice` is 3, MaxMind in AdCOM 1.0's List: IP Location Services, and is sent only with the module's country. Nothing else (no region, city, postal code, coordinates or network data).
- **`mode`** (`SID_MODULE_CONFIG.maxmind.mode`):
  - `fill` (the default): the module returns nothing when the platform reports a country (`PlatformInfo.country`) that has an alpha-3 code, that is, one the `geo` module would send;
  - `replace`: it returns the country whenever the lookup finds one. Listed after `geo` in `SID_MODULES`, its `country` overrides `geo`'s in the merge; `geo`'s other fields remain.
  - Any other `mode`, or any other setting, is an `error`.
- **Consent:** the country is coarse location, returned whatever the consent signals (GPC, COPPA, a US privacy opt-out, GDPR with or without a TC string, opt-out), as `geo` returns the CDN's country. The module's output never changes core's consent decisions.
- **The table without real data** (the package's fixture) covers only documentation addresses: 192.0.2.0/25 `FR`, 192.0.2.128/25 `XK`, 198.51.100.0/24 `JP`, 203.0.113.0/24 `BR`, 2001:db8::/48 `FR`, 2001:db8:1::/48 `JP`. The conformance cases (`conformance/cases/module-maxmind*.json`) use it.
- Nothing about the request is stored or logged.
