#!/usr/bin/env node
import { booleanFromEnv, ConfigError, LOCATION_FIELDS, parseHeaderMap, resolveConfig } from '@sharedid-edge/core';
// The built-in list with Bowser available to the ua module (SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}): the
// server isn't bundled, so it has no size budget to keep it out.
import { builtInModules } from '@sharedid-edge/modules/bowser';
import { createNodeServer } from './index.js';
import { loadModulePackages } from './module-packages.js';

// Configuration comes from the same SID_* environment variables as the edge workers (SID_MODULES picks which of the
// built-in modules run), plus:
//   PORT (default 8787), HOST (default 127.0.0.1), SID_TRUST_PROXY, SID_LOCATION_HEADERS, SID_PUBLIC_ORIGIN, and
//   SID_MODULE_PACKAGES (opt-in modules such as ec or vendor modules, added to the built-in ones: <package>#<export>,
//   comma-separated).
try {
  const config = resolveConfig(process.env, { requireCookieDomain: true });
  const port = Number(process.env['PORT'] ?? 8787);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const publicOrigin = process.env['SID_PUBLIC_ORIGIN'];
  const trustProxy = booleanFromEnv(process.env['SID_TRUST_PROXY'], false);
  const locationSetting = process.env['SID_LOCATION_HEADERS'];
  const configured = locationSetting !== undefined && locationSetting.trim() !== '';
  // Location headers are read only from a trusted proxy: setting them without the trust would silently do nothing.
  if (configured && !trustProxy) throw new ConfigError('SID_LOCATION_HEADERS needs SID_TRUST_PROXY=true: location headers are read only from a trusted proxy');
  const server = createNodeServer({
    config,
    modules: [...builtInModules, ...(await loadModulePackages(process.env['SID_MODULE_PACKAGES']))],
    trustProxy,
    ...(configured ? { locationHeaders: parseHeaderMap(locationSetting, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"cloudfront-viewer-country"}') } : {}),
    ...(publicOrigin === undefined ? {} : { publicOrigin })
  });
  server.listen(port, host, () => {
    console.log(`sharedid-edge listening on http://${host}:${String(port)}${config.basePath}/`);
  });
} catch (error) {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
}
