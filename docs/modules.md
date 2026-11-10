# Modules

Modules add IDs and signals to `/_sid/v1`, and some maintain cookies on `/_sid/sync` too. They're built into the worker but **none runs until you list it**.

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
- **Removing a module** from `SID_MODULES` turns it off.

## Modules on `/_sid/sync`

Prebid.js calls `/_sid/sync` (its `pixelUrl`) on page views with `extend: true`, with no code of yours. Modules that only maintain cookies run there too, so they work without the page calling `/_sid/v1`. The [module index](#module-index) shows which modules run there; each module's README says what it does there. In short: modules that maintain cookies (such as `reflect` and `ec`) or report to the [traffic signal](#the-traffic-signal) (such as `bot`) run on `/_sid/sync`; modules that return data don't, since `/_sid/sync` returns an image.

- **Same rules as `/_sid/v1`:** the same consent, opt-out, time limit and failure handling. Only the modules' cookies and traffic reports are used; the GIF, status and other headers Prebid.js gets are unchanged, apart from `X-SharedID-Modules` (see [Debugging headers](responses.md#debugging-headers)).
- **Choosing:** by default, every module in `SID_MODULES` that supports it runs on `/_sid/sync`. `SID_SYNC_MODULES` overrides that with a list (`"SID_SYNC_MODULES": "reflect"`), or `none`. Each name must also be in `SID_MODULES`, or every request fails with a 500 (a configuration error), so a typo can't go unnoticed; a listed module that doesn't run on `/_sid/sync`, such as `ip`, is reported `skipped`.
- **Daily by default:** the browser caches a successful sync response for `SID_SYNC_CACHE_SECONDS` (`86400`, a day), so these modules run there about once a day per browser. That keeps cookies from expiring, and a visitor whose cookies Safari deleted after 7 days away gets them back on the first page view, since the cache has expired by then. Lower `SID_SYNC_CACHE_SECONDS` to run them more often (`0`: every page view), at the cost of a worker request each time.

## Module index

Generated from each module's `package.json` (its `sharedidEdge` block) by `node scripts/docs.mjs --write`. Each module's README has its settings, responses, consent rules and troubleshooting; its specification is in [`spec/modules/`](../spec/modules).

<!-- generated:module-index:start -->
<!-- generated:module-index:end -->

To build your own, see [Adding a module](development.md#adding-a-module). Modules from vendors (in [`packages/vendor-modules/`](../packages/vendor-modules/README.md); none yet) aren't built in: you add them to your build, and any that forwards data to another service says so at the top of its README and is marked "⚠ forwards data to `<host>`" in the index.

## The traffic signal

The edge sees each request before any script runs, so it can tell the page whether the traffic looks automated, and the page can skip or flag the auction. Several sources report to one **traffic signal**, `ortb2.device.ext.traffic`, which the worker merges, most cautious first:

- **the platform:** on Cloudflare with Bot Management (an Enterprise add-on), its verified-bot flag, score and corporate-proxy flag, as source `platform`. This needs no module;
- **the `bot` module:** a `likely` bot when a "browser" lacks `Accept-Language` or the `Sec-Fetch-*` headers it always sends (`missingHeaders`), and `internal: true` for your own staff, marked by a cookie (`internalCookie`);
- **other modules,** such as a user agent module reporting crawlers that name themselves (`declared`), or IP intelligence reporting VPNs and data centres.

The signal is returned whatever the consent: it describes the traffic, not the person. Its fields and merge rules are in the specification's [Traffic signal](../spec/SPEC.md#traffic-signal); the [`bot` module's README](../packages/modules/bot/README.md) shows what each source reports.

## No SharedID for bots

`SID_SKIP_BOTS` (off by default) stops the worker setting or returning a SharedID for bots, which inflate ID counts and pollute frequency capping. `verified` skips verified bots, `declared` verified and declared ones, `likely` every bot; `SID_SKIP_BOTS_SCORE=10` also skips scores of 10 or less. A skipped request carries `X-SharedID-Status: skipped: bot`. **Existing IDs are never deleted,** so a misclassified visitor keeps theirs, and internal traffic is never skipped. On `/_sid/sync` the decision is the same: the platform's verdict merged with the reports of the modules that run there (`bot`, and any other in `SID_SYNC_MODULES` that reports traffic).
