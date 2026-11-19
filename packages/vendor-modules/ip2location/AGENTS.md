# packages/vendor-modules/ip2location

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../../modules/AGENTS.md`](../../modules/AGENTS.md), and those for vendor modules, which this is, in [`../AGENTS.md`](../AGENTS.md).

The `ip2location` module (`@sharedid-edge/module-ip2location`): the visitor's country from IP2Location LITE DB1, as `ortb2.device.geo.country` with `ipservice` 1, and proxy signals from IP2Proxy LITE PX10, as `ortb2.device.ext.traffic`. Maintained by IP2Location. Issue #12. Its behaviour is specified in [`spec/modules/ip2location.md`](../../../spec/modules/ip2location.md): change it with the code.

- **Two tables, one module.** `src/index.ts` composes the shared `ipDatabaseModule` for the country (so `fill`/`replace`, alpha-3, `maxAgeDays` and invalid-setting behaviour stay in `@sharedid-edge/ip-ranges`) and adds a second table's proxy kind as `ModuleResult.traffic`; core merges it. `mode` applies to the country only. Don't write `ortb2.device.ext.traffic` directly.
- **PX10's MMDB is GeoIP2-Anonymous-IP shaped.** Records have `is_anonymous`, `is_anonymous_vpn`, `is_hosting_provider`, `is_public_proxy`, `is_residential_proxy` and `is_tor_exit_node`, not a `proxy_type` string. The build maps the specific booleans to `tor`, `residential`, `vpn`, `public` and `datacenter`; `is_anonymous` alone names nothing. Keep `public` in core's `PROXY_KINDS` for LITE's public-proxy coverage.
- **LITE PX10 is a public-proxy subset.** VPN, Tor, hosting and residential coverage is in the commercial PX10 MMDB, which deployers can build with `--proxy-file`. Don't describe the LITE signals as full proxy detection.
- **No bot verdicts.** A proxy or hosting address is not a bot. Don't set `bot` or `botKind` from this data; that's the bot module's job and would make `SID_SKIP_BOTS` withhold IDs from real visitors.
- **The build-time credential path.** `IP2LOCATION_DOWNLOAD_TOKEN` is a `buildCredential`: `scripts/build-data.mjs` alone reads it, puts it in the download URL, and never writes or prints it. Keep it that way:
  - nothing from the environment goes into the data file;
  - errors name the file code, never the URL or the token (the URL carries it);
  - `test/ip2location.test.ts` builds with a made-up token in the environment, checks the output and the log for it and its encodings, and runs `scripts/check-build-secrets.mjs` on the output.
- **Download tests use a local stand-in** (`IP2LOCATION_DOWNLOAD_URL`): the build accepts only HTTP URLs on literal loopback addresses without embedded credentials and rejects redirects from the stand-in.
- **ZIP handling lives in [`@sharedid-edge/ip-ranges`](../../ip-ranges/AGENTS.md).** IP2Location ships ZIPs; `zipEntry` and `mmdbBytes` in the shared package unwrap stored and deflated archives, with names matched case-insensitively. Don't add a ZIP reader here.
- **No IP2Location or IP2Proxy data in the repository,** not even a slice. `src/data.ts` holds the shared country fixture and the hand-made proxy fixture in `src/fixtures.ts`, covering documentation addresses only. `--fixture` restores both.
- **Attribution:** `IP2LOCATION_ATTRIBUTION` and `IP2PROXY_ATTRIBUTION` go into every data file and `DataInfo`; the README says where IP2Location asks for them. Keep both if the terms change.
- **Scheduled refresh** isn't wired to `@sharedid-edge/data-updates` in stage 1. A future source must follow the maxmind one: its own secret, validated snapshots, no token in the request worker.
- **Size numbers in the README** are a guide until someone measures real DB1 and PX10 builds. Replace them when you do.
