# The `dbip` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and merging in `SID_MODULES` order, are there.

Name `dbip`; no `purposes`, no `gvlid`; `routes` `v1` only. A vendor module ([`packages/vendor-modules/dbip`](../../packages/vendor-modules/dbip/README.md)), added at build time, that runs only when listed in `SID_MODULES`. It looks the client IP up in a country table built from DB-IP's IP to Country Lite database at build time, and makes no network calls.

- **Lookup:** the client IP (`PlatformInfo.clientIp`, IPv4, IPv6, or IPv4-mapped IPv6 as IPv4) in the bundled table. IPv4 results MUST equal the database's. IPv6 is keyed by the address's first 64 bits: a /64 that the database splits between countries takes the country of its first address. A missing or unparsable client IP, an address without data, or a country code with no ISO 3166-1 alpha-3 equivalent (such as `XK`) is a miss: the module returns nothing (`empty`).
- **Output:** `{ "device": { "geo": { "type": 2, "country": <ISO 3166-1 alpha-3> } } }`, merged into `ortb2`. No `ipservice`: DB-IP isn't on AdCOM 1.0's List: IP Location Services. Nothing else (no region, city, postal code, coordinates or network data).
- **`mode`** (`SID_MODULE_CONFIG.dbip.mode`):
  - `fill` (the default): the module returns nothing when the platform reports a country (`PlatformInfo.country`) that has an alpha-3 code, that is, one the `geo` module would send;
  - `replace`: it returns the country whenever the lookup finds one. Listed after `geo` in `SID_MODULES`, its `country` overrides `geo`'s in the merge; `geo`'s other fields remain.
  - Any other `mode`, or any other setting, is an `error`.
- **Consent:** the country is coarse location, returned whatever the consent signals (GPC, COPPA, a US privacy opt-out, GDPR with or without a TC string, opt-out), as `geo` returns the CDN's country. The module's output never changes core's consent decisions.
- **The table without real data** (the package's fixture) covers only documentation addresses: 192.0.2.0/25 `FR`, 192.0.2.128/25 `XK`, 198.51.100.0/24 `JP`, 203.0.113.0/24 `BR`, 2001:db8::/48 `FR`, 2001:db8:1::/48 `JP`. The conformance cases (`conformance/cases/module-dbip*.json`) use it.
- Nothing about the request is stored or logged.
