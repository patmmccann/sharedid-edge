# The `ua` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `ua`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, on `/v1` and `/sync` (`routes` `v1`, `sync`). On `/v1` it maps the request's User-Agent Client Hints and `User-Agent` header to OpenRTB 2.6 `ortb2.device` fields, and flags self-identified bots in the shared traffic signal. On `/sync` it does only the bot check (see [On `/sync`](#on-sync)).

- **Client Hints** are read as RFC 8941 structured fields:
  - `Sec-CH-UA` and `Sec-CH-UA-Full-Version-List`: a list of strings, each with a string `v` parameter. Members without one are left out. **GREASE** brands (`Not`, `A` and `Brand` separated and surrounded by punctuation, such as `Not A(Brand`, `Not_A Brand` or `(Not(A:Brand`) MUST be left out. A malformed list is ignored as a whole. At most 8 brands are kept, of at most 64 characters each.
  - `Sec-CH-UA-Mobile`: `?1` or `?0`.
  - `Sec-CH-UA-Platform`, `-Platform-Version`, `-Model`, `-Arch` and `-Bitness`: a string. Empty strings, strings over 64 characters, malformed values, and the platform `Unknown` are ignored.
  - Header values over 1024 characters are ignored.
  - **Low-entropy** hints are `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` (browsers send them by default); the others are **high-entropy**.
