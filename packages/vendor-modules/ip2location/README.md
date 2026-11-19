# @sharedid-edge/module-ip2location

The `ip2location` module for [SharedID Edge](../../../README.md): the visitor's country from [IP2Location](https://www.ip2location.com)'s free **LITE DB1** database, as `ortb2.device.geo.country` with `ipservice` 1, and proxy signals from **IP2Proxy LITE PX10**, as `ortb2.device.ext.traffic`, in the `/_sid/v1` payload.

It works like the [`dbip`](../dbip/README.md) and [`maxmind`](../maxmind/README.md) modules for the country, and adds the traffic signal from issue #5. Both databases are **downloaded with your free IP2Location download token at build time** and built into the bundle. Lookups happen in memory, nothing is fetched while answering a request, and nothing about the visitor leaves the worker. **The token is used only by the build and never ships:** the bundled adapters' builds fail if a bundle contains it.

> **IP2Location LITE is free with a link back.** The [LITE terms](https://www.ip2location.com/lite-terms) require attribution, and the data is refreshed on the 1st and 15th of each month, so rebuild regularly. See [Data and licence](#data-and-licence). The package ships without real data.

## Contents

- [Turning it on](#turning-it-on)
- [The download token](#the-download-token)
- [Response](#response)
- [With the geo module: fill or replace](#with-the-geo-module-fill-or-replace)
- [Traffic signals](#traffic-signals)
- [Consent](#consent)
- [Settings](#settings)
- [Data and licence](#data-and-licence)
- [Keeping the data up to date](#keeping-the-data-up-to-date)
- [Size](#size)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

`ip2location` is a [vendor module](../README.md): it isn't built into the adapters. Until it's added, `SID_MODULES=ip2location` only reports it as `skipped` (`not installed`).

1. **Get a download token:** register for a free account at [ip2location.com/database/lite](https://www.ip2location.com/database/lite), then copy the download token from your account's download area. One token covers LITE DB1 and IP2Proxy LITE PX10.

2. **Build the data in.** From the repository, after `npm run build`, with the token in your build's environment:

   ```sh
   IP2LOCATION_DOWNLOAD_TOKEN=... npm run data -w @sharedid-edge/module-ip2location
   ```

   This:
   - downloads `DB1LITEMMDB` and `PX10LITEMMDB` from `www.ip2location.com/download`;
   - unpacks the ZIP archives, keeps only the country of each DB1 range and the proxy kinds of each PX10 range;
   - writes both tables to `packages/vendor-modules/ip2location/dist/data.js`, replacing the fixtures the package ships with.

   It prints both releases' dates, their range counts and the file's size. Options, after `--`:

   | Option | What |
   | --- | --- |
   | `--file <path>` | A DB1 `.zip` or `.mmdb` you downloaded yourself (from your account's download area). It needs no token and no network access for the country. |
   | `--proxy-file <path>` | The same for PX10, including a commercial `PX10MMDB` download. |
   | `--ipv4-only` | Leave IPv6 out: a smaller bundle ([Size](#size)), and IPv6 visitors get no country or signal. |
   | `--fixture` | Put the fixtures back. |

   Run it after `npm run build`, not before: the TypeScript build writes the fixtures' `dist/data.js`, and a clean build puts them back. The data file is in `dist/`, which git ignores, so it's never committed.

3. **Add the module to your build,** as `@sharedid-edge/module-ip2location#ip2locationModule`:

   | Platform | How |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`, run `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-ip2location#ip2locationModule`, then `npx wrangler deploy .sharedid-modules/worker.ts`. |
   | AWS Lambda, Vercel, Azure Functions, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-ip2location#ip2locationModule`, in place of `npm run bundle`. |
   | Node.js server | `SID_MODULE_PACKAGES=@sharedid-edge/module-ip2location#ip2locationModule` |
   | Cloudflare Snippet | Not available: the data doesn't fit a Snippet's 32 KB. |

4. **Turn it on** with `SID_MODULES`, after `geo` if you use both: `SID_MODULES=geo,ip2location`. To have IP2Location's country win over your CDN's, add `SID_MODULE_CONFIG={"ip2location":{"mode":"replace"}}`.

5. **Credit IP2Location** ([Data and licence](#data-and-licence)), and **schedule a rebuild** ([Keeping the data up to date](#keeping-the-data-up-to-date)).

## The download token

`IP2LOCATION_DOWNLOAD_TOKEN` is a **build-time credential** (`buildCredentials` in the package's `sharedidEdge` block):

- **Where it's used:** only `scripts/build-data.mjs` reads it, from the environment, and puts it in the download URL for `www.ip2location.com/download`. Errors name the file code (`DB1LITEMMDB`, `PX10LITEMMDB`), never the URL or the token.
- **What it's not:** it's never a setting or secret of the worker (`SID_MODULE_SECRETS`), never written to the data file, and never printed, errors included.
- **The data file holds** the two tables and their descriptions (`IP2LOCATION_DATA_INFO`, `IP2PROXY_DATA_INFO`). The script refuses to write it if it would contain the token.
- **Every bundle is checked:** the bundled adapters run [`scripts/check-build-secrets.mjs`](../../../scripts/check-build-secrets.mjs) on every bundle they build. A bundle containing the token (as is, or base64-, hex- or URI-encoded) fails the build, as long as the token is in the environment of that build. Values shorter than 8 characters aren't checked.
- **Keep the token out of the worker's environment:** set it in your CI's secret store for the build step only, not as a Worker variable or secret.

## Response

The country is [OpenRTB 2.6](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/main/2.6.md)'s `device.geo.country`: ISO 3166-1 alpha-3, as the `geo` module sends it, with `type` 2 (derived from the IP address), and `ipservice` 1: IP2Location's value in AdCOM 1.0's [List: IP Location Services](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/main/AdCOM%20v1.0%20FINAL.md#list_iplocationservices). The proxy signal is core's `ortb2.device.ext.traffic`, merged with any other module's and the platform's.

When it finds a country and a proxy signal:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": {
    "device": {
      "geo": { "type": 2, "country": "FRA", "ipservice": 1 },
      "ext": { "traffic": { "proxy": "vpn", "sources": ["ip2location"] } }
    }
  },
  "ext": { "modules": { "ip2location": { "ms": 0, "status": "ok" } } }
}
```

Either half can be missing on its own. When it adds nothing, it's `empty` and there's no `ortb2` from it:
- the address isn't in the data;
- the client IP is unknown;
- the code has no ISO alpha-3 code, and PX10 names no proxy kind;
- or, for the country in `fill` mode, the CDN already gave a country.

The country is DB1's own: where IP2Location places the address. Nothing precise (region, city, coordinates) is used.

## With the geo module: fill or replace

Modules' output is merged in `SID_MODULES` order, later modules over earlier ones. The `mode` setting says what `ip2location` adds for the country, as in the `dbip` module ([details](../dbip/README.md#with-the-geo-module-fill-or-replace)):

| `mode` | What `ip2location` sends | Use it |
| --- | --- | --- |
| `fill` (the default) | The country only when the platform gave the worker none that `geo` could send. It never contradicts `geo`. | With `geo`, to cover the requests your CDN can't locate. |
| `replace` | IP2Location's country, always. List `ip2location` **after** `geo` (`SID_MODULES=geo,ip2location`). | When you want IP2Location's country rather than your CDN's, or without `geo`. |

`ipservice` 1 is only sent with IP2Location's country. In `replace` mode with `geo` on, `geo`'s other fields (`region`, `metro`, `utcoffset`, and the precise ones) still come from the CDN: `ipservice` then describes the country only. **Without `geo`, use `replace`.** The traffic signal is independent of `mode` and is sent whichever one is configured.

## Traffic signals

IP2Proxy PX10's MMDB uses the GeoIP2-Anonymous-IP field layout: its records carry booleans, not a proxy type string. The module maps them to core's `proxy` kinds:

| PX10 field | `traffic.proxy` |
| --- | --- |
| `is_tor_exit_node` | `tor` |
| `is_residential_proxy` | `residential` |
| `is_anonymous_vpn` | `vpn` |
| `is_public_proxy` | `public` |
| `is_hosting_provider` | `datacenter` |

A record with several flags keeps the most specific kind, in that order (the order core's merge uses). `is_anonymous` on its own names no kind and is not used. The module reports a proxy kind only: it never sets `bot` or `botKind`. An IP database cannot tell a bot from a person on a proxy or a hosting address, and with `SID_SKIP_BOTS` configured that would withhold SharedIDs from real visitors.

**LITE PX10 is a public-proxy subset.** The free edition contains public proxies only; VPN, Tor, hosting provider and residential proxy coverage is in the commercial PX10 edition. With LITE data, expect `public` for most signals, with the others only where IP2Proxy's LITE release carries them. To use the full dataset, download `PX10MMDB` (not `PX10LITEMMDB`) from your account and build it with `--proxy-file`; the module reads either, and the licence is the commercial one, which you must check yourself.

## Consent

The country is coarse location, and the proxy signal describes the network, not the person. Both are sent whatever the consent signals, as `geo` sends the CDN's country. The module sends nothing precise, so core's `preciseLocationDenial` rules don't come into it.

It declares no `gvlid` and no TCF purposes: it acts for the publisher, with data built into the publisher's own worker, and nothing is sent to IP2Location. What the module returns never changes the worker's consent decisions. Nothing is stored or logged.

## Settings

`SID_MODULE_CONFIG`, under `ip2location`:

| Setting | Values | Default |
| --- | --- | --- |
| `mode` | `fill` or `replace` | `fill` |
| `maxAgeDays` | Positive number: report `stale` when either bundled database's publication date is older than this many days; keep the last good output | off |

An unknown setting, another `mode`, or an invalid `maxAgeDays` makes the module report `error`.

| Build environment | What |
| --- | --- |
| `IP2LOCATION_DOWNLOAD_TOKEN` | Your free IP2Location download token, for `npm run data`. A [build-time credential](#the-download-token): it never reaches the worker. |

## Data and licence

IP2Location LITE and IP2Proxy LITE are free under the [LITE terms](https://www.ip2location.com/lite-terms). Read them yourself; this isn't legal advice. The points that matter here:

- **Attribution.** Credit IP2Location on your site (a footer or privacy page) and in documentation about the feature, for example "This site or product includes IP2Location LITE data available from [https://lite.ip2location.com](https://lite.ip2location.com)", and the same for IP2Proxy LITE. `IP2LOCATION_ATTRIBUTION` and `IP2PROXY_ATTRIBUTION`, and the data file's first line, hold those texts.
- **No redistribution.** Don't publish the tables or share the downloads; they stay in your own deployment.
- **Updates.** LITE is refreshed on the 1st and 15th of each month. Rebuild and redeploy regularly ([below](#keeping-the-data-up-to-date)).
- **Use.** Not for identifying or locating a specific household, individual or street address. A country in an ad request is neither.
- **This repository holds no IP2Location or IP2Proxy data.** The package ships with small hand-made fixtures for documentation addresses only.

The build checks each download is a ZIP with the expected database type in its metadata, and rejects anything else. There's no published checksum for the token download, so the ZIP's structure and the MMDB metadata are what's checked.

## Keeping the data up to date

IP2Location publishes LITE on the 1st and 15th of each month. Run a scheduled CI job, twice a month for example: `npm run build`, `npm run data -w @sharedid-edge/module-ip2location` with the token from your CI's secrets, then your deploy step. Downloads happen at build time only, never while the worker answers requests.

Download once per build and reuse the ZIPs with `--file` and `--proxy-file` if you build several bundles; the token is one per account and IP2Location may rate-limit repeated downloads.

## Size

**Not measured yet, for the code or the data:** the project has no IP2Location token in CI, and the data can't be committed. The module's code is about the same as `maxmind`'s (3.7 KB minified, 1.4 KB gzipped, measured on the Lambda bundle with the fixture), plus the traffic table's decoder. The data is the same table format as `dbip`'s ([`@sharedid-edge/ip-ranges`](../../ip-ranges/README.md)); its size depends on the releases.

As a guide, DB-IP's country database built the same way ([`dbip` Size](../dbip/README.md#size)) adds:

| Build | Adds, minified | Adds, gzipped | Memory when loaded |
| --- | --- | --- | --- |
| IPv4 and IPv6 (default) | 3.8 MB | 865 KB | about 10 MB |
| `--ipv4-only` | 1.5 MB | 524 KB | about 4 MB |

The proxy table is usually smaller than the country table: most addresses are not proxies, and each value is a short code. `npm run data` prints the data file's raw and gzipped size, which is the number to use.

**Measure yours:**
- `npm run data` prints the data file's size, raw and gzipped;
- the bundled adapters print the bundle's gzipped size;
- for the Worker, run `npx wrangler deploy .sharedid-modules/worker.ts --dry-run --outdir dist-dry`.

**Platform limits:**
- **Cloudflare Workers:** the [limits page](https://developers.cloudflare.com/workers/platform/limits/) (November 2026) gives "Worker size (uncompressed): 64 MiB" on both Workers Free and Paid, says "There is no compressed size limit. Only the uncompressed bundle size counts.", and allows 1 second to run the global scope and 128 MB of memory per isolate.
- **AWS Lambda and Vercel Functions:** 250 MB unzipped.
- **Cloudflare Snippets:** can't hold it.

Both tables key IPv6 by /64, as in `dbip`: a /64 that the database splits takes the value of its first address.

## Using it in code

```ts
import { builtInModules } from '@sharedid-edge/modules';
import { ip2locationModule, IP2LOCATION_DATA_INFO, IP2PROXY_DATA_INFO } from '@sharedid-edge/module-ip2location';

const modules = [...builtInModules, ip2locationModule];
console.log(IP2LOCATION_DATA_INFO); // { database: 'IP2Location-LITE-DB1-2026-11-15', built: '2026-11-15', ... }
console.log(IP2PROXY_DATA_INFO);    // { database: 'IP2Proxy-LITE-PX10-2026-11-15', built: '2026-11-15', ... }
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ip2location` is `skipped`, `not installed` | It isn't in your build: step 3 of [Turning it on](#turning-it-on). |
| `ip2location` is `empty` for every visitor | The fixtures are built in, not IP2Location's data (`IP2LOCATION_DATA_INFO.fixture` is `true`): run `npm run data` after `npm run build`, then bundle again. Or `fill` mode with a CDN that locates every request, or no `geo`. |
| `ip2location` is `error` | Check that `mode` is `fill` or `replace` and `maxAgeDays` is positive. If you supply your own tables in code and set `maxAgeDays`, check the publication dates on both tables. |
| No `traffic` in the payload | The address isn't a proxy in the data, or it's in LITE PX10's public-proxy subset only and named no kind. LITE coverage is narrower than the commercial PX10 ([Traffic signals](#traffic-signals)). |
| `npm run data` says `Set IP2LOCATION_DOWNLOAD_TOKEN` | Set the token in the build's environment, or use `--file` and `--proxy-file`. |
| `npm run data` fails with `IP2Location rejected the download token` | The token is wrong or expired: copy it again from your account. |
| `npm run data` fails with `not a ZIP archive` | The download was refused or cut short: check the token and run it again. |
| `npm run data` fails with `Unexpected database type` | The file isn't the LITE DB1 or a PX10 MMDB; check which download it is. |
| The build fails with `contains the build-time credential IP2LOCATION_DOWNLOAD_TOKEN` | The token ended up in a bundle: don't put it in `SID_*` settings or your own code; set it only for the data step. |
