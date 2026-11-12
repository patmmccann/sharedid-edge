# @sharedid-edge/module-maxmind

The `maxmind` module for [SharedID Edge](../../../README.md): the visitor's country from [MaxMind](https://www.maxmind.com)'s free **GeoLite2 Country** database, as `ortb2.device.geo.country`, with `ipservice` 3 (MaxMind), in the `/_sid/v1` payload.

It works like the [`dbip`](../dbip/README.md) module, with MaxMind's data. The database is **downloaded with your MaxMind account ID and licence key at build time** and built into the bundle. Lookups happen in memory, nothing is fetched while answering a request, and nothing about the visitor leaves the worker. **The key is used only by the build and never ships:** the bundled adapters' builds fail if a bundle contains it.

> **You need a free MaxMind account and must accept the [GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula).** It requires attribution, and requires you to stop using a release within 30 days of a newer one, so rebuild regularly. See [Data and licence](#data-and-licence). The package ships without real data.

## Contents

- [Turning it on](#turning-it-on)
- [The licence key](#the-licence-key)
- [Response](#response)
- [With the geo module: fill or replace](#with-the-geo-module-fill-or-replace)
- [Consent](#consent)
- [Settings](#settings)
- [Data and licence](#data-and-licence)
- [Keeping the data up to date](#keeping-the-data-up-to-date)
- [Size](#size)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

`maxmind` is a [vendor module](../README.md): it isn't built into the adapters. Until it's added, `SID_MODULES=maxmind` only reports it as `skipped` (`not installed`).

1. **Get an account ID and a licence key:**
   - sign up for GeoLite at [maxmind.com/en/geolite2/signup](https://www.maxmind.com/en/geolite2/signup), accepting the EULA;
   - then, under **Manage License Keys** in your account, create a key;
   - your account ID is shown on the same page.

2. **Build the data in.** From the repository, after `npm run build`, with both in your build's environment:

   ```sh
   MAXMIND_ACCOUNT_ID=123456 MAXMIND_LICENSE_KEY=... npm run data -w @sharedid-edge/module-maxmind
   ```

   This:
   - downloads the latest `GeoLite2-Country` `.tar.gz` and its SHA-256 from `download.maxmind.com`, and checks one against the other;
   - keeps only the country of each address range;
   - writes the table to `packages/vendor-modules/maxmind/dist/data.js`, replacing the fixture the package ships with.

   It prints the release date, the number of ranges and the file's size. Options, after `--`:

   | Option | What |
   | --- | --- |
   | `--file <path>` | A `GeoLite2-Country` `.tar.gz` or `.mmdb` you downloaded yourself (from your account's **Download Databases** page). It needs no credentials and no network access. |
   | `--ipv4-only` | Leave IPv6 out: a smaller bundle ([Size](#size)), and IPv6 visitors get no country. |
   | `--fixture` | Put the fixture back. |

   Run it after `npm run build`, not before: the TypeScript build writes the fixture's `dist/data.js`, and a clean build puts it back. The data file is in `dist/`, which git ignores, so it's never committed.

3. **Add the module to your build,** as `@sharedid-edge/module-maxmind#maxmindModule`:

   | Platform | How |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`, run `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-maxmind#maxmindModule`, then `npx wrangler deploy .sharedid-modules/worker.ts`. |
   | AWS Lambda, Vercel, Azure Functions, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-maxmind#maxmindModule`, in place of `npm run bundle`. |
   | Node.js server | `SID_MODULE_PACKAGES=@sharedid-edge/module-maxmind#maxmindModule` |
   | Cloudflare Snippet | Not available: the data doesn't fit a Snippet's 32 KB. |

4. **Turn it on** with `SID_MODULES`, after `geo` if you use both: `SID_MODULES=geo,maxmind`. To have MaxMind's country win over your CDN's, add `SID_MODULE_CONFIG={"maxmind":{"mode":"replace"}}`.

5. **Credit MaxMind** ([Data and licence](#data-and-licence)), and **schedule a rebuild** ([Keeping the data up to date](#keeping-the-data-up-to-date)).

## The licence key

`MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` are **build-time credentials** (`buildCredentials` in the package's `sharedidEdge` block):

- **Where they're used:** only `scripts/build-data.mjs` reads them, from the environment. It sends them to `download.maxmind.com` as HTTP Basic authentication; `fetch` drops them when MaxMind redirects the download to its storage (the tests check this against a local stand-in).
- **What they're not:** they're never settings or secrets of the worker (`SID_MODULE_SECRETS`), never written to the data file, and never printed, errors included.
- **The data file holds** the country table and its description (`MAXMIND_DATA_INFO`). The script refuses to write it if it would contain either value.
- **Every bundle is checked:** the bundled adapters run [`scripts/check-build-secrets.mjs`](../../../scripts/check-build-secrets.mjs) on every bundle they build. A bundle containing either value (as is, or base64-, hex- or URI-encoded) fails the build, as long as the credentials are in the environment of that build. For the Worker, or anything else you deploy, run `node scripts/check-build-secrets.mjs <file>` with them set. Values shorter than 8 characters aren't checked, which leaves out most account IDs: an account ID isn't secret on its own.
- **Keep the key out of the worker's environment:** set it in your CI's secret store for the build step only, not as a Worker variable or secret. Anyone with it can download databases on your account.

## Response

The country is [OpenRTB 2.6](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/main/2.6.md)'s `device.geo.country`: ISO 3166-1 alpha-3, as the `geo` module sends it, with `type` 2 (derived from the IP address). It also carries `ipservice` 3: MaxMind's value in AdCOM 1.0's [List: IP Location Services](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/main/AdCOM%20v1.0%20FINAL.md#list_iplocationservices).

When it finds a country:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "geo": { "type": 2, "country": "FRA", "ipservice": 3 } } },
  "ext": { "modules": { "maxmind": { "ms": 0, "status": "ok" } } }
}
```

When it adds nothing, it's `empty` and there's no `ortb2` from it:
- the address isn't in the data;
- the client IP is unknown;
- the code has no ISO alpha-3 code;
- or, in `fill` mode, the CDN already gave a country.

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "maxmind": { "ms": 0, "status": "empty" } } }
}
```

The country is GeoLite2's `country`: where MaxMind places the address. It isn't `registered_country`, where the network is registered.

## With the geo module: fill or replace

Modules' output is merged in `SID_MODULES` order, later modules over earlier ones. The `mode` setting says what `maxmind` adds, as in the `dbip` module ([details](../dbip/README.md#with-the-geo-module-fill-or-replace)):

| `mode` | What `maxmind` sends | Use it |
| --- | --- | --- |
| `fill` (the default) | The country only when the platform gave the worker none that `geo` could send. It never contradicts `geo`. | With `geo`, to cover the requests your CDN can't locate. |
| `replace` | MaxMind's country, always. List `maxmind` **after** `geo` (`SID_MODULES=geo,maxmind`). | When you want MaxMind's country rather than your CDN's, or without `geo`. |

`ipservice` 3 is only sent with MaxMind's country. In `replace` mode with `geo` on, `geo`'s other fields (`region`, `metro`, `utcoffset`, and the precise ones) still come from the CDN: `ipservice` then describes the country only. **Without `geo`, use `replace`.**

## Consent

The country is coarse location, so it's sent whatever the consent signals, as `geo` sends the CDN's country. The module sends nothing precise, so core's `preciseLocationDenial` rules don't come into it.

It declares no `gvlid` and no TCF purposes: it acts for the publisher, with data built into the publisher's own worker, and nothing is sent to MaxMind. What the module returns never changes the worker's consent decisions. Nothing is stored or logged.

## Settings

`SID_MODULE_CONFIG`, under `maxmind`:

| Setting | Values | Default |
| --- | --- | --- |
| `mode` | `fill` or `replace` | `fill` |

An unknown setting or another `mode` makes the module report `error`.

| Build environment | What |
| --- | --- |
| `MAXMIND_ACCOUNT_ID` | Your MaxMind account ID, for `npm run data` |
| `MAXMIND_LICENSE_KEY` | A MaxMind licence key, for `npm run data`. A [build-time credential](#the-licence-key): it never reaches the worker. |

## Data and licence

GeoLite2 Country is free with a MaxMind account, under the [GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula) (updated 12 February 2026), which incorporates the [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/) licence. Read the EULA yourself; this isn't legal advice. The points that matter here:

- **Attribution (section 3).** Credit MaxMind, for example "This product includes GeoLite Data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com)", on your site (a footer or privacy page) and in documentation about the feature. `MAXMIND_ATTRIBUTION` and the data file's first line hold that text.
- **Updates (section 6.3).** Use new releases promptly, and destroy old ones within 30 days of a new release: rebuild and redeploy at least that often ([below](#keeping-the-data-up-to-date)).
- **Sharing (section 6.1).** Don't disclose the database to third parties without notifying MaxMind. The table in your bundle stays in your own deployment; don't publish the bundle.
- **Use (sections 4 and 5).** Not for credit, insurance, employment or similar eligibility decisions. Not for identifying or locating a specific household, individual or street address. A country in an ad request is neither.
- **This repository holds no MaxMind data.** The package ships with a small hand-made fixture for documentation addresses only.

The build checks the download against MaxMind's SHA-256, and that the file is GeoLite2 Country (`GeoLite2-Country` in its metadata). It fails on anything else.

## Keeping the data up to date

MaxMind updates GeoLite databases regularly and asks you not to rely on a schedule. The EULA requires old releases to be gone within 30 days of a new one. Run a scheduled CI job, weekly for example: `npm run build`, `npm run data -w @sharedid-edge/module-maxmind` with the two credentials from your CI's secrets, then your deploy step. Downloads happen at build time only, never while the worker answers requests.

MaxMind limits downloads per account per day (`429 Too Many Requests` beyond it), so don't download on every build. Cache the `.tar.gz` and use `--file`, or download only from the scheduled job.

## Size

The module's code adds 3.7 KB minified and 1.4 KB gzipped (measured: the Lambda bundle with the fixture). The data is the same table format as `dbip`'s ([`@sharedid-edge/ip-ranges`](../../ip-ranges/README.md)), so its size depends on how many country ranges the release has.

**Not measured yet with a real GeoLite2 release:** the project has no MaxMind key in CI, and GeoLite data can't be committed. As a guide, DB-IP's country database built the same way ([`dbip` Size](../dbip/README.md#size)) adds:

| Build | Adds, minified | Adds, gzipped | Memory when loaded |
| --- | --- | --- | --- |
| IPv4 and IPv6 (default) | 3.8 MB | 865 KB | about 10 MB |
| `--ipv4-only` | 1.5 MB | 524 KB | about 4 MB |

**Measure yours:**
- `npm run data` prints the data file's size, raw and gzipped;
- the bundled adapters print the bundle's gzipped size;
- for the Worker, run `npx wrangler deploy .sharedid-modules/worker.ts --dry-run --outdir dist-dry`.

**Platform limits:**
- **Cloudflare Workers:** the [limits page](https://developers.cloudflare.com/workers/platform/limits/) (November 2026) gives "Worker size (uncompressed): 64 MiB" on both Workers Free and Paid, says "There is no compressed size limit. Only the uncompressed bundle size counts.", and allows 1 second to run the global scope and 128 MB of memory per isolate.
- **AWS Lambda and Vercel Functions:** 250 MB unzipped.
- **Cloudflare Snippets:** can't hold it.

IPv6 is keyed by /64, as in `dbip`: a /64 that MaxMind splits between countries takes the country of its first address. `npm run data` prints how many networks that affects.

## Using it in code

```ts
import { builtInModules } from '@sharedid-edge/modules';
import { maxmindModule, MAXMIND_DATA_INFO } from '@sharedid-edge/module-maxmind';

const modules = [...builtInModules, maxmindModule];
console.log(MAXMIND_DATA_INFO); // { database: 'GeoLite2-Country-2026-11-10', built: '2026-11-10', families: 'ipv4,ipv6', fixture: false, ... }
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `maxmind` is `skipped`, `not installed` | It isn't in your build: step 3 of [Turning it on](#turning-it-on). |
| `maxmind` is `empty` for every visitor | The fixture is built in, not MaxMind's data (`MAXMIND_DATA_INFO.fixture` is `true`): run `npm run data` after `npm run build`, then bundle again. Or `fill` mode with a CDN that locates every request, or no `geo`. |
| `maxmind` is `error` | An invalid setting: `mode` must be `fill` or `replace`. |
| `npm run data` says `Set MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY` | Set both in the build's environment, or use `--file`. |
| `npm run data` fails with `HTTP 401` | MaxMind rejected the account ID or key: check both, and that the key is active. |
| `npm run data` fails with `HTTP 429` | MaxMind's daily download limit: download less often, and use `--file`. |
| `npm run data` fails with `doesn't match MaxMind's SHA-256` | The download was cut short or changed: run it again. |
| The build fails with `contains the build-time credential MAXMIND_LICENSE_KEY` | The key ended up in a bundle: don't put it in `SID_*` settings or your own code; set it only for the data step. |
