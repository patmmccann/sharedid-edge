export { createHandler, ROUTES, type HandlerOptions, type SharedIdEdgeHandler } from './handler.js';
export {
  ConfigError,
  DEFAULT_CONFIG,
  MAX_COOKIE_AGE_DAYS,
  resolveConfig,
  type SharedIdEdgeConfig
} from './config.js';
export {
  preciseLocationDenial,
  readConsent,
  storageDecision,
  TCF_COOKIE,
  type ConsentContext,
  type PreciseLocationDenial,
  type StorageDecision
} from './consent.js';
export { EU_COUNTRY_CODES, locationInfo, type LocationSource, type PlatformLocation } from './location.js';
export { decodeTcf, type TcfConsents } from './tcf.js';
export { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
export { idFromSyncParam, isValidId, mintId } from './id.js';
export {
  deepMerge,
  defineModule,
  ModuleRegistry,
  optOutCookies,
  runModules,
  type EdgeModule,
  type ModuleContext,
  type ModuleCookie,
  type ModuleResult,
  type ModuleRoute,
  type ModuleRunOutput
} from './modules.js';
export {
  BOT_KINDS,
  mergeTraffic,
  PROXY_KINDS,
  skipsBot,
  trafficReport,
  type BotKind,
  type ProxyKind,
  type SkipBotsSettings,
  type TrafficEntry,
  type TrafficReport,
  type TrafficSignal
} from './traffic.js';
export type { Eid, ModuleReport, PayloadV1, PlatformInfo } from './types.js';
