# packages/core

The platform-neutral implementation: `createHandler` (routes, ID choice, cookies, responses), `resolveConfig`, consent (`consent.ts`, `tcf.ts`) and the module interface (`modules.ts`). Published as `@sharedid-edge/core`; adapters and modules depend on its public API in `src/index.ts`.

- **No platform APIs.** The project compiles with `lib: ["ES2023", "WebWorker"]` and no Node or DOM types: only `Request`, `Response`, `Headers`, `URL`, `crypto.randomUUID`, `TextEncoder` and timers. Anything platform-specific (the client IP, `request.cf`) comes in through `PlatformInfo` from the adapter.
- **No runtime dependencies.** It's bundled into every worker. A full TCF decoder is deliberately not used; `tcf.ts` reads only what's needed.
- **Public API.** Everything exported from `src/index.ts` is public. Changing an exported type or signature is a breaking change for adapters and module authors: check `consumer-types/fixture/consumer.ts` still compiles (`npm run consumer-types`) and update it to cover new exports. `isolatedDeclarations` is on, so exports need explicit types.
- **Configuration.** New settings go in `SharedIdEdgeConfig`, `DEFAULT_CONFIG` and `resolveConfig` (with validation that throws `ConfigError`), the table in `resolveConfig`'s JSDoc, `spec/SPEC.md`, the README's configuration reference, and `packages/cloudflare/wrangler.jsonc` `vars` (then `npm run types -w @sharedid-edge/cloudflare`).
- **Tests** are in `test/` (Vitest, Node environment): `unit.test.ts` for the building blocks, `handler.test.ts` for behaviour through the handler. `test/helpers.ts` has `tcString(purposes, { publisher, vendors })` and `publisherTc(purposes)` to build TC strings and `setCookies(response)` to parse cookies. Use a fixed clock and ID generator (`createHandler({ now, mintId })`) for deterministic assertions.

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
- Use `context.config` for settings (from `SID_MODULE_CONFIG`), and validate them: it's `Record<string, unknown>`.
- Don't put personal data in the output unless the publisher enabled it in the module's config, and default to off. Don't log request data.
- A module that throws or exceeds `SID_MODULE_TIMEOUT_MS` is reported (`ext.modules`) and left out. Don't rely on that for control flow; return `undefined` when there's nothing to add.
- Modules with a `gvlid` don't run when GDPR applies until vendor consent decoding exists.
- Test each module with the handler (`createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'name' }) })`), including consent skips, and add conformance cases when its output is part of the payload contract.
