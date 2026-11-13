# Responses

Every route is under `SID_BASE_PATH` (`/_sid` by default). None of them reaches your origin.

## `GET /_sid/sync`: the `pixelUrl` endpoint

A 1×1 GIF (`200`, `Content-Type: image/gif`), plus the cookies:

```http
HTTP/1.1 200 OK
Content-Type: image/gif
Cache-Control: private, max-age=86400        (no-store when no ID was set, or a module asks for it)
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=…; Path=/; SameSite=Lax; Secure; HttpOnly
X-SharedID-Source: param
```

Modules that only set cookies (`reflect`, `ec`) or report to the [traffic signal](modules.md#the-traffic-signal) (`bot`) also run here, and add their cookies and an `X-SharedID-Modules` header with each one's status. Traffic reports count towards [`SID_SKIP_BOTS`](modules.md#no-sharedid-for-bots), as on `/_sid/v1`; anything else they return is ignored. With `SID_COOKIE_DOMAIN=.example.com`, `SID_MODULES=reflect` configured for `uid1` and for `_ga` with `restore`, and a request carrying `_pubcid`, `uid1` and `_ga`:

```http
HTTP/1.1 200 OK
Cache-Control: private, max-age=86400
Content-Length: 43
Content-Type: image/gif
X-Robots-Tag: noindex
X-SharedID-Modules: reflect=empty
X-SharedID-Source: cookie
Set-Cookie: uid1=AbC123xyz; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _ga=GA1.1.1234567890.1700000000; Max-Age=34560000; Expires=Wed, 15 Dec 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _sid_keep=eyJfZ2EiOiJHQTEuMS4xMjM0NTY3ODkwLjE3MDAwMDAwMDAifQ; Max-Age=34560000; Expires=Wed, 15 Dec 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Wed, 10 Nov 2027 21:57:46 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

A module that needs to see every sync can keep it out of the browser's cache: the [`clickid`](../packages/modules/clickid/README.md) module reads the landing page from the `Referer`, and a browser would reuse a cached sync on the next landing page. Then `Cache-Control` is `no-store`, and nothing else changes. With `SID_COOKIE_DOMAIN=.example.com` and `SID_MODULES=clickid`, real output:

```http
GET /_sid/sync?id=pubcid%253Ac29cb2ae-769d-42f6-891a-f53cadee823d
Referer: https://www.example.com/shoes?utm_source=google&gclid=EAIaIQobChMIexample_BwE
Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d

HTTP/1.1 200 OK
Cache-Control: no-store
Content-Length: 43
Content-Type: image/gif
X-Robots-Tag: noindex
X-SharedID-Modules: clickid=empty
X-SharedID-Source: cookie
Set-Cookie: _sid_gclid=1794447131.EAIaIQobChMIexample_BwE; Max-Age=7776000; Expires=Wed, 10 Feb 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Fri, 12 Nov 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Fri, 12 Nov 2027 01:32:11 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly
```

### Duplicate ID cookies

A browser can hold a host-only `_pubcid` next to the worker's domain one: written before SharedID Edge was deployed, by Prebid.js 11.48.0 and earlier with `storageControl`, or by the WordPress or Drupal plugin without a cookie domain. It then sends both, and the `Cookie` header doesn't say which is which. With `SID_COOKIE_DOMAIN=example.com` and a request carrying two of each ID cookie, the worker keeps the first value (browsers list the older cookie first), refreshes it on the domain, and deletes the host-only copies: the same `Set-Cookie` name with an empty value, `Max-Age=0` and **no `Domain`**, which leaves the domain cookie alone. `HttpOnly` stays on the recovery copy's deletion. Real output:

```http
GET /_sid/sync?id=pubcid%253A0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10
Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; _pubcid=0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10; _pubcid_sv=0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10

HTTP/1.1 200 OK
Cache-Control: private, max-age=86400
Content-Length: 43
Content-Type: image/gif
X-Robots-Tag: noindex
X-SharedID-Source: cookie
Set-Cookie: _pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Thu, 11 Nov 2027 18:53:36 GMT; Path=/; Domain=example.com; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=c29cb2ae-769d-42f6-891a-f53cadee823d; Max-Age=31536000; Expires=Thu, 11 Nov 2027 18:53:36 GMT; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly
Set-Cookie: _pubcid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure
Set-Cookie: _pubcid_sv=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure; HttpOnly
```

This is a successful sync that tidies up, not a denial. A response that deletes ID cookies because of opt-out, GPC, COPPA or consent has `X-SharedID-Status: denied: …`, sets no ID, and deletes both the domain and the host-only copies; this one has no `X-SharedID-Status`, and refreshes the domain cookies. `/_sid/v1` does the same, with the JSON payload. With a single cookie of each name, or with `SID_COOKIE_DOMAIN=host-only`, nothing extra is sent.

## `GET /_sid/v1`: the ID and the modules' output

JSON (`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`), with the same cookies as `/sync`. With `SID_MODULES=ip` and an IPv4 visitor:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }
  ],
  "ortb2": { "device": { "ip": "192.0.2.77" } },
  "ext": { "modules": { "ip": { "ms": 0, "status": "ok" } } }
}
```

An IPv6 visitor gets `"ortb2": { "device": { "ipv6": "2001:db8::7" } }` instead.

With `SID_MODULES=ip,geo`, both modules' output is merged into one `device` object. A visitor in Austin, in winter:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [
    { "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }
  ],
  "ortb2": {
    "device": {
      "ip": "192.0.2.77",
      "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -360, "city": "Austin", "zip": "78701", "lat": 30.2713, "lon": -97.7426 }
    }
  },
  "ext": { "modules": { "ip": { "ms": 1, "status": "ok" }, "geo": { "ms": 0, "status": "ok" } } }
}
```

The same request with `Sec-GPC: 1` gets no ID, deletes the ID cookies, and returns no IP:

```json
{
  "v": 1,
  "eids": [],
  "ext": { "modules": { "ip": { "ms": 0, "status": "empty" } } }
}
```

With `SID_MODULES=ip,geo`, `geo` still returns the coarse location, without city, postal code or coordinates:

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "geo": { "type": 2, "country": "USA", "region": "TX", "metro": "635", "utcoffset": -360 } } },
  "ext": { "modules": { "ip": { "ms": 1, "status": "empty" }, "geo": { "ms": 0, "status": "ok" } } }
}
```

