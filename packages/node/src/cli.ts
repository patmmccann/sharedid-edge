#!/usr/bin/env node
import { ConfigError, resolveConfig } from '@sharedid-edge/core';
import { ecModule } from '@sharedid-edge/module-ec';
import { ipModule } from '@sharedid-edge/module-ip';
import { createNodeServer } from './index.js';

// Configuration comes from the same SID_* environment variables as the edge workers (SID_MODULES picks which of the
// built-in modules run), plus:
//   PORT (default 8787), HOST (default 127.0.0.1), SID_TRUST_PROXY, SID_PUBLIC_ORIGIN.
try {
  const config = resolveConfig(process.env);
  const port = Number(process.env['PORT'] ?? 8787);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const publicOrigin = process.env['SID_PUBLIC_ORIGIN'];
  const server = createNodeServer({
    config,
    modules: [ipModule, ecModule],
    trustProxy: /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? ''),
    ...(publicOrigin === undefined ? {} : { publicOrigin })
  });
  server.listen(port, host, () => {
    console.log(`sharedid-edge listening on http://${host}:${String(port)}${config.basePath}/`);
  });
} catch (error) {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
}
