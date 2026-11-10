# packages/module-geo

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes.

The `geo` module (`@sharedid-edge/module-geo`): the platform's location data as the `/v1` payload's OpenRTB 2.6 `ortb2.device.geo`. See the [spec section](../../spec/SPEC.md#the-geo-module). It follows the [module-ip](../module-ip/AGENTS.md) package pattern: depends only on `@sharedid-edge/core`'s public API, platform-neutral, registered in `packages/cloudflare/src/modules.ts` and `packages/node/src/cli.ts`, off until listed in `SID_MODULES`.

- **Location comes from `PlatformInfo`,** never from `request.cf` or headers directly. Adapters fill it with core's `locationInfo` (`packages/core/src/location.ts`), which does the validation (empty values, `XX`, `T1`, non-finite or out-of-range coordinates). Add new location fields there and in both adapters, not here.
- **Coarse versus precise is the privacy boundary.** Coarse (`type`, `country`, `region`, `metro`, `utcoffset`) is always sent; precise (`city`, `zip`, `lat`, `lon`) in full or not at all, under core's `preciseLocationDenial` (shared with the `ip` module) and never with `{"precision":"coarse"}`. Don't round or truncate precise values, and don't move a field across the boundary without a spec change.
- **Settings fail loudly:** `geoPrecision` throws on an unknown key or value, so a typo can't send precise data; the worker reports the module as an `error`.
- `src/countries.ts` is the ISO 3166-1 alpha-2 to alpha-3 table: officially assigned codes only (249). Keep it sorted; the test checks the count. `utcOffsetMinutes` uses `Intl.DateTimeFormat` (`timeZoneName: 'longOffset'`), which Node.js and workerd both support.
- Never log or store the location, or put it anywhere but the response to the same request.
- Tests in `test/geo.test.ts` cover the table, region codes, UTC offsets (with daylight saving time), settings, consent and the module through `createHandler`. Use zones without daylight saving time (`America/Phoenix`, `Asia/Tokyo`) where the date isn't fixed. Conformance cases are in `conformance/cases/module-geo*.json`.
