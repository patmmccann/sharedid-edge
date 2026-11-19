# @sharedid-edge/module-encrypted-ip

The `encrypted-ip` module for [SharedID Edge](../../../README.md): the visitor's IP address, **encrypted** to the public key of each recipient you configure, so that the page can pass it on without any script on the page being able to read it:

- **Google Publisher Tag:** Google's [publisher-provided IP address](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address). Browser privacy features can mask the visitor's address on third-party ad requests; GPT takes the real one from you, encrypted to [Google's key](https://www.gstatic.com/real-ip/ip_enc_key.json), with `googletag.setConfig({ ipAddress })`.
- **Prebid Server hosts (experimental):** the same scheme with a Prebid Server host's own key, as proposed in [prebid/prebid-server#5106](https://github.com/prebid/prebid-server/issues/5106): Prebid Server would read `device.ext.prebid.eip`, decrypt it into `device.ip` or `device.ipv6`, and mask it under its usual privacy rules. [prebid/Prebid.js#16281](https://github.com/prebid/Prebid.js/issues/16281) proposes that Prebid.js send the value to Prebid Server only. **Neither has shipped:** the field name and this part of the module may change until they do.

Each recipient is separate and opt-in: Google only, Prebid Server only, or both. The encryption is HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)), the same for every recipient, written with Web Crypto only and checked against RFC 9180's published test vectors.

**Not an ID, and not readable on the page.** Each value is encrypted with a fresh ephemeral key for every request, so two values for the same address differ, and only the recipient, with its private key, can read one. The module follows the same consent rules as the [`ip`](../ip/README.md) module's plain address, and stores and logs nothing.

**It's opt-in at build time.** It isn't in the default builds: add it to yours (below), then list it in `SID_MODULES`.

## Contents

