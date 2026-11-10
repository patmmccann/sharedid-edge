# @sharedid-edge/module-reflect

The `reflect` module for [SharedID Edge](../../README.md): it keeps other first-party cookies on your site durable, the way SharedID Edge keeps `_pubcid` durable.

Scripts on your pages write first-party cookies with `document.cookie`, such as an ID vendor's `uid1` or Google's `_ga`. Safari caps cookies written by script at 7 days. The worker already sees those cookies on every request to `/_sid/*` on your site. With this module, each `/_sid/v1` call sets them again in a `Set-Cookie` header with the **same value** and a **new expiry**. They become server-set cookies, which Safari doesn't cap the same way, and their lifetime is refreshed on each visit.

Cookies you mark `restore` are also saved in one `HttpOnly` cookie the worker owns, the **keeper**. When Safari has deleted one of them (a visitor who didn't come back for 7 days), the next `/_sid/v1` call sets it again from the keeper. It's what the worker's `_pubcid_sv` recovery copy does for `_pubcid`.

The module never changes, returns or logs the values. It only sets cookies, and only when the worker would be allowed to store the SharedID itself.

## Contents

- [Turning it on](#turning-it-on)
- [What it does](#what-it-does)
- [Match the original cookie's attributes](#match-the-original-cookies-attributes)
- [Make `uid1` sticky and server-set](#make-uid1-sticky-and-server-set)
- [Restore Google Analytics and Ads cookies after Safari deletes them (`_ga`, `_gcl_aw`, `_gcl_au`)](#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au)
- [The keeper cookie](#the-keeper-cookie)
- [Response](#response)
- [Consent and opt-out](#consent-and-opt-out)
- [Settings](#settings)
- [Only on `/_sid/v1`](#only-on-_sidv1)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker and the Node.js server. It does nothing until you list it in `SID_MODULES` and name the cookies to reflect.

1. **Find out how each cookie is set now.** In your browser's developer tools (Application, then Cookies), note each cookie's name and its **Domain** column, and whether **HttpOnly** is ticked. A Domain starting with a dot, such as `.example.com`, means it was set for the whole site; one without a dot, such as `www.example.com`, means host-only. See [Match the original cookie's attributes](#match-the-original-cookies-attributes) for why this matters.

2. **Enable the module and list the cookies**, in `packages/cloudflare/wrangler.jsonc`:

   ```jsonc
   "vars": {
     "SID_MODULES": "reflect",                // or e.g. "ip,reflect"
     "SID_MODULE_CONFIG": "{\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,\"domain\":\"example.com\"}]}}"
   }
   ```

   The same JSON, readable:

   ```json
   {
     "reflect": {
       "cookies": [
         { "name": "uid1", "maxAgeDays": 365, "domain": "example.com", "httpOnly": false }
       ]
     }
   }
   ```

   With the Node.js server, set the `SID_MODULES` and `SID_MODULE_CONFIG` environment variables to the same values.

3. **Deploy** (`npm exec -w @sharedid-edge/cloudflare -- wrangler deploy`), then check with a cookie in the request:

   ```sh
   curl -si https://www.example.com/_sid/v1 -H 'Cookie: uid1=AbC%2Fx+y/z==' | grep -i '^set-cookie: uid1'
   # set-cookie: uid1=AbC%2Fx+y/z==; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
   curl -s https://www.example.com/_sid/v1 | jq .ext.modules.reflect
   # { "ms": 0, "status": "empty" }
   ```

4. **On the page,** call `/_sid/v1` once per page view, after the scripts that write the cookies have run. See [Only on `/_sid/v1`](#only-on-_sidv1).

## What it does

On each `/_sid/v1` request, for each configured cookie, in the order listed:

| Situation | Cookie |
| --- | --- |
| The request carries the cookie, and the worker may store the SharedID | set again: same value, new `Max-Age` and `Expires`; with `restore`, its value is saved in the keeper |
| The request doesn't carry it, it has `restore`, and the keeper has a value for it | **restored**: set with the saved value and the configured attributes |
| The request doesn't carry it otherwise, or its value is empty | none |
| Its value is quoted (`"…"`), longer than 1024 characters, or has characters a cookie value can't have (spaces, commas, `;`, `\`, non-ASCII) | none: it can't be set again unchanged, so it's left alone (and with `restore`, its saved value is dropped) |
| The worker may not store the SharedID (opt-out, GPC, COPPA, consent) | none, and nothing is deleted; the keeper, if the browser has one, is deleted |

The value is copied **byte for byte**. Percent-encoding, base64 padding (`=`), `+` and `/` stay exactly as they are; nothing is decoded or re-encoded. When the `Cookie` header has the same name twice (see below), the first one is used.

The cookie it sets:

```http
Set-Cookie: uid1=<same value>; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
```

- **`Max-Age`:** `maxAgeDays` × 86400, refreshed on every `/_sid/v1` call.
- **`Domain`:** `.{domain}` from the cookie's `domain` setting. Without it, `SID_COOKIE_DOMAIN`; without that too, host-only.
- **`HttpOnly`:** only with `"httpOnly": true`. The default is `false`, because the script that wrote the cookie usually needs to read it.
- **`Path=/`** and **`SameSite=Lax`:** always. Cookies set at another path, or with `SameSite=None` or `Strict`, aren't a good fit for this module.
- **`Secure`:** over https.

A restored cookie gets exactly the same attributes.

## Match the original cookie's attributes

A browser keeps cookies apart by name, **domain** and path. The `Cookie` header only carries names and values, so the worker can't see how a cookie was originally set. If the module sets it with a different domain, the browser ends up with **two** cookies of the same name: the original (still capped at 7 days in Safari) and the reflected one. Both are sent back, and the script that reads the cookie may see either.

So, for each cookie:

- **Domain:**
  - if the original's Domain starts with a dot (`.example.com`), set `"domain": "example.com"`;
  - if it's host-only (`www.example.com`, no dot), leave `domain` out, and don't set `SID_COOKIE_DOMAIN` (which would otherwise apply);
  - if your scripts write it from several subdomains, pick the domain they use.
- **HttpOnly:** leave it `false` for cookies a script wrote (scripts can't write `HttpOnly` cookies). Set it to `true` only if the script never needs to read the cookie again, which is rare.
- **Path:** the module always sets `Path=/`. A cookie written with another path ends up duplicated, so don't reflect it.

You can check in the browser's developer tools after a `/_sid/v1` call: there should be one cookie of each name, with the new expiry.

## Make `uid1` sticky and server-set

**The problem.** An ID vendor's script writes `uid1` on your pages with `document.cookie`. In Safari, a cookie written by script lasts at most 7 days, however long the script asked for. A visitor who comes back after 8 days gets a new `uid1`, so they look like a new user to the vendor and to the bidders that use it.

**The fix.** Have the worker set `uid1` again from your own domain. A cookie set in an HTTP response (a server-set cookie) isn't held to the 7-day cap, provided the worker answers on your site's own IP addresses (see [Troubleshooting](#troubleshooting)).

1. **Look at the original cookie.** In Chrome or Edge: developer tools, Application, Cookies, your site. In Safari: Develop, Show Web Inspector, Storage, Cookies. Find `uid1` and note:
   - **Domain:** `.example.com` (with the dot) means it's set for the whole site. Use `"domain": "example.com"`. A host name without the dot (`www.example.com`) means host-only: leave `domain` out.
   - **HttpOnly:** it won't be ticked, since a script wrote it. Keep `"httpOnly": false`, or the vendor's script can no longer read it.
   - **Expires:** in Safari, at most 7 days away. That's what you're fixing.

2. **Configure the module** (`wrangler.jsonc`, or the Node.js server's environment):

   ```jsonc
   "vars": {
     "SID_MODULES": "reflect",
     "SID_MODULE_CONFIG": "{\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,\"domain\":\"example.com\",\"httpOnly\":false,\"restore\":true}]}}"
   }
   ```

   Readable:

   ```json
   {
     "reflect": {
       "cookies": [
         { "name": "uid1", "maxAgeDays": 365, "domain": "example.com", "httpOnly": false, "restore": true }
       ]
     }
   }
   ```

   - `maxAgeDays: 365` gives a one-year expiry, refreshed on every `/_sid/v1` call.
   - `domain` and `httpOnly` match the original, so the browser keeps one `uid1`, not two.
   - `restore: true` is optional. It saves `uid1` in the [keeper](#the-keeper-cookie), so if Safari has already deleted `uid1` when the visitor comes back, the worker sets the old value again instead of letting the vendor mint a new one. Leave it out if the vendor's own deletion of `uid1` means something (for example, its opt-out).

3. **Call `/_sid/v1` from the page,** after the vendor's script has written `uid1`, so the request carries it:

   ```js
   fetch('/_sid/v1', { credentials: 'include' }).catch(() => {});
   ```

   If you already call it for the payload (the snippet in the main README that merges `ortb2` into Prebid.js), that call is enough. With `restore`, a call early in the page also restores `uid1` before the vendor's script reads it; see [the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads) below, which applies to any script.

4. **Verify.** Load a page, then in the developer tools:
   - **Network:** select the `/_sid/v1` request. Its response headers include `Set-Cookie: uid1=…; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure`, with the same value the request's `Cookie` header carried. With `restore`, there's also `Set-Cookie: _sid_keep=…; …; HttpOnly`.
   - **Application (Storage in Safari), Cookies:** there's one `uid1`, its **Expires** is a year from now (not 7 days), and its value hasn't changed. `_sid_keep` is there too, with **HttpOnly** ticked.
   - In Safari, check again after more than 7 days, or delete `uid1` by hand and reload: `uid1` comes back with the same value.

## Restore Google Analytics and Ads cookies after Safari deletes them (`_ga`, `_gcl_aw`, `_gcl_au`)

Google's tag (gtag.js, or Google Tag Manager) writes its cookies with `document.cookie`:
- `_ga`: the Google Analytics client ID;
- `_gcl_aw`: the Google Ads click ID (`gclid`) from an ad click;
- `_gcl_au`: the conversion linker's own ID.

Safari caps them at 7 days. A visitor who returns after that is counted as a new user, and a conversion can no longer be tied to the ad click. Reflecting the cookies keeps them alive while the visitor keeps coming back; the keeper brings them back when Safari has deleted them anyway.

### Configuration

gtag usually sets these cookies on your registrable domain (Domain `.example.com`); check yours in the developer tools as in [step 1 above](#make-uid1-sticky-and-server-set).

```json
{
  "reflect": {
    "cookies": [
      { "name": "_ga", "maxAgeDays": 400, "domain": "example.com", "restore": true },
      { "name": "_gcl_aw", "maxAgeDays": 90, "domain": "example.com", "restore": true },
      { "name": "_gcl_au", "maxAgeDays": 90, "domain": "example.com", "restore": true }
    ],
    "keeper": { "cookie": "_sid_keep", "maxAgeDays": 400 }
  }
}
```

As a variable:

```jsonc
"vars": {
  "SID_MODULES": "reflect",
  "SID_MODULE_CONFIG": "{\"reflect\":{\"cookies\":[{\"name\":\"_ga\",\"maxAgeDays\":400,\"domain\":\"example.com\",\"restore\":true},{\"name\":\"_gcl_aw\",\"maxAgeDays\":90,\"domain\":\"example.com\",\"restore\":true},{\"name\":\"_gcl_au\",\"maxAgeDays\":90,\"domain\":\"example.com\",\"restore\":true}],\"keeper\":{\"cookie\":\"_sid_keep\",\"maxAgeDays\":400}}}"
}
```

- **`maxAgeDays`:** Google gives `_ga` about 2 years, but browsers cap cookies at 400 days, so 400 is the most you can set. Google gives `_gcl_aw` and `_gcl_au` 90 days by default; keep your tag's setting. The expiry is refreshed on every `/_sid/v1` call, so it counts from the visitor's latest visit, not from when Google first set the cookie.
- **`httpOnly`:** left out (`false`). gtag has to read these cookies.
- **`keeper`:** these are the defaults, so you can leave it out. Its domain defaults to the first `restore` cookie's, `example.com` here.

### Timing: gtag.js reads `_ga` when it loads

The worker only answers `/_sid/*`; it doesn't run before your page's scripts. gtag.js reads `_ga` when it loads. If Safari deleted `_ga` and gtag loads first, it mints a new client ID and writes it: by the time `/_sid/v1` runs, the request carries the new `_ga`, which is present, so it wins and replaces the saved one.

So call `/_sid/v1` **before gtag.js loads**, and load gtag when the call is done (or after a short timeout, so a slow call never holds analytics back):

```html
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');

  // Restore _ga, _gcl_aw and _gcl_au first, then load gtag.js.
  Promise.race([
    fetch('/_sid/v1', { credentials: 'include' }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 500))
  ]).then(() => {
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX';
    document.head.appendChild(script);
  });
</script>
```

The restored cookies are set by the `/_sid/v1` response, so gtag.js finds them when it loads. With Google Tag Manager, load the container the same way.

If you'd rather not change how gtag loads, call `/_sid/v1` anywhere on the page. Cookies the browser still has are refreshed as usual. Cookies Safari deleted are restored on that call, but that page view has already run without them: **the restore takes effect from the next page view**, and only for cookies gtag didn't write again in the meantime. gtag writes a new `_ga` on load when it finds none (and the conversion linker does the same for `_gcl_au`); a present value always wins, so for those the saved value is replaced by the new one. `_gcl_aw`, which is written only when the visitor lands from an ad click, is restored. So for `_ga`, calling `/_sid/v1` before gtag.js is the option that keeps the client ID.

If you pass consent to the worker (`gdpr`, `gdpr_consent`), add the same query parameters to that early call.

### Consent and opt-out

- The keeper reflects and restores only when the worker would store the SharedID: not on opt-out, Global Privacy Control, `coppa=1`, a TC string that doesn't give the SharedID's consent, or GDPR without a TC string. See [Consent and opt-out](#consent-and-opt-out).
- When storage isn't allowed, the worker **deletes the keeper** (it's the worker's own store of these values) but leaves `_ga`, `_gcl_aw` and `_gcl_au` alone: they're Google's tag's cookies, and they expire on their own schedule.
- **`/_sid/optout`** always deletes the keeper. It deletes the Google cookies only if you set `"deleteOnOptOut": true` on them.
- The keeper follows the worker's storage decision, not Google consent mode or your CMP's analytics and advertising choices. If your consent setup can refuse analytics or ads storage while allowing the SharedID, either leave `restore` off, or call `/_sid/v1` only when those are allowed too.
- If a script deletes one of these cookies on purpose, the keeper restores it on the next `/_sid/v1` call while storage is allowed. Use `restore` only for cookies whose owner doesn't delete them as a signal.

### Compared with Stape's Cookie Keeper

This is similar to Stape's Cookie Keeper power-up, which stores a first-party master cookie through HTTP headers and restores those cookies when Safari deletes them. The two aren't the same product, and this module doesn't aim for exact parity. Here:
- it runs on your own edge worker (or Node.js server), on your domain;
- it runs only when the page calls `/_sid/v1`, not on every request to your site;
- it follows the worker's consent rules, and opting out deletes the keeper;
- you choose the cookies, their lifetimes and domains, up to 10 per worker.

## The keeper cookie

- **Name:** `_sid_keep`, or `keeper.cookie`. It can't be one of the configured cookies, a [reserved name](#settings), or one of the worker's configured cookie names.
- **What it holds:** the last known value of every `restore` cookie. Present values win; values for cookies the browser no longer has are kept, so they can be restored again later.
- **Format:** base64url (no padding) of a JSON object, `{"_ga":"GA1.1.1234567890.1700000000","_gcl_au":"1.1.987654321.1700000000"}` becomes `eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAiLCJfZ2NsX2F1IjoiMS4xLjk4NzY1NDMyMS4xNzAwMDAwMDAwIn0`. That keeps it a valid cookie value whatever characters the saved values use. It's not encrypted: anyone with the browser's cookies can read it, as they can read the cookies themselves. It's `HttpOnly`, so page scripts can't.
- **Malformed values** (edited by hand, or from an older version) count as empty: they're overwritten on the next call, or deleted if there's nothing to save. They never cause an error.
- **Size:** a cookie's name and value can't be more than 4096 bytes together. The cookies are added in the order you list them; one that doesn't fit is left out of the keeper (it's still reflected, just not restorable), and later ones that fit are still saved. Three Google cookies take about 200 bytes. It takes several cookies near the 1024-character value limit to reach it.
- **Attributes:** `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` over https, `Max-Age` from `keeper.maxAgeDays` (default 400 days), and `Domain` from `keeper.domain`; without it, the **first `restore` cookie's `domain`**, so the keeper reaches the same hosts as the cookies it restores; without that, `SID_COOKIE_DOMAIN`, else host-only.
- **Refreshed on every call:** the worker sets it on every `/_sid/v1` call where it has something to keep, so its expiry moves forward with each visit, like the cookies it keeps.
- With no `restore` cookie configured, no keeper is set, and a left-over one is deleted.

## Response

The module only sets cookies, so it adds nothing to the payload, and its status is `empty` whether or not it reflected anything. With `SID_MODULES=reflect` and a request carrying `uid1`:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure; HttpOnly
Set-Cookie: uid1=AbC%2Fx+y/z==; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
```

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "reflect": { "ms": 0, "status": "empty" } } }
}
```

With the [Google configuration](#configuration), a request carrying `_ga` and `_gcl_au` (`Cookie: _ga=GA1.1.1234567890.1700000000; _gcl_au=1.1.987654321.1700000000`) gets, after the SharedID cookies:

```http
Set-Cookie: _ga=GA1.1.1234567890.1700000000; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _gcl_au=1.1.987654321.1700000000; Max-Age=7776000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAiLCJfZ2NsX2F1IjoiMS4xLjk4NzY1NDMyMS4xNzAwMDAwMDAwIn0; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

A week later Safari has deleted `_ga` and `_gcl_au`; the request carries only the keeper (`Cookie: _sid_keep=eyJfZ2Ei…`), and gets the same three `Set-Cookie` headers: both cookies are restored, and the keeper is refreshed. The payload is the same as above in both cases.

With `Sec-GPC: 1`, the same requests get no cookies but a deletion of the keeper, if they carried one, and the same `"status": "empty"`:

```http
Set-Cookie: _sid_keep=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

`ext.modules.reflect.status` is:
- `empty`: the normal status. Check the `Set-Cookie` headers to see what was reflected or restored.
- `error`: the settings are invalid, or name a cookie the worker reserves. Nothing is reflected, and no details are given.

The payload doesn't say which cookies were reflected or restored. The payload's `ortb2` goes to bidders, and a list of your cookie names doesn't belong there; the `Set-Cookie` headers already show it.

## Consent and opt-out

Reflecting or restoring a cookie extends how long an identifier is stored on the visitor's device, so the module follows the same rules as the SharedID itself. It reflects and restores **only when the worker would set `_pubcid`**, and so **not** when there's:
- the SharedID opt-out cookie (`_pubcid_optout`);
- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a TC string that doesn't give the SharedID's consent (publisher mode: the publisher TC segment needs Purpose 1, and one of Purposes 2 to 10; vendor mode: see the main README);
- GDPR applying (`gdpr=1`, or an EU location on Cloudflare) without a TC string.

The response's `X-SharedID-Status: denied: <reason>` header shows which.

**The configured cookies are never deleted on `/_sid/v1`.** They belong to other scripts, which have their own consent handling and sometimes store their own opt-out state in them. When consent is missing, the module just stops extending them, and they expire on their original schedule.

**The keeper is deleted on `/_sid/v1` when consent is missing,** if the browser has one. It's the worker's own store of identifiers, so it follows the rule that denied consent deletes the worker's ID cookies, as it does for `_pubcid` and `_pubcid_sv`. Nothing is restored afterwards, even when consent comes back, until the cookies are saved again.

**On `/_sid/optout`,** a configured cookie is deleted only if you set `"deleteOnOptOut": true` for it. It's deleted with the configured `Domain` and `HttpOnly`, and only if the browser sent it. The keeper is always deleted (if the browser sent it). This works whether or not `reflect` is in `SID_MODULES`, as long as its settings are still in `SID_MODULE_CONFIG`. Leave `deleteOnOptOut` `false` (the default) unless you're sure the cookie's owner expects it: deleting a cookie that holds an opt-out marker would undo that opt-out.

## Settings

All in `SID_MODULE_CONFIG.reflect`. Unknown keys, wrong types and out-of-range values make the module an `error`.

| Key | | |
| --- | --- | --- |
| `cookies` | required | 1 to 10 entries, below. |
| `cookies[].name` | required | The cookie's name, exactly (names are case-sensitive). At most 64 characters, no spaces or `=`. Listed once. |
| `cookies[].maxAgeDays` | required | The new lifetime in days, a whole number from 1 to 400 (Chrome caps cookies at 400). |
| `cookies[].domain` | optional | Your registrable domain, such as `example.com`, without a leading dot. The cookie gets `Domain=.example.com`. Default: `SID_COOKIE_DOMAIN`, else host-only. |
| `cookies[].httpOnly` | optional | `true` adds `HttpOnly`. Default `false`. |
| `cookies[].deleteOnOptOut` | optional | `true` deletes the cookie on `/_sid/optout`. Default `false`. |
| `cookies[].restore` | optional | `true` saves the cookie in the keeper and restores it when the browser no longer has it. Default `false`. |
| `keeper` | optional | The keeper cookie's settings, below. Leave it out to use the defaults. |
| `keeper.cookie` | optional | The keeper's name. Default `_sid_keep`. Same rules as `cookies[].name`, and not one of the configured cookies. |
| `keeper.maxAgeDays` | optional | The keeper's lifetime in days, 1 to 400. Default `400`. |
| `keeper.domain` | optional | As `cookies[].domain`. Default: the first `restore` cookie's `domain`, else `SID_COOKIE_DOMAIN`, else host-only. |

These names can't be reflected: `_pubcid`, `_pubcid_sv` and `_pubcid_optout` (the worker sets them itself), `ts-ec` (the `ec` module's cookie, which isn't refreshed by design) and `euconsent-v2` (consent records keep the lifetime the CMP gives them). If you renamed the SharedID cookies with `SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE` or `SID_OPTOUT_COOKIE`, those names are refused too, at request time, as an `error`. The same goes for the keeper's name.

There are no secrets.

## Only on `/_sid/v1`

Modules run on `/_sid/v1` only. Prebid.js's `sharedIdSystem` calls `/_sid/sync` (its `pixelUrl`), not `/_sid/v1`, so **cookies are reflected and restored only on pages that call `/_sid/v1`**, for example with the `fetch` snippet in the main README that merges the payload's `ortb2`.

- To reflect a cookie, call it after the script that writes the cookie has run, so the request carries it. On a visitor's first page view the cookie may not exist yet; it's picked up on the next call.
- To restore a cookie before its script reads it, call it before that script loads; see [the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads). One early call does both: a cookie the browser still has is refreshed, one it lost is restored.
- Once a day or so is enough to keep a cookie from expiring; calling it on every page view is fine too.

Running cookie-only modules on `/_sid/sync` as well, which Prebid.js calls on every page with `extend: true`, is an open question for a later version.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { reflectModule } from '@sharedid-edge/module-reflect';

const handler = createHandler({ config: resolveConfig(env), modules: [reflectModule] });
```

Other exports:
- `reflectModuleConfig(config)`: parses and validates the settings, with the keeper's defaults applied; throws a `TypeError` on invalid ones.
- `rawCookieValue(header, name)`: a cookie's value exactly as the `Cookie` header carries it.
- `isReflectable(value)`: whether a value can be set again unchanged.
- `encodeKeeper(entries, maxLength)` and `decodeKeeper(value)`: the keeper's value format. `decodeKeeper` never throws.
- `RESERVED_COOKIE_NAMES`, `MAX_REFLECTED_COOKIES`, `MAX_REFLECTED_VALUE_LENGTH`, `MAX_REFLECT_AGE_DAYS`, `DEFAULT_KEEPER_COOKIE`, `DEFAULT_KEEPER_AGE_DAYS`, `MAX_KEEPER_COOKIE_BYTES`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.reflect` is missing | `reflect` isn't in `SID_MODULES`. |
| `ext.modules.reflect.status` is `error` | The settings are invalid: check the JSON, that each entry has `name` and `maxAgeDays` (1 to 400), that `domain` has no leading dot, that no name is reserved or listed twice, and that `keeper` has only `cookie`, `maxAgeDays` and `domain`, with a name that isn't also in `cookies`. |
| No `Set-Cookie` for the cookie | The request didn't carry it (check the page calls `/_sid/v1` after the cookie is written, and that `/_sid/*` is on a host the cookie's domain covers); or its value is quoted, too long or has characters that can't be copied; or storage isn't allowed: see `X-SharedID-Status`. |
| Two cookies of the same name in the browser | The configured `domain` doesn't match the original's. See [Match the original cookie's attributes](#match-the-original-cookies-attributes). Delete the stray copy once (developer tools), then fix the setting. |
| The page's script can't read the cookie any more | `httpOnly` is `true`. Set it to `false`. |
| The cookie still expires after 7 days in Safari | Run `verify-deployment` (see the main README): the endpoint's IP addresses probably don't match the site's, so Safari still caps it. Or the page doesn't call `/_sid/v1`. |
| No `_sid_keep` cookie | No cookie has `"restore": true`; or none of them was in the request yet; or storage isn't allowed (the keeper is then deleted). |
| A deleted cookie isn't restored | The keeper didn't have it: it was never in a `/_sid/v1` request with storage allowed, or it didn't fit in 4096 bytes, or the keeper was deleted by an opt-out or missing consent (or expired). Or the page's script wrote a new value before `/_sid/v1` ran: a present value always wins. |
| A new `_ga` in Safari after a week, even with `restore` | gtag.js loaded before `/_sid/v1` and minted a new one. Call `/_sid/v1` before gtag.js; see [the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads). |
| `_sid_keep` is deleted on every call | Storage isn't allowed (see `X-SharedID-Status`), or no cookie has `restore` any more. |