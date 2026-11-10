# @sharedid-edge/module-geo

The `geo` module for [SharedID Edge](../../README.md): the visitor's location, as your CDN sees it, in the `/_sid/v1` payload as OpenRTB 2.6 `ortb2.device.geo`.

Cloudflare geolocates every request, on every plan. With this module the page can give bidders that location without a geolocation script or a call to a geo service: merge the payload's `ortb2` into Prebid.js and the auction gets `device.geo`. Coarse fields (country, region, metro, UTC offset) are always sent; precise ones (city, postal code, coordinates) only when consent allows, and never rounded.

## Contents

- [Turning it on](#turning-it-on)
- [Fields](#fields)
- [Response](#response)
- [Consent](#consent)
- [Settings](#settings)
- [With the Node.js server](#with-the-nodejs-server)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker and the Node.js server. It does nothing until you list it in `SID_MODULES`.

1. **Enable it** in `packages/cloudflare/wrangler.jsonc`:

   ```jsonc
   "vars": {
     "SID_MODULES": "geo",          // or "ip,geo" for the IP address too
     "SID_MODULE_CONFIG": "{}"      // "{\"geo\":{\"precision\":\"coarse\"}}" to never send precise fields
   }
   ```

2. **Deploy** (`npm run deploy -w @sharedid-edge/cloudflare`), then check:

   ```sh
   curl -s https://www.example.com/_sid/v1 | jq '.ortb2.device.geo, .ext.modules.geo'
   ```

3. **On the page,** merge the payload's `ortb2` into Prebid.js before the auction:

   ```js
   fetch('/_sid/v1', { credentials: 'include' })
     .then(response => response.json())
     .then(payload => {
       if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
     })
     .catch(() => {});
   ```

Nothing is stored or logged, and no network call is made: the location is already in the request, and it's only returned to the browser that sent it. `/_sid/v1` responses are `Cache-Control: no-store`.

## Fields

| `device.geo` | | From (Cloudflare `request.cf`) | Example |
| --- | --- | --- | --- |
| `type` | always `2` (IP address) when any other field is present | | `2` |
| `country` | ISO 3166-1 **alpha-3**, as OpenRTB requires | `country` (alpha-2) | `"USA"` |
| `region` | ISO 3166-2 subdivision code, without the country prefix | `regionCode` | `"TX"` |
| `metro` | Nielsen DMA code (US only) | `metroCode` | `"635"` |
| `utcoffset` | minutes from UTC at the time of the request, so it follows daylight saving time | `timezone` | `-300` |
| `city` | precise | `city` | `"Austin"` |
| `zip` | precise | `postalCode` | `"78701"` |
| `lat`, `lon` | precise; numbers | `latitude`, `longitude` | `30.2713`, `-97.7426` |

- **Country** comes from a bundled table of all 249 officially assigned ISO 3166-1 codes. Tor (`T1`), unknown (`XX`) and user-assigned codes such as `XK` (Kosovo) give no `country`.
- **Region** is the part after the country prefix, upper case: `TX` and `US-TX` both give `TX`, `JP-13` gives `13`.
- **`utcoffset`** is computed from the time zone name with the runtime's time zone data (`America/Chicago` is `-360` in winter and `-300` in summer). It's left out when the zone is unknown.
- **Coordinates** are sent only as a pair, and only if both are finite numbers in range.
- Missing or invalid values are left out, never guessed. When no field is left, the module returns nothing.
- Cloudflare's `continent` and `isEUCountry` aren't sent: OpenRTB has no field for the continent, and whether GDPR applies (`regs.gdpr`) is for your consent setup to say, not a location lookup.

## Response

With `SID_MODULES=geo`, a visitor in Austin with no consent restrictions gets every field:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": {
    "device": {
      "geo": {
        "type": 2,
        "country": "USA",
        "region": "TX",
        "metro": "635",
        "utcoffset": -300,
        "city": "Austin",
        "zip": "78701",
        "lat": 30.2713,
        "lon": -97.7426
      }
    }
  },
  "ext": { "modules": { "geo": { "ms": 0, "status": "ok" } } }
}
```

The same visitor with Global Privacy Control (`Sec-GPC: 1`), or with `{"precision":"coarse"}`, gets only the coarse fields. (With GPC there's no SharedID either.)

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -300 } } },
  "ext": { "modules": { "geo": { "ms": 0, "status": "ok" } } }
}
```

With `SID_MODULES=ip,geo` both modules write to `ortb2.device`, and the payload merges them: `{ "device": { "ip": "192.0.2.77", "geo": { … } } }`.

`ext.modules.geo.status` is:
- `ok`: `device.geo` was returned, with or without the precise fields.
- `empty`: the platform had no usable location (for example a Tor exit, or a Node.js server without `SID_TRUST_PROXY`).
- `error`: the module's settings are invalid (see [Settings](#settings)). No details are given.

## Consent

TCF treats precise geolocation (within about 500 metres) as a special feature that needs the user's opt-in; a country or region doesn't. The module splits its fields the same way.

**Coarse fields** (`type`, `country`, `region`, `metro`, `utcoffset`) are always sent when known.

**Precise fields** (`city`, `zip`, `lat`, `lon`) are sent **in full or not at all**. A rounded coordinate or a truncated postal code still looks real but is wrong, so they're never coarsened. They're left out when any of these apply, the same rules as the [`ip` module](../../README.md#ip-the-real-client-ip)'s address:
- the visitor sends Global Privacy Control (`Sec-GPC: 1`), or the request has `coppa=1`;
- a `us_privacy` string opts out of sale (third character `Y`);
- a TCF TC string is invalid, or doesn't opt in to **Special Feature 1** (use precise geolocation data);
- GDPR applies (`gdpr=1`, or an EU location on Cloudflare) and there's no TC string.

`city` counts as precise. A city is usually coarser than 500 metres, but a small town can place a user as narrowly as a postal code, and bidders get the region and metro anyway.

The module has no TCF `purposes`, like `ip`: it runs under GDPR too, and the rules above decide what it sends.

## Settings

| Where | Key | | |
| --- | --- | --- | --- |
| `SID_MODULES` | `geo` | required | Turns the module on. |
| `SID_MODULE_CONFIG` | `geo.precision` | optional | `"precise"` (the default): precise fields when consent allows. `"coarse"`: never send precise fields. |

Anything else in `geo`'s settings, including a misspelt key (`{"geo":{"precison":"coarse"}}`) or another value (`"city"`), makes the module fail with status `error` on every request, rather than guess and send precise data you meant to turn off.

## With the Node.js server

The Node.js server has no geolocation of its own. Behind Cloudflare, it can use Cloudflare's **visitor location headers**: turn on the **Add visitor location headers** managed transform (in the Cloudflare dashboard, under Rules, Managed Transforms). Cloudflare then adds these headers to requests it forwards to your server:

| Header | Field |
| --- | --- |
| `cf-ipcountry` | country |
| `cf-region-code` | region |
| `cf-ipcity` | city |
| `cf-postal-code` | postal code |
| `cf-metro-code` | metro code |
| `cf-iplatitude`, `cf-iplongitude` | coordinates |
| `cf-timezone` | time zone |
| `cf-ipcontinent` | continent |

The server reads them **only with `SID_TRUST_PROXY=true`**, the same setting that makes it trust `X-Forwarded-For`. Otherwise anyone could send them. Set it only when your server is reachable solely through Cloudflare (or a proxy that removes these headers from client requests):

```sh
SID_MODULES=geo SID_TRUST_PROXY=true SID_PUBLIC_ORIGIN=https://www.example.com node packages/node/dist/cli.js
```

`cf-ipcity` is decoded as UTF-8, so city names like `Zürich` come through intact.

## Using it in code

The module and its building blocks are exported for other adapters and for tests:

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { geoModule, deviceGeo, alpha3, regionCode, utcOffsetMinutes } from '@sharedid-edge/module-geo';

const handler = createHandler({ config: resolveConfig(env), modules: [geoModule] });

alpha3('DE');                                           // 'DEU'
regionCode('US-TX');                                    // 'TX'
utcOffsetMinutes('Europe/Berlin', new Date());          // 60 or 120
deviceGeo({ country: 'US', region: 'TX' }, { precise: false, at: new Date() });
// { type: 2, country: 'USA', region: 'TX' }
```

Other exports: `ALPHA_3` (the whole table), `geoPrecision(config)` (settings parsing) and the `DeviceGeo` and `GeoPrecision` types. The consent rule is core's `preciseLocationDenial(consent)`, and adapters validate their location data with core's `locationInfo(source)`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.geo` is missing | `geo` isn't in `SID_MODULES`. |
| `status` is `error` | `SID_MODULE_CONFIG.geo` has a key other than `precision`, or a value other than `"precise"` or `"coarse"`. |
| `status` is `empty` on Cloudflare | Cloudflare had no location for the address (for example a Tor exit, `T1`). |
| `status` is `empty` with the Node.js server | `SID_TRUST_PROXY` isn't set, or the visitor location headers managed transform is off. |
| No `city`, `zip`, `lat` or `lon` | Consent rules them out (see [Consent](#consent)): check the request's `gdpr`, `gdpr_consent`, `Sec-GPC`, `us_privacy` and `coppa`, or `precision` is `"coarse"`. Cloudflare also doesn't know them for every address. |
| No `utcoffset` | Cloudflare gave no time zone, or the runtime doesn't know it. |
| No `country` for Kosovo | `XK` isn't an officially assigned ISO 3166-1 code, so there's no alpha-3 code to send. |
| Locally, `wrangler dev` shows your own location | `wrangler dev` fills `request.cf` from Cloudflare's view of your machine. |
