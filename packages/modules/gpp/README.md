# @sharedid-edge/module-gpp

The `gpp` module for [SharedID Edge](../../../README.md): the US privacy opt-outs in an [IAB Global Privacy Platform](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform) (GPP) string, for the SharedID. It reads the **US National section and the US state sections** that `gpp_sid` names, and when the visitor has **opted out of sale, sharing or targeted advertising**, the worker sets no SharedID and deletes an existing one, exactly as for Global Privacy Control.

The worker's own consent check reads GPC, COPPA, the opt-out cookie and TCF. It reads the `gpp` and `gpp_sid` parameters but doesn't decode the string, so a US visitor who opted out in your CMP still gets an ID. This module decodes just the fields that matter (the opt-outs, and the known-child consents) of the US sections. It's a **consent provider** (see [Consent providers](../../../spec/SPEC.md#consent-providers)): it adds nothing to the payload, and only changes the storage decision.

**It's opt-in at build time.** Unlike the built-in modules, it isn't in the default builds: you add it to yours (below), then list it in `SID_MODULES`. The default builds don't carry it, nor the code in core that runs it.

## Contents

- [How the GPP string reaches the worker](#how-the-gpp-string-reaches-the-worker)
- [Turning it on](#turning-it-on)
- [Consent rules](#consent-rules)
- [Responses](#responses)
- [What it reads](#what-it-reads)
- [Size](#size)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## How the GPP string reaches the worker

The module reads the request's `gpp` (the string) and `gpp_sid` (the sections that apply, comma-separated) query parameters, the names the GPP specification gives URL-based services. **Only requests that carry them are affected.** Today that means:

- **Your own calls** to `/_sid/v1` or `/_sid/sync`: add the values from your CMP's GPP API (`__gpp('ping')` gives `gppString` and `applicableSections`):

  ```js
  __gpp('ping', ({ gppString, applicableSections }) => {
    const sids = applicableSections.filter(id => id > 0).join(',');
    fetch(`/_sid/v1?gpp=${encodeURIComponent(gppString)}&gpp_sid=${sids}`, { credentials: 'include' });
  });
  ```

- **Prebid.js's SharedID pixel** (`pixelUrl`, the `/_sid/sync` call) with `pixelConsent: true`, in Prebid.js 11.53.0 and later: it adds `gpp` and `gpp_sid` (and `gdpr`, `gdpr_consent` and `us_privacy`) from Prebid.js's consent management, so with `consentManagementGpp` the sync carries the GPP string with no page code. See [Configure Prebid.js](../../../docs/prebid.md). Without `pixelConsent`, the sync carries none.

There's **no standard cookie** to read instead: the GPP specification leaves storage to the CMP ("The storage mechanism used for GPP Strings is up to a CMP"), and many keep the string in local storage only.

## Turning it on

1. **Add it to your build,** as `@sharedid-edge/module-gpp#gppModule`:

   | Platform | Build |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-gpp#gppModule`, then `npx wrangler deploy .sharedid-modules/worker.ts` in place of `npm run deploy`. Don't add it to `src/index.ts` and use `npm run deploy`: that build leaves consent providers out. |
   | Cloudflare Snippet | Nothing to add: the Snippet bundles the modules `SID_MODULES` lists, `gpp` included. See the [Snippet section](../../adapters/cloudflare/README.md#worker-or-snippet). |
   | AWS Lambda, Vercel, Azure Functions, Google Cloud, Akamai, Fastly | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-gpp#gppModule` in place of `npm run bundle` (Fastly: then `npm run wasm`). With `cmp` too, repeat `--module`. |
   | Node.js | `SID_MODULE_PACKAGES=@sharedid-edge/module-gpp#gppModule`, with the package installed next to the server. |

2. **List it** in `SID_MODULES`. It has no settings:

   ```jsonc
   "vars": {
     "SID_MODULES": "gpp"            // with others: "gpp,reflect"
   }
   ```

3. **Check** with a US National string that opts out of sale (`DBABLA~CVQaAAAAAABA.QA`, encoded with the IAB's reference library):

   ```sh
   curl -sI 'https://www.example.com/_sid/sync?gpp=DBABLA~CVQaAAAAAABA.QA&gpp_sid=7' | grep -i x-sharedid-status
   # x-sharedid-status: denied: gpp: usnat: opted out of sale
   ```

## Consent rules

The module looks only at the **US sections `gpp_sid` lists**: US National (`usnat`, section 7) and the state sections (`usca`, `usva`, `usco`, `usut`, `usct`, `usfl`, `usmt`, `usor`, `ustx`, `usde`, `usia`, `usne`, `usnh`, `usnj`, `ustn`, `usmn`, `usmd`, `usin`, `usky`, `usri`; sections 8 to 27). For each, in `gpp_sid` order:

1. **An opt-out of sale, sharing or targeted advertising** (`SaleOptOut`, `SharingOptOut`, `TargetedAdvertisingOptOut` = 1; US National version 3's `MspaOptOut` = 1) **denies** the SharedID and deletes the ID cookies, as GPC does, wherever the visitor is and even with a TC string that allows it.
2. **A known child without consent** (any `KnownChildSensitiveDataConsents` value of 1, "No Consent") denies too: the publisher knows the visitor is a child or teenager and has no consent to sell their data or use it for targeted advertising.
3. **A section the module can't read** denies (`gpp: <section>: unreadable`, or `gpp: unreadable GPP string`): a malformed or truncated string, one whose header doesn't list a section `gpp_sid` names, a missing `gpp`, or a section version newer than the module knows. When `gpp_sid` says a US section applies, the string is the visitor's US opt-out signal, and one the module can't read may hold an opt-out it can't see; it fails closed, the conservative reading.
4. **No opt-out:** nothing changes. The module never grants: it can't lift a GDPR denial, and it can't override GPC, COPPA, the opt-out cookie or a TC string.

**Ignored:** sections `gpp_sid` doesn't list, and non-US sections (TCF EU and Canada, which the worker reads as a TC string only from `gdpr_consent` or the `euconsent-v2` cookie; `uspv1`, the old US Privacy string). A `gpp` without `gpp_sid` changes nothing, and so does any `gpp` when `gpp_sid` lists no US section.

This only decides the SharedID (and what `reflect` and other modules see as `storage`). It doesn't change the other consent rules: precise location (`ip`, `geo`) still follows GPC, COPPA, `us_privacy` and TCF only.

## Responses

The module adds nothing to the payload. On `/_sid/v1` it reports `empty`:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "gpp": { "ms": 0, "status": "empty" } } }
}
```

Its effect is on the storage decision, in `X-SharedID-Status` on `/_sid/sync` and `/_sid/v1`:

| The GPP string says, for a US section in `gpp_sid` | `X-SharedID-Status` |
| --- | --- |
| no opt-out | none: the ID is set as without the module |
| opted out of sale | `denied: gpp: usnat: opted out of sale` (the section's name), ID deleted |
| opted out of sharing | `denied: gpp: usca: opted out of sharing`, ID deleted |
| opted out of targeted advertising | `denied: gpp: usco: opted out of targeted advertising`, ID deleted |
| opted out (US National version 3) | `denied: gpp: usnat: opted out`, ID deleted |
| a known child without consent | `denied: gpp: usco: no consent for a known child`, ID deleted |
| a section it can't read | `denied: gpp: usca: unreadable`, ID deleted |
| no header it can read, or no `gpp` | `denied: gpp: unreadable GPP string`, ID deleted |

## What it reads

The encoding is the IAB's [Consent String Specification](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/blob/main/Core/Consent%20String%20Specification.md):

- **The string:** sections joined with `~`, the header first; subsections joined with `.`. Each part is base64url, six bits a character.
- **The header:** `Type` Int(6) = 3, `Version` Int(6) = 1, then `Sections`, a Range (Fibonacci) of section IDs: an Int(12) count, then per entry a single/group bit and Fibonacci-coded offsets from the previous ID. The sections follow in that order.
- **Int(Fibonacci):** bits weighted 1, 2, 3, 5, 8, …, ended by `11`.

From each US section's core subsection it reads only the opt-out and known-child fields, at the positions of its technical specification in the IAB repository: [US National](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/tree/main/Sections/US-National) versions 1, 2 and 3, and [each state](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/tree/main/Sections/US-States) (version 1). The [module's specification](../../../spec/modules/gpp.md#decoding) has the table of positions. The layouts were checked against the IAB's reference library, [iabgpp-es](https://github.com/IABTechLab/iabgpp-es) (`@iabgpp/cmpapi` 3.2.0): every section it encodes, with each field opted out and not, reads the same here.

Two places where the specification and practice differ, both read:

- **Section headers.** US National version 3 and the Maryland, Indiana, Kentucky and Rhode Island sections specify a section header (`SectionId`, `Version`, `SubSections`) before the core; the IAB's reference library writes the four states without it. Both forms are read, told apart by the first six bits (the section's own ID for a header).
- **US National version 3** (November 2026, for the Fifth Amended and Restated MSPA) replaces the separate opt-outs with one, `MspaOptOut`, which the module reads. The reference library doesn't write it yet.

It doesn't read the notices, the sensitive-data fields, the other MSPA fields, or the GPC subsection (GPC reaches the worker as the `Sec-GPC` header).

## Size

Measured with this repository's build:

- **The module:** 2.4 KB minified, 1.3 KB gzipped.
- **A Lambda bundle with it:** 1.4 KB more gzipped than the default bundle (the module, and core's consent-provider code, which default builds leave out).
- **A Snippet** with `SID_MODULES: "gpp"`: 21.5 KB minified, 2.9 KB more than core alone, of the Snippet's 32 KB.

The default builds don't change. Your build reports its own size: `npm run bundle` prints the gzipped size, and the Snippet build its size by part.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { gppModule, gppSignal } from '@sharedid-edge/module-gpp';

const handler = createHandler({ config: resolveConfig(env), modules: [...builtInModules, gppModule] });

// The decoder on its own: { consent: 'denied', reason } or undefined, never a grant.
const signal = gppSignal('DBABLA~CVQaAAAAAABA.QA', [7]);   // { consent: 'denied', reason: 'usnat: opted out of sale' }
```

## Troubleshooting

- **`ext.modules.gpp` is `skipped`, `not installed`:** your build doesn't have the module. Add it (step 1), and check you deployed that build.
- **Nothing changes for visitors who opted out:** the request doesn't carry `gpp` and `gpp_sid`, or `gpp_sid` doesn't list the US section. Prebid.js's sync doesn't send them yet (see [How the GPP string reaches the worker](#how-the-gpp-string-reaches-the-worker)); check your own calls send both, and that `gpp_sid` is your CMP's `applicableSections`.
- **Every request is `denied: gpp: unreadable GPP string`:** `gpp_sid` names a US section and `gpp` is missing, cut short, or not a GPP string: often a macro that wasn't filled in (`gpp=${GPP_STRING}`), or a `+` or `~` mangled by URL-encoding. Encode it with `encodeURIComponent`.
- **`denied: gpp: <section>: unreadable`:** the header doesn't list that section, or the section is a version the module doesn't know yet (the IAB publishes new versions in its repository). Check the string with your CMP's tools, and update the module.
- **Visitors outside the US are denied with `gpp: …`:** their string says they opted out in a US section `gpp_sid` lists. That's intended: the CMP decided the section applies.
