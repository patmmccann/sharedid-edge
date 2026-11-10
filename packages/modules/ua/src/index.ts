import type { EdgeModule } from '@sharedid-edge/core';
import { createUaModule } from './module.js';

export { isGreaseBrand, parseBooleanHeader, parseBrandList, parseStringHeader, readClientHints, type BrandVersion, type ClientHints } from './client-hints.js';
export {
  createUaModule,
  deviceType,
  highEntropyDenial,
  hintOsVersion,
  uaDevice,
  uaSettings,
  versionComponents,
  type DeviceType,
  type HighEntropyDenial,
  type StructuredUserAgent,
  type SuaBrandVersion,
  type TrafficSignal,
  type UaDevice,
  type UaParserName,
  type UaSettings
} from './module.js';
export { botParser, MAX_UA_LENGTH, type ParsedUserAgent, type UserAgentParser } from './parse.js';

/**
 * The `ua` module without Bowser (`createUaModule()` with `botParser`): device data from User-Agent Client Hints, and
 * the traffic signal for clients whose User-Agent identifies them as bots. It runs only when listed in `SID_MODULES`;
 * nothing is stored or logged. The setting `"parser": "bowser"` makes it an `error`: the adapters use
 * `uaModuleWithBowser` from `@sharedid-edge/module-ua/bowser`, which supports it.
 */
export const uaModule: EdgeModule = createUaModule();
