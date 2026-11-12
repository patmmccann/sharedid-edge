export { createHandler, ROUTES, type HandlerOptions, type SharedIdEdgeHandler } from './handler.js';
export { configForHost, hostKey, hostOverrides, resolveHosts, settingsFromEnv, type EnvSettings } from './hosts.js';
export { booleanFromEnv, cachedByEnv, handlerOrMisconfigured, headerValue, isHeaderName, logRequestFailure, parseHeaderMap, parseViewerAddress, publicOriginFromEnv, SETTING_NAMES, splitHeaders, withPublicOrigin, type SplitHeaders } from './adapter.js';
export {
  ConfigError,
  DEFAULT_CONFIG,
  MAX_COOKIE_AGE_DAYS,
  resolveConfig,
  type ResolveConfigOptions,
  SETTINGS,
  type ConfigSetting,
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
export { EU_COUNTRY_CODES, LOCATION_FIELDS, locationInfo, locationWithEU, type LocationField, type LocationHeaders, type LocationSource, type PlatformLocation } from './location.js';
export { parseIp, type ParsedIp } from './ip.js';
export { decodeTcf, type TcfConsents } from './tcf.js';
export { cookieValues, parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
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
