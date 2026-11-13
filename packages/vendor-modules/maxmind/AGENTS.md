# packages/vendor-modules/maxmind

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../../modules/AGENTS.md`](../../modules/AGENTS.md), and those for vendor modules, which this is, in [`../AGENTS.md`](../AGENTS.md).

The `maxmind` module (`@sharedid-edge/module-maxmind`): the visitor's country from MaxMind's GeoLite2 Country database, as `ortb2.device.geo.country` with `ipservice` 3. Maintained by the project. Issue #12. Its behaviour is specified in [`spec/modules/maxmind.md`](../../../spec/modules/maxmind.md): change it with the code.

- **The build-time credential path.** `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` are `buildCredentials`: `scripts/build-data.mjs` alone reads them, sends them as Basic authentication to `download.maxmind.com`, and never writes or prints them. Keep it that way:
  - nothing from the environment goes into the data file;
  - errors name the variables, never their values;
  - `test/maxmind.test.ts` builds with made-up credentials in the environment, checks the output and the log for them and their encodings, and runs `scripts/check-build-secrets.mjs` on the output.
- **Download tests use a local stand-in** (`MAXMIND_DOWNLOAD_URL`, loopback only, which `no-network.mjs` allows): Basic authentication, the cross-origin redirect (the credentials must not follow it), the SHA-256 check and a rejected key. Don't document `MAXMIND_DOWNLOAD_URL` for deployers: the credentials go wherever it points.
- **Offline: data at build time,** as in [`dbip`](../dbip/AGENTS.md): `npm run data` writes `dist/data.js` over the compiled fixture, and requests never touch the network (`network: "none"`). Tests never reach the internet: they use `--file`, or the local stand-in, with a database from `writeMmdb`.
- **No MaxMind data in the repository,** not even a slice: the GeoLite EULA (section 6.1) restricts disclosure. `src/data.ts` is the shared hand-made fixture.
- **The download is checked** against MaxMind's `.sha256`, and the file's `database_type` must be `GeoLite2-Country`.
- **Shared logic lives in [`@sharedid-edge/ip-ranges`](../../ip-ranges/AGENTS.md).** This package holds only what's MaxMind's: the download, the credentials, the attribution, `ipservice` 3 and the module name.
- **`ipservice` 3** is MaxMind in AdCOM 1.0's List: IP Location Services.
- **Scheduled refresh** is opt-in through `@sharedid-edge/data-updates`'s `maxmindSource` and `countrySnapshotModule` (`ipservice: 3`), outside this offline module's execution. The updater alone gets its `SID_MODULE_SECRETS.maxmind` (`accountId`, `licenseKey`); snapshots carry no key. Pass `DATA_INFO` into the bundled module for optional `maxAgeDays`. The updater deletes superseded snapshot bodies after publishing (section 6.3: old releases gone within 30 days); keep that, and document an `expireAfterMs` of at most 30 days.
- **Size numbers** in the README are DB-IP's until someone measures a real GeoLite2 release. Replace them when you do.
