import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs the tests inside workerd, the Workers runtime, with the bindings from wrangler.jsonc.
export default defineConfig({
  // SID_COOKIE_DOMAIN is required and left empty in wrangler.jsonc for deployers to fill in; the tests use host-only.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { SID_COOKIE_DOMAIN: 'host-only' } } })],
  test: {
    include: ['test/**/*.test.ts']
  }
});
