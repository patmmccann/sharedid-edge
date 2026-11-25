# Modules

Modules add IDs and signals to `/_sid/v1`, and some maintain cookies on `/_sid/sync` too. They're built into the worker but **none runs until you list it**. A few are **opt-in at build time** (marked "opt-in build" in the [module index](#module-index), and the vendor modules): you add them to your build first, as each one's README shows, so the default builds don't carry them.

**Consent modules.** A module can also take part in the consent decision, as a [consent provider](../spec/SPEC.md#consent-providers): [`cmp`](../packages/modules/cmp/README.md) reads the cookie of a CMP that doesn't write a TCF TC string, and [`gpp`](../packages/modules/gpp/README.md) the US opt-outs in the GPP string (it only denies). They can deny the SharedID anywhere, or allow it where GDPR applies and there's no TC string, never overriding GPC, COPPA, the opt-out cookie or a TC string's denial. See [Consent and opt-out](consent.md).

## Choosing modules

Set `SID_MODULES` to a comma-separated list of module names, in the order their output should merge. Pass any settings in `SID_MODULE_CONFIG`, as JSON keyed by module name:

```jsonc
"vars": {
  "SID_MODULES": "ip,geo",              // names, in merge order
  "SID_MODULE_CONFIG": "{}",            // e.g. "{\"geo\":{\"precision\":\"coarse\"}}"
  "SID_MODULE_TIMEOUT_MS": "50"         // each module's time limit
}
```

Then deploy, and check `ext.modules` in the `/_sid/v1` response:

```sh
curl -s https://www.example.com/_sid/v1 | jq .ext.modules
# { "ip": { "ms": 0, "status": "ok" }, "geo": { "ms": 0, "status": "ok" } }
```

- **Unknown names** are reported as `skipped` with reason `not installed`: check the spelling, or that your build includes the module.
- **Failures are contained:** a module that errors or exceeds `SID_MODULE_TIMEOUT_MS` is reported and left out, and the rest of the response is unaffected.
- **Reference data can report `stale`:** a [scheduled snapshot](data-updates.md) is missing or past its maximum age. Usable last-good data may still contribute; an optional expiry drops its contribution. Downloads and conversion run on the scheduler, while modules read only validated in-memory data.
- **Settings are read-only to modules:** a module gets its `SID_MODULE_CONFIG` and `SID_MODULE_SECRETS` entries frozen, all the way down, since they serve every later request too. A module that tries to change them reports `error` (with no other effect); if a third-party module does, that's a bug for its maintainer.
- **Removing a module** from `SID_MODULES` turns it off.

## Modules on `/_sid/sync`

Prebid.js calls `/_sid/sync` (its `pixelUrl`) on page views with `extend: true`, with no code of yours. Modules that only maintain cookies run there too, so they work without the page calling `/_sid/v1`. The [module index](#module-index) shows which modules run there; each module's README says what it does there. In short: modules that maintain cookies (such as `reflect` and `ec`) or report to the [traffic signal](#the-traffic-signal) (such as `bot`) run on `/_sid/sync`; modules that return data don't, since `/_sid/sync` returns an image.

- **Same rules as `/_sid/v1`:** the same consent, opt-out, time limit and failure handling. Only the modules' cookies and traffic reports are used; the GIF, status and other headers Prebid.js gets are unchanged, apart from `X-SharedID-Modules` (see [Debugging headers](responses.md#debugging-headers)).
- **Choosing:** by default, every module in `SID_MODULES` that supports it runs on `/_sid/sync`. `SID_SYNC_MODULES` overrides that with a list (`"SID_SYNC_MODULES": "reflect"`), or `none`. Each name must also be in `SID_MODULES`, or every request fails with a 500 (a configuration error), so a typo can't go unnoticed; a listed module that doesn't run on `/_sid/sync`, such as `ip`, is reported `skipped`.
- **Daily by default:** the browser caches a successful sync response for `SID_SYNC_CACHE_SECONDS` (`86400`, a day), so these modules run there about once a day per browser. That keeps cookies from expiring, and a visitor whose cookies Safari deleted after 7 days away gets them back on the first page view, since the cache has expired by then. Lower `SID_SYNC_CACHE_SECONDS` to run them more often (`0`: every page view), at the cost of a worker request each time. The exception is [`clickid`](../packages/modules/clickid/README.md), which has to see every landing page: when it runs on `/_sid/sync`, the sync isn't cached at all.

## Module index

Generated from each module's `package.json` (its `sharedidEdge` block) by `node scripts/docs.mjs --write`. Each module's README has its settings, responses, consent rules and troubleshooting; its specification is in [`spec/modules/`](../spec/modules).

<!-- generated:module-index:start -->
| Name | Adds | Settings | On `/_sid/sync` | Specification |
| --- | --- | --- | --- | --- |
| [`bot`](../packages/modules/bot/README.md) | `ortb2.device.ext.traffic`: a likely bot when a browser lacks headers browsers send or its JA4 TLS fingerprint contradicts its user agent, and `internal` for your own staff, merged with other modules' reports and Cloudflare Bot Management. Sent whatever the consent | `missingHeaders`, `ja4Mismatch`, `internalCookie`; secret `internalToken` | yes | [spec](../spec/modules/bot.md) |
| [`clickid`](../packages/modules/clickid/README.md) | Nothing in the payload: stores the ad click IDs in the landing page's URL (`gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`, `ttclid`, and any you add) in server-set first-party cookies for 90 days from the click, for conversion and analytics tags on later page views; never sent to bidders | `params`, `maxAgeDays`, `domain`, `httpOnly`, `hosts` | yes | [spec](../spec/modules/clickid.md) |
| [`cmp`](../packages/modules/cmp/README.md) (opt-in build) | Nothing in the payload: a consent provider that reads the consent cookie of a CMP without a TCF TC string (Cookiebot, OneTrust, Complianz, CookieYes, iubenda, Borlabs Cookie). A refusal there denies the SharedID everywhere; a grant allows it where GDPR applies and there is no TC string | per CMP: `categories` (default its advertising category), `cookie` | no | [spec](../spec/modules/cmp.md) |
| [`encrypted-ip`](../packages/modules/encrypted-ip/README.md) (opt-in build) | `eip`: the visitor's IP address encrypted (HPKE) to each configured recipient's public key: `google` for `googletag.setConfig({ ipAddress })`, and `pbs` by Prebid Server host (experimental); nothing when consent rules it out. Not an ID, and readable only by its recipient | `google`, `pbs` (by host): each `key` (unless a scheduled snapshot provides it) and `keyFetched` | no | [spec](../spec/modules/encrypted-ip.md) |
| [`geo`](../packages/modules/geo/README.md) | `ortb2.device.geo`: country, region, metro and UTC offset, plus city, postal code and coordinates when consent allows | `precision`: `precise` (default) or `coarse` | no | [spec](../spec/modules/geo.md) |
| [`gpp`](../packages/modules/gpp/README.md) (opt-in build) | Nothing in the payload: a consent provider that decodes the US National and US state sections of the `gpp` string that `gpp_sid` names. An opt-out of sale, sharing or targeted advertising, or a known child without consent, denies the SharedID and deletes it, like GPC; a string it can't read for those sections denies too | none | no | [spec](../spec/modules/gpp.md) |
| [`ip`](../packages/modules/ip/README.md) | `ortb2.device.ip` or `ortb2.device.ipv6`: the visitor's full IP address, or nothing when consent rules it out | none | no | [spec](../spec/modules/ip.md) |
| [`reflect`](../packages/modules/reflect/README.md) | Nothing in the payload: re-sets first-party cookies other scripts wrote (such as `uid1` or `_ga`) with the same value and a new expiry, so Safari doesn't cap them, and with `restore`, sets them again from an `HttpOnly` keeper cookie after Safari deletes them | `cookies`, `keeper` | yes | [spec](../spec/modules/reflect.md) |
| [`tag-gateway`](../packages/modules/tag-gateway/README.md) (opt-in build; ⚠ forwards data to `*.fps.goog`) | Nothing in the payload but its `forwards` report: serves the Google tag and its measurement requests from a path on your site (`/metrics`), forwarding them to Google's tag gateway (`<tag ID>.fps.goog`), with the client IP and location only when consent allows, and nothing on opt-out, COPPA, GPC (by default) or without TCF purposes 1 and 7 where GDPR applies | `tags` (each `id` and `path`, **required**), `gpc` (`block` or `forward-anonymous`) | no | [spec](../spec/modules/tag-gateway.md) |
| [`ua`](../packages/modules/ua/README.md) | `ortb2.device` from User-Agent Client Hints (`sua`, `devicetype`, `os`, `osv`, `model`), and `device.ext.traffic` with `bot: true` for crawlers that identify themselves (on `/sync` too, for `SID_SKIP_BOTS`) | `ua`: also send `device.ua`; `parser`: `bowser`, in a build with Bowser, parses the `User-Agent` too | yes | [spec](../spec/modules/ua.md) |
| [`dbip`](../packages/vendor-modules/dbip/README.md) (vendor module, offline) | `ortb2.device.geo.country` from DB-IP's free IP to Country Lite database, built in at build time (CC BY 4.0) | `mode`: `fill` (default) or `replace`; optional `maxAgeDays` | no | [spec](../spec/modules/dbip.md) |
| [`ec`](../packages/vendor-modules/ec/README.md) (vendor module, offline; ⚠ IP-derived ID) | Trusted Server Edge Cookies: sets `ts-ec` and returns it as an EID. Off unless you turn it on | `domain`; secret `passphrase` | yes | [spec](../spec/modules/ec.md) |
| [`id5`](../packages/vendor-modules/id5/README.md) (vendor module; ⚠ network: `id5-sync.com`, `api.id5-sync.com`; ⚠ forwards data to `id5-sync.com`, `api.id5-sync.com`) | The ID5 ID as an EID, fetched from ID5 by the worker with your own ID5 partner number, cached in an `HttpOnly` cookie; nothing without ID5's TCF vendor consent where GDPR applies, or on opt-out, GPC, COPPA or a US opt-out. Off unless you turn it on | `partner` (**required**), `provider`, `endpoint`, `timeoutMs`, `domain`, `readCookie`, `browsers` (`all` or `webkit27`) | yes | [spec](../spec/modules/id5.md) |
| [`ip2location`](../packages/vendor-modules/ip2location/README.md) (vendor module, offline; needs `IP2LOCATION_DOWNLOAD_TOKEN` at build time) | `ortb2.device.geo` (with `ipservice` 1) from IP2Location LITE DB1 and `ortb2.device.ext.traffic` from IP2Proxy LITE PX10, built in at build time | `mode`: `fill` (default) or `replace`; optional `maxAgeDays`; build-time `IP2LOCATION_DOWNLOAD_TOKEN` | no | [spec](../spec/modules/ip2location.md) |
| [`maxmind`](../packages/vendor-modules/maxmind/README.md) (vendor module, offline; needs `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` at build time) | `ortb2.device.geo.country` (with `ipservice` 3) from MaxMind's GeoLite2 Country database, downloaded with your licence key and built in at build time | `mode`: `fill` (default) or `replace`; optional `maxAgeDays`; build-time `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` | no | [spec](../spec/modules/maxmind.md) |
<!-- generated:module-index:end -->

To build your own, see [Adding a module](development.md#adding-a-module). Modules from vendors (in [`packages/vendor-modules/`](../packages/vendor-modules/README.md)) aren't built in: you add them to your build.

### Modules that forward data

Modules only work from what the worker already has, and send nothing anywhere, with two exceptions: a **forwarding module**, such as [`tag-gateway`](../packages/modules/tag-gateway/README.md), owns paths on your site outside `/_sid` and answers them by passing requests on to a service it names; and a vendor module that **looks an ID up** from the vendor's API while answering `/_sid/v1` or `/_sid/sync`, such as [`id5`](../packages/vendor-modules/id5/README.md), within a short time limit, caching the answer in the visitor's own cookie. Such a module:

- is **off by default:** it's an opt-in build, does nothing until it's in `SID_MODULES` and configured, and reaches only the hosts declared in its code, which core enforces (never an open proxy);
- is **marked** "⚠ forwards data to `<host>`" in the index above, and says at the **top** of its README, in a box, what it sends, to which host, when, and under which consent conditions;
- **still follows the privacy rules:** core sends nothing on opt-out, COPPA, a consent provider's denial or missing TCF consent where GDPR applies (for a module acting for a TCF vendor, such as `id5`, that vendor's consent), nor with Global Privacy Control unless the module's setting forwards anonymously then, without any client IP or location (a module that looks IDs up never sends anything with GPC); the full IP and precise location only go where the [`ip`](../packages/modules/ip/README.md) and [`geo`](../packages/modules/geo/README.md) modules would send them;
- reports on `/_sid/v1` whether this visitor's requests are forwarded (`ext.modules.<name>.forwards`), and nothing about them;
- needs a platform that can send requests to other hosts: the Cloudflare Worker and Snippet, Node.js, AWS Lambda, Vercel and Google Cloud. Elsewhere (Lambda@Edge, Azure, Akamai, Fastly) a configuration that lists one gets a 500 rather than being ignored.

See [Forwarding modules](../spec/SPEC.md#forwarding-modules) and [Module requests](../spec/SPEC.md#module-requests) in the specification.

## The traffic signal

The edge sees each request before any script runs, so it can tell the page whether the traffic looks automated, and the page can skip or flag the auction. Several sources report to one **traffic signal**, `ortb2.device.ext.traffic`, which the worker merges, most cautious first:

- **the platform:** on Cloudflare with Bot Management (an Enterprise add-on), its verified-bot flag, score and corporate-proxy flag, as source `platform`. This needs no module;
- **the `bot` module:** a `likely` bot when a "browser" lacks `Accept-Language` or the `Sec-Fetch-*` headers it always sends (`missingHeaders`), or when its JA4 TLS fingerprint, where the platform provides one, contradicts its user agent (`ja4Mismatch`), and `internal: true` for your own staff, marked by a cookie (`internalCookie`);
- **other modules,** such as a user agent module reporting crawlers that name themselves (`declared`), or IP intelligence reporting VPNs and data centres.

The signal is returned whatever the consent: it describes the traffic, not the person. Its fields and merge rules are in the specification's [Traffic signal](../spec/SPEC.md#traffic-signal); the [`bot` module's README](../packages/modules/bot/README.md) shows what each source reports.

## No SharedID for bots

`SID_SKIP_BOTS` (off by default) stops the worker setting or returning a SharedID for bots, which inflate ID counts and pollute frequency capping. `verified` skips verified bots, `declared` verified and declared ones, `likely` every bot; `SID_SKIP_BOTS_SCORE=10` also skips scores of 10 or less. A skipped request carries `X-SharedID-Status: skipped: bot`. **Existing IDs are never deleted,** so a misclassified visitor keeps theirs, and internal traffic is never skipped. On `/_sid/sync` the decision is the same: the platform's verdict merged with the reports of the modules that run there (`bot`, `ua`'s bot check, and any other in `SID_SYNC_MODULES` that reports traffic), so a crawler that names itself gets no ID from Prebid.js's pixel call either.