With `SID_MODULES=ua`, Chrome on Windows (sending the default Client Hints) gets device data, and a crawler gets the bot flag:

```json
{
  "ortb2": {
    "device": {
      "sua": {
        "browsers": [{ "brand": "Google Chrome", "version": ["131"] }, { "brand": "Chromium", "version": ["131"] }],
        "platform": { "brand": "Windows" },
        "mobile": 0,
        "source": 1
      },
      "devicetype": 2,
      "os": "Windows"
    }
  },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

```json
{
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "declared", "sources": ["ua"] } } } },
  "ext": { "modules": { "ua": { "ms": 0, "status": "ok" } } }
}
```

With the [`bot` module](../packages/modules/bot/README.md) (`SID_MODULES=bot`), a request whose browser user agent comes without `Accept-Language` is a likely bot. The **traffic signal** is returned even with `Sec-GPC: 1`, which still rules out the ID:

```json
{
  "v": 1,
  "eids": [],
  "ortb2": { "device": { "ext": { "traffic": { "bot": true, "botKind": "likely", "sources": ["bot"] } } } },
  "ext": { "modules": { "bot": { "ms": 0, "status": "ok" } } }
}
```

| Field | |
| --- | --- |
| `v` | Payload version, `1`. |
| `sharedid` | The SharedID. Absent when storage isn't allowed (opt-out, GPC, COPPA, consent), or for a bot with `SID_SKIP_BOTS`. |
| `eids` | OpenRTB `user.ext.eids`: the SharedID as `pubcid.org` (`atype` 1), then any IDs from modules. `[]` when there are none. |
| `ortb2` | An OpenRTB 2.x first-party data fragment, merged from every module's output in `SID_MODULES` order, plus the traffic signal in `device.ext.traffic` (which the worker writes from every module's report and, on Cloudflare with Bot Management, the platform's verdict). Absent when there's nothing to return. Pass it to `pbjs.mergeConfig({ ortb2 })`. |
| `ext.modules` | One entry per module in `SID_MODULES`: `ms` (time taken) and `status`: `ok` (it returned data), `empty` (nothing to add, for example consent rules out the IP), `skipped` (with a `reason`, such as `not installed` for a name the worker doesn't have), `error` or `timeout`. An optional `stale: true` flag marks missing or old reference data; usable last-good output may still contribute. Error details are never returned. See [Scheduled data updates](data-updates.md). |

To read `/v1` from a page on another origin, list that origin in `SID_ALLOWED_ORIGINS` and fetch with `credentials: 'include'`. The response then carries `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`; it never carries `*`.

## `GET /_sid/optout` and `GET /_sid/optin`

`204 No Content`. `/optout` sets `_pubcid_optout=1` and deletes the ID cookies; `/optin` deletes `_pubcid_optout`.

## Debugging headers

- `X-SharedID-Source`: where the ID came from: `cookie`, `recovery` (restored from the `HttpOnly` copy), `param` (adopted from Prebid.js's `?id=`) or `minted`.
- `X-SharedID-Status: denied: <reason>`: why no ID was set. The reason is `opt-out`, `gpc`, `coppa` or `tcf: …`.
- `X-SharedID-Status: skipped: bot`: [`SID_SKIP_BOTS`](modules.md#no-sharedid-for-bots) ruled the ID out. Nothing was set, and nothing deleted.
- `X-SharedID-Modules` (on `/sync` only): each module that ran there, with its status, as in `ext.modules`: `reflect=empty, ec=ok, bot=ok`. Never cookie names, values or error details. `empty` is the normal status for a module that only sets cookies; `bot` is `ok` when it reported something to the traffic signal, which on `/sync` counts only towards `SID_SKIP_BOTS`.
