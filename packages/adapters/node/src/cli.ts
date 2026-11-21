#!/usr/bin/env node
import type { Server } from 'node:http';
import { booleanFromEnv, ConfigError, LOCATION_FIELDS, parseHeaderMap, settingsFromEnv, trustedUpstreamFromEnv } from '@sharedid-edge/core';
// The built-in list with Bowser available to the ua module (SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}): the
// server isn't bundled, so it has no size budget to keep it out.
import { builtInModules } from '@sharedid-edge/modules/bowser';
import { withSecretFiles } from './env-files.js';
import { createHealthServer, HEALTH_PATH, healthPortFromEnv } from './health.js';
import { createNodeServer } from './index.js';
import { loadModulePackages } from './module-packages.js';

// Configuration comes from the same SID_* environment variables as the edge workers (SID_MODULES picks which of the
// built-in modules run), plus:
//   PORT (default 8787), HOST (default 127.0.0.1), HEALTH_PORT (a health check on its own port; off by default),
//   SID_TRUST_PROXY, SID_CLIENT_IP_HEADER, SID_LOCATION_HEADERS, SID_PUBLIC_ORIGIN, SID_UPSTREAM_SECRETS (with
//   SID_UPSTREAM_AUTH_HEADER and SID_UPSTREAM_HOST_HEADER), and SID_MODULE_PACKAGES (opt-in modules such as ec or vendor
//   modules, added to the built-in ones: <package>#<export>, comma-separated). SID_MODULE_SECRETS and
//   SID_UPSTREAM_SECRETS can come from files instead, named by SID_MODULE_SECRETS_FILE and SID_UPSTREAM_SECRETS_FILE.
try {
  const env = withSecretFiles(process.env);
  // The configuration, and with SID_HOSTS one per hostname (the Host header picks it).
  const settings = settingsFromEnv(env, { requireCookieDomain: true });
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '127.0.0.1';
  const healthPort = healthPortFromEnv(env['HEALTH_PORT'], port);
  const publicOrigin = env['SID_PUBLIC_ORIGIN'];
  const trustProxy = booleanFromEnv(env['SID_TRUST_PROXY'], false);
  // Trusted upstream reads SID_CLIENT_IP_HEADER and SID_LOCATION_HEADERS itself; without it, they're the trusted proxy's.
  const upstream = trustedUpstreamFromEnv(env, { trustProxy });
  const locationSetting = env['SID_LOCATION_HEADERS'];
  const configured = trustProxy && locationSetting !== undefined && locationSetting.trim() !== '';
  const clientIpHeader = trustProxy ? env['SID_CLIENT_IP_HEADER']?.trim() ?? '' : '';
  const server = createNodeServer({
    ...settings,
    modules: [...builtInModules, ...(await loadModulePackages(env['SID_MODULE_PACKAGES']))],
    trustProxy,
    upstream,
    // createNodeServer checks both: SID_CLIENT_IP_HEADER is a header name, and both need SID_TRUST_PROXY.
    ...(clientIpHeader === '' ? {} : { clientIpHeader }),
    ...(configured ? { locationHeaders: parseHeaderMap(locationSetting, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"cloudfront-viewer-country"}') } : {}),
    ...(publicOrigin === undefined ? {} : { publicOrigin })
  });
  const servers: Server[] = [server];
  server.listen(port, host, () => {
    console.log(`sharedid-edge listening on http://${host}:${String(port)}${settings.config.basePath}/`);
  });
  if (healthPort !== undefined) {
    const health = createHealthServer();
    servers.push(health);
    health.listen(healthPort, host, () => {
      console.log(`sharedid-edge health check on http://${host}:${String(healthPort)}${HEALTH_PATH}`);
    });
  }
  // As a container's main process, nothing stops the server on SIGTERM unless it does so itself: close the listeners,
  // let the requests in flight finish, and exit; or exit anyway after 10 seconds.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => process.exit(0), 10_000).unref();
      let open = servers.length;
      for (const listener of servers) {
        listener.close(() => {
          open -= 1;
          if (open === 0) process.exit(0);
        });
      }
    });
  }
} catch (error) {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
}
