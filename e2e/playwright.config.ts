import { defineConfig, devices } from '@playwright/test';

const PORT = 4310;
// E2E_BASE_URL runs the same tests against a live deployment (https://e2e.sharedid.dev in the live-tests workflow)
// instead of the local server.
const live = process.env['E2E_BASE_URL'];

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: { baseURL: live ?? `http://127.0.0.1:${String(PORT)}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  ...(live === undefined
    ? {
      webServer: {
        command: 'node --experimental-strip-types server.ts',
        url: `http://127.0.0.1:${String(PORT)}/`,
        env: { PORT: String(PORT) },
        reuseExistingServer: false
      }
    }
    : {})
});
