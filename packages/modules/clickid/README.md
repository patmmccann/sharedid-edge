# @sharedid-edge/module-clickid

The `clickid` module for [SharedID Edge](../../../README.md): it keeps the ad click IDs in your landing page's URL in **server-set first-party cookies**, so a conversion on a later page view, or a later visit, can still be attributed.

Ad platforms add a click ID to the landing page's URL: `gclid`, `gbraid` and `wbraid` (Google Ads), `dclid` (Display & Video 360), `fbclid` (Meta), `msclkid` (Microsoft Advertising) and `ttclid` (TikTok). Today each vendor's tag keeps its own with `document.cookie` (`_gcl_aw`, `_fbc`, `_uetmsclkid`), which Safari caps at 7 days, and at 24 hours on a page reached through a link decorated by a known tracker. The worker sees the landing page's URL on the first `/_sid/sync` or `/_sid/v1` call of the page view. With this module it stores each click ID it finds in a cookie it sets itself, for 90 days from the click, where your conversion tags, analytics pipeline or server-side tagging can read it later.

Click IDs are **never** put in the `/_sid/v1` payload: no `eids`, no `ortb2`, nothing in `ext`. They can't reach bidders.

## Contents

- [Turning it on](#turning-it-on)
- [The cookies](#the-cookies)
- [Reading a click ID](#reading-a-click-id)
- [Who uses the click IDs](#who-uses-the-click-ids)
- [Where the URL comes from](#where-the-url-comes-from)
- [Response](#response)
- [Consent and opt-out](#consent-and-opt-out)
- [Settings](#settings)
- [When it runs: `/_sid/sync` and `/_sid/v1`](#when-it-runs-_sidsync-and-_sidv1)
- [`clickid` or `reflect` for Google's `_gcl_aw`?](#clickid-or-reflect-for-googles-_gcl_aw)
- [Not yet supported](#not-yet-supported)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into every adapter. It does nothing until you list it in `SID_MODULES`.

1. **Enable it**, in `packages/adapters/cloudflare/wrangler.jsonc` (the other adapters take the same variables):

   ```jsonc
   "vars": {
     "SID_MODULES": "clickid",                 // or e.g. "reflect,clickid"
     "SID_COOKIE_DOMAIN": ".example.com"       // optional: share the cookies across your subdomains
   }
   ```

   No `SID_MODULE_CONFIG` is needed for the seven default parameters. See [Settings](#settings) to turn some off, rename cookies or add parameters such as LinkedIn's `li_fat_id`.

2. **Make sure the landing page calls the worker.** If the page runs Prebid.js with SharedID Edge's `pixelUrl` ([Prebid.js setup](../../../docs/prebid.md)), there's nothing to add: Prebid.js calls `/_sid/sync` on page views and the browser sends the landing page as the `Referer`. Otherwise, or to be independent of the referrer policy, call `/_sid/v1` with the page's URL as early as you can:

   ```html
   <script>
     fetch('/_sid/v1?url=' + encodeURIComponent(location.href), { credentials: 'include' });
   </script>
   ```

   Add the consent parameters you have (`gdpr`, `gdpr_consent`, `us_privacy`, `coppa=1`), as for any `/_sid/v1` call (see [Consent](../../../docs/consent.md)).

3. **Deploy, then check** with a made-up click ID:

   ```sh
   curl -si 'https://www.example.com/_sid/v1?url=https%3A%2F%2Fwww.example.com%2F%3Fgclid%3Dtest-123' | grep -i '^set-cookie: _sid_'
   # Set-Cookie: _sid_gclid=1794447131.test-123; Max-Age=7776000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
   ```

## The cookies

| Parameter | Ad platform | Cookie (default name) |
| --- | --- | --- |
| `gclid` | Google Ads | `_sid_gclid` |
| `gbraid` | Google Ads (iOS app campaigns, web to app) | `_sid_gbraid` |
| `wbraid` | Google Ads (iOS, app to web) | `_sid_wbraid` |
| `dclid` | Display & Video 360, Campaign Manager 360 | `_sid_dclid` |
| `fbclid` | Meta | `_sid_fbclid` |
| `msclkid` | Microsoft Advertising | `_sid_msclkid` |
| `ttclid` | TikTok | `_sid_ttclid` |

- **Value:** `<click time>.<id>`: the time the worker saw the click, in Unix seconds, a dot, and the click ID exactly as it came, after one round of URL decoding. For example `_sid_gclid=1794447131.EAIaIQobChMIexample_BwE`.
- **Only safe values are stored:** letters, digits and `.`, `_`, `~`, `-`, at most 512 characters. Anything else (a value still percent-encoded, with spaces, or too long) is ignored, never rewritten. When a parameter appears twice in the URL, the first is used.
- **Lifetime:** `maxAgeDays`, 90 days by default, counted from the click. That's the longest click-through conversion window Google Ads allows (the default is 30 days), the retention Microsoft suggests for `msclkid`, and the lifetime of Google's `_gcl_aw` and Meta's `_fbc` cookies; Meta's and TikTok's attribution windows are shorter (see [Who uses the click IDs](#who-uses-the-click-ids)). Later visits **don't** extend it. The same click ID seen again (a reload, a bookmarked landing URL) leaves the cookie as it is; a different click ID for the same parameter replaces it.
- **Attributes:** `Path=/`, `SameSite=Lax`, `Secure` (over https), `Domain` from the module's `domain` (else `SID_COOKIE_DOMAIN`, else host-only), and `HttpOnly` only if you set `httpOnly: true`. They're readable by page scripts by default, since the usual consumer is a conversion tag.
- Cookies of other parameters are left alone: a `fbclid` landing doesn't touch `_sid_gclid`.

## Reading a click ID

The ID is everything after the first dot (IDs may contain dots themselves):

```js
function clickId(name) {
  const cookie = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  if (cookie === undefined) return undefined;
  const value = cookie.slice(name.length + 1);
  const dot = value.indexOf('.');
  return { id: value.slice(dot + 1), clickedAt: new Date(Number(value.slice(0, dot)) * 1000) };
}

// For example, with a conversion event in your analytics pipeline (RudderStack expects properties.gclid):
const gclid = clickId('_sid_gclid');
if (gclid !== undefined) rudderanalytics.track('Order Completed', { gclid: gclid.id, revenue: 42 });
```

Server-side tagging on the same registrable domain (with `SID_COOKIE_DOMAIN` or `domain` set so the cookie reaches it) reads the same cookie from the request; with `httpOnly: true`, only server-side code can.

## Who uses the click IDs

Vendor tags don't read `_sid_*` cookies: they keep writing their own. Send the stored ID to the platform from your own code, typically with a server-side conversion:

| Parameter | The vendor tag's own cookie | Sending a stored ID |
| --- | --- | --- |
| `gclid`, `gbraid`, `wbraid` | `_gcl_aw`, `_gcl_gb` ([Google's cookie list](https://business.safety.google/adscookies/), 90 days; Google doesn't document which holds `gbraid` or `wbraid`) | Google Ads API click conversions: `gclid`, `gbraid`, `wbraid`; send every one you have ([Google](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks)) |
| `dclid` | `_gcl_dc` (90 days) | Floodlight (Campaign Manager 360) |
| `fbclid` | `_fbc` = `fb.<n>.<milliseconds>.<fbclid>` | Conversions API `fbc`. Build it as `fb.1.<click time × 1000>.<id>` and don't change the ID's case ([Meta](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/)) |
| `msclkid` | `_uetmsclkid` | Conversions API `userData.msclkid`; Microsoft suggests keeping the latest one for 90 days, as this module does ([Microsoft](https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration)) |
| `ttclid` | `ttclid` ([TikTok](https://ads.tiktok.com/help/article/using-cookies-with-tiktok-pixel?lang=en)) | Events API `ttclid`, on every web event |

**Why it pays, and for whom.** It helps a site that **buys** ads and lands the clicks on its own pages: a store, or a publisher running subscription, app or affiliate campaigns. Safari caps cookies written by `document.cookie` at 7 days ([WebKit](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/)), and at 24 hours on a page reached from a known tracker through a URL with a query string ([WebKit](https://webkit.org/blog/8828/intelligent-tracking-prevention-2-2/)). A conversion after that, but inside the platform's window, has no click to be attributed to. Under-reported conversions feed automated bidding, which targets conversions or conversion value ([Google](https://support.google.com/google-ads/answer/7065882?hl=en)), and they make a campaign's return look lower than it is. Uploading the stored click ID with the conversion reports it. It doesn't change what you earn from selling ad space: click IDs never go to bidders.

**IDs the browser strips can't be kept:** see [Troubleshooting](#troubleshooting). Firefox's Strict mode also strips `fbclid` ([Mozilla](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html)), and Brave strips `fbclid`, `gclid` and `msclkid` ([Brave](https://brave.com/privacy-updates-5/)).

**Other platforms** can be added with [`params`](#settings): LinkedIn `li_fat_id`, X `twclid`, Pinterest `epik`, Snapchat `ScCid` and Reddit `rdt_cid`.

## Where the URL comes from

In order:

1. the `url` query parameter of the request (the snippet above sends `location.href`);
2. otherwise the `Referer` header. A same-origin request sends the full page URL, query string included, under the browser's default referrer policy (`strict-origin-when-cross-origin`). This is what makes the `/_sid/sync` call from Prebid.js work with no page code.

Either way, the URL's host must be the request's own host or one listed in `hosts`; anything else is ignored. And the request itself must come from your site: one the browser marks `Sec-Fetch-Site: cross-site`, or whose `Referer` is on another host, stores nothing, even with a `url` on your host. So another site can't plant a click ID through a link to your worker. A request with neither header (`curl`, or a page with `Referrer-Policy: no-referrer` in a browser that doesn't send `Sec-Fetch-Site`) is judged by its URL alone.

## Response

The module only sets cookies, so it reports `empty` and adds nothing to the payload. A landing page's `/_sid/v1` call, with `SID_COOKIE_DOMAIN=.example.com`, real output:

```http
GET /_sid/v1?url=https%3A%2F%2Fwww.example.com%2Fshoes%3Ffbclid%3DIwAR2example_aem
Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d

HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Set-Cookie: _sid_fbclid=1794447131.IwAR2example_aem; Max-Age=7776000; Expires=Wed, 10 Feb 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Fri, 12 Nov 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Fri, 12 Nov 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "clickid": { "ms": 0, "status": "empty" } } }
}
```

The payload is the same with or without a click ID, and when consent denies storage. With invalid settings the status is `error` and nothing is set. On `/_sid/sync`, `X-SharedID-Modules: clickid=empty` shows it ran (see [Responses](../../../docs/responses.md#get-_sidsync-the-pixelurl-endpoint)).

## Consent and opt-out

Click IDs exist to measure and attribute advertising, so the rules are at least as strict as for the SharedID. Nothing is stored, and the click ID cookies the browser has are **deleted**, when:

- **the SharedID can't be stored:** the opt-out cookie, Global Privacy Control (`Sec-GPC: 1`), `coppa=1`, a TC string that doesn't give the SharedID's consent, or GDPR applying (by `gdpr=1` or the visitor's location) without a TC string;
- **US privacy:** the `us_privacy` string opts out of sale (its third character is `Y`, as in `1YYN`). It's read from the `us_privacy` parameter, else from the `usprivacy` cookie that IAB's CCPA framework uses, since Prebid.js's `/_sid/sync` call carries no consent parameters;
- **TCF:** when there's a TC string (the `gdpr_consent` parameter or the CMP's `euconsent-v2` cookie) or GDPR applies, the publisher TC segment must consent to **Purposes 1 and 7** (store and access information on a device; measure advertising performance).

Deleting needs the module to run, so it checks Purposes 1 and 7 itself rather than declaring them as module `purposes` (core skips a module with missing purposes before it runs).

**Opt-out:** `/_sid/optout` deletes every click ID cookie of the configuration the browser sent, whether or not `clickid` is in `SID_MODULES`, including parameters you've since switched off with `enabled: false`.

**Vendor consent isn't checked.** The worker doesn't decode per-vendor consent yet, so the module doesn't check consent for Google (GVL ID 755), Meta, Microsoft or TikTok, only the publisher purposes above. If your CMP setup needs vendor consent before a click ID is kept, call `/_sid/v1` only after it's given, and keep `clickid` off `/_sid/sync` (`SID_SYNC_MODULES`, see [When it runs](#when-it-runs-_sidsync-and-_sidv1)).

**Google Consent Mode** (`ad_storage`, `ad_user_data`) lives in the page and never reaches the worker. If you use Consent Mode, call `/_sid/v1` with `url` only once `ad_storage` is granted and keep `clickid` off `/_sid/sync`, or switch off `gclid`, `gbraid`, `wbraid` and `dclid`. [Prebid.js issue #16159](https://github.com/prebid/Prebid.js/issues/16159) proposes a Consent Mode v2 module for Prebid.js; until consent signals like that reach the worker, this is the page's job.

## Settings

All optional, in `SID_MODULE_CONFIG`:

```json
{
  "clickid": {
    "params": [
      { "name": "dclid", "enabled": false },
      { "name": "fbclid", "cookie": "fbclid_kept" },
      { "name": "li_fat_id", "cookie": "_sid_li_fat_id" }
    ],
    "maxAgeDays": 90,
    "domain": "example.com",
    "httpOnly": false,
    "hosts": ["shop.example.com"]
  }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `params` | the seven above | Entries `{ "name", "cookie"?, "enabled"? }`. One naming a default parameter changes it (`enabled: false` turns it off; `cookie` renames its cookie); any other adds a parameter, kept in `cookie` (default `_sid_<name>`). Names start with a letter, then letters, digits, `_` or `-` (at most 64), and match case-sensitively (`ScCid` isn't `sccid`). At most 20 parameters in all. |
| `maxAgeDays` | `90` | The cookies' lifetime from the click, 1 to 400 days. |
| `domain` | `SID_COOKIE_DOMAIN` | `example.com` for `Domain=.example.com`, or `host-only` for no `Domain`. |
| `httpOnly` | `false` | `true` hides the cookies from page scripts, for server-side consumers only. |
| `hosts` | none | Other hostnames (lower case, up to 20) whose URLs count as landing pages, for a landing page on one host whose `/_sid/v1` call goes to another. The request's own host always counts. Only hosts on the same site (registrable domain) as the worker work from a browser, which marks a call from another site `Sec-Fetch-Site: cross-site`. |

Cookie names can't be `_pubcid`, `_pubcid_sv`, `_pubcid_optout`, `ts-ec`, `euconsent-v2` or `_sid_keep` (the `reflect` module's keeper), nor your configured SharedID cookie names, and two parameters can't share a cookie. Any other mistake (an unknown key, a wrong type, a duplicate) makes the module report `error` on every call and set nothing; the error doesn't say which value is wrong, so check against this table.

## When it runs: `/_sid/sync` and `/_sid/v1`

Its routes are `v1` and `sync`. On `/_sid/sync`, the call Prebid.js makes on page views, it reads the landing page from the `Referer`.

**Syncs aren't cached while it runs there.** Normally the browser reuses a sync response for `SID_SYNC_CACHE_SECONDS` (a day). The browser's cache is keyed on the sync URL, which is the same on every page, so a cached sync would skip the worker on every landing page until it expired, and miss those clicks. So whenever `clickid` runs on `/_sid/sync`, the response is `Cache-Control: no-store`: one worker request per page view that calls `pixelUrl`, instead of one a day. If that's too many requests, keep it on `/_sid/v1` only, with the [snippet](#turning-it-on) on your pages, by listing the other modules in `SID_SYNC_MODULES`:

```jsonc
"SID_MODULES": "reflect,clickid",
"SID_SYNC_MODULES": "reflect"        // or "none"
```

## `clickid` or `reflect` for Google's `_gcl_aw`?

They do different jobs:

- **`reflect`** keeps cookies the page **already wrote**. If Google's tag (with the conversion linker) writes `_gcl_aw` and your Google Ads conversions read it, [`reflect`](../reflect/README.md#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au) with `restore` keeps that cookie server-set and brings it back after Safari deletes it. Google's tags keep working unchanged.
- **`clickid`** writes cookies **of its own** from the URL, which no tag has to have written. Use it when the consumer is your code: an analytics or event pipeline (RudderStack's `properties.gclid`, Jitsu), offline conversion uploads, server-side tagging, or a platform whose tag you don't run. It covers `gbraid` and `wbraid`, whose cookie Google doesn't document, and non-Google platforms.

Using both is fine: they set different cookies. For `gclid` you rarely need both.

## Not yet supported

- **Vendor cookie formats.** Writing the platforms' own cookies (`_gcl_aw=GCL.<seconds>.<gclid>`, `_fbc=fb.1.<milliseconds>.<fbclid>`, `_uetmsclkid=_uet<msclkid>`), so vendor tags pick them up unchanged, is a planned follow-up. Meta documents `_fbc`; the `_gcl_aw` and `_uetmsclkid` value formats aren't documented by Google or Microsoft (`GCL.<seconds>.<gclid>` is what third-party implementations write), so each has to be checked against the vendor's tag, and the cookies compete with the vendors' own tags and server-side copies.
- **Per-vendor TCF consent** (above).

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { clickIdModule, clickIdModuleConfig } from '@sharedid-edge/module-clickid';

const handler = createHandler({ config: resolveConfig({ SID_MODULES: 'clickid' }), modules: [clickIdModule] });
clickIdModuleConfig({ params: [{ name: 'li_fat_id' }] }); // validates settings; throws a TypeError on a mistake
```

The package also exports `landingUrl`, `clickIdFrom` and `storedClickId`, the steps above, and `clickIdDenial`, the consent check.

## Troubleshooting

- **No `_sid_*` cookie after landing with `?gclid=…`:**
  - Check `ext.modules.clickid` in the `/_sid/v1` response (or `X-SharedID-Modules` on `/_sid/sync`). `error` means invalid settings; no entry means `clickid` isn't in `SID_MODULES` (or, on `/_sid/sync`, not in `SID_SYNC_MODULES`).
  - `X-SharedID-Status: denied: …` on the response means consent denied storage; so do a `us_privacy` opt-out of sale and a TC string without Purpose 7, which leave no header. See [Consent and opt-out](#consent-and-opt-out).
  - **The referrer policy.** Without `url`, the module needs the full landing URL in the `Referer`. A page or site with `Referrer-Policy: no-referrer`, `origin` or `strict-origin` (as a header or a `<meta name="referrer">` tag) sends no query string, so there's nothing to find. Use the [snippet](#turning-it-on) with `url`, or a policy that keeps same-origin URLs (`strict-origin-when-cross-origin`, the default, or `same-origin`).
  - **The landing page doesn't call the worker.** The click ID is only in the landing page's URL. A landing page without Prebid.js (or whose sync doesn't fire on that page) and without the `/_sid/v1` snippet passes it by, and the next page's URL no longer has it. Add the snippet to landing pages.
  - **The URL is on another host:** a landing page on `shop.example.com` calling the worker on `www.example.com` needs `"hosts": ["shop.example.com"]`.
  - **The value was rejected:** values with characters outside letters, digits and `._~-`, still percent-encoded, or longer than 512 characters are ignored. Real click IDs fit; a test value like `test 123` doesn't.
  - **Safari strips some parameters.** Safari's Link Tracking Protection removes known click IDs, such as `gclid` and `fbclid`, from URLs in Private Browsing, in links opened from Mail and Messages, and with Advanced Tracking and Fingerprinting Protection on. The page never sees them, so there's nothing to keep. That's expected, not something to work around.
- **The cookie's expiry doesn't move on later visits.** By design: the lifetime counts from the click. A new click ID replaces it.
- **A click on a second landing page wasn't kept.** With `clickid` on `/_sid/sync` the sync isn't cached; check that `Cache-Control` on `/_sid/sync` is `no-store`. If it shows `private, max-age=…`, `clickid` didn't run there.
