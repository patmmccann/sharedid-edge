# @sharedid-edge/module-bot

The `bot` module for [SharedID Edge](../../../README.md): bot and staff-traffic signals for the `/_sid/v1` payload's shared traffic signal, `ortb2.device.ext.traffic`.

The edge sees each request before any script runs, so it's well placed to say whether the traffic looks automated. The page can then skip or flag the auction for bots, and send the signal to bidders that accept it. With [`SID_SKIP_BOTS`](#no-sharedid-for-bots-sid_skip_bots), the worker also stops minting SharedIDs for bots, which inflate ID counts and pollute frequency capping.

## Contents

- [Turning it on](#turning-it-on)
- [The traffic signal](#the-traffic-signal)
- [Responses](#responses)
- [Signals](#signals)
- [No SharedID for bots: `SID_SKIP_BOTS`](#no-sharedid-for-bots-sid_skip_bots)
- [Using it in Prebid.js](#using-it-in-prebidjs)
- [Consent and privacy](#consent-and-privacy)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

The module is built into the Cloudflare Worker, the Node.js server, the AWS Lambda adapter, the Vercel adapter, the Azure Functions app and the Google Cloud function, and does nothing until you list it. It runs on `/_sid/v1` and `/_sid/sync`. Its signals are each off until you turn them on:

```jsonc
// packages/adapters/cloudflare/wrangler.jsonc
"vars": {
  "SID_MODULES": "bot",
  "SID_MODULE_CONFIG": "{\"bot\":{\"missingHeaders\":true,\"internalCookie\":\"its_me\"}}"
}
```

| Setting | Default | |
| --- | --- | --- |
| `missingHeaders` | `false` | Report a **likely bot** when a "browser" lacks headers browsers send. A heuristic, so it's opt-in. |
| `ja4Mismatch` | `false` | Report a **likely bot** when the client's JA4 TLS fingerprint contradicts the browser its user agent claims. Only on platforms that provide JA4 ([which](#ja4-fingerprint-that-contradicts-the-user-agent)); elsewhere it does nothing. A heuristic, so it's opt-in. |
| `internalCookie` | none | A cookie name. A request carrying it is marked **internal**: your own staff. |

| Secret (`SID_MODULE_SECRETS`) | |
| --- | --- |
| `internalToken` | Optional, at least 16 characters. The internal cookie then counts only when its value is this token, so visitors can't mark themselves as staff by guessing the cookie name. |

Any other key, or a value of the wrong type, makes the module report `error` on every request (with no details), rather than run with a setting silently ignored.

Deploy, then check:

```sh
curl -s -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0.0.0' https://www.example.com/_sid/v1 | jq '.ortb2.device.ext.traffic, .ext.modules.bot'
# { "bot": true, "botKind": "likely", "sources": ["bot"] }
# { "ms": 0, "status": "ok" }
```

(`curl` sends no `Accept-Language`, so with a browser user agent it's a likely bot.)

## The traffic signal

`ortb2.device.ext.traffic` isn't this module's alone. Core merges every module's report, and the platform's own verdict, into one object:

| Field | |
| --- | --- |
| `bot` | `true` if any source says the request is a bot. |
| `botKind` | The strongest claim: `verified` (a known good bot the platform verified, such as a search crawler), then `declared` (a crawler that names itself, from the `ua` module), then `likely` (a heuristic or score). |
| `proxy` | `datacenter`, `vpn`, `residential`, `tor` or `relay` (iCloud Private Relay and similar, or a verified corporate proxy; never a bot). The most specific wins: `tor`, `residential`, `relay`, `vpn`, then `datacenter`. |
| `score` | The lowest human-likelihood score reported, from 1 (bot) to 99 (human). |
| `internal` | `true` if the visitor is your own staff. |
| `sources` | Who contributed: `platform` (Cloudflare Bot Management), then module names in `SID_MODULES` order. |

**Where Cloudflare's data comes in.** On a Cloudflare zone with Bot Management (an Enterprise add-on), the Worker reads `request.cf.botManagement` (`verifiedBot` as `botKind: verified`, `score`, and `corporateProxy` as `proxy: relay`) and core merges it as source `platform`, **whether or not this module runs**. This module doesn't repeat it, so nothing is counted twice. Without Bot Management, and on the other platforms, there's no platform verdict. The [specification](../../../spec/SPEC.md#traffic-signal) has the exact rules.

## Responses

A normal visitor: nothing to report, so no `ortb2`, and the module reports `empty`:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "bot": { "ms": 0, "status": "empty" } } }
}
```

A likely bot: a Chrome user agent without `Accept-Language` or `Sec-Fetch-*` headers (with `ja4Mismatch`, a Chrome user agent over Python's TLS reports the same; the fingerprint itself is never returned):

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "likely", "sources": ["bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

A verified bot (Googlebot) on Cloudflare with Bot Management: the platform's `verified` verdict and score, merged with this module's `likely` (Googlebot sends no `Accept-Language`). The strongest kind wins:

```json
{
  "v": 1,
  "sharedid": "aeaacdaa-2381-4cc4-bbd5-22678648c2e9",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "aeaacdaa-2381-4cc4-bbd5-22678648c2e9", "atype": 1 }] }],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "verified", "score": 1, "sources": ["platform", "bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

With `SID_SKIP_BOTS=verified` (or `declared` or `likely`), the same request gets no `sharedid`, `"eids": []`, no ID cookie, and `X-SharedID-Status: skipped: bot`; the traffic signal is unchanged.

An internal visitor, with the `its_me` cookie:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ortb2": { "device": { "ext": { "traffic": { "internal": true, "sources": ["bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

A likely bot with Global Privacy Control (`Sec-GPC: 1`): no ID, the ID cookies are deleted (`X-SharedID-Status: denied: gpc`), and the traffic signal is **still there**:

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "likely", "sources": ["bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

| `ext.modules.bot.status` | Meaning |
| --- | --- |
| `ok` | It reported something; see `ortb2.device.ext.traffic`. |
| `empty` | Nothing to report, or both signals are off. |
| `error` | A setting or the secret is invalid. |
| missing | `bot` isn't in `SID_MODULES`. |

## Signals

**Missing browser headers** (`missingHeaders`). Only requests whose user agent claims to be a browser (it starts `Mozilla/5.0 (`) are judged; other clients (`curl`, server libraries, apps) are left to the `ua` module. Such a request is a **likely** bot when:

- it has no `Accept-Language`, or an empty one. Every browser sends it, with `fetch()` too; or
- it has none of `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, and the user agent is a version that always sends them over https: Chrome, Edge, Opera and other Chromium browsers from version 80, Firefox from 90, Safari from 17. Older browsers, and other iOS browsers, aren't expected to send them.

This is a weak signal: a browser extension or a privacy proxy can strip headers, and a careful bot can send them all. The policy is deliberately conservative, so treat `likely` as a hint, not proof. It doesn't use a crawler list, or any other reference data, so there's nothing for [scheduled data updates](../../../docs/data-updates.md) to refresh: crawlers that name themselves are the [`ua` module](../ua/README.md)'s job, reported as `declared`, and its list can be [updated on a schedule](../ua/README.md#scheduled-crawler-list-updates).

### JA4 fingerprint that contradicts the user agent

`ja4Mismatch` compares how the client set up its TLS connection with what its user agent says it is. A script that sends a Chrome user agent from Python or Go still negotiates TLS the way Python or Go does, and the platform sees that in the [JA4 fingerprint](https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md) of its ClientHello. When the two contradict, the module reports a **likely** bot, and with `SID_SKIP_BOTS=likely` the worker mints no SharedID for it (`X-SharedID-Status: skipped: bot`), as for the other heuristics.

```jsonc
"vars": {
  "SID_MODULES": "bot",
  "SID_MODULE_CONFIG": "{\"bot\":{\"ja4Mismatch\":true}}",
  "SID_SKIP_BOTS": "likely"
}
```

**Where the fingerprint comes from.** Only from the platform, computed from the visitor's own connection; never from a request header a visitor could send:

| Platform | JA4 | |
| --- | --- | --- |
| Cloudflare Worker (and Snippet) | `request.cf.botManagement.ja4` | Only on zones with Bot Management, an Enterprise add-on. Without it there's no JA4, and the setting does nothing. |
| Fastly Compute | `event.client.tlsJA4` | Every service, over https. |
| AWS Lambda behind CloudFront | `CloudFront-Viewer-JA4-Fingerprint` | Only with `SID_CLOUDFRONT_JA4=true`, once the origin request policy adds that header (the managed `AllViewerExceptHostHeader` doesn't). See the [Lambda adapter's README](../../adapters/aws-lambda/README.md#platform-information). |
| Lambda@Edge, Vercel, Azure, Google Cloud, Akamai, Node.js | none | The setting does nothing. |

In trusted-upstream mode there's no JA4 either: the connection the platform sees is the publisher's CDN's, not the visitor's. The fingerprint is only compared: it's never stored, logged, returned or used to derive an identifier.

**What counts as a contradiction.** The module reads the TLS stack from the fingerprint's cipher hash (its second part, which stays the same across a browser's releases), using a small table taken from FoxIO's public [JA4+ mapping](https://github.com/FoxIO-LLC/ja4/blob/main/ja4plus-mapping.csv):

| Cipher hash | Stack |
| --- | --- |
| `8daaf6152771` | Chromium (Chrome, Edge, Opera, Samsung Internet, Android WebView, Electron) |
| `5b57614c22b0` | Firefox |
| `a09f3c656075` | Safari (Apple's TLS stack) |
| `85036bcba153`, `c7886603b240` | Python |
| `9dc949149365`, `e33ad33b3d25`, `cbb2034c60b8`, `8cdfa2d4673b` | Go |

It's a contradiction when a user agent claiming Chromium, Firefox or Safari comes over Python's or Go's TLS, or over another of the three browsers' (Chrome's user agent over Firefox's TLS, say). The rules are conservative, so that real browsers aren't caught:

- **An unknown fingerprint is no decision.** A new browser version with a new cipher list, curl, Java, .NET, or anything else not in the table isn't judged; neither is a user agent that doesn't claim one of the three browsers (crawlers that name themselves are the [`ua` module](../ua/README.md)'s job).
- **HTTP/3 isn't judged.** Over QUIC (`q…` fingerprints) every browser offers the same three TLS 1.3 cipher suites, so the cipher hash can't tell them apart.
- **iPhone and iPad user agents aren't judged.** Every iOS browser (Chrome's `CriOS`, Firefox's `FxiOS`, in-app browsers) uses Apple's TLS stack whatever it calls itself.
- **Apple's stack behind a Mac user agent isn't judged,** since iPad browsers asking for the desktop site send a Mac user agent (Chrome's or Firefox's included).

What it can still misjudge: a TLS-intercepting proxy or antivirus between the visitor and the CDN (on corporate networks, or some security software) replaces the browser's ClientHello with its own, and a browser extension that switches the user agent to another browser's makes the browser lie. If such a proxy is built on Go, or the extension claims another browser, a real visitor looks like a contradiction. Skipping never deletes an ID, so a misjudged visitor keeps the one they have; they're just not given a new one on that request. And a bot running a real browser engine (headless Chrome with Chrome's user agent) has a matching fingerprint: this catches scripts that borrow a browser's user agent, not automated browsers.

**Internal traffic** (`internalCookie`). Your staff set a cookie, and their visits are marked `internal: true`, so the page can, for example, skip ad auctions for them or set OpenRTB `test: 1` so QA traffic isn't billed. That's the page's decision; the worker only reports it, and `SID_SKIP_BOTS` doesn't skip internal traffic (staff see what visitors see). Set the cookie from an internal page:

```html
<script>
  // Valid for a year, on the whole site. Use your internalToken as the value if you set one.
  document.cookie = 'its_me=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure';
</script>
```

It's a functional cookie, set by the visitor's own deliberate action. The worker never sets or deletes it.

## No SharedID for bots: `SID_SKIP_BOTS`

A core setting, off by default, that uses the merged traffic signal from every source (this module, the `ua` module, the platform):

| Setting | Values | Skips |
| --- | --- | --- |
| `SID_SKIP_BOTS` | `verified` | Verified bots only. |
| | `declared` | Verified and declared bots. |
| | `likely` | Every bot, including this module's `likely`. |
| `SID_SKIP_BOTS_SCORE` | 1 to 99 | Requests whose `score` is at or below it (Cloudflare Bot Management treats 1 as automated and 2 to 29 as likely automated). |

A skipped request gets no ID cookie, no `sharedid` and no `pubcid.org` eid, and carries `X-SharedID-Status: skipped: bot`. An existing ID is **never deleted**, so a misclassified visitor keeps theirs (it's just not refreshed on that request). Consent comes first: with GPC, COPPA, opt-out or denied consent, the ID is deleted as usual and the status is `denied: …`.

The module also runs on `/_sid/sync`, which Prebid.js's `pixelUrl` calls on page views, so its signals skip there too, merged with the platform's verdict: a likely bot doesn't get from the pixel call an ID it wouldn't get from `/_sid/v1`. There the signal isn't returned (the response is a GIF); `X-SharedID-Modules: bot=ok` shows the module reported something. To keep it off `/_sid/sync`, list the other modules in `SID_SYNC_MODULES` (or set it to `none`); see [Modules on `/_sid/sync`](../../../docs/modules.md#modules-on-_sidsync).

## Using it in Prebid.js

Fetch `/_sid/v1` and act on the signal before the auction:

```js
fetch('/_sid/v1', { credentials: 'include' })
  .then(response => response.json())
  .then(payload => {
    const traffic = payload.ortb2?.device?.ext?.traffic;
    if (traffic?.bot === true && traffic.botKind !== 'likely') return;   // skip the auction for sure bots
    if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
  })
  .catch(() => {});
```

Merged into the auction's first-party data, `device.ext.traffic` reaches Prebid Server and bidders that read it. A Prebid.js RTD module that does this, with a timeout, is planned in prebid/Prebid.js#15909.

## Consent and privacy

- **Sent whatever the consent.** The traffic signal describes the traffic, not the person, and it helps pages and bidders avoid invalid traffic, so it's returned with GPC, COPPA, opt-out and denied consent too. The module has no TCF `purposes`, so it runs when GDPR applies.
- **Nothing stored or logged.** The module reads headers and one cookie of the same request, and the result goes only to the browser that sent it, in a `Cache-Control: no-store` response.
- `internalToken` is a secret: it's never returned, logged or put in an error.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { botModule, botSettings, missingBrowserHeaders, sendsFetchMetadata } from '@sharedid-edge/module-bot';

const handler = createHandler({ config: resolveConfig(env), modules: [botModule] });

sendsFetchMetadata('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15');   // false: Safari 15
```

Exports:

- `botModule`
- `botSettings(config)`: the checked settings
- `missingBrowserHeaders(headers, url)` and `sendsFetchMetadata(userAgent)`: the missing-headers heuristic
- `ja4Contradicts(userAgent, ja4)`, with `ja4Stack(ja4)` and `claimedBrowser(userAgent)`: the JA4 check

Any module can report to the traffic signal by returning `traffic` (core's `TrafficReport`); see [`../AGENTS.md`](../AGENTS.md).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ext.modules.bot` is missing | `bot` isn't in `SID_MODULES`. |
| `status` is always `empty` | Every signal is off: set `missingHeaders`, `ja4Mismatch`, `internalCookie`, or several. |
| `ja4Mismatch` never reports anything | The platform provides no JA4: on Cloudflare the zone needs Bot Management; on AWS set `SID_CLOUDFRONT_JA4=true` and add `CloudFront-Viewer-JA4-Fingerprint` to the origin request policy; other platforms have none ([where it comes from](#ja4-fingerprint-that-contradicts-the-user-agent)). Or the clients aren't in its table, or they're on HTTP/3. |
| Real visitors are skipped with `ja4Mismatch` | A TLS-intercepting proxy or antivirus, or a user agent switcher, between them and the CDN. Turn `ja4Mismatch` off, or don't skip `likely` bots. |
| `status` is `error` | A misspelt setting (they're case-sensitive), a wrong type, or an `internalToken` under 16 characters. |
| Real visitors are flagged `likely` | Something between the browser and the worker strips `Accept-Language` or `Sec-Fetch-*` (some proxies and extensions do). Turn `missingHeaders` off, or don't skip `likely` bots. |
| `internal` doesn't appear | The cookie isn't sent to the worker's path or domain (set `Path=/` and the right `Domain`), or its value doesn't match `internalToken`. |
| A `platform` source on every response in `wrangler dev` | Offline, the local runtime makes up a Bot Management score of 99. Deployed, it comes only from Bot Management. |
