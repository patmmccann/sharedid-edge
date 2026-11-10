# e2e

Browser tests proving SharedID Edge works with **unmodified** Prebid.js (the `prebid.js` npm package's `dist/not-for-prod/prebid.js`), in Chromium, Firefox and WebKit, through Playwright.

- Separate install (`npm ci` in this folder), so the main workspace doesn't pull in Prebid.js and browsers. It imports the built core (`../packages/core/dist`), so run `npm run build` at the root first.
- `server.ts` serves the test page, Prebid.js and `/_sid/*` (the core handler) from one origin, and records sync requests (`/__sync-log`, `/__reset`). It runs with `SID_SYNC_CACHE_SECONDS=0` so every visit reaches the endpoint.
- Don't use `pbjs.getUserIdsAsync()` to wait: with `extend: true` and `pixelUrl` it never resolves on later visits (a Prebid.js issue, fixed by prebid/Prebid.js#16135). Wait for the `/_sid/sync` response instead, then read cookies and `pbjs.getUserIds()`.
- Pin the `prebid.js` version, and bump it deliberately: these tests are the evidence that the `pixelUrl` contract still holds.
- WebKit here doesn't simulate Safari's 7-day cap on script-set cookies; tests simulate a capped cookie by clearing it. Real-world Safari lifetimes are measured on deployments.
- Type-check with `npm run typecheck` (strict, the root `tsconfig.base.json`).
