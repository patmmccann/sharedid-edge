export { createGcpHandler, sendInternalError, type GcpHandler, type GcpHandlerOptions } from './handler.js';
export { handlerFromEnv, parseLocationHeaders, parseTrustedHops, type Env } from './env.js';
export { builtInModules } from '@sharedid-edge/modules';
export { EU_COUNTRY_CODES } from '@sharedid-edge/core';
export {
  clientIp,
  LOCATION_FIELDS,
  platformInfo,
  type LocationField,
  type LocationHeaders,
  type PlatformOptions
} from './platform.js';
