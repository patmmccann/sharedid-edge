import { defineConfig, devices } from '@playwright/test';

const PORT = 4310;
// E2E_BASE_URL runs the same tests against a live deployment (https://e2e.sharedid.dev in the live-tests workflow)
// instead of the local server.
const live = process.env['E2E_BASE_URL'];
// Locally, the page is served on a hostname under a registrable domain, like the live site, not on 127.0.0.1: Prebid.js
// writes _pubcid on the highest domain it can, and on an IP address that probe misbehaves (WebKit on Linux accepts
// Domain=0.0.1). Every browser reaches e2e.sharedid.test through the local server, used as its HTTP proxy, so no DNS
// setup is needed. The tests read the cookie domain from E2E_COOKIE_DOMAIN, set here for local runs.
const LOCAL_HOST = 'e2e.sharedid.test';
if (live === undefined) process.env['E2E_COOKIE_DOMAIN'] ??= 'sharedid.test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: live === undefined
    ? { baseURL: `http://${LOCAL_HOST}`, proxy: { server: `http://127.0.0.1:${String(PORT)}` } }
    : { baseURL: live },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  ...(live === undefined
    ? {
      webServer: {
        command: 'node --experimental-strip-types bundle-prebid.ts && node --experimental-strip-types server.ts',
        url: `http://127.0.0.1:${String(PORT)}/`,
        env: { PORT: String(PORT) },
        reuseExistingServer: false
      }
    }
    : {})
});
