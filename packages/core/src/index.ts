export { createHandler, MAX_COOKIE_BYTES, MAX_URL_BYTES, ROUTES, type HandlerOptions, type RateLimiter, type RateLimitRequest, type SharedIdEdgeHandler } from './handler.js';
export { booleanFromEnv, cachedByEnv, fetchForward, handlerOrMisconfigured, headerValue, isHeaderName, logRequestFailure, parseHeaderMap, parseViewerAddress, publicOriginFromEnv, SETTING_NAMES, splitHeaders, withPublicOrigin, type SplitHeaders } from './adapter.js';
export { configForHost, hostKey, hostOverrides, resolveHosts, settingsFromEnv, type EnvSettings } from './hosts.js';
export {
  clientIpFromHeader,
  DEFAULT_UPSTREAM_AUTH_HEADER,
  DEFAULT_UPSTREAM_HOST_HEADER,
  forwardedPlatformInfo,
  parseForwardedHost,
  refuseTrustedUpstream,
  trustedUpstreamFromEnv,
  utf8Header,
  withTrustedUpstream,
  type ForwardedHeaders,
  type TrustedUpstream,
  type TrustedUpstreamOptions
} from './upstream.js';
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
  storageDecisionWith,
  TCF_COOKIE,
  type ConsentContext,
  type ConsentSignal,
  type PreciseLocationDenial,
  type StorageDecision
} from './consent.js';
export { EU_COUNTRY_CODES, GDPR_COUNTRY_CODES, gdprFromLocation, LOCATION_FIELDS, locationInfo, locationWithEU, type LocationField, type LocationHeaders, type LocationSource, type PlatformLocation } from './location.js';
export { parseIp, type ParsedIp } from './ip.js';
export { decodeTcf, type TcfConsents } from './tcf.js';
export { cookieValues, parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
export { idFromSyncParam, isValidId, mintId } from './id.js';
export {
  consentSignal,
  deepMerge,
  defineModule,
  ModuleRegistry,
  optOutCookies,
  runModules,
  type ConsentHookContext,
  type EdgeModule,
  type ModuleContext,
  type ModuleCookie,
  type ModuleResult,
  type ModuleRoute,
  type ModuleRunOutput
} from './modules.js';
export {
  declaredHost,
  FORWARD_TIMEOUT_MS,
  forwardingPaths,
  MAX_FORWARD_BODY_BYTES,
  type ForwardContext,
  type ForwardDecision,
  type ForwardFetch,
  type ForwardInit,
  type ModuleForwarding
} from './forwarding.js';
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
export type { EncryptedIp, EncryptedIpValue, Eid, ModuleReport, PayloadV1, PlatformInfo } from './types.js';
