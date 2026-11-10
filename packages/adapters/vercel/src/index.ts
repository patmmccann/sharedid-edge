export {
  createVercelHandler,
  createVercelMiddleware,
  internalError,
  middleware,
  type VercelHandler,
  type VercelHandlerOptions,
  type VercelMiddleware
} from './handler.js';
export { handlerFromEnv, middlewareFromEnv, type Env } from './env.js';
export { builtInModules } from '@sharedid-edge/modules';
export { EU_COUNTRY_CODES } from '@sharedid-edge/core';
export { clientIp, platformInfo, type PlatformOptions } from './platform.js';
