# @sharedid-edge/module-ua

The `ua` module for [SharedID Edge](../../../README.md): the browser's User-Agent Client Hints and `User-Agent` header in the `/_sid/v1` payload as OpenRTB 2.6 device data (`ortb2.device.sua`, `devicetype`, `os`, `osv`, `make`, `model`), plus a **bot flag** for crawlers that identify themselves, in the shared traffic signal `ortb2.device.ext.traffic`.

It runs on `/_sid/v1` only: `/_sid/sync` returns an image, so there's nowhere to put the device data.

The worker sees the request headers before any script on the page runs. Prebid.js fills `device.sua` from `navigator.userAgentData` too, but only once it has loaded, only in Chromium browsers, and not where a privacy extension blocks the API. The headers arrive regardless. The bot flag lets the page skip or mark auctions for Googlebot, Bingbot, link previewers such as Slackbot or `facebookexternalhit`, and other automated clients.

## Contents

- [Turning it on](#turning-it-on)
- [Fields](#fields)
- [Responses](#responses)
- [The traffic signal](#the-traffic-signal)
- [Consent](#consent)
- [Settings](#settings)
- [Getting high-entropy hints](#getting-high-entropy-hints)
- [Full parsing with Bowser](#full-parsing-with-bowser)
- [On AWS Lambda behind CloudFront](#on-aws-lambda-behind-cloudfront)
- [Using it in code](#using-it-in-code)
- [Credits and licences](#credits-and-licences)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker, the Node.js server, and the AWS Lambda, Vercel, Azure Functions and Google Cloud adapters. It does nothing until you list it in `SID_MODULES`.

1. **Enable it** in `packages/adapters/cloudflare/wrangler.jsonc`:

   ```jsonc
   "vars": {
     "SID_MODULES": "ua",           // or "ip,geo,ua"
     "SID_MODULE_CONFIG": "{}"      // "{\"ua\":{\"ua\":true}}" to also send device.ua
   }
   ```

2. **Deploy** (`npm run deploy -w @sharedid-edge/cloudflare`), then check from Chrome's DevTools console on your site:

   ```js
   await (await fetch('/_sid/v1')).json()
   ```

   (`curl` sends no Client Hints, and `isbot` counts `curl` as an automated client, so it gets the bot flag.)

3. **On the page,** merge the payload's `ortb2` into Prebid.js before the auction:

   ```js
   fetch('/_sid/v1', { credentials: 'include' })
     .then(response => response.json())
     .then(payload => {
       if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
     })
     .catch(() => {});
   ```

Nothing is stored or logged, and no network call is made: the headers are already in the request, and the result goes only to the browser that sent it. `/_sid/v1` responses are `Cache-Control: no-store`.

## Fields

| `device` | From | Example |
| --- | --- | --- |
| `sua.browsers` | `Sec-CH-UA-Full-Version-List` when sent, else `Sec-CH-UA` (major versions). GREASE brands such as `"Not A(Brand"` are dropped. | `[{ "brand": "Google Chrome", "version": ["131", "0", "6778", "86"] }]` |
| `sua.platform` | `Sec-CH-UA-Platform`, with `Sec-CH-UA-Platform-Version` | `{ "brand": "Windows", "version": ["15", "0", "0"] }` |
| `sua.mobile` | `Sec-CH-UA-Mobile` | `0` |
| `sua.architecture`, `sua.bitness` | `Sec-CH-UA-Arch`, `Sec-CH-UA-Bitness` | `"x86"`, `"64"` |
| `sua.model` | `Sec-CH-UA-Model` (Android; desktops send `""`, which is left out) | `"Pixel 8"` |
| `sua.source` | `1`: low-entropy hints only. `2`: high-entropy hints included. `3`: parsed from the `User-Agent` (with [Bowser](#full-parsing-with-bowser)). | `1` |
| `devicetype` | `Sec-CH-UA-Mobile: ?1` is a phone (`4`); `?0` on Windows, macOS, Linux or Chrome OS is a PC (`2`). With Bowser, also tablets (`5`), connected TVs (`3`) and set-top boxes (`7`). | `2` |
| `os` | `Sec-CH-UA-Platform`, else (with Bowser) the `User-Agent` | `"Windows"` |
| `osv` | `Sec-CH-UA-Platform-Version`. On Windows that's an API version, so `13` and up becomes `"11"` and `1` to `12` becomes `"10"`. | `"11"` |
| `model` | `Sec-CH-UA-Model`, else (with Bowser) the `User-Agent` | `"Pixel 8"` |
| `make` | Only with Bowser | `"Apple"` |
| `ua` | The `User-Agent` header, with the `ua` setting | |
| `ext.traffic` | `{ "bot": true, "botKind": "declared", "sources": ["ua"] }` for a crawler or automated client | |

- Malformed hints are ignored, never guessed at. The hint headers are RFC 8941 structured fields, and a list that doesn't parse is dropped as a whole.
- Values browsers freeze aren't sent: macOS is always `10.15.7` in the `User-Agent`, Windows 10 and 11 are both `Windows NT 10.0`, and Chrome's reduced Android `User-Agent` always says `Android 10; K`. A Chromium version of the form `131.0.0.0` gives only `["131"]`.
- When there's nothing to send, the module returns nothing.

## Responses

**Chrome on Android with high-entropy hints** (`sua.source` 2):

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": {
    "device": {
      "sua": {
        "browsers": [
          { "brand": "Chromium", "version": ["131", "0", "6778", "81"] },
          { "brand": "Google Chrome", "version": ["131", "0", "6778", "81"] }
        ],
        "platform": { "brand": "Android", "version": ["14", "0", "0"] },
        "mobile": 1,
        "model": "Pixel 8",
        "source": 2
      },
      "devicetype": 4,
      "model": "Pixel 8",
      "os": "Android",
      "osv": "14.0.0"
    }
  },
  "ext": { "modules": { "ua": { "ms": 1, "status": "ok" } } }
}
```

**Chrome on Windows with the default hints** (`sua.source` 1). Most requests look like this until the browser is asked for more (see [Getting high-entropy hints](#getting-high-entropy-hints)):

```json
{
  "ortb2": {
    "device": {
      "sua": {
        "browsers": [{ "brand": "Google Chrome", "version": ["131"] }, { "brand": "Chromium", "version": ["131"] }],
        "platform": { "brand": "Windows" },
        "mobile": 0,
        "source": 1
      },
      "devicetype": 2,
      "os": "Windows"
    }
  },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

**Safari on iPhone** sends no Client Hints. With the default parser the module only checks its `User-Agent` for bots, so there's nothing to add:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "ua": { "ms": 0, "status": "empty" } } }
}
```

With [Bowser](#full-parsing-with-bowser) (`"parser": "bowser"`), the same request gets device data parsed from the `User-Agent` (`sua.source` 3):

```json
{
  "ortb2": {
    "device": {
      "sua": { "browsers": [{ "brand": "Safari", "version": ["18", "1"] }], "platform": { "brand": "iOS", "version": ["18", "1"] }, "mobile": 1, "source": 3 },
      "devicetype": 4,
      "make": "Apple",
      "model": "iPhone",
      "os": "iOS",
      "osv": "18.1"
    }
  },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

**Googlebot:**

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "declared", "sources": ["ua"] } } } },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

**Consent-limited:** the Chrome on Android request above with Global Privacy Control (`Sec-GPC: 1`) gets only low-entropy fields: major versions, no platform version, no model, `sua.source` 1. (With GPC there's no SharedID either.)

```json
{
  "v": 1,
  "eids": [],
  "ortb2": {
    "device": {
      "sua": {
        "browsers": [{ "brand": "Chromium", "version": ["131"] }, { "brand": "Google Chrome", "version": ["131"] }],
        "platform": { "brand": "Android" },
        "mobile": 1,
        "source": 1
      },
      "devicetype": 4,
      "os": "Android"
    }
  },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

Googlebot with GPC still gets the traffic signal.

With `SID_MODULES=ip,geo,ua` the modules all write to `ortb2.device`, and the payload merges them: `{ "device": { "ip": "192.0.2.77", "geo": { … }, "sua": { … }, "devicetype": 2, … } }`.

`ext.modules.ua.status` is:
- `ok`: device data or the traffic signal was returned.
- `empty`: nothing to add, for example a browser without Client Hints that isn't a bot, or no `User-Agent`.
- `error`: the module's settings are invalid (see [Settings](#settings)). No details are given.

## The traffic signal

For a client whose `User-Agent` identifies it as a crawler, bot or other automated client, the module adds:

```json
{ "device": { "ext": { "traffic": { "bot": true, "botKind": "declared", "sources": ["ua"] } } } }
```

This is the shared shape any module can write ([sharedid-edge#5](https://github.com/patmmccann/sharedid-edge/issues/5)):

- `bot`: `true`. The module never says a request is human: for other requests `traffic` is absent.
- `botKind`: `declared`, a client that says what it is. Other values (`verified`, `likely`) come from modules with stronger or weaker evidence.
- `sources`: the modules that contributed.

Detection uses [isbot](https://github.com/omrilotan/isbot), a maintained list of about 200 patterns covering: search engines (Googlebot, Bingbot, YandexBot, Baiduspider), AI crawlers (GPTBot, ClaudeBot), link previewers (Slackbot, `facebookexternalhit`, Twitterbot), monitoring services, HTTP libraries (`curl`, `python-requests`) and headless browsers (`HeadlessChrome`). It only catches clients that identify themselves: a bot pretending to be Chrome passes as Chrome.

**On the page,** skip the auction, or pass the flag on:

```js
if (payload.ortb2?.device?.ext?.traffic?.bot) {
  // Don't run the auction for crawlers, or set ortb2.device.ext.traffic for bidders that read it.
}
```

Core reads the module's `device.ext.traffic` as its report to the shared [traffic signal](../../../README.md#bot-bot-and-staff-traffic-signals) and merges it with the other reports (the `bot` module's, the platform's), most cautious first, so `sources` lists every contributor. With `SID_SKIP_BOTS=declared` (or `likely`), a crawler `ua` flags gets no SharedID.

## Consent

Device data isn't personal on its own, but high-entropy hints and models add to what can fingerprint a browser. So, like the `geo` module's precise fields, they're left out when consent asks for less.

**Low-entropy fields are always sent:** the brands with major versions (`Sec-CH-UA`), `sua.platform.brand`, `sua.mobile`, `devicetype`, `os` and `make`. Browsers send these hints to every site by default.

**High-entropy fields** (full versions, `sua.platform.version`, `sua.architecture`, `sua.bitness`, `sua.model`, `osv`, `model`, and `ua`) are left out, and `sua.source` is then `1` (or `3`), when any of these apply:
- the visitor sends Global Privacy Control (`Sec-GPC: 1`), or the request has `coppa=1`;
- a `us_privacy` string opts out of sale (third character `Y`);
- a TCF TC string is invalid;
- GDPR applies (`gdpr=1`, or an EU location on Cloudflare) and there's no TC string.

**The traffic signal is always sent**, under GPC and COPPA too. It describes the traffic, not the person, and it helps the page and bidders avoid serving or paying for invalid traffic.

The module has no TCF `purposes`, like `ip` and `geo`: it runs under GDPR too, and the rules above decide what it sends.

## Settings

| Where | Key | | |
| --- | --- | --- | --- |
| `SID_MODULES` | `ua` | required | Turns the module on. |
| `SID_MODULE_CONFIG` | `ua.parser` | optional | `"bowser"` parses the `User-Agent` with Bowser, filling every `device` field it can; it needs a build with Bowser (see [Full parsing with Bowser](#full-parsing-with-bowser)). `"isbot"` (the default) uses Client Hints, and the `User-Agent` only for the bot check. |
| `SID_MODULE_CONFIG` | `ua.ua` | optional | `true` adds the raw `User-Agent` as `device.ua` (when consent allows high-entropy data). `false` (the default) leaves it out, since Prebid.js sends it already. |

Anything else in `ua`'s settings, including a misspelt key, a string `"true"` or another parser name, makes the module fail with status `error` on every request. `acceptCh`, proposed in #11, isn't a setting: see the next section.

## Getting high-entropy hints

Chromium sends only `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` unless the site asks for more. Browsers take that request (`Accept-CH`) **only from the page's own response** (the HTML document), not from a `fetch` like `/_sid/v1`, so the worker can't ask on its own. Add the header to your pages' responses:

```http
Accept-CH: Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Arch, Sec-CH-UA-Bitness
```

or a meta tag in the page's `<head>`:

```html
<meta http-equiv="Accept-CH" content="Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Arch, Sec-CH-UA-Bitness">
```

The browser then sends those hints with its later requests to your origin, including `/_sid/v1`, which is on the same origin. The first page view of a session doesn't carry them. If `/_sid/v1` is on another origin (a different subdomain, allowed through `SID_ALLOWED_ORIGINS`), the page must also delegate the hints to it with `Permissions-Policy`, for example `Permissions-Policy: ch-ua-model=(self "https://id.example.com")`.

## Full parsing with Bowser

By default the module reads device data from Client Hints, which Chromium browsers send and Safari and Firefox don't; it only checks the `User-Agent` for bots. [Bowser](https://github.com/bowser-js/bowser) parses the `User-Agent` itself, so Safari, Firefox, smart TVs and requests without hints get device data too. It's **off by default and not in the default bundles**, to keep them small: you build it in, then choose it with a setting.

**Bundle size.** Bowser adds about 8 to 8.7 KB gzipped to each bundle. Minified and gzipped, against the 32 KB budget CI checks for both builds:

| Bundle | Default (no Bowser) | With Bowser |
| --- | --- | --- |
| Cloudflare Worker | 18.0 KB | 25.8 KB |
| AWS Lambda | 18.9 KB | 27.4 KB |
| Vercel | 18.7 KB | 27.2 KB |
| Azure Functions | 19.5 KB | 28.0 KB |

The Node.js server isn't bundled, and always has Bowser.

**Turning it on** takes two steps:

1. **Build with Bowser,** one command per adapter. Each swaps in `@sharedid-edge/modules/bowser`, the built-in list with `uaModuleWithBowser` (the Worker through its `src/bowser.ts` entry point, the other bundles through an esbuild alias); no code changes.

   | Adapter | Build with Bowser |
   | --- | --- |
   | Cloudflare Worker | `npm run deploy:bowser -w @sharedid-edge/cloudflare` in place of `deploy` (also `dev:bowser`, and `build:bowser` for a dry run into `dist-bowser/`) |
   | AWS Lambda | `npm run bundle:bowser -w @sharedid-edge/aws-lambda` in place of `bundle`; it writes `deploy/lambda.mjs` as usual, so `sam deploy` is unchanged |
   | Vercel | `npm run bundle:bowser -w @sharedid-edge/vercel` in place of `bundle`; copy `deploy/sharedid-edge.mjs` into your site as usual |
   | Azure Functions | `npm run bundle:bowser -w @sharedid-edge/azure-functions` in place of `bundle`; the same `deploy/` function app |
   | Google Cloud | `npm run bundle:bowser -w @sharedid-edge/gcp-functions` in place of `bundle`; the same `deploy/` function source |
   | Node.js server | Nothing: it always has Bowser |

2. **Choose it** with the `parser` setting, wherever the adapter takes its settings (the Worker's `vars` in `wrangler.jsonc`, the Node.js server's environment, or the Lambda function's, Vercel project's, Function App's or Cloud Run function's environment variables):

   ```jsonc
   "vars": {
     "SID_MODULES": "ua",
     "SID_MODULE_CONFIG": "{\"ua\":{\"parser\":\"bowser\"}}"   // add \"ua\":true to also send device.ua
   }
   ```

   `"parser": "isbot"`, or leaving it out, goes back to Client Hints and the bot check. With `"parser": "bowser"` on a build without Bowser, the module reports `status: "error"` on every request rather than quietly sending less, so a missed build step shows in `ext.modules.ua`.

**What it adds,** each field only when Bowser recognizes it. All are native OpenRTB 2.6 `device` fields. The browser goes in `sua.browsers`, OpenRTB's place for it, so nothing is added under `device.ext`: OpenRTB has no field for the rendering engine, and bidders don't read one.

| `device` | From Bowser | Example |
| --- | --- | --- |
| `sua` | Only when the browser sent no Client Hints, with `source` `3`: `browsers` (the browser's name and version), `platform` (the OS and version), `mobile` (`1` for a phone) | `{ "browsers": [{ "brand": "Firefox", "version": ["133", "0"] }], "platform": { "brand": "Android", "version": ["14"] }, "mobile": 1, "source": 3 }` |
| `devicetype` | Bowser's device class: phone `4`, tablet `5`, desktop `2`, smart TV `3`. An Apple TV or Amazon Fire TV, which Bowser doesn't classify, is a set-top box, `7` | `5` |
| `make` | The device maker, when the `User-Agent` names it (Apple, Amazon, Huawei, Nokia, …) | `"Apple"` |
| `model` | The device model, when the `User-Agent` names it (`iPhone`, `iPad`, a Fire TV's `AFT…` code) | `"iPad"` |
| `os`, `osv` | The OS and its version. Versions browsers freeze (macOS `10.15.7`, `Windows NT 10.0`, Android `10; K`) are left out | `"iOS"`, `"17.6"` |

**Client Hints still win** where both give a value: `sua`, `os`, `osv` and `model` come from the hints when the browser sent them, and the mobile hint decides phone or not (a tablet the `User-Agent` reports stays a tablet). Bowser fills what the hints don't give, typically `make`. Its OS version is used only when it describes the hinted OS.

**Consent** works as for hints (see [Consent](#consent)). `model`, `osv`, `sua.platform.version`, browser versions beyond the major one, and `ua` are high-entropy: they're left out under GPC, COPPA, a US privacy opt-out, an invalid TC string, or GDPR without a TC string. `devicetype`, `make`, `os`, the browser's name with its major version, and `sua.mobile` are always sent, like the low-entropy hints every Chromium browser sends. The traffic signal is unchanged, and always sent.

**Safari 17.6 on iPad**, with `{"ua":{"parser":"bowser","ua":true}}`:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": {
    "device": {
      "ua": "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "sua": {
        "browsers": [{ "brand": "Safari", "version": ["17", "6"] }],
        "platform": { "brand": "iOS", "version": ["17", "6"] },
        "mobile": 0,
        "source": 3
      },
      "devicetype": 5,
      "make": "Apple",
      "model": "iPad",
      "os": "iOS",
      "osv": "17.6"
    }
  },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

With GPC the same request gets only `{ "sua": { "browsers": [{ "brand": "Safari", "version": ["17"] }], "platform": { "brand": "iOS" }, "mobile": 0, "source": 3 }, "devicetype": 5, "make": "Apple", "os": "iOS" }`. Firefox 133 on Android gets `sua` as in the table, `devicetype` `4`, `os` `"Android"` and `osv` `"14"`, and no maker or model, which Firefox leaves out of its `User-Agent`.

Things to know:

- **iPads** ask for desktop sites by default, with a Mac's `User-Agent`, so they're reported as a Mac (`devicetype` 2). Nothing in the request tells them apart.
- **Android WebViews** (in-app browsers) are reported as Chrome on Android. Android phone models (`SM-S918B`) aren't read: Bowser doesn't, and Chrome's reduced `User-Agent` hides them. `Sec-CH-UA-Model` gives them.
- **Roku** devices are reported as TVs (`3`): Roku TVs and Roku players send the same `User-Agent`. A PlayStation 5 gets only its browser.
- Bowser also recognizes some crawlers; either it or isbot sets the bot flag.
- **In your own entry point,** import `uaModuleWithBowser` from `@sharedid-edge/module-ua/bowser` in place of `uaModule`, or `builtInModules` from `@sharedid-edge/modules/bowser` in place of `@sharedid-edge/modules`. `uaModule` leaves Bowser out, and reports `error` if the setting asks for it.

## On AWS Lambda behind CloudFront

CloudFront sends the function only the headers its origin request policy lists, and replaces an unlisted `User-Agent` with `Amazon CloudFront`. The stack's policy doesn't list `User-Agent` or the Client Hints yet, so on Lambda the module sees neither and reports `empty`. (It ignores `Amazon CloudFront` rather than flag every request as a bot.) To use it there, add `User-Agent`, `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` (and the high-entropy hints you ask for) to the `OriginRequestPolicy` headers in `template.yaml`, or use your own policy. CloudFront limits a policy to 10 headers by default; ask AWS for a higher quota if you need more. See [`packages/adapters/aws-lambda/README.md`](../../adapters/aws-lambda/README.md#platform-information).

On Cloudflare and the Node.js server, every request header reaches the module.

## Using it in code

The module and its building blocks are exported for other adapters and for tests:

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { uaModule, readClientHints, uaDevice, isGreaseBrand } from '@sharedid-edge/module-ua';

const handler = createHandler({ config: resolveConfig(env), modules: [uaModule] });

isGreaseBrand('Not A(Brand');                                   // true
const hints = readClientHints(new Headers({ 'Sec-CH-UA-Mobile': '?1', 'Sec-CH-UA-Platform': '"Android"' }));
uaDevice(hints, undefined, { highEntropy: true, includeUa: false });
// { sua: { platform: { brand: 'Android' }, mobile: 1, source: 1 }, devicetype: 4, os: 'Android' }
```

Other exports: `createUaModule({ parser, bowser })` (the module with any `UserAgentParser`, and the one the `"bowser"` setting picks), `botParser` (the default parser), the header parsers `parseBrandList`, `parseStringHeader` and `parseBooleanHeader`, `deviceType`, `hintOsVersion`, `versionComponents`, `highEntropyDenial(consent)`, `uaSettings(config)`, and the types. `@sharedid-edge/module-ua/bowser` exports `bowserParser` and `uaModuleWithBowser`.

## Credits and licences

This package is Apache-2.0. It depends on:

- **[isbot](https://github.com/omrilotan/isbot)** by Omri Lotan, released under [the Unlicense](https://github.com/omrilotan/isbot/blob/main/LICENSE) (public domain). Built into every adapter. No attribution is required; we credit it anyway.
- **[Bowser](https://github.com/bowser-js/bowser)**, © 2015 Dustin Diaz and contributors, [MIT licence](https://github.com/bowser-js/bowser/blob/master/LICENSE). Used by `@sharedid-edge/module-ua/bowser`, in the adapters' Bowser builds and the Node.js server. If you distribute a bundle built with it, the MIT licence asks you to include Bowser's copyright and licence notice.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.ua` is missing | `ua` isn't in `SID_MODULES`. |
| `status` is `error` | `SID_MODULE_CONFIG.ua` has a key other than `ua` and `parser`, `ua` isn't `true` or `false`, or `parser` isn't `"isbot"` or `"bowser"`. Or `parser` is `"bowser"` and the bundle was built without Bowser: use the adapter's Bowser build (see [Full parsing with Bowser](#full-parsing-with-bowser)). |
| `status` is `empty` in Safari or Firefox | They send no Client Hints, and with the default parser the module only checks their `User-Agent` for bots. Build with Bowser and set `"parser": "bowser"` for device data (see [Full parsing with Bowser](#full-parsing-with-bowser)). |
| `status` is `empty` on AWS Lambda | The origin request policy doesn't forward `User-Agent` and the hints (see [above](#on-aws-lambda-behind-cloudfront)). |
| `sua.source` is always `1` | The browser hasn't been asked for high-entropy hints (see [Getting high-entropy hints](#getting-high-entropy-hints)), or consent limits them: check `Sec-GPC`, `coppa`, `us_privacy`, `gdpr` and `gdpr_consent`. |
| No `osv` for a Mac, or for Windows | The `User-Agent` freezes them (macOS `10.15.7`, `Windows NT 10.0`). With `Sec-CH-UA-Platform-Version`, Chromium sends the real version. |
| An iPad is reported as a Mac | iPadOS asks for desktop sites with a Mac's `User-Agent`. |
| Every request has the bot flag | The requests come from a tool such as `curl`, a test runner or a headless browser, which isbot counts as automated clients. Or a proxy in front of the worker replaces the `User-Agent`. |
| `status` is `timeout` | The first request in a fresh isolate compiles isbot's pattern (a few milliseconds). If it still exceeds `SID_MODULE_TIMEOUT_MS` (50 ms by default), raise that. |
