# packages/module-reflect

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes.

The `reflect` module (`@sharedid-edge/module-reflect`): re-sets first-party cookies other scripts wrote (named in `SID_MODULE_CONFIG.reflect.cookies`) with the same value and a new `Max-Age`, so they become server-set cookies. See the [spec section](../../spec/SPEC.md#the-reflect-module).

- **Values are opaque.** Copy them byte for byte from the raw `Cookie` header (`rawCookieValue`, not `context.cookies`, which strips quotes). Never decode, re-encode, trim, inspect, log or return them, and never put cookie names or values in the payload or in errors. A value that can't be set unchanged (quoted, over 1024 characters, not cookie-octets) is skipped, not fixed.
- **Consent follows `context.storage`,** the SharedID's own storage decision. Don't add separate consent rules here; if the SharedID's rules change, this module follows.
- **Never delete on `/v1`.** These are other parties' cookies (some hold their owner's opt-out state). Deletion happens only on `/optout`, only for entries with `deleteOnOptOut: true`.
- **Settings are validated strictly** (`reflectModuleConfig`): unknown keys, wrong types and out-of-range values throw, which makes the module an `error`. Keep error messages free of configured values. `RESERVED_COOKIE_NAMES` lists the names that can't be configured; core separately refuses the worker's configured cookie names.
- **No `purposes`:** consent comes from `context.storage`, which already applies TCF. The output is cookies only, so core reports `empty`.
- **Tests:** `test/reflect.test.ts` covers settings validation, byte-for-byte reflection, every consent denial, reserved names, attributes, `/optout` and the module through `createHandler`. Conformance cases are in `conformance/cases/module-reflect.json`.
