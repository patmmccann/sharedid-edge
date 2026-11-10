# packages/modules

The modules this project maintains: [`ip`](ip/README.md), [`ec`](ec/README.md), [`geo`](geo/README.md), [`reflect`](reflect/README.md) and [`ua`](ua/README.md), each its own package (`@sharedid-edge/module-<name>`), plus [`all`](all/README.md) (`@sharedid-edge/modules`), the built-in list. Vendor modules live in [`../vendor-modules/`](../vendor-modules/AGENTS.md), with extra rules. Each module's own `AGENTS.md` adds its specifics.

- **Project modules are built in.** Every adapter bundles them through `builtInModules` (`all/src/index.ts`); a new module is added there, never to an adapter. Being built in doesn't turn a module on: it does nothing until listed in `SID_MODULES`.
- **A package per module,** depending only on `@sharedid-edge/core`'s public API (and, where it saves duplicating code, another project module, as `ec` uses `ip`'s parser). Core never depends on a module.
- **Platform-neutral**, like core: `lib: ["ES2023", "WebWorker"]`, no Node or DOM types, no runtime dependencies besides core (the exception is `ua`, which bundles `isbot`; see its `AGENTS.md`). Platform data comes through `PlatformInfo`, never `request.cf` or headers read directly; add new fields to `PlatformInfo` in core and to the adapters.
- **No network calls,** and no data updates during requests.

## Writing a module

```ts
export const example = defineModule({
  name: 'example',          // lowercase, digits and -
  purposes: [1, 7],         // TCF purposes it needs publisher consent for when GDPR applies; omit if none
  run(context) {            // may be async; must not make network calls
    return { ortb2: { device: { ext: { example: 1 } } } };   // or { eids: [...] }, or undefined
  }
});
```

- Output is OpenRTB: `eids` in the `user.ext.eids` shape, other signals as an `ortb2` fragment. It's deep-merged with other modules' output in `SID_MODULES` order.
- Use `context.config` for settings (from `SID_MODULE_CONFIG`), and validate them: it's `Record<string, unknown>`. Settings that could leak data on a typo throw, so the module reports `error` instead.
- Secrets come from `SID_MODULE_SECRETS` (`context.secrets`). Never return, log or put them in an error message.
- Data that locates the user precisely (a full IP address, coordinates, a postal code, a city) is sent in full or not at all, and left out when `preciseLocationDenial(consent)` gives a reason.
- `context.storage` is the worker's own storage decision for the SharedID (`{ allowed: false, reason }` on opt-out, GPC, COPPA or denied consent). A module that stores or extends an identifier should follow it, as `reflect` does.
- Don't put personal data in the output unless the publisher enabled it in the module's config, and default to off. Never log, store or hash request data, or put it anywhere but the response to the same request.
- A module that throws or exceeds `SID_MODULE_TIMEOUT_MS` is reported (`ext.modules`) and left out. Don't rely on that for control flow; return `undefined` when there's nothing to add.
- Modules with a `gvlid` don't run when GDPR applies until vendor consent decoding exists.

## Tests

- Test each module with the handler (`createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'name' }) })`), including every consent skip.
- Add conformance cases (`conformance/cases/module-<name>*.json`) when its output is part of the payload contract.

## Docs

- **Every module has its own `README.md`** (also its npm page): turning it on, the response shape with JSON examples (when it returns data, and when it doesn't), consent rules, settings and secrets, and troubleshooting. Models: [`ip/README.md`](ip/README.md) and [`ec/README.md`](ec/README.md).
- **Link it from the main README:** a row in the built-in modules table and a section under Modules.
- Behaviour changes go in `spec/SPEC.md` (a section per module) with the code.
