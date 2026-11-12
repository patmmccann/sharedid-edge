export type { FastlyClientInfo, FastlyFetchEvent, FastlyGeolocation } from './fastly.js';
export { createFastlyHandler, internalError, type FastlyHandler, type FastlyHandlerOptions } from './handler.js';
export {
  CONFIG_STORE,
  createStoresHandler,
  envFromStores,
  handlerFromEnv,
  SECRET_SETTING,
  SECRET_STORE,
  type ConfigStoreLike,
  type SecretStoreLike,
  type Stores
} from './env.js';
export { builtInModules } from '@sharedid-edge/modules';
export { platformInfo } from './platform.js';
