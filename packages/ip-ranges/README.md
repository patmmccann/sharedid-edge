# @sharedid-edge/ip-ranges

For opt-in runtime snapshots, [@sharedid-edge/data-updates](../data-updates/README.md) reuses this package's MMDB conversion and lookup code. `buildCountryData` returns the encoded `data` as well as its generated module source. `ipDatabaseModule` accepts `info` and an optional `now` clock; modules can configure positive `maxAgeDays` to add a `stale: true` report flag based on the database's publication date, while retaining last-good output. No downloader is added to this package's request entry point.

Compact IP range tables for [SharedID Edge](../../README.md)'s IP database modules, such as [`dbip`](../vendor-modules/dbip/README.md). A module's build script turns a vendor's database (an [MMDB](https://maxmind.github.io/MaxMind-DB/) file, as DB-IP and MaxMind publish) into a small table of what the module returns, the country of each address range; the module bundles it and looks addresses up in memory, with no network access.

You don't use this package directly to deploy: it's a dependency of the modules. It's for the people writing them.

## What's in it

| Import | Runs | What |
| --- | --- | --- |
| `@sharedid-edge/ip-ranges` | In the worker | `decodeRangeTable`, `lookupRange`; `ipDatabaseModule`, a module that returns the country as `ortb2.device.geo` with a `mode` (`fill` or `replace`) setting; `geoMode`; `countryFor` |
| `@sharedid-edge/ip-ranges/build` | At build time | `MmdbReader`, a dependency-free MMDB reader; `buildRangeTable` and `encodeRangeTable`; `buildCountryData`, which turns a downloaded file (`.mmdb`, `.mmdb.gz` or MaxMind's `.tar.gz`) into a module's data file; `writeMmdb`, for test fixtures; `FIXTURE_TABLE` |

Both use web-standard APIs only, like core.

## The table

The address space split into ranges, each with a value or none, stored as delta-encoded range starts and a value per range (the format is documented on `RangeTable` in [`src/table.ts`](src/table.ts)):

- **IPv4:** exact; a range starts on any address.
- **IPv6:** keyed by /64. A /64 split between values in the database takes the value of its first address; `buildRangeTable` reports how many networks that changes (`v6SubPrefixesFolded`).
- **Adjacent ranges with the same value are merged,** and `decodeRangeTable` checks the table before a module uses it.

A module decodes its table once, when the worker starts, into typed arrays; a lookup is a binary search. Each module's README gives the sizes of its tables.

## An IP database module

```ts
import { ipDatabaseModule } from '@sharedid-edge/ip-ranges';
import { DATA } from './data.js'; // written by the module's build script

export const exampleModule = ipDatabaseModule({ name: 'example', data: DATA, ipservice: 3 });
```

`ipservice` is the vendor's value in AdCOM 1.0's List: IP Location Services, if it has one. The module returns `{ "device": { "geo": { "type": 2, "country": "FRA" } } }`; with `{"mode":"fill"}` (the default) only when the platform gave the `geo` module no country. See the [`dbip` README](../vendor-modules/dbip/README.md#with-the-geo-module-fill-or-replace).
