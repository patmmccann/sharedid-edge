# packages/ip-ranges

User documentation is in [README.md](README.md) (also the npm package page). The rules for the modules that use it are in [`../modules/AGENTS.md`](../modules/AGENTS.md) and [`../vendor-modules/AGENTS.md`](../vendor-modules/AGENTS.md).

`@sharedid-edge/ip-ranges`: what IP database vendor modules (`dbip`, and MaxMind's to come) share, so they don't copy code (vendor modules are outside `check:duplication`). Not a module itself: it has no `sharedidEdge` block and isn't in the module index.

- **Two entry points.** `.` is what runs in the worker: `decodeRangeTable`, `lookupRange` and `ipDatabaseModule`. `./build` adds what runs at build time: the MMDB reader, `buildRangeTable`, `encodeRangeTable`, `buildCountryData`, gunzip and tar, and `writeMmdb` for fixtures. Keep build-time code out of `.`, so bundles don't carry it.
- **Platform-neutral, both entry points:** `lib: ["ES2023", "WebWorker"]`, web APIs only (`DecompressionStream`, `atob`), no Node.js built-ins. Vendor build scripts do the file and network I/O.
- **The table format is versioned** (`RANGE_TABLE_VERSION`). A change to it bumps the version, and `decodeRangeTable` rejects other versions: a module's data file and its code must come from the same build.
- **Validate untrusted input.** The MMDB file comes from a download; the reader bounds-checks every read and throws on anything malformed. `decodeRangeTable` rejects tables that don't increase or have out-of-range values.
- **Output follows the `geo` module:** alpha-3 countries (`alpha3` from `@sharedid-edge/module-geo`), `type` 2, coarse location only. Precise fields, if a module ever adds them, follow `preciseLocationDenial`.
- **Scheduled data:** `buildCountryData` also returns the encoded `data` string, so the separate `@sharedid-edge/data-updates` package can publish JSON without parsing or executing generated JavaScript. The request entry point still imports no downloader. Bundled modules may opt into `maxAgeDays` (positive finite number) against `DataInfo.built`: old data reports `stale`, even on a miss, and retains its normal output. `info` and an optional clock belong to `IpDatabaseModuleOptions`; missing dates with an age configured are errors.
- **Tests** build MMDB files with `writeMmdb` (24-, 28- and 32-bit records, IPv4 aliases, pointers) and check lookups at range boundaries. Never commit a vendor's database or a slice of one: the fixture (`FIXTURE_TABLE`) is hand-made and covers documentation addresses only.
