export { createHandler, ROUTES, type HandlerOptions, type SharedIdEdgeHandler } from './handler.js';
export {
  ConfigError,
  DEFAULT_CONFIG,
  MAX_COOKIE_AGE_DAYS,
  resolveConfig,
  type SharedIdEdgeConfig
} from './config.js';
export { readConsent, storageDecision, TCF_COOKIE, type ConsentContext, type StorageDecision } from './consent.js';
export { decodeTcf, type TcfConsents } from './tcf.js';
export { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
export { idFromSyncParam, isValidId, mintId } from './id.js';
export {
  deepMerge,
  defineModule,
  ModuleRegistry,
  runModules,
  type EdgeModule,
  type ModuleContext,
  type ModuleCookie,
  type ModuleResult,
  type ModuleRunOutput
} from './modules.js';
export type { Eid, ModuleReport, PayloadV1, PlatformInfo } from './types.js';
