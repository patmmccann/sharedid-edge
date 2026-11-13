# packages/modules

The modules this project maintains, listed in the [module index](../../docs/modules.md#module-index), each its own package (`@sharedid-edge/module-<name>`), plus [`all`](all/README.md) (`@sharedid-edge/modules`), the built-in list. Vendor modules live in [`../vendor-modules/`](../vendor-modules/AGENTS.md), with extra rules. Each module's own `AGENTS.md` adds its specifics.

- **Project modules are built in.** Every adapter bundles them through `builtInModules` (`all/src/index.ts`); a new module is added there, never to an adapter. Being built in doesn't turn a module on: it does nothing until listed in `SID_MODULES`.
- **A package per module,** depending only on `@sharedid-edge/core`'s public API (and, where it saves duplicating code, another project module's exports, as the `ec` vendor module uses `ip`'s parser). Core never depends on a module.
- **Platform-neutral**, like core: `lib: ["ES2023", "WebWorker"]`, no Node or DOM types, no runtime dependencies besides core (the exception is `ua`, which bundles `isbot`, and `bowser` in opt-in builds; see its `AGENTS.md`). Platform data comes through `PlatformInfo`, never `request.cf` or headers read directly; add new fields to `PlatformInfo` in core and to the adapters.
- **No network calls,** and no data updates during requests.
- **Scheduled reference data** uses the opt-in [updater](../data-updates/README.md). Adapter setup/background work loads validated snapshots from private storage; a module's `run` reads only the in-memory copy. Downloads and conversion run on the scheduler or administrative command. `stale: true` reports missing or old data while usable last-good output may still contribute; an expiry may drop it. Never give an updater request context or cache visitor data with the reference data.
- **Nothing from a request outlives it.** A module object, and anything at a module's top level, can serve many visitors in turn: adapters keep a handler for as long as the settings don't change, and the Fastly adapter's reusable-sandbox build keeps the whole JavaScript instance from one request to the next. So keep no request data (IP, cookies, consent, IDs, headers, location, User-Agent) in module-level variables, closures made at setup, or caches; derive everything from the context on each run. Caches of constants or of configuration are fine. Don't write to `config` or `secrets` (they're frozen: the write throws and the module reports `error`), and don't use a module-level regular expression with the `g` or `y` flag, whose `lastIndex` carries over between calls.

## Writing a module

```ts
export const example = defineModule({
  name: 'example',          // lowercase, digits and -
  purposes: [1, 7],         // TCF purposes it needs publisher consent for when GDPR applies; omit if none
  routes: ['v1'],           // where it runs: 'v1' (the default) and/or 'sync'; see below
  run(context) {            // may be async; must not make network calls
    return { ortb2: { device: { ext: { example: 1 } } } };   // or { eids: [...] }, or undefined
  }
});
```

- Output is OpenRTB: `eids` in the `user.ext.eids` shape, other signals as an `ortb2` fragment. It's deep-merged with other modules' output in `SID_MODULES` order.
- **`routes`** says where the module runs: `['v1']` (the default) or `['v1', 'sync']`. Add `'sync'` only for modules that maintain cookies (`reflect`, and the `ec` vendor module) or report traffic (`bot`): Prebid.js calls `/sync` (its `pixelUrl`) on page views, so they run with no page code. On `/sync` the module gets the same context, but only its `cookies` and `traffic` report are used (the report for `SID_SKIP_BOTS` only); `eids` and `ortb2` are dropped, since the response is a GIF. Modules that return data (`ip`, `geo`) stay on `v1`. Deployers can narrow it with `SID_SYNC_MODULES`. The browser caches a successful sync for `SID_SYNC_CACHE_SECONDS` (a day by default), so don't rely on running there on every page view. A module that must see every sync (`clickid`, which reads the landing page from the `Referer`) returns `noStore: true`, which makes that sync `no-store`; it costs a request per page view, so don't use it for modules that are fine running once a day.
- Use `context.config` for settings (from `SID_MODULE_CONFIG`), and validate them: it's `Record<string, unknown>`, frozen all the way down (copy before changing anything). Settings that could leak data on a typo throw, so the module reports `error` instead.
- **Parse settings with an exported function, usable when a Snippet is built.** The Cloudflare Snippet validates settings when it's built and ships them parsed ([PREVALIDATED](../adapters/cloudflare/AGENTS.md)): a module whose settings take more than a line to check exports a pure parser (`reflectModuleConfig`, `clickIdModuleConfig`, `botSettings`, `uaSettings`: the raw entry in, the parsed settings out, a `TypeError` with a message naming the setting on anything invalid), reads its settings only through it, starts it with `if ((globalThis as { __SID_PREVALIDATED__?: boolean }).__SID_PREVALIDATED__ === true) return config as unknown as Settings;` (the Snippet passes the parsed settings as the entry, and its build-time `define` turns the rest of the parser into dead code), and lists the parser in `MODULES` in `packages/adapters/cloudflare/scripts/build-snippet.mjs`. The parser mustn't depend on the request, the clock or anything else known only at run time. Gate a new optional feature behind a setting the parser resolves, so a Snippet whose settings don't use it can leave its code out (an `__SID_UNUSED_*` flag; see the [Cloudflare adapter's `AGENTS.md`](../adapters/cloudflare/AGENTS.md)), and add a configuration that uses it, and one that doesn't, to `scripts/test-snippet.mjs` there.
- Secrets come from `SID_MODULE_SECRETS` (`context.secrets`). Never return, log or put them in an error message.
- Data that locates the user precisely (a full IP address, coordinates, a postal code, a city) is sent in full or not at all, and left out when `preciseLocationDenial(consent)` gives a reason.
- `context.cookieDomain` is `SID_COOKIE_DOMAIN`, the `Domain` core gives your cookies when you don't set one, or `undefined` for host-only. A cookie's `hostOnly: true` overrides it.
- `context.storage` is the worker's own storage decision for the SharedID (`{ allowed: false, reason }` on opt-out, GPC, COPPA or denied consent). A module that stores or extends an identifier should follow it, as `reflect` does.
- Don't put personal data in the output unless the publisher enabled it in the module's config, and default to off. Never log, store or hash request data, or put it anywhere but the response to the same request.
- A module that throws or exceeds `SID_MODULE_TIMEOUT_MS` is reported (`ext.modules`) and left out. Don't rely on that for control flow; return `undefined` when there's nothing to add.
- Modules with a `gvlid` don't run when GDPR applies until vendor consent decoding exists.

