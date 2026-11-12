#!/usr/bin/env node
import { booleanFromEnv, ConfigError, LOCATION_FIELDS, parseHeaderMap, settingsFromEnv, trustedUpstreamFromEnv } from '@sharedid-edge/core';
// The built-in list with Bowser available to the ua module (SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}): the
// server isn't bundled, so it has no size budget to keep it out.
import { builtInModules } from '@sharedid-edge/modules/bowser';
import { createNodeServer } from './index.js';
import { loadModulePackages } from './module-packages.js';

// Configuration comes from the same SID_* environment variables as the edge workers (SID_MODULES picks which of the
// built-in modules run), plus:
//   PORT (default 8787), HOST (default 127.0.0.1), SID_TRUST_PROXY, SID_CLIENT_IP_HEADER, SID_LOCATION_HEADERS,
//   SID_PUBLIC_ORIGIN, SID_UPSTREAM_SECRETS (with SID_UPSTREAM_AUTH_HEADER and SID_UPSTREAM_HOST_HEADER), and SID_MODULE_PACKAGES (opt-in modules such as ec or vendor modules, added to the built-in
//   ones: <package>#<export>, comma-separated).
try {
  // The configuration, and with SID_HOSTS one per hostname (the Host header picks it).
  const settings = settingsFromEnv(process.env, { requireCookieDomain: true });
  const port = Number(process.env['PORT'] ?? 8787);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const publicOrigin = process.env['SID_PUBLIC_ORIGIN'];
  const trustProxy = booleanFromEnv(process.env['SID_TRUST_PROXY'], false);
  // Trusted upstream reads SID_CLIENT_IP_HEADER and SID_LOCATION_HEADERS itself; without it, they're the trusted proxy's.
  const upstream = trustedUpstreamFromEnv(process.env, { trustProxy });
  const locationSetting = process.env['SID_LOCATION_HEADERS'];
  const configured = trustProxy && locationSetting !== undefined && locationSetting.trim() !== '';
  const clientIpHeader = trustProxy ? process.env['SID_CLIENT_IP_HEADER']?.trim() ?? '' : '';
  const server = createNodeServer({
    ...settings,
    modules: [...builtInModules, ...(await loadModulePackages(process.env['SID_MODULE_PACKAGES']))],
    trustProxy,
    upstream,
    // createNodeServer checks both: SID_CLIENT_IP_HEADER is a header name, and both need SID_TRUST_PROXY.
    ...(clientIpHeader === '' ? {} : { clientIpHeader }),
    ...(configured ? { locationHeaders: parseHeaderMap(locationSetting, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"cloudfront-viewer-country"}') } : {}),
    ...(publicOrigin === undefined ? {} : { publicOrigin })
  });
  server.listen(port, host, () => {
    console.log(`sharedid-edge listening on http://${host}:${String(port)}${settings.config.basePath}/`);
  });
} catch (error) {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
}
