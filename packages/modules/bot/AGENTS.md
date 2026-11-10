# packages/modules/bot

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes.

The `bot` module (`@sharedid-edge/module-bot`): bot and staff-traffic reports for the shared traffic signal, `ortb2.device.ext.traffic`. See the [spec section](../../../spec/SPEC.md#the-bot-module) and the [traffic signal](../../../spec/SPEC.md#traffic-signal) rules. It follows the module rules in [`../AGENTS.md`](../AGENTS.md).

- **Report with `traffic`, never `ortb2`.** Core merges every report and writes `ortb2.device.ext.traffic` itself; it sets `sources` too.
- **No platform data here.** The platform's verdict (Cloudflare Bot Management) enters through `PlatformInfo.traffic`, filled by the adapter, and core merges it as source `platform`. Repeating it here would count it twice and tie the output to this module.
- **No crawler list.** Declared crawlers are the `ua` module's job (`botKind: declared`). This module only has heuristics (`likely`) and the internal marker.
- **Heuristics stay conservative and opt-in.** `missingHeaders` judges only user agents that claim to be a browser, and expects `Sec-Fetch-*` only from versions that always send them, over secure origins. Before widening it, think about the real visitors it would misclassify: `SID_SKIP_BOTS=likely` stops their SharedID.
- **Settings fail loudly:** `botSettings` throws on an unknown key or a wrong type; the secret check never echoes the value.
- **Consent doesn't apply to the signal** (a maintainer decision): it runs and reports under GPC, COPPA, opt-out and denied consent. Never store or log anything about the request.
- Tests in `test/bot.test.ts` cover the settings, the user agent table, the heuristic, the internal cookie and token, consent and `SID_SKIP_BOTS` through `createHandler`. Conformance cases are in `conformance/cases/module-bot.json` and `conformance/cases/skip-bots.json`. The runner's HTTP client always sends `Sec-Fetch-Mode`, so cases use an empty `Accept-Language` for the heuristic.
