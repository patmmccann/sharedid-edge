# @sharedid-edge/module-dbip

The `dbip` module for [SharedID Edge](../../../README.md): the visitor's country from [DB-IP](https://db-ip.com)'s free **IP to Country Lite** database, as `ortb2.device.geo.country` in the `/_sid/v1` payload.

The [`geo`](../../modules/geo/README.md) module sends the location your CDN or platform gives the worker. Some platforms give none (the Node.js server without location headers, Google Cloud without a country, a CDN that doesn't know an address), and some publishers want the same database everywhere. This module looks the client IP up in DB-IP's data, **built into the bundle at build time**: lookups happen in memory, nothing is fetched while answering a request, and nothing about the visitor leaves the worker.

> **The data is DB-IP's, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).** No account or key is needed, but DB-IP requires attribution: see [Data and licence](#data-and-licence). The package ships without real data; you build it in with `npm run data` ([Turning it on](#turning-it-on)).

## Contents

- [Turning it on](#turning-it-on)
- [Response](#response)
- [With the geo module: fill or replace](#with-the-geo-module-fill-or-replace)
- [Consent](#consent)
- [Settings](#settings)
- [Data and licence](#data-and-licence)
- [Keeping the data up to date](#keeping-the-data-up-to-date)
- [Size](#size)
- [What it doesn't do (yet)](#what-it-doesnt-do-yet)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

`dbip` is a [vendor module](../README.md): it isn't built into the adapters. You build DB-IP's data into it, add it to your build, then list it in `SID_MODULES`. Until it's added, `SID_MODULES=dbip` only reports it as `skipped` (`not installed`).

1. **Build the data in.** From the repository, after `npm run build`:

   ```sh
   npm run data -w @sharedid-edge/module-dbip
   ```

   This downloads this month's `dbip-country-lite-YYYY-MM.mmdb.gz` from `download.db-ip.com` (last month's, early in a month before the new release is out), keeps only the country of each address range, and writes the table to `packages/vendor-modules/dbip/dist/data.js`, replacing the fixture the package ships with. It prints the release, the number of ranges and the file's size. Options, after `--`:

   | Option | What |
   | --- | --- |
   | `--month 2026-11` | A given monthly release |
   | `--file <path>` | A `.mmdb` or `.mmdb.gz` you downloaded yourself (from [db-ip.com/db/download/ip-to-country-lite](https://db-ip.com/db/download/ip-to-country-lite)); no network access |
   | `--ipv4-only` | Leave IPv6 out: a smaller bundle ([Size](#size)), and IPv6 visitors get no country |
   | `--fixture` | Put the fixture back |

   Run it after `npm run build`, not before: the TypeScript build writes the fixture's `dist/data.js`, and a clean build (`tsc -b --clean`, or deleting `dist/`) puts the fixture back. The data file is in `dist/`, which git ignores, so it's never committed.

2. **Add the module to your build,** as `@sharedid-edge/module-dbip#dbipModule`:

   | Platform | How |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-dbip#dbipModule`, then `npx wrangler deploy .sharedid-modules/worker.ts` |
   | AWS Lambda, Vercel, Azure Functions, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-dbip#dbipModule` in place of `npm run bundle` |
   | Node.js server | `SID_MODULE_PACKAGES=@sharedid-edge/module-dbip#dbipModule` |
   | Cloudflare Snippet | Not available: the data doesn't fit a Snippet's 32 KB |

   The bundle size the build prints includes the data: check it against your platform's limit ([Size](#size)).

3. **Turn it on** with `SID_MODULES`, after `geo` if you use both: `SID_MODULES=geo,dbip`. To have DB-IP's country win over your CDN's, add `SID_MODULE_CONFIG={"dbip":{"mode":"replace"}}` ([fill or replace](#with-the-geo-module-fill-or-replace)).

4. **Credit DB-IP** where the licence asks ([Data and licence](#data-and-licence)).

5. **Check it:** `curl -s https://www.example.com/_sid/v1` from a network your CDN doesn't locate, or with `mode` `replace`, shows `ortb2.device.geo.country` and `"dbip":{"status":"ok"}` in `ext.modules`.

## Response

The country is [OpenRTB 2.6](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/main/2.6.md)'s `device.geo.country`, ISO 3166-1 alpha-3 as the `geo` module sends it, with `type` 2 (derived from the IP address). DB-IP isn't on AdCOM 1.0's [List: IP Location Services](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/main/AdCOM%20v1.0%20FINAL.md#list_iplocationservices) (ip2location, Neustar, MaxMind, NetAcuity and 51Degrees are), so there's no `ipservice`.

When it finds a country:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "geo": { "type": 2, "country": "FRA" } } },
  "ext": { "modules": { "dbip": { "ms": 0, "status": "ok" } } }
}
```

When it adds nothing (the address isn't in the data, the client IP is unknown, DB-IP's code has no ISO alpha-3 code, such as `XK` for Kosovo, or in `fill` mode the CDN already gave a country), it's `empty` and there's no `ortb2` from it:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "dbip": { "ms": 0, "status": "empty" } } }
}
```

## With the geo module: fill or replace

Modules' output is merged in `SID_MODULES` order, later modules over earlier ones. The `mode` setting says what `dbip` adds:

| `mode` | What `dbip` sends | Use it |
| --- | --- | --- |
| `fill` (the default) | The country only when the platform gave the worker none that `geo` could send (none, or one without an alpha-3 code such as Tor's `T1`). It never contradicts `geo`, so the order doesn't matter. | With `geo`, to cover the requests your CDN can't locate. |
| `replace` | DB-IP's country, always. List `dbip` **after** `geo` (`SID_MODULES=geo,dbip`), so its country wins. | When you want DB-IP's country rather than your CDN's, or without `geo`. |

With `replace`, only the country is DB-IP's: `geo`'s other fields (`region`, `metro`, `utcoffset`, and the precise ones) still come from the CDN, and can describe another country when the two disagree. If that matters, set `geo` to `{"precision":"coarse"}` or turn `geo` off. **Without `geo`, use `replace`:** in `fill` mode the module sends nothing for any request the platform has located.

## Consent

The country is coarse location, so it's sent whatever the consent signals, as `geo` sends the CDN's country: under GPC, COPPA, a US privacy opt-out and GDPR alike. The module sends nothing precise (no region, city, postal code or coordinates), so core's `preciseLocationDenial` rules don't come into it. It declares no `gvlid` and no TCF purposes: it acts for the publisher, with data built into the publisher's own worker; nothing is sent to DB-IP. What the module returns never changes the worker's consent decisions, which come from the request and the platform.

The address is looked up in memory and the country echoed back to the same browser; nothing is stored or logged.

## Settings

`SID_MODULE_CONFIG`, under `dbip`:

| Setting | Values | Default |
| --- | --- | --- |
| `mode` | `fill` or `replace` ([above](#with-the-geo-module-fill-or-replace)) | `fill` |

An unknown setting or another `mode` makes the module report `error` and add nothing. It has no secrets, and its build needs no key.

## Data and licence

DB-IP publishes [IP to Country Lite](https://db-ip.com/db/download/ip-to-country-lite) monthly, free, under the [Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/) ([db-ip.com/db/lite.php](https://db-ip.com/db/lite.php)). The terms, as DB-IP states them on that page (read them yourself; this isn't legal advice):

- **Attribution to DB-IP.com is required.** For web applications, DB-IP asks that pages that display or use results from the database link back to DB-IP, and suggests `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>`. Pages that send the country to bidders use its results, so put that link on your site, in its footer or privacy page for example.
- **The table built into your bundle is an adaptation** (country ranges only). If you share it (a published bundle, say), CC BY 4.0 asks you to credit DB-IP, link the licence and say it was changed. The data file starts with a comment that credits DB-IP, and `DBIP_DATA_INFO.attribution` holds the credit, but your bundler may strip comments.
- **This repository holds no DB-IP data.** The package ships with a small hand-made fixture for documentation addresses only; your build downloads the data.

The download page lists each file's SHA-1 and MD5 for the uncompressed `.mmdb`: to check a file before building it in, download it yourself, compare `sha1sum`, and pass it with `--file`. The build checks the file is DB-IP's country database (`DBIP-Country-Lite` in its metadata) and fails on anything else.

## Keeping the data up to date

DB-IP publishes a new release at the start of each month. Rebuild and redeploy monthly: a scheduled CI job that runs `npm run build`, `npm run data -w @sharedid-edge/module-dbip` and your deploy step is enough. Downloads happen at build time only, never while the worker answers requests. `DBIP_DATA_INFO` says which release is built in ([Using it in code](#using-it-in-code)).

## Size

The table is compact (sorted range starts, delta-encoded, and a country per range), but it's still much bigger than the worker: it's what you trade for no network calls. Measured with the November 2026 release (`dbip-country-lite-2026-11`: 251 countries) and this repository's build (esbuild, minified), as the increase over the bundle without the module:

| Build | Ranges | Adds, minified | Adds, gzipped | Memory when loaded | Decode at startup |
| --- | --- | --- | --- | --- | --- |
| IPv4 and IPv6 (default) | 362,999 IPv4, 369,646 IPv6 | 3.8 MB | 865 KB | about 10 MB: the 3.8 MB string and 5.1 MB of arrays | about 55 ms |
| `--ipv4-only` | 362,999 IPv4 | 1.5 MB | 524 KB | about 4 MB: 1.5 MB and 1.8 MB | about 35 ms |
| The module without data (the fixture) | 8 IPv4, 4 IPv6 | 3.6 KB | 1.4 KB | negligible | negligible |

- **Memory** is the table decoded into typed arrays when the worker starts, plus the encoded string, which stays in the bundle. Decode time is from Node.js 24 on a laptop; edge CPUs differ.
- **Platform limits:** Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (November 2026) give "Worker size (uncompressed): 64 MiB" on both Workers Free and Paid, say "There is no compressed size limit. Only the uncompressed bundle size counts.", and allow 1 second to run the global scope and 128 MB of memory per isolate; `wrangler deploy --dry-run` reported 3788 KiB (864 KiB gzipped) for the Worker with the full table. AWS Lambda and Vercel Functions allow 250 MB unzipped. A Cloudflare Snippet's 32 KB can't hold it. The project's [32 KB budget](../../adapters/AGENTS.md) is for the default bundles and isn't enforced with opt-in modules.
- **Measure your own build:** the bundled adapters print the gzipped size (`Lambda bundle with @sharedid-edge/module-dbip: deploy/lambda.mjs, 885627 bytes gzipped`, and the file's size in `deploy/`); for the Worker, `npx wrangler deploy .sharedid-modules/worker.ts --dry-run --outdir dist-dry` prints the total upload. `npm run data` prints the data file's size.
- **Accuracy of the slimmed table:** IPv4 lookups give exactly what the database gives. IPv6 is keyed by /64 (the size of a typical subscriber's network), so a /64 that DB-IP splits between countries takes the country of its first address. In the November 2026 release, 18,343 networks smaller than a /64 have a country other than their /64's first address. Checked against the database itself, 49 of 300,000 IPv6 addresses sampled near the table's range starts got a different country; all 300,000 sampled IPv4 addresses matched.

## What it doesn't do (yet)

- **Network data (ASN, organization):** DB-IP's free **IP to ASN Lite** database has them, but OpenRTB has no field for them yet; where to put them is an open question in [#12](https://github.com/patmmccann/sharedid-edge/issues/12). Built the same way, the ASN table would add about 4.4 MB minified, 1.7 MB gzipped.
- **City and region:** DB-IP's City Lite is too big to build into a bundle. Reading it from platform storage (R2, a file next to the function) is planned.
- **Proxy and hosting flags:** the Lite databases don't have them. Modules that do will report them through the [traffic signal](../../modules/AGENTS.md#reporting-traffic-bots-proxies-internal-visitors).

## Using it in code

```ts
import { builtInModules } from '@sharedid-edge/modules';
import { dbipModule, DBIP_DATA_INFO } from '@sharedid-edge/module-dbip';

const modules = [...builtInModules, dbipModule];
console.log(DBIP_DATA_INFO); // { database: 'dbip-country-lite-2026-11', built: '2026-11-01', families: 'ipv4,ipv6', fixture: false, ... }
```

The lookup and the table format are in [`@sharedid-edge/ip-ranges`](../../ip-ranges/README.md), shared with the other IP database modules.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `dbip` is `skipped`, `not installed` | It isn't in your build: step 2 of [Turning it on](#turning-it-on). |
| `dbip` is `empty` for every visitor | The fixture is built in, not DB-IP's data: `DBIP_DATA_INFO.fixture` is `true`. Run `npm run data -w @sharedid-edge/module-dbip` after `npm run build`, then bundle again. Or `fill` mode with a CDN that locates every request, or no `geo`: see [fill or replace](#with-the-geo-module-fill-or-replace). |
| `dbip` is `empty` for some visitors | Their address isn't in DB-IP's data, has a code without an ISO alpha-3 code, or is IPv6 in an `--ipv4-only` build. Or the worker doesn't see the client IP: check `ip` or `X-Forwarded-For` handling for your adapter. |
| `dbip` is `error` | An invalid setting: `mode` must be `fill` or `replace`, and there are no other settings. |
| `npm run data` fails with `No DB-IP release found` | db-ip.com didn't answer, or has no release for the month: try `--month` with last month, or download the file yourself and use `--file`. |
| `npm run data` fails with `Unexpected database type` | The file isn't IP to Country Lite (an ASN or City file, say). |
| The country disagrees with `geo`'s region or city | `replace` mode with `geo` on: [fill or replace](#with-the-geo-module-fill-or-replace). |
