import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// The sGTM tests (sgtm/README.md), against the docker compose stack in sgtm/, which must be running: npm run test:sgtm.
// Not part of `npx playwright test` (playwright.config.ts), which needs no Docker and no Tag Manager container.
// The stack's settings from sgtm/.env, as docker compose and wait.sh read them; the environment overrides them.
const envFile = join(import.meta.dirname, 'sgtm', '.env');
if (existsSync(envFile)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    // Only the settings the tests use: never CONTAINER_CONFIG.
    if (['SITE_HOST', 'PREVIEW_HOST', 'HTTPS_PORT', 'SID_COOKIE_DOMAIN'].includes(name)) process.env[name] ??= value;
  }
}
const host = process.env['SITE_HOST'] ?? 'www.sharedid.test';
const previewHost = process.env['PREVIEW_HOST'] ?? 'sgtm-preview.sharedid.test';
const port = process.env['HTTPS_PORT'] ?? '8443';
process.env['E2E_COOKIE_DOMAIN'] ??= process.env['SID_COOKIE_DOMAIN'] ?? 'sharedid.test';

export default defineConfig({
  testDir: 'sgtm',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: {
    baseURL: `https://${host}:${port}`,
    // nginx's certificate is self-signed (sgtm/certs.sh).
    ignoreHTTPSErrors: true
  },
  // Chromium only: what's tested is SharedID Edge and sGTM's server side, which doesn't depend on the browser engine.
  // The site's hostnames resolve to the stack on 127.0.0.1 without editing /etc/hosts; everything else (gtag.js from
  // www.googletagmanager.com) resolves as usual.
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: { args: [`--host-resolver-rules=MAP ${host} 127.0.0.1, MAP ${previewHost} 127.0.0.1`] }
    }
  }]
});
