# @sharedid-edge/module-ec

The `ec` module for [SharedID Edge](../../README.md): IAB Tech Lab [Trusted Server Edge Cookies](https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html) (`ts-ec`).

It sets the `ts-ec` cookie on the publisher's domain and returns the Edge Cookie as `ortb2.user.id` in the `/_sid/v1` payload. Publishers who use Trusted Server, or want its identifier, can then run one edge worker for both the SharedID and the EC.

> **This ID is derived from the visitor's IP address.** An EC is `HMAC-SHA256(passphrase, IP)` as 64 hex characters, a dot, and 6 random characters. Everyone behind the same IPv4 address, or the same IPv6 /64, gets the same 64-character prefix, and anyone with the passphrase can test which address an EC came from. That's how Trusted Server defines EC. It's the one IP-derived identifier in SharedID Edge, so the module is **off unless you turn it on**. The SharedID (`_pubcid`) is unaffected and stays random.

## Contents

- [Turning it on](#turning-it-on)
- [What it does](#what-it-does)
- [The ID](#the-id)
- [The cookie](#the-cookie)
- [Response](#response)
- [Consent and opt-out](#consent-and-opt-out)
- [Settings](#settings)
- [Differences from Trusted Server](#differences-from-trusted-server)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker, the Node.js server and the AWS Lambda adapter. It does nothing until you list it in `SID_MODULES` and give it a passphrase.

1. **Create a passphrase** of at least 32 bytes, and keep it secret. For example:

   ```sh
   openssl rand -hex 32
   ```

   Use the same passphrase as your Trusted Server deployment if you want both to derive the same prefix for the same address.

2. **Store it as a secret.** Put it in `SID_MODULE_SECRETS`, never in `vars`:

   ```sh
   npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_MODULE_SECRETS
   # paste: {"ec":{"passphrase":"<your passphrase>"}}
   ```

   For local development, put the same line in `packages/cloudflare/.dev.vars` (which git ignores) as `SID_MODULE_SECRETS={"ec":{"passphrase":"…"}}`. With the Node.js server, set the `SID_MODULE_SECRETS` environment variable. On AWS Lambda, pass it as the SAM template's `SidModuleSecrets` parameter (see [the Lambda adapter's README](../aws-lambda/README.md#secrets)).

3. **Enable the module, and set your domain**, in `packages/cloudflare/wrangler.jsonc`:

   ```jsonc
   "vars": {
     "SID_MODULES": "ip,ec",                                          // or just "ec"
     "SID_MODULE_CONFIG": "{\"ec\":{\"domain\":\"example.com\"}}"     // cookie gets Domain=.example.com
   }
   ```

4. **Deploy** (`npm exec -w @sharedid-edge/cloudflare -- wrangler deploy`), then check:

   ```sh
   curl -si https://www.example.com/_sid/v1 | grep -i '^set-cookie: ts-ec'
   curl -s https://www.example.com/_sid/v1 | jq .ext.modules.ec
   # { "ms": 1, "status": "ok" }
   ```

5. **On the page,** merge the payload's `ortb2` into Prebid.js before the auction, as the main README shows. The EC then reaches bidders as `user.id`.

## What it does

On each `/_sid/v1` request, the module does one of three things:

| Situation | Cookie | Payload |
| --- | --- | --- |
| Consent allows it and there's no valid `ts-ec` | sets a new `ts-ec` | `ortb2.user.id` = the new EC |
| Consent allows it and a valid `ts-ec` exists | none (not refreshed) | `ortb2.user.id` = the existing EC |
| Consent withdrawn (see below) | deletes `ts-ec` | nothing |
| Consent unclear (GDPR applies without a TC string, or the TC string can't be decoded) | none; an existing `ts-ec` is left alone | nothing |

`/_sid/optout` also deletes `ts-ec`, whether or not `ec` is in `SID_MODULES`. The module doesn't run on `/_sid/sync`, so Prebid.js's `pixelUrl` calls never set an EC; only `/_sid/v1` does.

## The ID

```text
7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc.nZ1GxL
└──────────────── 64 lowercase hex: HMAC-SHA256 ────────────────┘ └ 6 random ┘
```

- **Prefix:** `HMAC-SHA256(key = passphrase, message = normalized IP)`, as lowercase hex.
- **Normalized IP:**
  - IPv4: dotted decimal, for example `192.0.2.77`.
  - IPv6: the first four hextets (the /64), each zero-padded to four lowercase hex digits, with no separators. `2001:db8:85a3:0:8a2e:370:7334:1234` becomes `20010db885a30000`.
  - IPv4-mapped IPv6 (`::ffff:192.0.2.77`) counts as IPv4.
- **Suffix:** 6 characters drawn uniformly from `A-Za-z0-9`.
- **Validation:** only the format is checked (`^[0-9a-f]{64}\.[A-Za-z0-9]{6}$`), as in Trusted Server. The HMAC isn't re-checked against the current IP, so an EC survives the visitor changing networks. A `ts-ec` with another format is replaced.

Test vector, passphrase `conformance-passphrase-0123456789abcdef`:

| Address | Normalized | Prefix |
| --- | --- | --- |
| `192.0.2.77` | `192.0.2.77` | `7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc` |
| `2001:db8:85a3:0:8a2e:370:7334:1234` | `20010db885a30000` | `53535a5d73a52082fa6be4418fff1ca1f0b3986ac180be1ffbfce280a0db284b` |

## The cookie

```http
Set-Cookie: ts-ec=<id>; Max-Age=31536000; Expires=…; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

- **`HttpOnly`:** page scripts can't read it, so it reaches the page only through the `/_sid/v1` payload.
- **One year,** not refreshed on later visits (as in Trusted Server).
- **`Domain`:** `.{domain}` from the module's `domain` setting. Otherwise `SID_COOKIE_DOMAIN`, otherwise host-only.
- **`Secure`:** only over https, so plain-http local development still works.
- **Deletion:** the same attributes, an empty value, `Max-Age=0` and an `Expires` in 1970.

## Response

With `SID_MODULES=ec`, a first `/_sid/v1` call from `192.0.2.77`:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "user": { "id": "7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc.nZ1GxL" } },
  "ext": { "modules": { "ec": { "ms": 1, "status": "ok" } } }
}
```

`ext.modules.ec.status` is:
- `ok`: an EC was returned.
- `empty`: none, because consent rules it out, there's no client IP, or the cookie was only deleted.
- `error`: a missing or short passphrase, or an invalid `domain`. No details are given.

The EC is returned as `user.id`, which is where Trusted Server puts it. There's no EID source for EC.

## Consent and opt-out

Trusted Server's rules, applied to the signals SharedID Edge has.

**Withdrawn:** `ts-ec` is deleted and nothing is returned, when there's:
- the SharedID opt-out cookie (`_pubcid_optout`), or a visit to `/_sid/optout`;
- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a `us_privacy` string that opts out of sale (third character `Y`);
- a TC string without consent for TCF **Purpose 1** in its core segment.

**Fail closed:** nothing is set or returned, but an existing `ts-ec` is kept, when:
- GDPR applies (`gdpr=1`, or an EU location on Cloudflare) and there's no TC string;
- the TC string can't be decoded.

**Allowed** otherwise, including with a TC string that consents to Purpose 1.

## Settings

| Where | Key | | |
| --- | --- | --- | --- |
| `SID_MODULES` | `ec` | required | Turns the module on. |
| `SID_MODULE_SECRETS` | `ec.passphrase` | required | The HMAC key, at least 32 bytes. Set it as a platform secret. Changing it changes the prefix of new ECs only. |
| `SID_MODULE_CONFIG` | `ec.domain` | optional | Your registrable domain, such as `example.com`, without a leading dot. The cookie gets `Domain=.example.com`. |

## Differences from Trusted Server

This module implements the cookie and its ID. It doesn't implement the rest of Trusted Server:

- **When the EC is set:** on `/_sid/v1` calls only, not on page loads proxied through Trusted Server.
- **No server-side state:** no KV identity graph, partner ID sync, pull sync, `/identify` or batch-sync API, `ts-ec-pull-complete` marker, or tombstones.
- **Consent signals:** this worker's (`gdpr`, the TC string, GPC, `us_privacy`, `coppa`), not Trusted Server's per-country and per-state jurisdiction lists. GPP isn't decoded yet, and GPC withdraws everywhere, not only in US states.
- **No `x-ts-ec` header,** inbound or outbound. Trusted Server's current code doesn't set one either, though its draft spec describes it.

Where Trusted Server's draft specification and its code differ, this module follows the code. The code sets `HttpOnly`, and normalizes IPv6 to hex without separators.

## Using it in code

The module and its building blocks are exported for other adapters and for tests:

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { ecModule, ecPrefix, normalizeIp, isValidEcId } from '@sharedid-edge/module-ec';
import { parseIp } from '@sharedid-edge/module-ip';

const handler = createHandler({ config: resolveConfig(env), modules: [ecModule] });

const ip = parseIp('2001:db8:85a3::1');
if (ip) console.log(await ecPrefix(passphrase, normalizeIp(ip)));   // 64 hex characters
```

Other exports:
- `EC_COOKIE`, `EC_MAX_AGE_SECONDS`, `MIN_PASSPHRASE_BYTES`
- `randomSuffix()`
- `ecDecision(consent, optedOut)` (the consent rules)
- `ecModuleConfig()` and `ecPassphrase()` (settings parsing)

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.ec` is missing | `ec` isn't in `SID_MODULES`. |
| `ext.modules.ec.status` is `error` | `SID_MODULE_SECRETS` has no `ec.passphrase`, or it's under 32 bytes, or `ec.domain` has a leading dot or isn't a domain. |
| `status` is `empty` and no cookie is set | Consent rules it out (see above). Check the request's `gdpr`, `gdpr_consent`, `Sec-GPC`, `us_privacy` and `coppa`. Or the platform gave no client IP. |
| The cookie isn't sent back on later requests | `Domain` doesn't match the page's host. Check `ec.domain`, and that `/_sid/*` is served on your own domain. |
| Two visitors in one office share a prefix | Expected: they share an IP address. The suffix tells them apart. |
