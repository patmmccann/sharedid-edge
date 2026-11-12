# packages/vendor-modules/dbip

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../../modules/AGENTS.md`](../../modules/AGENTS.md), and those for vendor modules, which this is, in [`../AGENTS.md`](../AGENTS.md).

The `dbip` module (`@sharedid-edge/module-dbip`): the visitor's country from DB-IP's IP to Country Lite database (CC BY 4.0), as `ortb2.device.geo.country`. Maintained by the project. Issue #12. Its behaviour is specified in [`spec/modules/dbip.md`](../../../spec/modules/dbip.md): change it with the code.

- **Offline: data at build time.** `scripts/build-data.mjs` (`npm run data`) downloads the month's MMDB from `download.db-ip.com`, or reads `--file`, and writes `dist/data.js`, replacing what TypeScript compiled from `src/data.ts`, the fixture. Requests never touch the network: keep `network: "none"`. The build script is the only code here that downloads anything, and tests never run it with the network (they use `--file` with a generated database).
- **No DB-IP data in the repository**, not even a slice. `src/data.ts` is the hand-made fixture from `@sharedid-edge/ip-ranges` (`FIXTURE_TABLE`, documentation addresses only); the test checks it matches. Change the fixture there, not here.
- **The logic lives in [`@sharedid-edge/ip-ranges`](../../ip-ranges/AGENTS.md):** the MMDB reader, the table format, `buildCountryData` and the module (`ipDatabaseModule`: lookup, `mode`, output). This package holds only what's DB-IP's: the download URL, the database type check, the attribution and the module name. Don't copy code between this and other IP database modules; extend the shared package.
- **No `ipservice`:** DB-IP isn't on AdCOM 1.0's IP Location Services list. Add it if AdCOM adds DB-IP.
- **Attribution:** `DBIP_ATTRIBUTION` goes into every data file and `DATA_INFO`; the README says where DB-IP asks for it on web pages. Keep both if DB-IP's terms change.
- **Size and accuracy numbers in the README** come from a real release: re-measure with `npm run data` and a bundle when the format or the code changes.