## Reporting traffic: bots, proxies, internal visitors

Any module can say something about the traffic, and core merges every report into one `ortb2.device.ext.traffic` (spec: [Traffic signal](../../spec/SPEC.md#traffic-signal)). Return it as `traffic`, core's `TrafficReport`:

```ts
run({ request }) {
  return isDeclaredCrawler(request.headers.get('User-Agent')) ? { traffic: { bot: true, botKind: 'declared' } } : undefined;
}
```

- **Fields:** `bot`, `botKind` (`verified`, `declared` or `likely`; it implies `bot`), `proxy` (`datacenter`, `vpn`, `residential`, `tor` or `relay`), `score` (an integer, 1 bot to 99 human) and `internal`. Report only what you know; leave the rest out.
- **Core owns the field.** It merges every module's report and the platform's verdict (`PlatformInfo.traffic`, source `platform`) with most-cautious-wins rules and sets `sources` to the module names. Don't write `ortb2.device.ext.traffic` yourself: if you do, core reads it as your report rather than merging it as is, so you can't override another source.
- **Invalid values are errors:** a wrong type, an unknown `botKind` or `proxy`, a `score` outside 1 to 99, or `bot: false` with a `botKind` makes the module an `error` and none of its output is used.
- **A relay is never a bot.** iCloud Private Relay and similar services carry people's traffic: report `proxy: 'relay'` without `bot`.
- **Consent doesn't gate it:** the signal describes the traffic, not the person, and is returned under GPC, COPPA and opt-out too. That applies to the traffic report only; precise location and identifiers keep their own rules. Don't put personal data in a report, and never store or log it.
- **`SID_SKIP_BOTS`** reads the merged verdict, so your report can stop SharedID minting for bots. Report `verified` or `declared` only when you're sure, and prefer `likely` for heuristics.
- Platform-derived verdicts (a CDN's bot score) belong in `PlatformInfo.traffic`, filled by the adapter, not in a module.

## Tests

- Test each module with the handler (`createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'name' }) })`), including every consent skip.
- Add conformance cases (`conformance/cases/module-<name>*.json`) when its output is part of the payload contract, and through `/_sid/sync` for a module that runs there.

## Docs

- **Every module has its own `README.md`** (also its npm page): turning it on, the response shape with JSON examples (when it returns data, and when it doesn't), consent rules, settings and secrets, and troubleshooting. Models: [`ip/README.md`](ip/README.md) and the `ec` vendor module's [`README.md`](../vendor-modules/ec/README.md).
- **Response examples go in the module's README,** not in `docs/responses.md`.
- **Metadata, not shared prose:** add a `sharedidEdge` block to its `package.json` (`kind: "module"`, `name`, `title`, `summary`, `settings`, `routes`; see [Package metadata](../../docs/development.md#package-metadata)), then run `node scripts/docs.mjs --write`. That lists it in the root README, the [module index](../../docs/modules.md#module-index) and the root `AGENTS.md`; don't edit those by hand. `routes` must match the module's own (`npm run check:docs` checks).
- **Its specification** is `spec/modules/<name>.md`, a page of its own, changed with the code; the spec's list of modules is generated from that folder.
