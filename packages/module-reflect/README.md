# @sharedid-edge/module-reflect

The `reflect` module for [SharedID Edge](../../README.md): it keeps other first-party cookies on your site durable, the way SharedID Edge keeps `_pubcid` durable.

Scripts on your pages write first-party cookies with `document.cookie`, such as an ID vendor's `uid1`. Safari caps cookies written by script at 7 days. The worker already sees those cookies on every request to `/_sid/*` on your site. With this module, each `/_sid/v1` call sets them again in a `Set-Cookie` header with the **same value** and a **new expiry**. They become server-set cookies, which Safari doesn't cap the same way, and their lifetime is refreshed on each visit.

The module never changes, decodes, returns or logs the values. It only sets cookies, and only when the worker would be allowed to store the SharedID itself.

## Contents

- [Turning it on](#turning-it-on)
- [What it does](#what-it-does)
- [Match the original cookie's attributes](#match-the-original-cookies-attributes)
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
| The request carries the cookie, and the worker may store the SharedID | set again: same value, new `Max-Age` and `Expires` |
| The request doesn't carry it, or its value is empty | none |
| Its value is quoted (`"…"`), longer than 1024 characters, or has characters a cookie value can't have (spaces, commas, `;`, `\`, non-ASCII) | none: it can't be set again unchanged, so it's left alone |
| The worker may not store the SharedID (opt-out, GPC, COPPA, consent) | none, and nothing is deleted |

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

With `Sec-GPC: 1`, the same request gets no cookies at all and the same `"status": "empty"`.

`ext.modules.reflect.status` is:
- `empty`: the normal status. Check the `Set-Cookie` headers to see what was reflected.
- `error`: the settings are invalid, or name a cookie the worker reserves. Nothing is reflected, and no details are given.

The payload doesn't say which cookies were reflected. The payload's `ortb2` goes to bidders, and a list of your cookie names doesn't belong there; the `Set-Cookie` headers already show it.

## Consent and opt-out

Reflecting a cookie extends how long an identifier is stored on the visitor's device, so the module follows the same rules as the SharedID itself. It reflects **only when the worker would set `_pubcid`**, and so **not** when there's:
- the SharedID opt-out cookie (`_pubcid_optout`);
- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a TC string that doesn't give the SharedID's consent (publisher mode: the publisher TC segment needs Purpose 1, and one of Purposes 2 to 10; vendor mode: see the main README);
- GDPR applying (`gdpr=1`, or an EU location on Cloudflare) without a TC string.

The response's `X-SharedID-Status: denied: <reason>` header shows which.

**Nothing is deleted on `/_sid/v1`.** These cookies belong to other scripts, which have their own consent handling and sometimes store their own opt-out state in them. When consent is missing, the module just stops extending them, and they expire on their original schedule.

**On `/_sid/optout`,** a cookie is deleted only if you set `"deleteOnOptOut": true` for it. It's deleted with the configured `Domain` and `HttpOnly`, and only if the browser sent it. This works whether or not `reflect` is in `SID_MODULES`, as long as its settings are still in `SID_MODULE_CONFIG`. Leave it `false` (the default) unless you're sure the cookie's owner expects it: deleting a cookie that holds an opt-out marker would undo that opt-out.

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

These names can't be reflected: `_pubcid`, `_pubcid_sv` and `_pubcid_optout` (the worker sets them itself), `ts-ec` (the `ec` module's cookie, which isn't refreshed by design) and `euconsent-v2` (consent records keep the lifetime the CMP gives them). If you renamed the SharedID cookies with `SID_COOKIE_NAME`, `SID_RECOVERY_COOKIE` or `SID_OPTOUT_COOKIE`, those names are refused too, at request time, as an `error`.

There are no secrets.

## Only on `/_sid/v1`

Modules run on `/_sid/v1` only. Prebid.js's `sharedIdSystem` calls `/_sid/sync` (its `pixelUrl`), not `/_sid/v1`, so **cookies are reflected only on pages that call `/_sid/v1`**, for example with the `fetch` snippet in the main README that merges the payload's `ortb2`.

- Call it after the scripts that write the cookies have run, so the request carries them. On a visitor's first page view the cookie may not exist yet; it's picked up on the next call.
- Once a day or so is enough to keep a cookie from expiring; calling it on every page view is fine too.

Running cookie-only modules on `/_sid/sync` as well, which Prebid.js calls on every page with `extend: true`, is an open question for a later version.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { reflectModule } from '@sharedid-edge/module-reflect';

const handler = createHandler({ config: resolveConfig(env), modules: [reflectModule] });
```

Other exports:
- `reflectModuleConfig(config)`: parses and validates the settings; throws a `TypeError` on invalid ones.
- `rawCookieValue(header, name)`: a cookie's value exactly as the `Cookie` header carries it.
- `isReflectable(value)`: whether a value can be set again unchanged.
- `RESERVED_COOKIE_NAMES`, `MAX_REFLECTED_COOKIES`, `MAX_REFLECTED_VALUE_LENGTH`, `MAX_REFLECT_AGE_DAYS`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.reflect` is missing | `reflect` isn't in `SID_MODULES`. |
| `ext.modules.reflect.status` is `error` | The settings are invalid: check the JSON, that each entry has `name` and `maxAgeDays` (1 to 400), that `domain` has no leading dot, and that no name is reserved or listed twice. |
| No `Set-Cookie` for the cookie | The request didn't carry it (check the page calls `/_sid/v1` after the cookie is written, and that `/_sid/*` is on a host the cookie's domain covers); or its value is quoted, too long or has characters that can't be copied; or storage isn't allowed: see `X-SharedID-Status`. |
| Two cookies of the same name in the browser | The configured `domain` doesn't match the original's. See [Match the original cookie's attributes](#match-the-original-cookies-attributes). Delete the stray copy once (developer tools), then fix the setting. |
| The page's script can't read the cookie any more | `httpOnly` is `true`. Set it to `false`. |
| The cookie still expires after 7 days in Safari | Run `verify-deployment` (see the main README): the endpoint's IP addresses probably don't match the site's, so Safari still caps it. Or the page doesn't call `/_sid/v1`. |
