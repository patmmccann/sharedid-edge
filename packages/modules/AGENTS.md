# packages/modules

The modules this project maintains: [`ip`](ip/README.md), [`ec`](ec/README.md), [`geo`](geo/README.md), [`reflect`](reflect/README.md), [`bot`](bot/README.md) and [`ua`](ua/README.md), each its own package (`@sharedid-edge/module-<name>`), plus [`all`](all/README.md) (`@sharedid-edge/modules`), the built-in list. Vendor modules live in [`../vendor-modules/`](../vendor-modules/AGENTS.md), with extra rules. Each module's own `AGENTS.md` adds its specifics.

- **Project modules are built in.** Every adapter bundles them through `builtInModules` (`all/src/index.ts`); a new module is added there, never to an adapter. Being built in doesn't turn a module on: it does nothing until listed in `SID_MODULES`.
- **A package per module,** depending only on `@sharedid-edge/core`'s public API (and, where it saves duplicating code, another project module, as `ec` uses `ip`'s parser). Core never depends on a module.
- **Platform-neutral**, like core: `lib: ["ES2023", "WebWorker"]`, no Node or DOM types, no runtime dependencies besides core (the exception is `ua`, which bundles `isbot`, and `bowser` in opt-in builds; see its `AGENTS.md`). Platform data comes through `PlatformInfo`, never `request.cf` or headers read directly; add new fields to `PlatformInfo` in core and to the adapters.
- **No network calls,** and no data updates during requests.

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
- **`routes`** says where the module runs: `['v1']` (the default) or `['v1', 'sync']`. Add `'sync'` only for modules that maintain cookies (`reflect`, `ec`) or report traffic (`bot`): Prebid.js calls `/sync` (its `pixelUrl`) on page views, so they run with no page code. On `/sync` the module gets the same context, but only its `cookies` and `traffic` report are used (the report for `SID_SKIP_BOTS` only); `eids` and `ortb2` are dropped, since the response is a GIF. Modules that return data (`ip`, `geo`) stay on `v1`. Deployers can narrow it with `SID_SYNC_MODULES`. The browser caches a successful sync for `SID_SYNC_CACHE_SECONDS` (a day by default), so don't rely on running there on every page view.
- Use `context.config` for settings (from `SID_MODULE_CONFIG`), and validate them: it's `Record<string, unknown>`. Settings that could leak data on a typo throw, so the module reports `error` instead.
- Secrets come from `SID_MODULE_SECRETS` (`context.secrets`). Never return, log or put them in an error message.
- Data that locates the user precisely (a full IP address, coordinates, a postal code, a city) is sent in full or not at all, and left out when `preciseLocationDenial(consent)` gives a reason.
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

- **Every module has its own `README.md`** (also its npm page): turning it on, the response shape with JSON examples (when it returns data, and when it doesn't), consent rules, settings and secrets, and troubleshooting. Models: [`ip/README.md`](ip/README.md) and [`ec/README.md`](ec/README.md).
- **Link it from the main README:** a row in the built-in modules table and a section under Modules.
- Behaviour changes go in `spec/SPEC.md` (a section per module) with the code.