- [Turning it on](#turning-it-on)
- [Settings](#settings)
- [Keys](#keys)
- [Response](#response)
- [On the page](#on-the-page)
- [Consent rules](#consent-rules)
- [Runtimes](#runtimes)
- [Size and speed](#size-and-speed)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

1. **Add it to your build,** as `@sharedid-edge/module-encrypted-ip#encryptedIpModule`:

   | Platform | Build |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-encrypted-ip#encryptedIpModule`, then `npx wrangler deploy .sharedid-modules/worker.ts` in place of `npm run deploy`. |
   | AWS Lambda, Lambda@Edge, Vercel, Azure Functions, Google Cloud | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-encrypted-ip#encryptedIpModule` in place of `npm run bundle`. |
   | Node.js | `SID_MODULE_PACKAGES=@sharedid-edge/module-encrypted-ip#encryptedIpModule`, with the package installed next to the server. |
   | Cloudflare Snippet, Akamai, Fastly | Not supported: see [Runtimes](#runtimes). |

   For keys from a schedule rather than settings, build your own entry point instead ([Keys](#keys)).

2. **List the recipients,** with their keys. In `wrangler.jsonc`, or your platform's settings:

   ```jsonc
   "vars": {
     "SID_MODULES": "encrypted-ip",          // with others: "ip,geo,encrypted-ip"
     "SID_MODULE_CONFIG": "{\"encrypted-ip\":{\"google\":{\"key\":{\"keys\":[{\"kty\":\"OKP\",\"crv\":\"X25519\",\"x\":\"OQOocFPWwDfHQ1SdhGII-6_DHfAqamg2qC2E5kygfis\",\"kid\":\"ypXWcw\"}]},\"keyFetched\":\"2026-11-19T14:55:00Z\"}}}"
   }
   ```

   That's Google's key file as it was on 19 November 2026; it rotates, so for anything but a test, deliver keys on a schedule ([Keys](#keys)).

3. **Check:**

   ```sh
   curl -s https://www.example.com/_sid/v1 | jq '.eip, .ext.modules["encrypted-ip"]'
   # { "google": { "value": "_akzTBlVz4LP2tqx4KnsOJ-7h684zRfGjrzIBE7sow-N_eaRN4vyI2pGN8DB6Y4WyRaLYECvhJtTQg", "kid": "ypXWcw" } }
   # { "ms": 1, "status": "ok" }
   ```

## Settings

`SID_MODULE_CONFIG["encrypted-ip"]` lists the recipients:

| Setting | |
| --- | --- |
| `google` | Encrypt for Google Publisher Tag. |
| `pbs` | Encrypt for these Prebid Server hosts, an object keyed by host name: the host of the Prebid.js `s2sConfig` endpoint, in lower case, with `:port` when it isn't the default (`pbs.example.com`, `pbs.example.com:8443`). Experimental. |

Each recipient's entry is an object, `{}` or:

| Setting | |
| --- | --- |
| `key` | The recipient's public key: its key file as published (a JWKS, `{ "keys": [ … ] }`) or one key (`{ "kty": "OKP", "crv": "X25519", "x": "…", "kid": "…" }`). From a key file, the first X25519 key is used: the current one. Leave it out when a scheduled snapshot provides the key. A key with a private part (`d`) is refused. |
| `keyFetched` | When you fetched that key: an ISO 8601 date and time with a time zone (`2026-11-19T14:55:00Z`). Optional; with it, the module reports `stale` once the key is over 24 hours old. |

```jsonc
{"encrypted-ip":{"google":{}}}                                         // Google, key from a schedule
{"encrypted-ip":{"pbs":{"pbs.example.com":{}}}}                         // one Prebid Server host
{"encrypted-ip":{"google":{},"pbs":{"pbs.example.com":{},"pbs.example.org:8443":{}}}}  // all three
```

Keys are public: they go in `SID_MODULE_CONFIG`, not `SID_MODULE_SECRETS`. A setting it doesn't know, a malformed key or date, a host name in upper case or with a scheme or path, no recipient at all, or a recipient with a key in both its settings and a snapshot makes the module an `error`: no value for anyone.

## Keys

Keys are never fetched while answering a visitor. Each recipient's comes from one of two places:

- **Settings** (`key`), for a test, or a deployment that redeploys at least daily with a fresh key. Add `keyFetched` so a forgotten one shows up as `stale`.
- **A scheduled snapshot,** with the opt-in [`@sharedid-edge/data-updates`](../../data-updates/README.md) package, the same way as the IP databases ([Scheduled data updates](../../../docs/data-updates.md#encrypted-ip-keys)): a scheduled job downloads the key file, validates it (an X25519 key, `x` 32 bytes) and publishes `{ kid, x }` to private storage; the worker reloads it in the background. `googleIpKeySource()` downloads [Google's key file](https://www.gstatic.com/real-ip/ip_enc_key.json); `pbsIpKeySource({ name, url })` a Prebid Server host's, from the HTTPS URL its operator publishes.

**Freshness.** Google keeps rotated private keys, so a value encrypted with a key fetched within the last 24 hours still decrypts. Google asks that you refresh its key at least every 24 hours, and sooner when its `Cache-Control` says so: `max-age=3000`, 50 minutes, when this was written. So schedule the job every 30 minutes or so. The module counts a key as fresh for 24 hours after it was fetched (`keyFetched`, or the snapshot's last successful check). Older, or more than 5 minutes ahead of the worker's clock, its values are marked `stale: true`, and still sent: if Google can't decrypt one, GPT falls back to the request's own address. A recipient with no key at all gets no value, and the module reports `stale: true`.

A Prebid Server host's operator says how often its keys rotate; the proposal keeps previous keys for a grace period like Google's. The same 24-hour rule applies.

## Response

The values go in the `/_sid/v1` payload's `eip`, never in `ortb2` (which pages hand to every bidder). Each is `{ value, kid?, stale? }`: `value` is the encrypted address, unpadded base64url of 67 to 124 characters; `kid` the ID of the key it was encrypted to, when the key has one; `stale: true` when that key is over 24 hours old. With `SID_MODULES=encrypted-ip`, Google and two Prebid Server hosts (one of whose keys was fetched two days earlier), and an IPv4 visitor (`192.0.2.77`), real output:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }
  ],
  "eip": {
    "google": { "value": "_akzTBlVz4LP2tqx4KnsOJ-7h684zRfGjrzIBE7sow-N_eaRN4vyI2pGN8DB6Y4WyRaLYECvhJtTQg", "kid": "ypXWcw" },
    "pbs": {
      "pbs.example.com": { "value": "BHSfq6suB9Drbec7UQHG0CqELgYS6HZBNdX9k4YcdkV8Pl7hLiuU9dj-6pd6BDFf1prYVSNPtKSIWQ", "kid": "2026-11" },
      "pbs.example.org:8443": { "value": "QF6xmKJozIhzb0QiecpZ_KXBzMAlDCjOwClzNqYoZiNggvvEGQInplfjwxsj6aBLsyU9H0p0EXJdKA", "stale": true }
    }
  },
  "ext": { "modules": { "encrypted-ip": { "ms": 1, "status": "ok", "stale": true } } }
}
```

Values are random: a new one on every request, even for the same visitor.

Prebid Server values are keyed by host so that the page, or Prebid.js, can pick the one for its `s2sConfig` endpoint without ambiguity; a host that serves several publishers decrypts with its own key, whose `kid` is there too.

When consent rules it out, or the platform has no client IP, there's no `eip` and the report is `empty`:

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "encrypted-ip": { "ms": 0, "status": "empty" } } }
}
```

A recipient without a key is left out, the others are not, and the report adds `"stale": true`.

## On the page

**Google Publisher Tag.** Call `googletag.setConfig({ ipAddress })` before `enableServices`, `display` or `refresh`: it only affects ad requests made after it. Fetch `/_sid/v1` early, and hold the first ad request until it answers (or a short timeout passes):

```js
const sid = fetch('/_sid/v1', { credentials: 'include' }).then(r => r.json()).catch(() => ({}));
googletag.cmd.push(async () => {
  const payload = await Promise.race([sid, new Promise(resolve => setTimeout(resolve, 300, {}))]);
  const ipAddress = payload.eip?.google?.value;
  if (ipAddress) googletag.setConfig({ ipAddress });
  googletag.enableServices();
  googletag.display('div-gpt-ad-1');
});
```

To check, filter the browser's Network tab for `/gampad/ads`: the `ips` parameter carries the value (URL-encoded). The Google Publisher Console's Page Request tab warns about an `ipAddress` it can't use. See [Configuring Prebid.js](../../../docs/prebid.md#encrypted-client-ip-google-publisher-tag-and-prebid-server) for doing this next to Prebid.js.

**Prebid Server (experimental).** Prebid.js doesn't send the value yet: [prebid/Prebid.js#16281](https://github.com/prebid/Prebid.js/issues/16281) proposes that the `sharedIdEdge` RTD module read `eip.pbs[<host>]` and send it as `device.ext.prebid.eip` to that Prebid Server host only, never to client-side bidders. Don't put the value in Prebid.js's global `ortb2`: every bidder would get it.

## Consent rules

No value for any recipient (status `empty`) when:

- the request has `Sec-GPC: 1`, or `coppa=1`;
- the `us_privacy` string opts out of sale;
- there is a TC string without opt-in to Special Feature 1 (use precise geolocation data), or an invalid one, or GDPR applies with no TC string;
- the browser has opted out (`_pubcid_optout`), or a consent provider such as [`cmp`](../cmp/README.md) or [`gpp`](../gpp/README.md) refused;
- the platform has no valid client IP.

These are the [`ip` module's rules](../ip/README.md#full-address-or-nothing), plus the opt-out cookie and consent providers. Under TCF, Special Feature 1 decides, as for the plain address; the SharedID's own storage consent (Purpose 1) doesn't.

## Runtimes

The module needs Web Crypto's X25519 (`generateKey`, `exportKey`, `deriveBits`), HMAC-SHA256 and AES-GCM:

| Runtime | X25519 | |
| --- | --- | --- |
| Cloudflare Workers | Yes | [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) lists X25519. Conformance-tested in `wrangler dev`. |
| Node.js 24: the Node.js server, AWS Lambda and Lambda@Edge (`nodejs24.x`), Vercel, Azure Functions, Google Cloud | Yes | Node.js's Web Crypto. Conformance-tested behind each platform's stand-in. |
| Cloudflare Snippets | Not offered | The runtime is Workers', but a Snippet has no scheduled jobs, storage or secrets for keys, and its settings are fixed at build time: the module isn't in the Snippet build. |
| Akamai EdgeWorkers | **No** | The [`crypto` module](https://techdocs.akamai.com/edgeworkers/docs/crypto) has no `generateKey`, `deriveBits` or X25519. |
| Fastly Compute | **No** | Its [`SubtleCrypto`](https://js-compute-reference-docs.edgecompute.app/docs/globals/SubtleCrypto/) derives bits with PBKDF2 only and encrypts with AES-CBC only. |

On Akamai and Fastly the module reports `error` and returns nothing; the rest of the payload is unaffected. Their conformance targets list the cases that encrypt as known limitations.

## Size and speed

Measured with this repository's build:

- **A Lambda bundle with it:** 2.7 KB more gzipped than the default bundle (24.1 KB, 26.8 KB with the module), including the `ip` module's address parser, which a build with `ip` already has. Measure your own build: `npm run bundle` prints its gzipped size.
- **Speed:** about 0.5 ms per value on Node.js 24 (one X25519 key generation and agreement, five HMACs and AES-GCM), measured with 5,000 encryptions in a row on a laptop. Values are made per request, one per recipient: caching them per address would keep visitor data between requests.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createEncryptedIpModule, encryptedIpModule, encryptIp } from '@sharedid-edge/module-encrypted-ip';

// Keys from settings:
const handler = createHandler({ config: resolveConfig(env), modules: [...builtInModules, encryptedIpModule] });

// Keys from scheduled snapshots (SnapshotCache from @sharedid-edge/data-updates), for recipients listed in the settings:
const module = createEncryptedIpModule({ keys: { google: () => googleKeys.current, pbs: { 'pbs.example.com': () => pbsKeys.current } } });

// One value on its own:
const value = await encryptIp('203.0.113.42', { x: 'OQOocFPWwDfHQ1SdhGII-6_DHfAqamg2qC2E5kygfis' });
```

## Troubleshooting

- **`ext.modules["encrypted-ip"]` is `skipped`, `not installed`:** your build doesn't have the module. Add it ([Turning it on](#turning-it-on)), and check you deployed that build.
- **`error`:** the settings are invalid (see [Settings](#settings)), or the runtime has no X25519 ([Runtimes](#runtimes)).
- **`empty`, with `stale: true`, and no `eip`:** no recipient has a key. Check the scheduled job ran and published (its manifest's `checkedAt`), and that the snapshot names match.
- **`empty` without `stale`:** consent ruled it out, or the platform has no client IP. Try without GPC, outside GDPR, and look at `X-SharedID-Status`.
- **`timeout`:** a fresh worker's first Web Crypto call takes longer than later ones (about 15 ms on Node.js on a laptop, against 1 ms or less after). If it happens often, raise `SID_MODULE_TIMEOUT_MS` (50 ms by default).
- **A value has `stale: true`:** its key is over 24 hours old. Check the job's schedule and failures.
- **GPT ignores `ipAddress`:** check the Publisher Console's Page Request tab. A value outside 67 to 124 characters is dropped (this module's never are); one Google can't decrypt (an old key) makes GPT use the request's own address. Make sure `setConfig` runs before the ad request.