- **The User-Agent** is parsed by the parser the `parser` setting chooses (see Settings): `isbot` (the default) recognizes only bots; `bowser` also recognizes the browser and its version, the OS and its version, the device class (phone, tablet, desktop, smart TV, set-top box), the maker and the model. What a parser recognizes in a given User-Agent is implementation-defined; the mapping below isn't. The first 512 characters are parsed. A `User-Agent` of exactly `Amazon CloudFront` (what CloudFront sends when it doesn't forward the visitor's) is treated as absent.
- **Output,** each field only when known:

  | `device` | From |
  | --- | --- |
  | `sua` | From Client Hints, when any low-entropy hint is present: `browsers` (the full version list when high entropy is allowed and it was sent, else `Sec-CH-UA` with major versions), `platform` (`brand` from `Sec-CH-UA-Platform`, `version` from `-Platform-Version`), `mobile` (`1` or `0`), `architecture`, `bitness`, `model`. Versions are arrays of their dot-separated components (`["131","0","6778","86"]`); a version that isn't dot-separated digits is left out. `source` is `2` when any high-entropy field is included, else `1`. Without hints, from the parsed User-Agent when it gives a browser or OS: `browsers` with the one browser, `platform` with the OS, `mobile` when the device type is known (`1` for a phone), and `source` `3`. A User-Agent version of the form `N.0.0.0` (Chromium's reduced User-Agent) gives only `[N]`. |
  | `devicetype` | `Sec-CH-UA-Mobile: ?1` gives `4` (phone), or `5` if the User-Agent says tablet. `?0` with a desktop platform (`Windows`, `macOS`, `Linux`, `Chrome OS`, `Chromium OS`) gives `2`. Otherwise the parsed device class: phone `4`, tablet `5`, smart TV `3`, set-top box `7`, desktop `2`. Otherwise a desktop OS gives `2`. |
  | `os` | `Sec-CH-UA-Platform`, else the parsed OS name. |
  | `osv` | `Sec-CH-UA-Platform-Version`; on Windows, `13` and up is `11`, `1` to `12` is `10`, and `0` is left out. Else the parsed OS version, only when the parsed OS is the hinted one (or there's no hint). Values browsers freeze MUST NOT be sent: macOS `10.15.7` and `10.15`, Windows `NT 10.0` (10 or 11), and Android `10` in Chrome's reduced User-Agent (`Android 10; K`). |
  | `make` | The parsed device maker. A bot's operator isn't a maker. |
  | `model` | `Sec-CH-UA-Model`, else the parsed model. |
  | `ua` | The `User-Agent` header, only with the `ua` setting. |
  | `ext.traffic` | `{ "bot": true, "botKind": "declared", "sources": ["ua"] }` when the User-Agent identifies the client as a crawler, bot or other automated client. Absent otherwise: the module never claims a request is human. |

- **Consent:** high-entropy data (`sua.browsers` full versions, `sua.platform.version`, `sua.architecture`, `sua.bitness`, `sua.model`, `osv`, `model` and `ua`) is left out, and `sua.source` is then `1` or `3`, when:
  - the request has `Sec-GPC: 1`, or `coppa=1`;
  - the `us_privacy` string opts out of sale (its third character is `Y`);
  - there is a TC string that is invalid;
  - GDPR applies and there is no TC string.

  `sua` browser brands with major versions, `sua.platform.brand`, `sua.mobile`, `devicetype`, `os` and `make` are always sent. **The traffic signal is always sent**, under GPC and COPPA too: it describes the traffic, not the person.
- **Settings,** `SID_MODULE_CONFIG.ua`: `ua` (optional boolean, default `false`) adds `device.ua`. `parser` (optional, `"isbot"` or `"bowser"`, default `"isbot"`) chooses the User-Agent parser; Client Hints take precedence over either, as in the table. An implementation MAY leave `bowser` out of a build (this one does by default, to keep bundles small); the module MUST then report `error` when the setting asks for it, rather than ignore it. Any other key or a value of another type makes the module an `error` on every request.
- **The traffic signal:** the module's `device.ext.traffic` is its report to the [traffic signal](../SPEC.md#traffic-signal), merged by core with the other reports.
- **Scheduled crawler list** (optional, configured in code by a deployment that runs the [updater](../SPEC.md#scheduled-data-updates); off by default): the crawler list both parsers use may come from a validated in-memory snapshot instead of the list compiled into the build. A snapshot list is a set of regular expressions matched case-insensitively against the parsed part of the `User-Agent`; a list MUST be refused, before it's published or loaded, when it has fewer than 50 or more than 10,000 patterns, a pattern that doesn't compile or matches the empty string, or when it matches a current browser's `User-Agent` or misses a well-known crawler's (Googlebot, Bingbot and others). With the option on, the module:
  - uses the snapshot's list while its last successful check is no older than the configured expiry (if any) and no more than 5 minutes ahead of the clock, and adds `stale: true` once it's older than the configured maximum age;
  - otherwise (no snapshot yet, expired, too far ahead, or a list that doesn't compile) uses the compiled-in list and adds `stale: true`.

  `stale` never changes the module's other output or its status: with no field to return, it's `empty` with `stale: true`. Without the option, the module uses the compiled-in list and never reports `stale`. The module never downloads a list or reads storage while answering a request.
- When there's no field to return, it returns nothing (status `empty`). Nothing is stored or logged.

## On `/sync`

Prebid.js's `pixelUrl` call has no payload, but its traffic reports count for [Skipping bots](../SPEC.md#skipping-bots) (see [Modules on `/sync`](../SPEC.md#modules-on-sync)). There the module MUST only decide whether the `User-Agent` identifies the client as a crawler, bot or other automated client, with the same parser and crawler list as on `/v1` (the `parser` setting, the scheduled list and `stale` work the same), and:

- when it does, report `{ "bot": true, "botKind": "declared" }` as its traffic report (status `ok`), so with `SID_SKIP_BOTS` set to `declared` or `likely` the pixel call sets no ID, as `/v1` doesn't;
- otherwise, including without a `User-Agent` or with `Amazon CloudFront`, return nothing (status `empty`).

It MUST NOT read Client Hints or build device data there: `/sync` returns an image, so it would be work for nothing. Without `SID_SKIP_BOTS`, its report changes nothing on `/sync`. With `SID_SYNC_MODULES` set, it runs on `/sync` only when listed there.
