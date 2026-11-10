export type { AzureCookie, AzureHttpRequest, AzureHttpResponseInit } from './types.js';
export { createAzureHandler, internalError, toResponseInit, type AzureHandler, type AzureHandlerOptions } from './handler.js';
export { handlerFromEnv, parseFrontDoorIds, parseLocationHeaders, routeFor, routeFromEnv, type Env } from './env.js';
export { parseSetCookie, preservedByHost } from './cookies.js';
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
