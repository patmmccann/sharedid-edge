# conformance

The conformance suite is the contract between the specification and every implementation, including future ports (Rust, other platforms). Cases are JSON so any language can run them; the TypeScript runner is one implementation of the runner.

- **Case files** (`cases/*.json`) each have a `description`, the `config` (`SID_*` variables) the target must run with, and `cases`. The runner starts a target per file with that config. Files with an empty `config` are also run against live deployments (`--base-url`), so keep default-configuration cases there and others in separate files.
- **Case shape** is defined by `case-file.schema.json` and validated by `src/cases.ts` (unknown keys fail, so a typo can't silently skip an assertion). Keep the schema, the TypeScript types and the validator in step. Use `jsonAbsent` (dotted key paths) to assert that the payload leaves something out, such as precise location fields.
- **Visitor location** is sent as Cloudflare's visitor location headers (`cf-ipcountry`, `cf-region-code`, `cf-ipcity`, …). The Node.js target reads them with `SID_TRUST_PROXY`; for `wrangler dev`, `src/targets.ts` passes the same values as `request.cf` through Miniflare's `MF-CF-Blob` header, since workerd otherwise uses Cloudflare's view of the machine running the suite. Use time zones without daylight saving time so `utcoffset` doesn't depend on the date.
- **Emulated platforms map the cases' headers to their own.** A local stand-in for a platform (`src/*-emulator.ts`) drops the platform's own client IP and location headers from the client's request, as the platform does, and sets them from the case: the client IP from the connection, or with `SID_TRUST_PROXY` from the first `X-Forwarded-For` entry, and the location from the `cf-*` headers (with `SID_TRUST_PROXY`):

  | Case header | Lambda (`lambda-emulator.ts`) | Vercel (`vercel-emulator.ts`) |
  | --- | --- | --- |
  | client IP | `CloudFront-Viewer-Address` (`ip:port`) | `x-real-ip`, `x-forwarded-for`, `x-vercel-forwarded-for` |
  | `cf-ipcountry` | `CloudFront-Viewer-Country` | `x-vercel-ip-country` |
  | `cf-region-code` | `CloudFront-Viewer-Country-Region` | `x-vercel-ip-country-region` |
  | `cf-ipcity` | `CloudFront-Viewer-City` | `x-vercel-ip-city`, percent-encoded |
  | `cf-postal-code` | `CloudFront-Viewer-Postal-Code` | `x-vercel-ip-postal-code` |
  | `cf-metro-code` | `CloudFront-Viewer-Metro-Code` | none |
  | `cf-iplatitude`, `cf-iplongitude` | `CloudFront-Viewer-Latitude`, `-Longitude` | `x-vercel-ip-latitude`, `-longitude` |
  | `cf-timezone` | `CloudFront-Viewer-Time-Zone` | `x-vercel-ip-timezone` |
  | `cf-ipcontinent` | none | `x-vercel-ip-continent` |

  An emulator holds only its platform's header names and event or response shapes. The rest is shared in `src/emulator.ts`: loading the bundle (`loadBundleExport`), the case's client IP (`caseClientIp`), its location headers renamed by the emulator's table (`caseLocation`, which decodes the city back to UTF-8), the body, and the server that answers a failed invocation with a 502 (`serve`). A new emulator uses them rather than copying another.

- **A field the platform doesn't report** is listed in the target's `unavailable` payload paths in `src/targets.ts` (Vercel: `ortb2.device.geo.metro`). The runner removes those paths from `json` and `jsonIncludes` and checks they're absent instead, so the target can't pass by inventing them. List only what the platform genuinely lacks, never to skip a failure, and say so in the adapter's README.
- **Every behaviour in spec/SPEC.md should have a case.** Add cases with the spec change, before or with the implementation. Use fixed IDs (the suite uses `c29cb2ae-769d-42f6-891a-f53cadee823d` and `0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10`) and `valuePattern` only for minted IDs.
- **`Secure`** is checked generically: present over https targets, absent over http. Don't assert it per case.
- **TC strings** in cases are generated with `tcString()` from `packages/core/test/helpers.ts`; note in the file's `description` which purposes each consents to.
- Run with `npm run conformance` (Node.js target), `npm run conformance:wrangler` (workerd through `wrangler dev`; no account needed) `npm run conformance:lambda` (the Lambda bundle behind `src/lambda-emulator.ts`, a local stand-in for CloudFront and the function URL that sets `CloudFront-Viewer-Address`) and `npm run conformance:vercel` (the Vercel bundle behind `src/vercel-emulator.ts`, a local stand-in for Vercel's proxy). All must pass. Build first (`npm run build`): the runner and the Node target run from `dist/`.
