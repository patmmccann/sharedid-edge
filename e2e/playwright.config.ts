import { defineConfig, devices } from '@playwright/test';

const PORT = 4310;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: { baseURL: `http://127.0.0.1:${String(PORT)}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    command: 'node --experimental-strip-types server.ts',
    url: `http://127.0.0.1:${String(PORT)}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false
  }
});
