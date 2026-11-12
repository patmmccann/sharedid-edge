# @sharedid-edge/module-ip

The `ip` module for [SharedID Edge](../../../README.md): the visitor's real IP address, in the `/_sid/v1` payload as OpenRTB `ortb2.device.ip` or `ortb2.device.ipv6`.

It runs on `/_sid/v1` only: `/_sid/sync` returns an image, so there's nowhere to put the address.

Bid requests made from the page, or relayed through Prebid Server, don't always carry the user's own address; bidders may see a proxy's or a server's instead. The worker sees the connecting address, so it can hand it back to the page for the auction's first-party data.

## Contents

- [Turning it on](#turning-it-on)
- [Response](#response)
- [Full address or nothing](#full-address-or-nothing)
- [Where the address comes from](#where-the-address-comes-from)
- [Using it in Prebid.js](#using-it-in-prebidjs)
- [Privacy](#privacy)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker, the Node.js server and the AWS Lambda adapter, and does nothing until you list it. It has no settings.

```jsonc
// packages/adapters/cloudflare/wrangler.jsonc
"vars": {
  "SID_MODULES": "ip",                  // with other modules: "ip,ec"
  "SID_ALLOWED_ORIGINS": ""             // only if a page on another origin fetches /_sid/v1
}
```

Deploy, then check:

```sh
curl -s https://www.example.com/_sid/v1 | jq '.ortb2, .ext.modules.ip'
# { "device": { "ip": "203.0.113.9" } }
# { "ms": 0, "status": "ok" }
```

## Response

An IPv4 visitor:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "ip": "192.0.2.77" } },
  "ext": { "modules": { "ip": { "ms": 0, "status": "ok" } } }
}
```

An IPv6 visitor gets `ipv6` instead, in RFC 5952 form (lowercase, zeros compressed):

```json
{ "ortb2": { "device": { "ipv6": "2001:db8::7" } } }
```

When consent rules the address out, there's no `device` field, and the module reports `empty`:

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "ip": { "ms": 0, "status": "empty" } } }
}
```

| `ext.modules.ip.status` | Meaning |
| --- | --- |
| `ok` | The address is in `ortb2.device`. |
| `empty` | Consent rules it out (below), or the platform gave no valid client address. |
| missing | `ip` isn't in `SID_MODULES`. |

IPv4-mapped IPv6 addresses (`::ffff:192.0.2.77`, which Node.js reports for IPv4 clients on dual-stack sockets) are returned as IPv4 `ip`.

## Full address or nothing

The module never sends a truncated address. A truncated address looks real but places the user in the wrong network, which is worse for bidders than no address. It sends nothing when any of these holds:

- Global Privacy Control (`Sec-GPC: 1`);
- `coppa=1`;
- a `us_privacy` string that opts out of sale (third character `Y`);
- a TCF TC string that's invalid or doesn't opt in to **Special Feature 1** (use precise geolocation data);
- GDPR applies (`gdpr=1`, or a visitor in the EU, the rest of the EEA, the UK or Turkey) and there's no TC string.

Otherwise it sends the full address.

## Where the address comes from

| Platform | Source | Spoofable? |
| --- | --- | --- |
| Cloudflare Worker | `CF-Connecting-IP`, set by Cloudflare | No: Cloudflare overwrites it. |
| AWS Lambda behind CloudFront | `CloudFront-Viewer-Address`, set by CloudFront (forwarded by the template's origin request policy) | No, as long as only CloudFront can call the function URL (origin access control). |
| Vercel | `x-real-ip` (else the first `x-forwarded-for` entry), set by Vercel's proxy | No on Vercel: Vercel overwrites both. Off Vercel, set `SID_BEHIND_VERCEL=false`, which ignores them. |
| Azure Functions behind Front Door | `X-Azure-ClientIP`, set by Front Door | No, as long as only your Front Door profile can reach the function app (the template's access restriction and `SID_FRONT_DOOR_ID`). |
| Google Cloud Run functions behind the external Application Load Balancer | The second-to-last `X-Forwarded-For` entry, written by the load balancer (`SID_TRUSTED_HOPS`) | No, as long as only the load balancer can reach the function (ingress). The first entry is the visitor's and is never used. |
| Node.js server | The socket's remote address | No. Behind a proxy, though, it's the proxy's address. |
| Node.js server with `SID_TRUST_PROXY=true` | The first `X-Forwarded-For` entry | Only safe behind a proxy that overwrites the header. Otherwise visitors can set it. |

## Using it in Prebid.js

Fetch `/_sid/v1` and merge its `ortb2` before the auction:

```js
fetch('/_sid/v1', { credentials: 'include' })
  .then(response => response.json())
  .then(payload => {
    if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
  })
  .catch(() => {});
```

Prebid Server and bidders then see `device.ip` or `device.ipv6`. A Prebid.js RTD module that does this, with a timeout, is planned in prebid/Prebid.js#15909.

## Privacy

- The address goes only to the browser that sent the request, in a `Cache-Control: no-store` response.
- The worker doesn't store or log it.
- SharedIDs are never derived from it.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { ipModule, parseIp, formatIpv6, omissionReason, deviceFields } from '@sharedid-edge/module-ip';

const handler = createHandler({ config: resolveConfig(env), modules: [ipModule] });

parseIp('::ffff:192.0.2.1');   // { version: 4, octets: [192, 0, 2, 1] }
parseIp('fe80::1%eth0');       // undefined: only plain addresses are accepted
```

Exports:
- `ipModule`
- `parseIp`, `formatIpv4`, `formatIpv6` (RFC 5952)
- `omissionReason(consent)` (the consent rules: core's `preciseLocationDenial`, which the `geo` module also uses for its precise fields)
- `deviceFields(ip)` (the OpenRTB mapping)

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.ip` is missing | `ip` isn't in `SID_MODULES`. |
| `status` is `empty` for everyone | On Node.js behind a proxy without `SID_TRUST_PROXY`, the address is the proxy's, which is still returned; `empty` means consent rules it out. Check the request's `gdpr`, `gdpr_consent`, `Sec-GPC`, `us_privacy` and `coppa`. EU visitors without a readable TC string get nothing: see the CMP note in [Consent and opt-out](../../../docs/consent.md). |
| The address is your load balancer's | Self-hosting behind a proxy: set `SID_TRUST_PROXY=true`, and make sure the proxy overwrites `X-Forwarded-For`. |
| The page can't read `/_sid/v1` | It's on another origin: add that origin to `SID_ALLOWED_ORIGINS` and fetch with `credentials: 'include'`. |
