# SharedID variable for server-side Google Tag Manager

[`sharedid-variable.tpl`](sharedid-variable.tpl) is a **variable template** for a server-side Google Tag Manager (sGTM) container. It returns the visitor's Prebid SharedID from the `_pubcid` cookie that SharedID Edge sets, so tags in your server container can use it, for example to send it to an ad platform that accepts publisher-provided IDs.

It only reads cookies (and the `Sec-GPC` header) from the request sGTM is handling. It sets nothing, calls nothing and logs nothing. For how it fits with the rest of an sGTM setup, see [Using SharedID Edge with server-side GTM](../../docs/sgtm.md).

## Contents

- [Before you start](#before-you-start)
- [Import it](#import-it)
- [What it returns](#what-it-returns)
- [Fields](#fields)
- [Permissions](#permissions)
- [Example: send the SharedID with a tag](#example-send-the-sharedid-with-a-tag)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [About the file](#about-the-file)

## Before you start

sGTM only sees cookies the browser sends to it, so **`_pubcid` has to reach your tagging server's host**:

- **sGTM on a path of your site** (`www.example.com/metrics`, Google's recommended setup): it gets the same cookies as your pages, so this works with any `SID_COOKIE_DOMAIN`.
- **sGTM on a subdomain** (`metrics.example.com`): `SID_COOKIE_DOMAIN` must be your registrable domain (`example.com`), which is the normal setting. With `SID_COOKIE_DOMAIN=host-only`, the cookie stays on `www.example.com` and the subdomain never sees it.
- **sGTM on the cloud provider's domain** (`*.run.app`): it sees none of your site's cookies. Use [the page snippet](../../docs/sgtm.md#option-a-add-the-sharedid-to-ga4-events-on-the-page) instead.

Your CDN or load balancer must forward cookies to the tagging server (Google's same-origin guide says the same).

## Import it

1. Download [`sharedid-variable.tpl`](sharedid-variable.tpl).
2. In Tag Manager, open your **server** container and click **Templates**.
3. Under **Variable Templates**, click **New**. The Template Editor opens.
4. Click the More Actions menu (⋮) and select **Import**, then pick the file.
5. Check the **Permissions** tab (below), and click **Save**.
6. Click **Variables** > **User-Defined Variables** > **New**, choose **SharedID (SharedID Edge)** under Custom, keep the defaults, and save it as, say, `SharedID`.

These are the import steps in Google's [Custom templates: Export and import](https://developers.google.com/tag-platform/tag-manager/templates#export_and_import). The template isn't in the Community Template Gallery: the gallery needs a repository of its own for each template ([gallery submission](https://developers.google.com/tag-platform/tag-manager/templates/gallery)), which this project hasn't set up.

## What it returns

The SharedID as a string, such as `c29cb2ae-769d-42f6-891a-f53cadee823d`, chosen the way SharedID Edge chooses it ([The ID](../../spec/SPEC.md#the-id)):

1. the `HttpOnly` recovery copy, `_pubcid_sv`, if it's a valid ID. Page scripts can't read it, but sGTM, a server, can. When it differs from `_pubcid`, the page re-minted the ID after Safari capped the cookie, and SharedID Edge puts this value back on its next call, so this is the ID the visitor keeps;
2. otherwise `_pubcid`, if it's a valid ID.

A valid ID matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. When the browser sends two cookies of the same name, the first is used, as SharedID Edge does ([Duplicates](../../spec/SPEC.md#cookies)).

It returns `undefined`:

- when neither cookie is there or valid (a first page view before Prebid.js or SharedID Edge set it, or consent that ruled it out: SharedID Edge deletes the cookies then);
- when the opt-out cookie, `_pubcid_optout`, is present;
- for a request with `Sec-GPC: 1` (Global Privacy Control), unless you untick that field. SharedID Edge deletes the ID cookies on its next call for such a browser, but the request sGTM gets may come first.

It doesn't read TCF, Google Consent Mode or other consent signals. Gate the tags that use it as you gate any tag ([Consent](../../docs/sgtm.md#consent-keeping-consent-mode-and-sharedid-edge-consistent)).

## Fields

| Field | Default | What it's for |
| --- | --- | --- |
| SharedID cookie | `_pubcid` | SharedID Edge's `SID_COOKIE_NAME`. |
| Recovery cookie (HttpOnly copy) | `_pubcid_sv` | SharedID Edge's `SID_RECOVERY_COOKIE`. Empty reads the SharedID cookie only. |
| Opt-out cookie | `_pubcid_optout` | Returns `undefined` when present. Empty ignores it. |
| Return undefined for requests with Global Privacy Control | ticked | Returns `undefined` for `Sec-GPC: 1`. |

If you renamed a cookie in SharedID Edge, change it here **and** add the new name to the **Reads cookie value(s)** permission, or the template stops with a permission error.

## Permissions

The template asks for two, both narrowed to what it uses (Google's [server-side permissions](https://developers.google.com/tag-platform/tag-manager/server-side/permissions)):

| Permission | Set to | Used by |
| --- | --- | --- |
| **Reads cookie value(s)** (`get_cookies`) | Specific: `_pubcid`, `_pubcid_sv`, `_pubcid_optout` | `getCookieValues` |
| **Reads HTTP request** (`read_request`) | Specific: headers, `sec-gpc` only | `getRequestHeader` |

It uses `createRegex` and `testRegex` to check the ID, which need no permission but need a server image of version 2.0.0 or later ([`createRegex`](https://developers.google.com/tag-platform/tag-manager/server-side/api#createregex)); on an older image it returns `undefined`.

## Example: send the SharedID with a tag

With the variable saved as `SharedID`:

1. In a tag that takes a user or publisher ID (a custom field, an "external ID", or a template's user ID parameter), set the field to `{{SharedID}}`.
2. To send it only when there is one, add a trigger condition: `SharedID` **does not equal** `undefined`.
3. Open **Preview**, load a page of your site in the debug session, and select a request: the **Variables** tab shows `SharedID` with the visitor's ID. Compare it with the `_pubcid` cookie in the browser's developer tools (Application > Cookies).

Whether a platform accepts the SharedID, and under which consent, is up to that platform and your consent setup; see [Consent](../../docs/sgtm.md#consent-keeping-consent-mode-and-sharedid-edge-consistent).

## Tests

The file has nine test scenarios in its `___TESTS___` section (the recovery copy wins, duplicates, invalid values, opt-out, GPC on and off). Run them in the Template Editor's **Tests** tab with **Run Tests** ([Tests](https://developers.google.com/tag-platform/tag-manager/templates/tests)). They ran in Node.js against the template's code with stand-ins for the sandbox's APIs; they haven't been run in Google's Template Editor by this project yet, which needs a Tag Manager account.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `SharedID` is `undefined` in Preview | The request carries no `_pubcid`: check the request's cookies in Preview's **Request** tab. sGTM on a subdomain with `SID_COOKIE_DOMAIN=host-only`, on a `*.run.app` domain, or behind a CDN that drops cookies, sees none. Or the visitor opted out, sends GPC, or SharedID Edge's consent rules removed the ID. |
| A permission error naming a cookie | You renamed a cookie in the fields but not in the **Reads cookie value(s)** permission. |
| It's always `undefined`, with cookies present | The server image is older than 2.0.0 (`createRegex` returns `null`), or the cookie value isn't a valid ID. |
| It differs from `_pubcid` in the browser | The recovery copy differs: the page re-minted the ID, and SharedID Edge restores the recovery copy on its next call. That's expected. |

## About the file

It's in Tag Manager's template export format: the `___INFO___`, `___TEMPLATE_PARAMETERS___`, `___SANDBOXED_JS_FOR_SERVER___`, `___SERVER_PERMISSIONS___`, `___TESTS___` and `___NOTES___` sections, with the `___TERMS_OF_SERVICE___` header every export carries. The format was checked against Google's documentation and against the export files of Stape's Apache-2.0 templates ([cookie-extender-tag](https://github.com/stape-io/cookie-extender-tag), [cookie-restore-tag](https://github.com/stape-io/cookie-restore-tag), [data-client](https://github.com/stape-io/data-client), [consent-parser-variable](https://github.com/stape-io/consent-parser-variable)); no code was copied from them. It's licensed under this repository's [Apache-2.0](../../LICENSE) licence.

It lives in `templates/sgtm/`, outside `packages/`, because it isn't an npm package or a SharedID Edge module: it runs in Google's sandbox, not in the worker, and nothing in the build imports it.
