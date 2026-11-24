# @sharedid-edge/module-id5

> **⚠ This module forwards data to `id5-sync.com` or `api.id5-sync.com`** (ID5's API, over the public internet). It's **off unless you add it to your build, list it in `SID_MODULES` and give it your ID5 partner number.**
>
> - **What is sent:** one `POST` with a JSON body: your ID5 partner number (`partner`), the visitor's **full IP address** (`ip` for IPv4, `ipv6` for IPv6, from your platform, never from the request's headers, and only a routable public address), the browser's **user agent** (`ua`), the visitor's **SharedID** as ID5's partner user ID (`puid`), your site's host name (`domain`), the consent strings the request carries (`gdpr`, `gdpr_consent`, `us_privacy`, `gpp_string`, `gpp_sid`), your `provider` name if you set one, the time (`ts`), this integration's name and version (`origin`, `v`), and the `signature` ID5 returned last time. No other cookie, header or page URL.
> - **To which host:** `id5-sync.com` by default (`https://id5-sync.com/gs/v2/<partner>.json`), or `api.id5-sync.com` if you set `endpoint`. Core refuses any other host.
> - **When:** on `/_sid/v1` and `/_sid/sync`, only when the visitor has no cached ID5 answer younger than 8 hours (ID5's refresh time), so about once per visitor per 8 hours of activity, within a time limit (`timeoutMs`, 300 ms by default). With `"browsers": "webkit27"`, only for visitors on Apple WebKit 27 or later (Safari, and every browser on iOS and iPadOS).
> - **Under which consent conditions:** **nothing at all** is sent with the SharedID opt-out cookie, Global Privacy Control, a COPPA request (`coppa=1`), a `us_privacy` opt-out of sale, a US opt-out in the GPP string, a consent provider's denial (`cmp`, `gpp`), whenever the SharedID itself may not be stored, where GDPR applies without a TC string, or with a TC string (wherever the visitor is) that doesn't give **ID5 (TCF vendor 131)** consent, with consent for Purpose 1 and consent or legitimate interest for one of Purposes 2 to 10. The IP address also needs the precise-location rules the [`ip`](../../modules/ip/README.md) module follows (with a TC string, opt-in to Special Feature 1); without it, nothing is sent. ID5 may use the IP address and user agent to find or match the visitor's ID5 ID: the ID comes from ID5, never from this project.
> - **Why the public internet:** ID5's API runs only there; there's no co-located alternative.
>
> `ext.modules.id5.forwards` on `/_sid/v1` says whether this visitor's data may be sent, and nothing about it. Nothing is logged or kept, apart from ID5's answer in the visitor's own `HttpOnly` cookie.

The `id5` module for [SharedID Edge](../../../README.md): the [ID5 ID](https://id5.io), fetched server-to-server by your edge worker and returned as EIDs in the `/_sid/v1` payload. It helps when a visitor's browser doesn't load ID5's own script or reach ID5's domain: the ID comes back from your own domain.

**It needs your own ID5 partner number and agreement with ID5.** The module calls ID5's API with your partner number, so you need an ID5 account, a signed agreement, and ID5 to have turned on server-side fetching for that partner (until then ID5 answers with an error, and the module returns nothing). An upstream operator or hosting company running one endpoint for many publishers uses its own partner number and declares itself as ID5's `provider`. Written from ID5's public documentation and Prebid.js's ID5 module, not by ID5: **confirm the request with ID5 for your partner account** (see [The request](#the-request)). It's been tested against a stub of ID5's API, never against ID5 itself.

## Contents

- [Turning it on](#turning-it-on)
- [What it does](#what-it-does)
- [The request](#the-request)
- [The cookie](#the-cookie)
- [Response](#response)
- [Using the EIDs in Prebid.js](#using-the-eids-in-prebidjs)
- [Consent and opt-out](#consent-and-opt-out)
- [Settings](#settings)
- [Only where the browser blocks ID5: `browsers`](#only-where-the-browser-blocks-id5-browsers)
- [Platforms](#platforms)
- [Size](#size)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

`id5` is a [vendor module](../README.md), maintained by the project. It isn't built into the adapters: you add it to your build, then list it in `SID_MODULES` with your partner number. Until then, `SID_MODULES=id5` only reports it as `skipped` (`not installed`).

1. **Add it to your build,** as `@sharedid-edge/module-id5#id5Module`:

   | Platform | How |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-id5#id5Module`, and deploy with `npx wrangler deploy .sharedid-modules/worker.ts` in step 4 |
   | AWS Lambda, Vercel, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-id5#id5Module` in place of `npm run bundle` |
   | Node.js server | `SID_MODULE_PACKAGES=@sharedid-edge/module-id5#id5Module` |
   | Lambda@Edge, Azure Functions, Akamai, Fastly, Cloudflare Snippet | Not available: see [Platforms](#platforms) |

2. **Raise `SID_MODULE_TIMEOUT_MS`.** Core stops waiting for a module after `SID_MODULE_TIMEOUT_MS`, 50 ms by default, which is shorter than a round trip to ID5. Set it above the module's `timeoutMs` (300 ms by default), for example to `400`. The request to ID5 never waits longer than four fifths of `SID_MODULE_TIMEOUT_MS`, so the module always has time to answer from its cache.

3. **Enable the module with your partner number**, in `packages/adapters/cloudflare/wrangler.jsonc` (173 is ID5's test partner; use your own):

   ```jsonc
   "vars": {
     "SID_MODULES": "id5",
     "SID_MODULE_TIMEOUT_MS": "400",
     "SID_MODULE_CONFIG": "{\"id5\":{\"partner\":173,\"domain\":\"example.com\"}}"
   }
   ```

   An upstream operator adds its provider name, as agreed with ID5: `{"id5":{"partner":173,"provider":"example-operator"}}`.

4. **Deploy,** then check from a browser on your site (the module needs a real visitor's IP address and user agent):

   ```sh
   curl -s https://www.example.com/_sid/v1 -A 'Mozilla/5.0' | jq .ext.modules.id5
   # { "ms": 120, "status": "ok", "forwards": true }
   ```

5. **On the page,** pass the EIDs to Prebid.js: see [Using the EIDs in Prebid.js](#using-the-eids-in-prebidjs).

## What it does

On each `/_sid/v1` or `/_sid/sync` request (on `/_sid/sync` only its cookie is used; there's no payload):

| Situation | Request to ID5 | Cookie | Payload |
| --- | --- | --- | --- |
| Opt-out, GPC, COPPA, denied consent, a US opt-out (see [Consent](#consent-and-opt-out)) | none | deletes `sid_id5_<partner>` | nothing from ID5 |
| An `id5id` cookie holds an ID5 answer (see `readCookie`) | none | unchanged | its EIDs |
| A cached answer younger than its refresh time (8 hours, or less if ID5 says so) | none | unchanged | the cached EIDs |
| No cache, or the cache is due a refresh | one, with the cached `signature` | the new answer | ID5's EIDs |
| ID5 doesn't answer within `timeoutMs`, or the network fails | the one above, abandoned | unchanged | the cached EIDs, if under 30 days old; else nothing |
| ID5 answers with an error or nothing usable | the one above | asks again in an hour, keeping the cache | the cached EIDs, if any |
| ID5 answers with its opt-out (`universal_uid` `0`, or `privacy.id5_consent: false`) | the one above | an opt-out marker, no ID, until the next refresh | nothing from ID5 |
| No routable client IP, no user agent, or consent rules out a full IP address | none | unchanged | the cached EIDs, if any |
| `"browsers": "webkit27"` and the visitor's browser isn't Apple WebKit 27 or later | none | unchanged | the cached EIDs, if any |

The module never delays a response by more than `timeoutMs`: the ID5 EID is simply missing from that response, and the next request tries again.

`/_sid/optout` deletes the cache cookie too, whether or not `id5` is in `SID_MODULES`.

## The request

Following ID5's [server-to-server API](https://wiki.id5.io/docs/mobile-in-app-integration) and its [Prebid Server module](https://wiki.id5.io/docs/id5-user-id-module-for-prebid-server) (which fetch from `/gs/v2` server-side with the device's IP address and user agent), and Prebid.js's `id5IdSystem` (the `/gs/v2` fetch body), the module sends:

```json
{
  "partner": 173,
  "origin": "sharedid-edge",
  "v": "0.1.0",
  "ts": "2026-11-24T12:00:00.000Z",
  "gdpr": 1,
  "gdpr_consent": "<the TC string>",
  "us_privacy": "1YNN",
  "gpp_string": "<the GPP string>",
  "gpp_sid": "2,7",
  "provider": "example-operator",
  "domain": "www.example.com",
  "ua": "Mozilla/5.0 …",
  "ip": "203.0.114.7",
  "puid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "s": "<the signature from ID5's last answer>"
}
```

- `ip` is a routable IPv4 address; a routable IPv6 address goes as `ipv6` instead, never as `ip`. An IPv4-mapped IPv6 address (`::ffff:203.0.114.7`) is sent as IPv4. A private, loopback, link-local, shared (CGNAT), reserved or documentation address is never sent, and without a routable address the module sends nothing (ID5 would otherwise see your worker's address).
- `puid` is the visitor's SharedID, sent only when there is one and every consent check above has passed.
- Consent fields are sent only when the request has them; `gdpr` is `1` when GDPR applies and `0` otherwise.
- `s` is ID5's `signature` from the cached answer, sent back on each refresh so ID5 can return the same ID. With the `/ga/v1` endpoint it's sent as `signature`.

**Confirm with ID5** for your partner account: the endpoint (`/gs/v2` or `/ga/v1`), `origin` and `v`, `provider`, and that `/gs/v2` reads `ua` and `puid` as top-level fields. The endpoint is a setting, so you can follow what ID5 tells you without a new release.

**The answer** used: `ids` (complete EIDs, such as ID5's own and its TrueLink ID; at most four, two UIDs each), or the legacy `universal_uid`, which becomes `{ "source": "id5-sync.com", "uids": [{ "id": …, "atype": 1, "ext": { "linkType": … } }] }`; `signature`; `cache_control.max_age_sec`, which can shorten the refresh to no less than 15 minutes; and the opt-out (`universal_uid` `"0"`, `privacy.id5_consent: false`). Everything is checked; anything else is ignored.

## The cookie

`sid_id5_<partner>` (`sid_id5_173`), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, with `domain` from the settings (else `SID_COOKIE_DOMAIN`). It holds ID5's answer (the EIDs and `signature`) and when it was fetched, as base64url JSON. It lasts 30 days from the last answer, as ID5's documentation asks ("delete after 30 days without a user event"), and is refreshed after 8 hours on a visit. An answer too large for the cookie (over 3 KB) is cached without its EIDs, so the next request asks again. One cookie per partner number, so changing partner starts afresh.

It isn't Prebid.js's `id5id`: Prebid.js's ID5 module keeps its own answer in local storage, which a server can't write, so the EIDs come from `/_sid/v1` instead.

## Response

With `SID_MODULES=id5`, a `/_sid/v1` call that gets an ID from ID5:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] },
    { "source": "id5-sync.com", "uids": [{ "id": "ID5*AbCd…", "atype": 1, "ext": { "linkType": 2 } }] }
  ],
  "ext": { "modules": { "id5": { "ms": 118, "status": "ok", "forwards": true } } }
}
```

And with Global Privacy Control (nothing sent, and an existing cache deleted):

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "id5": { "ms": 0, "status": "empty", "forwards": false } } }
}
```

Where GDPR applies without ID5's vendor consent, core skips the module and deletes its cookie:

```json
{ "ext": { "modules": { "id5": { "ms": 0, "status": "skipped", "reason": "tcf: no consent for vendor 131" } } } }
```

`ext.modules.id5.status` is:
- `ok`: ID5 EIDs were returned (fresh or cached).
- `empty`: none: consent rules it out, ID5 opted the visitor out, the request timed out with nothing cached, or there's no routable client IP or user agent. On `/_sid/sync`, `X-SharedID-Modules: id5=ok` when it fetched or used an ID.
- `skipped`, with a reason: where GDPR applies, no TC string, an unreadable one, or no consent for ID5 (vendor 131) or Purpose 1 in it.
- `error`: invalid settings (no `partner`, an unknown setting, an endpoint on another host). No details are given.
- `timeout`: `SID_MODULE_TIMEOUT_MS` is shorter than the round trip (step 2 of [Turning it on](#turning-it-on)).

`forwards` is whether the visitor's data may be sent to ID5 on this request (consent, opt-out and GPC), not whether it was.

## Using the EIDs in Prebid.js

The EIDs are in the payload's `eids`. Pass ID5's to Prebid.js as first-party data before the auction, next to `ortb2` from [Configure Prebid.js](../../../docs/prebid.md#module-output-_sidv1):

```js
fetch('/_sid/v1', { credentials: 'include' })
  .then(response => response.json())
  .then(payload => {
    const eids = (payload.eids || []).filter(eid => eid.source !== 'pubcid.org');   // Prebid.js's SharedID module sends pubcid.org itself
    pbjs.que.push(() => {
      if (payload.ortb2) pbjs.mergeConfig({ ortb2: payload.ortb2 });
      if (eids.length > 0) pbjs.mergeConfig({ ortb2: { user: { ext: { eids } } } });
    });
  })
  .catch(() => {});
```

If Prebid.js's own ID5 module also runs on the page, bidders may get the ID5 ID twice; it's the same ID when both come from your partner number. Run one or the other per page if your bidders mind.

## Consent and opt-out

**No request, no ID, and the cache deleted** when there's:
- the SharedID opt-out cookie (`_pubcid_optout`), or a visit to `/_sid/optout`;
- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a `us_privacy` string that opts out of sale (third character `Y`);
- a US section of the GPP string, listed in `gpp_sid`, that opts out of sale, sharing or targeted advertising (the [`gpp`](../../modules/gpp/README.md) module's rules, applied whether or not that module is in `SID_MODULES`);
- a consent provider's denial (`cmp`, `gpp`), or anything else that denies the SharedID's own storage;
- where GDPR applies, no TC string;
- a TC string, wherever the visitor is, that can't be read, or that lacks **ID5's vendor consent (GVL ID 131)**, consent for **Purpose 1** in its core segment, or consent or legitimate interest for at least one of **Purposes 2 to 10** (the same test as SharedID's vendor mode). Where GDPR applies, core checks the first two and skips the module (`skipped`); elsewhere the module checks them itself (`empty`);
- an `id5id` cookie holding ID5's opt-out (`0`).

**ID5's own opt-out:** when ID5 answers `universal_uid` `"0"` or `privacy.id5_consent: false`, no ID is kept or returned, and ID5 isn't asked again until the next refresh.

**No request, but the cache is kept,** when the IP address may not be sent: with a TC string without opt-in to Special Feature 1 (precise geolocation), as for the [`ip`](../../modules/ip/README.md) module. The cached EIDs are still returned.

**Where GDPR applies** is core's rule ([consent rules](../../../docs/consent.md)): `gdpr=1`, or, without `gdpr`, a visitor in the EU, the rest of the EEA, the UK or Turkey. The TC string comes from `gdpr_consent` or the CMP's `euconsent-v2` cookie, and is sent to ID5 as `gdpr_consent`.

## Settings

| Where | Key | | |
| --- | --- | --- | --- |
| `SID_MODULES` | `id5` | required | Turns the module on. |
| `SID_MODULE_TIMEOUT_MS` | | raise it | Above `timeoutMs`, such as `400`: the default 50 ms is too short for a round trip to ID5. |
| `SID_MODULE_CONFIG` | `id5.partner` | required | Your ID5 partner number. |
| | `id5.provider` | optional | Who runs the integration, sent to ID5 as `provider`: an upstream operator or hosting company running SharedID Edge for publishers, with the name agreed with ID5. 1 to 100 printable characters. |
| | `id5.endpoint` | optional | ID5's endpoint, `https://id5-sync.com/gs/v2/{partner}.json` by default (`{partner}` is replaced). Must be https on `id5-sync.com` or `api.id5-sync.com`; for example `https://api.id5-sync.com/gs/v2` (ID5's Prebid Server module) or `https://api.id5-sync.com/ga/v1` (ID5's in-app server-to-server API). |
| | `id5.timeoutMs` | optional | How long to wait for ID5, 10 to 5000 ms; 300 by default. Never longer than four fifths of `SID_MODULE_TIMEOUT_MS`. |
| | `id5.domain` | optional | The cache cookie's domain, such as `example.com` (it gets `Domain=.example.com`), or `auto`. Else `SID_COOKIE_DOMAIN`. |
| | `id5.browsers` | optional | Which visitors the module asks ID5 for: `all` (the default), or `webkit27`, only visitors on Apple WebKit 27 or later. See [below](#only-where-the-browser-blocks-id5-browsers). |
| | `id5.readCookie` | optional | A first-party cookie that may hold an ID5 answer, used without asking ID5: `id5id` by default (Prebid.js's ID5 module with cookie storage, maybe percent-encoded, maybe per partner under `pbjs`). `""` turns it off. |

There are no secrets: the partner number isn't one. The module is designed for one partner number per deployment: an upstream operator's own, with its `provider` name. `SID_HOSTS` can give each site its own `SID_MODULE_CONFIG`, but per-publisher partner numbers haven't been designed or tested for this module yet.

## Only where the browser blocks ID5: `browsers`

Starting with version 27, Apple's WebKit (Safari on the Mac, and every browser on iOS and iPadOS, which all use WebKit) blocks the requests a page makes to ID5 itself, so ID5's own script can't get an ID there. In other browsers it can. With `"browsers": "webkit27"`, the module asks ID5 only for visitors on those browsers: the server-side fetch fills the gap where the browser blocks ID5's own requests, and sends nothing for visitors whose browser can reach ID5 directly. A page that also runs ID5's own integration gets the ID from one place per visitor, rather than a second ID5 lookup from your server.

The browser is judged from the `User-Agent`, conservatively (when unsure, the module doesn't ask):

- **iOS and iPadOS** (`iPhone`, `iPad` or `iPod`): any browser, with an OS version of 27 or later (`OS 27_0 like Mac OS X`), or Safari's `Version/27` or later. Safari has reported a frozen OS version before, which is why its `Version/` token counts; a third-party iOS browser (Chrome, Firefox, Edge) has no `Version/` token, so if its OS version is frozen too it isn't recognised, and the module doesn't ask.
- **macOS:** Safari only, with `Version/27` or later; not Chrome, Firefox, Edge or another browser on a Mac. An iPad asking for the desktop site sends Safari's Mac user agent, and counts the same way.
- Everything else (Android, Windows, Linux) never matches.

For other visitors the module behaves as if it couldn't ask ID5 on that request: no request is sent, and a cached answer under 30 days old (or an `id5id` cookie) is still returned. Consent works exactly as without the setting: a denial still deletes the cache, whatever the browser. The default, `all`, asks for every visitor who passes the consent rules.

## Platforms

The module sends requests to ID5 through core, which only adapters that can reach other hosts provide: the **Cloudflare Worker**, **AWS Lambda**, **Vercel**, **Google Cloud** and the **Node.js server**. **Lambda@Edge, Azure Functions, Akamai and Fastly** refuse it (a 500 on every request, never silently ignored), as they refuse forwarding modules. It can't run in a **Cloudflare Snippet**: a request to ID5 alone takes longer than a Snippet's 5 ms, and vendor modules aren't built into Snippets.

## Size

About 11 KB minified, 4.8 KB gzipped (measured with esbuild, core left out), of which about 1.6 KB gzipped is the `gpp` module's GPP reader and the `ip` module's address formatting, which it uses and which your build may already have (`ip` is built in). No data is loaded at start-up, and it keeps nothing in memory between requests. Measure your own build with the adapter's bundle command: its size check prints the bundle's gzipped size.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { id5Module } from '@sharedid-edge/module-id5';

const handler = createHandler({
  config: resolveConfig(env),
  modules: [...builtInModules, id5Module],
  forwardFetch: request => fetch(request)   // the adapters pass this already
});
```

Other exports: `id5ModuleConfig()` (the settings parser), `parseId5Reply()`, `existingId5Reply()`, `id5RequestBody()`, `id5Denial()`, `clientAddress()`, `isRoutableIp()`, `isWebKit27()`, `readCache()`, `cacheCookieValue()`, and the constants `ID5_GVLID`, `ID5_HOSTS`, `ID5_DEFAULT_ENDPOINT`, `ID5_EID_SOURCE`, `ID5_REFRESH_SECONDS`, `ID5_MAX_AGE_SECONDS`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.id5` is missing | `id5` isn't in `SID_MODULES`. |
| `status` is `skipped`, `not installed` | The module isn't in your build (step 1). |
| Every request is a 500 | The platform can't send requests to other hosts (Lambda@Edge, Azure, Akamai, Fastly): see [Platforms](#platforms). |
| `status` is `timeout` | `SID_MODULE_TIMEOUT_MS` is too short; set it above `timeoutMs`. |
| `status` is `error` | Invalid settings: `partner` missing or not a whole number, an unknown key (a typo), an `endpoint` that isn't https on ID5's hosts, or a bad `domain`. |
| `status` is `empty` on the first visit, `ok` later | ID5 took longer than `timeoutMs`. The next request tries again; raise `timeoutMs` (and `SID_MODULE_TIMEOUT_MS`) if it keeps happening. |
| Always `empty`, `forwards: true` | ID5 answers with an error: server-side fetching isn't turned on for your partner number yet, or the request fields need confirming with ID5 (see [The request](#the-request)). The module asks again every hour. Or the visitor's address isn't routable (a private network, a test machine), or there's no user agent. |
| `forwards: false` | Opt-out, GPC, COPPA or missing consent for this visitor. |
| Nothing for visitors on Chrome, Firefox, Android or Windows | `"browsers": "webkit27"` limits the module to Apple WebKit 27 or later; set it to `all` (or leave it out) to ask for everyone. |
| `skipped`, `tcf: no consent for vendor 131` | The TC string doesn't give ID5 consent. |
| Nothing for visitors whose CMP sends a TC string, though ID5 has consent | The TC string doesn't opt in to Special Feature 1 (precise geolocation), which a full IP address needs here. |
