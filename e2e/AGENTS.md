# e2e

Browser tests proving SharedID Edge works with **unmodified** Prebid.js, in Chromium, Firefox and WebKit, through Playwright.

- Separate install (`npm ci` in this folder), so the main workspace doesn't pull in Prebid.js and browsers. It imports the built core (`../packages/core/dist`), so run `npm run build` at the root first.
- `server.ts` serves the test page (`site/public/index.html`), Prebid.js and `/_sid/*` (the core handler) from one origin. It runs with `SID_SYNC_CACHE_SECONDS=0` so every visit reaches the endpoint, and with the `reflect` module (`uid1`, and `_ga` with `restore`), which runs on Prebid.js's `/_sid/sync` calls; it imports the built module (`../packages/modules/reflect/dist`).
- **`pbjs.getUserIdsAsync()` resolves** with `extend: true` and `pixelUrl` since Prebid.js 11.49.0 (prebid/Prebid.js#16135; in 11.48.0 and earlier it never resolved on later visits). A test checks it. Most tests still wait for the `/_sid/sync` response, since that's what they inspect.
- **The Prebid.js the page loads** is a bundle of a typical publisher setup (`prebid-modules.json`: TCF consent management and `tcfControl`, `storageControl`, `userId` with SharedID and Unified ID, the OpenX, Magnite, TripleLift and Microsoft bidders, `gptPreAuction`, and the generic analytics adapter with its skinny preset), about 100 KB gzipped, not the 4 MB `not-for-prod` build. It shows SharedID works next to them; the page configures only the User ID module. `bundle-prebid.ts` (`npm run bundle-prebid`) assembles it into `site/public/prebid/prebid.js` (gitignored) the way Prebid's download page does: the release's precompiled `dist/chunks` for those modules and their dependencies, checked against its `checksums.json`, between a banner and `processQueue()`. Playwright's local server builds it first; the live workflow builds it before deploying `site/`. Change `prebid-modules.json` to change the setup, then rebuild the TC string (below).
- **`prebid.js` is pinned** to one version in `package.json`, so CI, the live site and local runs all test the same Prebid.js. Dependabot (`.github/dependabot.yml`) proposes the new release weekly; the PR's e2e run checks the `pixelUrl` contract still holds before it merges. If a new Prebid.js release breaks these tests, fix SharedID Edge or report it to Prebid.js.
## Consent: the TC string the tests run with

The page's consent comes from `site/public/tcf.js`, in one of three **scenarios**, picked with `?consent=<name>` in the page URL (`visit(page, '/?consent=denied')`):

| Scenario | Consent | What the tests check |
| --- | --- | --- |
| `given` (default) | GDPR applies; purpose and publisher consent for 1-10 | Every other test runs with it; one checks Prebid.js has GDPR scope and both ID cookies are set |
| `denied` | GDPR applies; no purpose 1 consent for vendors or the publisher | Prebid.js (`tcfControl`) writes no id and doesn't call `pixelUrl`; the endpoint answers `denied: tcf: no publisher consent for purpose 1` and deletes the ID cookies left by an earlier visit |
| `notApplicable` | GDPR doesn't apply; no TC string | Prebid.js reports `gdprApplies: false`, no `euconsent-v2`, and SharedID works as usual |

No CMP runs on the page: static consent data covers what the tests need. `tcf.js` sets `window.SID_E2E_TCF`, which the page passes to Prebid.js as static consent data (`consentManagement: { gdpr: { cmpApi: 'static', consentData: { getTCData: … } } }`), and writes the same string to `euconsent-v2`. That cookie is how SharedID Edge sees it, because `sharedIdSystem` doesn't send consent to `pixelUrl`. A test checks that Prebid.js has GDPR scope and that both ID cookies are set.

**The `given` string** (GVL v184, TCF policy version 5): `CQthOAAQthOAAACABBENC4FgAP_AAAAAACiQIEQCQAKgAZAA4ACAAGgARQF5gMZAgQAAAAAA.IAAA.f_gAAAAAAAAA`

| | |
| --- | --- |
| Purpose consents | 1-10 |
| Publisher consents | 1-10 (SharedID Edge's publisher mode needs purpose 1, and one of 2-10) |
| Legitimate interests, special features, restrictions | none |
| Vendor consents | 21 The Trade Desk (`unifiedIdSystem`), 25 Yahoo (extra), 28 TripleLift (`tripleliftBidAdapter`), 32 Microsoft/Xandr (`msftBidAdapter`), 52 Magnite (`magniteBidAdapter`), 69 OpenX (`openxBidAdapter`), 755 Google (extra), 793 Amazon Ads (extra), 1032 Project Agora (`msftBidAdapter`'s `projectagora` alias) |

The `denied` string is the same without purpose 1 in either purpose or publisher consents: `CQthOAAQthOAAACABBENC4FgAH_AAAAAACiQIEQCQAKgAZAA4ACAAGgARQF5gMZAgQAAAAAA.IAAA.b_gAAAAAAAAA`. `tcf.js`'s header lists every scenario, its string and each vendor's reason. Decode the string at https://iabgpp.com to check it.

**The vendor consents follow the bundle.** They're every GVL ID the modules in `prebid-modules.json` declare in `prebid.js`'s own metadata (`node_modules/prebid.js/metadata/modules/<module>.json`, `components[].gvlid`, aliases included), plus `extraVendors` in `tcf-config.json` for vendors with no module in the bundle (Google, Amazon, Yahoo). CI runs `npm run tc-string -- --check` (offline). It fails when the vendors in `tcf.js` or in the string differ from what the modules and `tcf-config.json` add up to, for example after a module is added to the bundle, or a Prebid.js bump changes a module's GVL ID.

**To make a different string:**

1. Change what it consents to: a scenario's `purposeConsents` or `publisherConsents` (or `gdprApplies: false`), add a scenario under `scenarios` in `tcf-config.json` (then use it with `?consent=<name>`), change `extraVendors`, or change the bundle's modules in `prebid-modules.json`.
2. Run `npm run tc-string` in `e2e/`. It fetches the current Global Vendor List, encodes the string with the IAB Tech Lab's `@iabtechlabtcf/core`, decodes it again to check it, and rewrites `site/public/tcf.js`. Don't edit `tcf.js` by hand.
3. Update the strings above to match `tcf.js`'s header.
4. Run the tests locally (`npx playwright test`). The `given` scenario must keep publisher consent for purpose 1 (and one of 2-10), or SharedID Edge sets no ID and most tests fail; put a stricter string in a scenario of its own, as `denied` is.

`tc-string.ts` sets `cmpId` 2 and `cmpVersion` 1: placeholders, since Prebid.js and SharedID Edge don't check them.

- WebKit here doesn't simulate Safari's 7-day cap on script-set cookies; tests simulate a capped cookie by clearing it. Real-world Safari lifetimes are measured on deployments.
- **The tests read requests from the browser,** never from the server: the `sid` fixture records the page's `/_sid/*` requests and the cookies sent with them (`request.allHeaders()`). That keeps every test runnable against a live deployment.
- **The cookie domain.** Prebid.js writes `_pubcid` on the highest domain it can, so the endpoint's `SID_COOKIE_DOMAIN` must match; a test checks there's one `_pubcid`, on the expected domain. Locally the page is `http://e2e.sharedid.test`, reached through `server.ts` as every browser's HTTP proxy (no DNS setup), with `SID_COOKIE_DOMAIN=sharedid.test`; live it's `E2E_COOKIE_DOMAIN` (`sharedid.dev`). Don't go back to 127.0.0.1: Prebid.js's root-domain probe misbehaves on an IP address. Tests add their own cookies with `cookieScope(baseURL)`, on that domain.
- **Live:** `E2E_BASE_URL=https://e2e.sharedid.dev E2E_COOKIE_DOMAIN=sharedid.dev npx playwright test` runs the same tests against the Cloudflare test zone, with no local server. `site/` is the live test site (a static-assets Worker); the [Live tests workflow](../.github/workflows/e2e-cloudflare.yml) deploys it with the latest Prebid.js copied into `site/public/prebid/` (gitignored). See [Live tests](../packages/adapters/cloudflare/README.md#live-tests).
- Type-check with `npm run typecheck` (strict, the root `tsconfig.base.json`).
- **CI installs browsers with `install-browser.sh`,** never `npx playwright install --with-deps` directly: it installs the browser from Playwright's CDN first, then its system packages through apt with a time limit, and carries on with the runner image's packages when apt can't reach the Ubuntu mirrors (which happens on GitHub's runners for hours at a time, each apt run hanging for minutes).
- Run one browser with `npx playwright test --project=chromium` (or `firefox`, `webkit`). CI runs each browser as its own job: `e2e-chromium` first, then Firefox and WebKit (the `e2e` matrix), which start only once Chromium passes. Each job installs only its own browser.
