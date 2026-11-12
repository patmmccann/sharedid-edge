# @sharedid-edge/module-reflect

The `reflect` module for [SharedID Edge](../../../README.md): it keeps other first-party cookies on your site durable, the way SharedID Edge keeps `_pubcid` durable.

Scripts on your pages write first-party cookies with `document.cookie`, such as an ID vendor's `uid1` or Google's `_ga`. Safari caps cookies written by script at 7 days. The worker already sees those cookies on every request to `/_sid/*` on your site. With this module, each call to `/_sid/sync` (which Prebid.js makes on page views, with no extra page code) or `/_sid/v1` sets them again in a `Set-Cookie` header with the **same value** and a **new expiry**. They become server-set cookies, which Safari doesn't cap the same way, and their lifetime is refreshed on each visit.

Cookies you mark `restore` are also saved in one `HttpOnly` cookie the worker owns, the **keeper**. When Safari has deleted one of them (a visitor who didn't come back for 7 days), the next call sets it again from the keeper. It's what the worker's `_pubcid_sv` recovery copy does for `_pubcid`. If the page's script has already written a new value by then, [`prefer`](#which-value-wins-prefer) decides whether the new value or the saved one is kept.

The module never changes, returns or logs the values. It only sets cookies, and only when the worker would be allowed to store the SharedID itself.

## Contents

- [Turning it on](#turning-it-on)
- [What it does](#what-it-does)
- [Match the original cookie's attributes](#match-the-original-cookies-attributes)
- [Make `uid1` sticky and server-set](#make-uid1-sticky-and-server-set)
- [Duplicates](#duplicates)
- [Restore Google Analytics and Ads cookies after Safari deletes them (`_ga`, `_gcl_aw`, `_gcl_au`)](#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au)
- [The keeper cookie](#the-keeper-cookie)
- [Which value wins: `prefer`](#which-value-wins-prefer)
- [Response](#response)
- [Consent and opt-out](#consent-and-opt-out)
- [Settings](#settings)
- [When it runs: `/_sid/sync` and `/_sid/v1`](#when-it-runs-_sidsync-and-_sidv1)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker, the Node.js server and the AWS Lambda adapter. It does nothing until you list it in `SID_MODULES` and name the cookies to reflect.

1. **Find out how each cookie is set now.** In your browser's developer tools (Application, then Cookies), note each cookie's name and its **Domain** column, and whether **HttpOnly** is ticked. A Domain starting with a dot, such as `.example.com`, means it was set for the whole site; one without a dot, such as `www.example.com`, means host-only. See [Match the original cookie's attributes](#match-the-original-cookies-attributes) for why this matters.

2. **Enable the module and list the cookies**, in `packages/adapters/cloudflare/wrangler.jsonc`:

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
   curl -si https://www.example.com/_sid/sync -H 'Cookie: uid1=AbC%2Fx+y/z==' | grep -i '^x-sharedid-modules\|^set-cookie: uid1'
   # x-sharedid-modules: reflect=empty
   # set-cookie: uid1=AbC%2Fx+y/z==; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
   ```

4. **On the page,** nothing more, if Prebid.js already calls `/_sid/sync` (its `pixelUrl`, with `extend: true`): that call runs the module. Without it, call `/_sid/v1` once per page view, after the scripts that write the cookies have run. See [When it runs](#when-it-runs-_sidsync-and-_sidv1).

## What it does

On each `/_sid/sync` or `/_sid/v1` request, for each configured cookie, in the order listed:

| Situation | Cookie |
| --- | --- |
| The request carries the cookie, it has `restore`, the keeper has a value for it, and [`prefer`](#which-value-wins-prefer) picks the saved value (`backup`, or `older` when the saved value is older) | **restored**: set with the saved value and the configured attributes, replacing the one the browser sent |
| The request carries the cookie otherwise, and the worker may store the SharedID | set again: same value, new `Max-Age` and `Expires`; with `restore`, its value is saved in the keeper |
| The request doesn't carry it, it has `restore`, and the keeper has a value for it | **restored**: set with the saved value and the configured attributes |
| The request doesn't carry it otherwise, or its value is empty | none |
| Its value is quoted (`"…"`), longer than 1024 characters, or has characters a cookie value can't have (spaces, commas, `;`, `\`, non-ASCII) | none: it can't be set again unchanged, so it's left alone (and with `restore`, its saved value is dropped) |
| The worker may not store the SharedID (opt-out, GPC, COPPA, consent) | none, and nothing is deleted; the keeper, if the browser has one, is deleted |

The value is copied **byte for byte**. Percent-encoding, base64 padding (`=`), `+` and `/` stay exactly as they are; nothing is decoded or re-encoded. When the `Cookie` header has the same name twice (see below), the first one is used.

The cookie it sets:

```http
Set-Cookie: uid1=<same value>; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
```

- **`Max-Age`:** `maxAgeDays` × 86400, refreshed on every call.
- **`Domain`:** `.{domain}` from the cookie's `domain` setting, or none with `"domain": "host-only"`. Without a `domain` setting, `SID_COOKIE_DOMAIN`.
- **`HttpOnly`:** only with `"httpOnly": true`. The default is `false`, because the script that wrote the cookie usually needs to read it.
- **`Path=/`** and **`SameSite=Lax`:** always. Cookies set at another path, or with `SameSite=None` or `Strict`, aren't a good fit for this module.
- **`Secure`:** over https.

A restored cookie gets exactly the same attributes.

## Match the original cookie's attributes

A browser keeps cookies apart by name, **domain** and path. The `Cookie` header only carries names and values, so the worker can't see how a cookie was originally set. If the module sets it with a different domain, the browser ends up with **two** cookies of the same name: the original (still capped at 7 days in Safari) and the reflected one. Both are sent back, and the script that reads the cookie may see either.

So, for each cookie:

- **Domain:**
  - if the original's Domain starts with a dot (`.example.com`), set `"domain": "example.com"`;
  - if it's host-only (`www.example.com`, no dot), set `"domain": "host-only"` (without a `domain`, `SID_COOKIE_DOMAIN` applies);
  - if your scripts write it from several subdomains, pick the domain they use.
- **HttpOnly:** leave it `false` for cookies a script wrote (scripts can't write `HttpOnly` cookies). Set it to `true` only if the script never needs to read the cookie again, which is rare.
- **Path:** the module always sets `Path=/`. A cookie written with another path ends up duplicated, so don't reflect it.

You can check in the browser's developer tools after a `/_sid/sync` or `/_sid/v1` call: there should be one cookie of each name, with the new expiry.

## Make `uid1` sticky and server-set

**The problem.** An ID vendor's script writes `uid1` on your pages with `document.cookie`. In Safari, a cookie written by script lasts at most 7 days, however long the script asked for. A visitor who comes back after 8 days gets a new `uid1`, so they look like a new user to the vendor and to the bidders that use it.

**The fix.** Have the worker set `uid1` again from your own domain. A cookie set in an HTTP response (a server-set cookie) isn't held to the 7-day cap, provided the worker answers on your site's own IP addresses (see [Troubleshooting](#troubleshooting)).

1. **Look at the original cookie.** In Chrome or Edge: developer tools, Application, Cookies, your site. In Safari: Develop, Show Web Inspector, Storage, Cookies. Find `uid1` and note:
   - **Domain:** `.example.com` (with the dot) means it's set for the whole site. Use `"domain": "example.com"`. A host name without the dot (`www.example.com`) means host-only: use `"domain": "host-only"`. Leaving `domain` out gives the cookie `SID_COOKIE_DOMAIN`'s domain.
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

   - `maxAgeDays: 365` gives a one-year expiry, refreshed on every call.
   - `domain` and `httpOnly` match the original, so the browser keeps one `uid1`, not two.
   - `restore: true` is optional. It saves `uid1` in the [keeper](#the-keeper-cookie), so if Safari has already deleted `uid1` when the visitor comes back, the worker sets the old value again instead of letting the vendor mint a new one. Leave it out if the vendor's own deletion of `uid1` means something (for example, its opt-out).
   - `"prefer": "backup"` (optional, with `restore`) also puts the saved `uid1` back when the vendor's script already wrote a new one before the worker was called. Add it only if the vendor never changes `uid1` on purpose; see [Which value wins](#which-value-wins-prefer).

3. **Let Prebid.js's pixel call carry it.** With `pixelUrl: '/_sid/sync'` and `extend: true` (see [Configure Prebid.js](../../../docs/prebid.md)), Prebid.js calls the worker on page views, and that call reflects `uid1` when the browser has it. If the vendor's script writes `uid1` after Prebid.js's call, the next call picks it up.

   **Where the vendor's tag sits matters for `restore`.** Prebid.js makes its pixel call as soon as it loads. If the vendor's tag comes **after** Prebid.js in the page, the pixel call reaches the worker before the tag runs, so a `uid1` Safari deleted comes back with its old value, and the tag then finds it and keeps it. If the vendor's tag comes **before** Prebid.js, it has already minted a new `uid1` by the time the pixel call is made, and with the default `prefer` the browser's new value wins (the keeper saves it from then on). To keep the old value in that case, add `"prefer": "backup"` (only if the vendor never changes `uid1` on purpose), or load the vendor's tag after Prebid.js. The [browser tests](../../../e2e/AGENTS.md) check both orders. Without Prebid.js's pixel call, call `/_sid/v1` from the page, after the vendor's script has written `uid1`:

   ```js
   fetch('/_sid/v1', { credentials: 'include' }).catch(() => {});
   ```

   If you already call it for the payload (the [snippet](../../../docs/prebid.md#module-output-_sidv1) that merges `ortb2` into Prebid.js), that call is enough. With `restore`, a call early in the page also restores `uid1` before the vendor's script reads it; see [the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads) below, which applies to any script.

4. **Verify.** Load a page, then in the developer tools:
   - **Network:** select the `/_sid/sync` (or `/_sid/v1`) request; if it says "(disk cache)", disable the cache and reload. Its response headers include `Set-Cookie: uid1=…; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure`, with the same value the request's `Cookie` header carried. With `restore`, there's also `Set-Cookie: _sid_keep=…; …; HttpOnly`.
   - **Application (Storage in Safari), Cookies:** there's exactly one `uid1` (two mean `domain` doesn't match where the vendor writes it; see [Duplicates](#duplicates)), its **Expires** is a year from now (not 7 days), and its value hasn't changed. `_sid_keep` is there too, with **HttpOnly** ticked.
   - In Safari, check again after more than 7 days, or delete `uid1` by hand and reload: `uid1` comes back with the same value.

## Duplicates

A browser can hold two cookies with the same name, set with different `Domain`s: a host-only `uid1` from a vendor's tag next to the `Domain=.example.com` copy this module sets, say. It sends both, and the `Cookie` header doesn't say which is which. The module reflects the **first** (browsers list the older copy first). Then:

- **Same value in every copy:** it also deletes the host-only copy (an empty value, `Max-Age=0`, no `Domain`), which leaves the domain copy alone, so the browser keeps one. This needs the copy it sets to have a domain (the cookie's `domain`, else `SID_COOKIE_DOMAIN`).
- **Different values:** it deletes neither. The other copy may be the vendor's newer write, such as a rotated ID or its opt-out, and the module never overrides that. Set `domain` to match where the vendor writes the cookie, and the copies stop diverging.
- **The keeper** (`_sid_keep`) is this worker's own, so a host-only duplicate of it is always deleted.

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
      { "name": "_ga", "maxAgeDays": 400, "domain": "example.com", "restore": true, "prefer": "older" },
      { "name": "_gcl_aw", "maxAgeDays": 90, "domain": "example.com", "restore": true },
      { "name": "_gcl_au", "maxAgeDays": 90, "domain": "example.com", "restore": true, "prefer": "older" }
    ],
    "keeper": { "cookie": "_sid_keep", "maxAgeDays": 400 }
  }
}
```

As a variable:

```jsonc
"vars": {
  "SID_MODULES": "reflect",
  "SID_MODULE_CONFIG": "{\"reflect\":{\"cookies\":[{\"name\":\"_ga\",\"maxAgeDays\":400,\"domain\":\"example.com\",\"restore\":true,\"prefer\":\"older\"},{\"name\":\"_gcl_aw\",\"maxAgeDays\":90,\"domain\":\"example.com\",\"restore\":true},{\"name\":\"_gcl_au\",\"maxAgeDays\":90,\"domain\":\"example.com\",\"restore\":true,\"prefer\":\"older\"}],\"keeper\":{\"cookie\":\"_sid_keep\",\"maxAgeDays\":400}}}"
}
```

- **`prefer: "older"`** on `_ga` and `_gcl_au` (recommended): if gtag.js loaded before the worker was called and minted a new `_ga` or `_gcl_au` because Safari had deleted the old one, the worker sees that the new value was created after the saved one and puts the saved one back. See [Which value wins](#which-value-wins-prefer). It only replaces a value with an older one, so a visitor's established client ID is kept, and the cookie is fixed from the **next** page view (the current page's hits were already sent with the new ID).
- **`_gcl_aw` keeps the default, `prefer: "browser"`.** gtag writes `_gcl_aw` only when the visitor lands from an ad click, and its time is that click's. A newer `_gcl_aw` means a newer click, which should replace the old one, so `older` would undo it.

- **`maxAgeDays`:** Google gives `_ga` about 2 years, but browsers cap cookies at 400 days, so 400 is the most you can set. Google gives `_gcl_aw` and `_gcl_au` 90 days by default; keep your tag's setting. The expiry is refreshed on every call, so it counts from the visitor's latest visit, not from when Google first set the cookie.
- **`httpOnly`:** left out (`false`). gtag has to read these cookies.
- **`keeper`:** these are the defaults, so you can leave it out. Its domain defaults to the first `restore` cookie's, `example.com` here.

### Timing: gtag.js reads `_ga` when it loads

The worker only answers `/_sid/*`; it doesn't run before your page's scripts. gtag.js reads `_ga` when it loads. If Safari deleted `_ga` and gtag loads first, it mints a new client ID and writes it: by the time the worker is called, the request carries the new `_ga`, which is present, so it wins and replaces the saved one.

Prebid.js's pixel call (`/_sid/sync`) usually comes after gtag.js has loaded, so on its own it restores `_ga` too late. It still keeps the cookies refreshed on every visit, and restores `_gcl_aw` (see below). To keep the `_ga` client ID through a deletion, call `/_sid/v1` **before gtag.js loads**, and load gtag when the call is done (or after a short timeout, so a slow call never holds analytics back):

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

If you'd rather not change how gtag loads, rely on Prebid.js's pixel call, or call `/_sid/v1` anywhere on the page. Cookies the browser still has are refreshed as usual. Cookies Safari deleted are restored on that call, but that page view has already run without them: **the restore takes effect from the next page view**. gtag writes a new `_ga` on load when it finds none (and the conversion linker does the same for `_gcl_au`). With `"prefer": "older"`, as in the configuration above, the worker replaces those new values with the older saved ones, so the visitor keeps their client ID from the next page view on; with the default, `"prefer": "browser"`, the new value wins and replaces the saved one. `_gcl_aw`, which is written only when the visitor lands from an ad click, is restored either way. Calling `/_sid/v1` before gtag.js is still the only option that keeps the client ID on the current page view too.

A visitor whose cookies Safari deleted hasn't been back for 7 days, so the browser's cached `/_sid/sync` response (one day by default) has expired by then, and the first pixel call on their return reaches the worker.

If you pass consent to the worker (`gdpr`, `gdpr_consent`), add the same query parameters to that early call.

### Consent and opt-out

- The keeper reflects and restores only when the worker would store the SharedID: not on opt-out, Global Privacy Control, `coppa=1`, a TC string that doesn't give the SharedID's consent, or GDPR without a TC string. See [Consent and opt-out](#consent-and-opt-out).
- When storage isn't allowed, the worker **deletes the keeper** (it's the worker's own store of these values) but leaves `_ga`, `_gcl_aw` and `_gcl_au` alone: they're Google's tag's cookies, and they expire on their own schedule.
- **`/_sid/optout`** always deletes the keeper. It deletes the Google cookies only if you set `"deleteOnOptOut": true` on them.
- The keeper follows the worker's storage decision, not Google consent mode or your CMP's analytics and advertising choices. If your consent setup can refuse analytics or ads storage while allowing the SharedID, either leave `restore` off, or keep `reflect` off `/_sid/sync` (set `SID_SYNC_MODULES` without it, or to `none`) and call `/_sid/v1` only when those are allowed too: Prebid.js's pixel call doesn't know about them.
- If a script deletes one of these cookies on purpose, the keeper restores it on the next call while storage is allowed. Use `restore` only for cookies whose owner doesn't delete them as a signal. Likewise, with `prefer: "older"` a deliberately reset `_ga` (one written with a new client ID) is replaced by the saved one; with `prefer: "backup"`, any new value is.

### Compared with Stape's Cookie Keeper and Cookie Extender

This is similar to Stape's Cookie Keeper power-up, which stores a first-party master cookie through HTTP headers and restores those cookies when Safari deletes them. The two aren't the same product, and this module doesn't aim for exact parity. Here:
- it runs on your own edge worker (or Node.js server), on your domain;
- it runs when Prebid.js calls `/_sid/sync` (at most once per `SID_SYNC_CACHE_SECONDS` in each browser, a day by default) or the page calls `/_sid/v1`, not on every request to your site;
- it follows the worker's consent rules, and opting out deletes the keeper;
- you choose the cookies, their lifetimes and domains, up to 10 per worker.

With [`keeper.mode: "per-cookie"`](#one-keeper-or-a-backup-per-cookie-keepermode), the backups work like Stape's open-source [Cookie Extender](https://github.com/stape-io/cookie-extender-tag) tag instead, a backup cookie per cookie, except that these backups are `HttpOnly`.

## The keeper cookie

- **Name:** `_sid_keep`, or `keeper.cookie`. It can't be one of the configured cookies, a [reserved name](#settings), or one of the worker's configured cookie names.
- **What it holds:** the last known value of every `restore` cookie: the value the browser sent, unless [`prefer`](#which-value-wins-prefer) picked the saved one. Values for cookies the browser no longer has are kept, so they can be restored again later.
- **Format:** base64url (no padding) of a JSON object, `{"_ga":"GA1.1.1234567890.1700000000","_gcl_au":"1.1.987654321.1700000000"}` becomes `eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAiLCJfZ2NsX2F1IjoiMS4xLjk4NzY1NDMyMS4xNzAwMDAwMDAwIn0`. That keeps it a valid cookie value whatever characters the saved values use. It's not encrypted: anyone with the browser's cookies can read it, as they can read the cookies themselves. It's `HttpOnly`, so page scripts can't.
- **Malformed values** (edited by hand, or from an older version) count as empty: they're overwritten on the next call, or deleted if there's nothing to save. They never cause an error.
- **Size:** a cookie's name and value can't be more than 4096 bytes together. The cookies are added in the order you list them; one that doesn't fit is left out of the keeper (it's still reflected, just not restorable), and later ones that fit are still saved. Three Google cookies take about 200 bytes. It takes several cookies near the 1024-character value limit to reach it.
- **Attributes:** `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` over https, `Max-Age` from `keeper.maxAgeDays` (default 400 days), and `Domain` from `keeper.domain`; without it, the **first `restore` cookie's `domain`**, so the keeper reaches the same hosts as the cookies it restores; without that, `SID_COOKIE_DOMAIN`, else host-only.
- **Refreshed on every call:** the worker sets it on every `/_sid/sync` or `/_sid/v1` call where it has something to keep, so its expiry moves forward with each visit, like the cookies it keeps.
- With no `restore` cookie configured, no keeper is set, and a left-over one is deleted.

### One keeper or a backup per cookie: `keeper.mode`

By default (`"master"`), one keeper cookie holds every saved value. With `"keeper": { "mode": "per-cookie" }`, each `restore` cookie gets its own `HttpOnly` backup instead: `_ga` is backed up in `_ga_backup`, with its value as is (`keeper.suffix` changes `_backup`).

| | One keeper (`master`, default) | A backup per cookie (`per-cookie`) |
| --- | --- | --- |
| Size | All values share 4096 bytes | Each backup has its own 4096 |
| Request size | One extra cookie | One extra cookie per `restore` cookie |
| Format | base64url JSON | The value as is, byte for byte |
| A corrupted backup | Loses every saved value | Loses only that one |
| In DevTools | Opaque | Readable |

Pick `per-cookie` when you restore cookies whose values together approach 4096 bytes, or want to see the backups plainly; otherwise one keeper keeps requests smaller. The backups follow the same rules as the keeper: `HttpOnly` (unlike Stape's, which page scripts can read), refreshed on every call, `Max-Age` from `keeper.maxAgeDays`, `Domain` from `keeper.domain` (else each cookie's own `domain`), deleted when storage isn't allowed and on `/_sid/optout`.

**Switching is safe.** The worker reads both forms: after a switch, it restores from whichever the browser has, writes the configured form, and deletes the other.

## Which value wins: `prefer`

A `restore` cookie can be in the request **and** in the keeper with a different value. That happens when Safari deleted the cookie and the page's script minted a new one before the worker was called: gtag.js does it with `_ga` when it loads first. Each `restore` cookie's `prefer` setting says which value is kept:

| `prefer` | The request carries the cookie and the keeper has another value | Use it for |
| --- | --- | --- |
| `"browser"` (default) | The browser's value wins: it's set again and replaces the saved one. | Cookies whose owner may change them on purpose. This is how the keeper has always worked. |
| `"backup"` | The saved value wins: it's set over the browser's, whatever that is, and stays saved. | Identifiers that should never change once set, like `uid1` in [the example above](#make-uid1-sticky-and-server-set). |
| `"older"` | Whichever was **created first** wins, read from the creation time in the value. On a tie, or if either value doesn't have the expected format, the browser's value wins, as with `"browser"`. | `_ga` and `_gcl_au`, which carry the time they were minted. |

In every mode, a cookie missing from the request is restored from the keeper, and the browser's value is saved when the keeper has nothing for it. A value that wins is set **byte for byte** with the cookie's configured attributes: the worker compares values, it never changes them. Nothing is restored when the worker may not store the SharedID ([consent](#consent-and-opt-out)), and the keeper is deleted then, as always.

**Example, `older`.** The keeper has `_ga=GA1.1.1234567890.1700000000` (created November 2023). Safari deleted `_ga`, and gtag.js minted `GA1.1.555555555.1750000000` (June 2025) before the page called `/_sid/v1`:

```http
Cookie: _ga=GA1.1.555555555.1750000000; _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAifQ
```

The saved value is older, so it's restored, and the keeper keeps it:

```http
Set-Cookie: _ga=GA1.1.1234567890.1700000000; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAifQ; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

With `"prefer": "browser"`, the same request gets `_ga=GA1.1.555555555.1750000000` back and a keeper holding that new value. With `"backup"`, it gets the saved value, as with `older`; but `backup` would also restore it if the browser's `_ga` were the older one.

**Caveats:**
- **It fixes later page views, not the current one.** By the time the page calls `/_sid/v1`, a script that minted a new value has already used it: gtag.js has sent the page view's hits with the new client ID. The restored cookie is what gtag reads from the next page view on. To keep the ID on the current page view too, call `/_sid/v1` before the script loads ([timing](#timing-gtagjs-reads-_ga-when-it-loads)).
- **`backup` overrides the cookie's owner.** If the script resets its cookie on purpose (a new client ID after the user asked for one, or its own opt-out marker), `backup` puts the old value back on the next call (Prebid.js's pixel or `/_sid/v1`), for as long as the keeper has it. That's why it isn't the default. `older` does the same for a deliberate reset that writes a newer value.
- **The creation time comes from the visitor's clock.** gtag writes it with the browser's time. A value more than a day in the future (by the worker's clock) doesn't count as parsed, so the browser's value wins. A clock that's behind can make a new value look older than the saved one; then the new value wins, as it would by default.

**Formats `older` reads.** Each value must match its format exactly, and the creation time must be 10 digits of Unix seconds:

| `format` | Value | Assumed for the cookie named |
| --- | --- | --- |
| `"ga"` | `GA1.<d>.<random>.<seconds>`, where `<d>` is the cookie domain's depth: `GA1.1.…` (gtag.js) and `GA1.2.…` (older analytics.js) both match. | `_ga` |
| `"gcl_au"` | `1.<d>.<random>.<seconds>` | `_gcl_au` |
| `"gcl_aw"` | `GCL.<seconds>.<click ID>`; the time is the ad click's | `_gcl_aw` |

The format comes from the cookie's exact name. For a cookie gtag writes under another name (its `cookie_prefix` setting, such as `site_ga`), set `"format"`. `"prefer": "older"` on any other cookie without `"format"` is a settings error, since there would be nothing to compare. Other cookies, like `uid1` or a UUID, don't carry their creation time; use `"browser"` or `"backup"` for them. The `_ga_<container>` session cookies aren't in the `"ga"` format.

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

On `/_sid/sync`, the same cookies come with Prebid.js's pixel, and `X-SharedID-Modules` gives the status instead of the payload. With the configuration in [Turning it on](#turning-it-on) plus `_ga` with `restore`, and `SID_COOKIE_DOMAIN=.example.com`:

```http
HTTP/1.1 200 OK
Content-Type: image/gif
Content-Length: 43
Cache-Control: private, max-age=86400
X-Robots-Tag: noindex
X-SharedID-Modules: reflect=empty
X-SharedID-Source: cookie
Set-Cookie: uid1=AbC123xyz; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _ga=GA1.1.1234567890.1700000000; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAifQ; Max-Age=34560000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

The payload doesn't say which cookies were reflected or restored. The payload's `ortb2` goes to bidders, and a list of your cookie names doesn't belong there; the `Set-Cookie` headers already show it.

## Consent and opt-out

Reflecting or restoring a cookie extends how long an identifier is stored on the visitor's device, so the module follows the same rules as the SharedID itself. It reflects and restores **only when the worker would set `_pubcid`**, and so **not** when there's:
- the SharedID opt-out cookie (`_pubcid_optout`);
- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a TC string that doesn't give the SharedID's consent (publisher mode: the publisher TC segment needs Purpose 1, and one of Purposes 2 to 10; vendor mode: see [Consent and opt-out](../../../docs/consent.md));
- GDPR applying (`gdpr=1`, or a visitor in the EU, the rest of the EEA, the UK or Turkey) without a TC string.

The response's `X-SharedID-Status: denied: <reason>` header shows which.

**The configured cookies are never deleted on `/_sid/sync` or `/_sid/v1`.** They belong to other scripts, which have their own consent handling and sometimes store their own opt-out state in them. When consent is missing, the module just stops extending them, and they expire on their original schedule.

**The keeper is deleted on `/_sid/sync` and `/_sid/v1` when consent is missing,** if the browser has one. It's the worker's own store of identifiers, so it follows the rule that denied consent deletes the worker's ID cookies, as it does for `_pubcid` and `_pubcid_sv`. Nothing is restored afterwards, even when consent comes back, until the cookies are saved again.

**On `/_sid/optout`,** a configured cookie is deleted only if you set `"deleteOnOptOut": true` for it. It's deleted with the configured `Domain` and `HttpOnly`, and only if the browser sent it. The keeper is always deleted (if the browser sent it). This works whether or not `reflect` is in `SID_MODULES`, as long as its settings are still in `SID_MODULE_CONFIG`. Leave `deleteOnOptOut` `false` (the default) unless you're sure the cookie's owner expects it: deleting a cookie that holds an opt-out marker would undo that opt-out.

## Settings

All in `SID_MODULE_CONFIG.reflect`. Unknown keys, wrong types and out-of-range values make the module an `error`.

| Key | | |
| --- | --- | --- |
| `cookies` | required | 1 to 10 entries, below. |
| `cookies[].name` | required | The cookie's name, exactly (names are case-sensitive). At most 64 characters, no spaces or `=`. Listed once. |
| `cookies[].maxAgeDays` | required | The new lifetime in days, a whole number from 1 to 400 (Chrome caps cookies at 400). |
| `cookies[].domain` | optional | Your registrable domain, such as `example.com`, without a leading dot (the cookie gets `Domain=.example.com`), or `host-only` for a cookie without a `Domain`. Default: `SID_COOKIE_DOMAIN`. |
| `cookies[].httpOnly` | optional | `true` adds `HttpOnly`. Default `false`. |
| `cookies[].deleteOnOptOut` | optional | `true` deletes the cookie on `/_sid/optout`. Default `false`. |
| `cookies[].restore` | optional | `true` saves the cookie in the keeper and restores it when the browser no longer has it. Default `false`. |
| `cookies[].prefer` | optional | With `"restore": true`: which value wins when the browser sends the cookie and the keeper has another, `"browser"`, `"backup"` or `"older"`. See [Which value wins](#which-value-wins-prefer). Default `"browser"`. |
| `cookies[].format` | optional | With `"prefer": "older"`: the value's format, `"ga"`, `"gcl_au"` or `"gcl_aw"`. Default: from the name (`_ga`, `_gcl_au`, `_gcl_aw`); required for other names. |
| `keeper` | optional | The keeper cookie's settings, below. Leave it out to use the defaults. |
| `keeper.cookie` | optional | The keeper's name. Default `_sid_keep`. Same rules as `cookies[].name`, and not one of the configured cookies. |
| `keeper.maxAgeDays` | optional | The keeper's lifetime in days, 1 to 400. Default `400`. |
| `keeper.domain` | optional | As `cookies[].domain`. Default: the first `restore` cookie's `domain`, else `SID_COOKIE_DOMAIN`. |

These names can't be reflected: `_pubcid`, `_pubcid_sv` and `_pubcid_optout` (the worker sets them itself), `ts-ec` (the `ec` module's cookie, which isn't refreshed by design) and `euconsent-v2` (consent records keep the lifetime the CMP gives them). If you renamed the SharedID cookies with `SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE` or `SID_OPTOUT_COOKIE`, those names are refused too, at request time, as an `error`. The same goes for the keeper's name.

There are no secrets.

## When it runs: `/_sid/sync` and `/_sid/v1`

The module runs on both routes, with the same rules:

- **`/_sid/sync`**, Prebid.js's `pixelUrl`. With `extend: true`, Prebid.js calls it on page views, so cookies are refreshed, saved and restored **with no code on your page**. The response is still the 1×1 GIF; only the cookies and an `X-SharedID-Modules: reflect=…` header are added.
- **`/_sid/v1`**, when your page calls it: for the payload (the `fetch` snippet in [Configure Prebid.js](../../../docs/prebid.md#module-output-_sidv1)), or early in the page to restore a cookie before its script reads it ([the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads)).

**The sync response is cached.** A browser keeps a successful `/_sid/sync` response for `SID_SYNC_CACHE_SECONDS` (default `86400`, a day) and doesn't call the worker again until it expires, so from Prebid.js's pixel the module runs about once a day per browser. That's enough to keep a cookie from expiring, and a cookie Safari deleted after 7 days without a visit is restored on the visitor's first page view back, since the cached response has expired by then. A cookie deleted some other way is restored when the cache next expires, or on the next `/_sid/v1` call. To run it more often, lower `SID_SYNC_CACHE_SECONDS` (`3600` for hourly; `0` for every page view, at the cost of a worker request on every page view).

- To reflect a cookie, the request has to carry it: a call made before the script that writes the cookie has run picks it up on the next call. On a visitor's first page view the cookie may not exist yet.
- To keep `reflect` off `/_sid/sync`, set `SID_SYNC_MODULES` to the modules you do want there, or `none`.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { reflectModule } from '@sharedid-edge/module-reflect';

const handler = createHandler({ config: resolveConfig(env), modules: [reflectModule] });
```

Other exports:
- `reflectModuleConfig(config)`: parses and validates the settings, with the keeper's defaults applied; throws a `TypeError` on invalid ones.
- `rawCookieValue(header, name)`: a cookie's value exactly as the `Cookie` header carries it (the first, when the name repeats), and `rawCookieValues(header, name)` every value in header order.
- `isReflectable(value)`: whether a value can be set again unchanged.
- `encodeKeeper(entries, maxLength)` and `decodeKeeper(value)`: the keeper's value format. `decodeKeeper` never throws.
- `cookieTimestamp(format, value, nowSeconds)`: the creation time `prefer: "older"` reads from a value, or `undefined`. Never throws.
- The types `ReflectModuleConfig`, `ReflectedCookie`, `KeeperSettings`, `KeeperPreference` and `TimestampFormat`.
- `RESERVED_COOKIE_NAMES`, `MAX_REFLECTED_COOKIES`, `MAX_REFLECTED_VALUE_LENGTH`, `MAX_REFLECT_AGE_DAYS`, `DEFAULT_KEEPER_COOKIE`, `DEFAULT_KEEPER_AGE_DAYS`, `MAX_KEEPER_COOKIE_BYTES`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.reflect` is missing | `reflect` isn't in `SID_MODULES`. |
| `ext.modules.reflect.status` is `error` | The settings are invalid: check the JSON, that each entry has `name` and `maxAgeDays` (1 to 400), that `domain` has no leading dot, that no name is reserved or listed twice, and that `keeper` has only `cookie`, `maxAgeDays` and `domain`, with a name that isn't also in `cookies`. `prefer` other than `"browser"` needs `"restore": true`; `"older"` needs a cookie named `_ga`, `_gcl_au` or `_gcl_aw`, or a `format`; `format` is only for `"older"`. |
| No `Set-Cookie` on `/_sid/sync` | The response came from the browser's cache ("(disk cache)" in the Network panel): the module runs again when it expires (`SID_SYNC_CACHE_SECONDS`). Or `X-SharedID-Modules` is missing or doesn't list `reflect`: it isn't in `SID_MODULES`, or `SID_SYNC_MODULES` leaves it out. |
| No `Set-Cookie` for the cookie | The request didn't carry it (check the cookie is written before Prebid.js's pixel call or your `/_sid/v1` call, and that `/_sid/*` is on a host the cookie's domain covers); or its value is quoted, too long or has characters that can't be copied; or storage isn't allowed: see `X-SharedID-Status`. |
| Two cookies of the same name in the browser | The configured `domain` doesn't match the original's. See [Match the original cookie's attributes](#match-the-original-cookies-attributes). Delete the stray copy once (developer tools), then fix the setting. |
| The page's script can't read the cookie any more | `httpOnly` is `true`. Set it to `false`. |
| The cookie still expires after 7 days in Safari | Run `verify-deployment` (see your platform's README): the endpoint's IP addresses probably don't match the site's, so Safari still caps it. Or neither Prebid.js's pixel call (`pixelUrl` with `extend: true`) nor a `/_sid/v1` call reaches the worker. |
| No `_sid_keep` cookie | No cookie has `"restore": true`; or none of them was in the request yet; or storage isn't allowed (the keeper is then deleted). |
| A deleted cookie isn't restored | The keeper didn't have it: it was never in a `/_sid/sync` or `/_sid/v1` request with storage allowed, or it didn't fit in 4096 bytes, or the keeper was deleted by an opt-out or missing consent (or expired). Or the page's script wrote a new value before the worker was called: with the default `"prefer": "browser"`, a present value wins. See [Which value wins](#which-value-wins-prefer). |
| A new `_ga` in Safari after a week, even with `restore` | gtag.js loaded before the worker was called (Prebid.js's pixel call usually comes after gtag.js) and minted a new one. Set `"prefer": "older"` on `_ga` to restore the old one from the next page view, and call `/_sid/v1` before gtag.js to keep it on the first one too; see [the timing caveat](#timing-gtagjs-reads-_ga-when-it-loads). |
| `"prefer": "older"` keeps the new `_ga` | The values don't both match the [`ga` format](#which-value-wins-prefer) (a renamed cookie needs `"format"`), the new value's time is more than a day ahead of the worker's clock, or the visitor's clock was behind when gtag minted it. The browser's value wins then. |
| A cookie's owner reset it, and the old value came back | `"prefer": "backup"` (or `"older"`, for a newer value) restores the saved value over any new one. Use `"browser"` for cookies their owner changes on purpose. |
| No `Set-Cookie` for a cookie on Azure Functions, and the log says it "cannot preserve multiple raw Set-Cookie headers" | The Functions host can set only one cookie per response whose value has characters other than letters, digits, `-`, `.`, `_` and `~`; a second is left out rather than changed. See [the Azure adapter](../../adapters/azure-functions/README.md#cookie-values). |
| `_sid_keep` is deleted on every call | Storage isn't allowed (see `X-SharedID-Status`), or no cookie has `restore` any more. |