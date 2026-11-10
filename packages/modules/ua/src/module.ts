import { defineModule, type ConsentContext, type EdgeModule, type ModuleContext, type ModuleResult } from '@sharedid-edge/core';
import { readClientHints, type BrandVersion, type ClientHints } from './client-hints.js';
import { botParser, type ParsedUserAgent, type UserAgentParser } from './parse.js';

/** OpenRTB 2.6 `BrandVersion`: a brand and its version split into components (`["131", "0", "6778", "86"]`). */
export interface SuaBrandVersion {
  readonly brand: string;
  readonly version?: readonly string[];
}

/** OpenRTB 2.6 `UserAgent` (`device.sua`), the structured user agent. */
export interface StructuredUserAgent {
  readonly browsers?: readonly SuaBrandVersion[];
  readonly platform?: SuaBrandVersion;
  /** 1 when the browser prefers a mobile experience, 0 otherwise. */
  readonly mobile?: 0 | 1;
  readonly architecture?: string;
  readonly bitness?: string;
  readonly model?: string;
  /** 1: low-entropy Client Hints only; 2: high-entropy Client Hints too; 3: parsed from the User-Agent. */
  readonly source: 1 | 2 | 3;
}

/**
 * OpenRTB 2.6 `device.devicetype` (AdCOM device types) this module sends: 2 personal computer, 3 connected TV,
 * 4 phone, 5 tablet.
 */
export type DeviceType = 2 | 3 | 4 | 5;

/**
 * The shared traffic signal, `device.ext.traffic` (sharedid-edge#5). This module reports only self-identified
 * crawlers: `{ bot: true, botKind: 'declared', sources: ['ua'] }`.
 */
export interface TrafficSignal {
  readonly bot: boolean;
  readonly botKind?: 'verified' | 'declared' | 'likely';
  readonly sources: readonly string[];
}

/** The `device` fields this module fills. */
export interface UaDevice {
  readonly ua?: string;
  readonly sua?: StructuredUserAgent;
  readonly devicetype?: DeviceType;
  readonly make?: string;
  readonly model?: string;
  readonly os?: string;
  readonly osv?: string;
  readonly ext?: { readonly traffic: TrafficSignal };
}

/** The module's settings, from `SID_MODULE_CONFIG.ua`. */
export interface UaSettings {
  /** Also send the raw User-Agent as `device.ua`. Off by default: Prebid.js sends it already. */
  readonly ua: boolean;
}

/**
 * Reads the module's `SID_MODULE_CONFIG` entry. Throws on an unknown key or a value of the wrong type, so a typo
 * fails loudly; the worker then reports the module as an `error`.
 */
export function uaSettings(config: Readonly<Record<string, unknown>>): UaSettings {
  for (const key of Object.keys(config)) {
    if (key !== 'ua') throw new TypeError(`ua: unknown setting "${key}"`);
  }
  const ua = config['ua'];
  if (ua !== undefined && typeof ua !== 'boolean') throw new TypeError('ua: "ua" must be true or false');
  return { ua: ua ?? false };
}

/** Why only low-entropy fields are sent; see `highEntropyDenial`. */
export type HighEntropyDenial = 'gpc' | 'coppa' | 'us-privacy' | 'tcf: no TC string' | 'tcf: invalid TC string';

/**
 * Why high-entropy device data (full versions, the OS version, model, architecture, bitness, the raw User-Agent) must
 * be left out, or undefined if it may be sent. It's left out with Global Privacy Control, for a request subject to
 * COPPA, with a `us_privacy` string that opts out of sale, with an invalid TC string, or when GDPR applies and there's
 * no TC string. The device class, OS name, maker, browser brands with major versions and the traffic signal are
 * always sent.
 */
export function highEntropyDenial(consent: ConsentContext): HighEntropyDenial | undefined {
  if (consent.gpc) return 'gpc';
  if (consent.coppa) return 'coppa';
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  if (consent.tcString !== undefined) return consent.tcf === undefined ? 'tcf: invalid TC string' : undefined;
  if (consent.gdprApplies === true) return 'tcf: no TC string';
  return undefined;
}

const VERSION = /^[0-9]+(?:\.[0-9]+){0,5}$/;

/** A version as OpenRTB's list of components, or undefined if it isn't dotted digits. */
export function versionComponents(version: string | undefined): string[] | undefined {
  return version !== undefined && VERSION.test(version) ? version.split('.') : undefined;
}

/** The major version: the first component. */
function major(version: string | undefined): string | undefined {
  return versionComponents(version)?.[0];
}

/**
 * Chromium's reduced User-Agent sends `131.0.0.0` whatever the build: only the major version is real. Other
 * versions are kept as given.
 */
function uaVersion(version: string | undefined): string[] | undefined {
  const parts = versionComponents(version);
  if (parts === undefined) return undefined;
  return parts.length === 4 && parts.slice(1).every(p => p === '0') ? parts.slice(0, 1) : parts;
}

function brandVersion(brand: string, version: readonly string[] | undefined): SuaBrandVersion {
  return version === undefined ? { brand } : { brand, version };
}

const DESKTOP_PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'linux', 'chrome os', 'chromium os']);

/**
 * The OpenRTB device type. The `Sec-CH-UA-Mobile` hint comes first (a phone, or a tablet when the User-Agent says
 * so); then the parsed User-Agent; then a desktop OS means a personal computer.
 */
export function deviceType(hints: ClientHints, parsed: ParsedUserAgent): DeviceType | undefined {
  if (hints.mobile === true) return parsed.type === 'tablet' ? 5 : 4;
  if (hints.mobile === false && hints.platform !== undefined && DESKTOP_PLATFORMS.has(hints.platform.toLowerCase())) return 2;
  switch (parsed.type) {
    case 'mobile': return 4;
    case 'tablet': return 5;
    case 'tv': return 3;
    case 'desktop': return 2;
    case undefined: break;
  }
  const os = hints.platform ?? parsed.os?.name;
  return os !== undefined && DESKTOP_PLATFORMS.has(os.toLowerCase()) ? 2 : undefined;
}

/**
 * The OS version from `Sec-CH-UA-Platform-Version`. On Windows that's the platform API version, not the release:
 * 13 and up is Windows 11, 1 to 10 is Windows 10, and 0 is earlier (left out).
 */
export function hintOsVersion(platform: string | undefined, platformVersion: string): string | undefined {
  const parts = versionComponents(platformVersion);
  if (parts === undefined) return undefined;
  if (platform?.toLowerCase() !== 'windows') return platformVersion;
  const release = Number(parts[0]);
  return release >= 13 ? '11' : release >= 1 ? '10' : undefined;
}

/**
 * Maps the request's Client Hints and User-Agent to OpenRTB 2.6 `device` fields. Hints are preferred; the parsed
 * User-Agent fills what they don't give. With `highEntropy: false` only low-entropy fields are returned (see
 * `highEntropyDenial`). The traffic signal is always included for a self-identified bot.
 */
export function uaDevice(
  hints: ClientHints,
  userAgent: string | undefined,
  options: { readonly highEntropy: boolean; readonly includeUa: boolean; readonly parser?: UserAgentParser }
): UaDevice | undefined {
  const parsed: ParsedUserAgent = userAgent === undefined ? { bot: false } : (options.parser ?? botParser)(userAgent);
  const { highEntropy } = options;
  const devicetype = deviceType(hints, parsed);

  const os = hints.platform ?? parsed.os?.name;
  let osv: string | undefined;
  if (highEntropy) {
    if (hints.platformVersion !== undefined) osv = hintOsVersion(hints.platform, hints.platformVersion);
    // The parsed version only describes the hinted OS if the parser agrees on its name.
    else if (parsed.os !== undefined && (hints.platform === undefined || hints.platform.toLowerCase() === parsed.os.name.toLowerCase())) osv = parsed.os.version;
  }
  const model = highEntropy ? hints.model ?? parsed.model : undefined;
  const make = parsed.vendor;

  const sua = structuredUserAgent(hints, parsed, { highEntropy, devicetype, osv });
  const device: UaDevice = {
    ...(options.includeUa && highEntropy && userAgent !== undefined ? { ua: userAgent } : {}),
    ...(sua === undefined ? {} : { sua }),
    ...(devicetype === undefined ? {} : { devicetype }),
    ...(make === undefined ? {} : { make }),
    ...(model === undefined ? {} : { model }),
    ...(os === undefined ? {} : { os }),
    ...(osv === undefined ? {} : { osv }),
    ...(parsed.bot ? { ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } } } : {})
  };
  return Object.keys(device).length === 0 ? undefined : device;
}

function hintBrands(brands: readonly BrandVersion[], full: boolean): SuaBrandVersion[] {
  return brands.map(b => brandVersion(b.brand, full ? versionComponents(b.version) : versionComponents(major(b.version))));
}

/**
 * `device.sua`: from Client Hints when the browser sent any (`source` 1, or 2 with high-entropy hints), else from the
 * parsed User-Agent (`source` 3).
 */
function structuredUserAgent(
  hints: ClientHints,
  parsed: ParsedUserAgent,
  context: { readonly highEntropy: boolean; readonly devicetype: DeviceType | undefined; readonly osv: string | undefined }
): StructuredUserAgent | undefined {
  const { highEntropy } = context;
  if (hints.brands !== undefined || hints.platform !== undefined || hints.mobile !== undefined) {
    const full = highEntropy ? hints.fullVersionList : undefined;
    const browsers = full !== undefined ? hintBrands(full, true) : hints.brands === undefined ? undefined : hintBrands(hints.brands, false);
    const platformVersion = highEntropy && hints.platformVersion !== undefined ? versionComponents(hints.platformVersion) : undefined;
    const architecture = highEntropy ? hints.architecture : undefined;
    const bitness = highEntropy ? hints.bitness : undefined;
    const model = highEntropy ? hints.model : undefined;
    const high = full !== undefined || platformVersion !== undefined || architecture !== undefined || bitness !== undefined || model !== undefined;
    return {
      ...(browsers === undefined || browsers.length === 0 ? {} : { browsers }),
      ...(hints.platform === undefined ? {} : { platform: brandVersion(hints.platform, platformVersion) }),
      ...(hints.mobile === undefined ? {} : { mobile: hints.mobile ? 1 : 0 }),
      ...(architecture === undefined ? {} : { architecture }),
      ...(bitness === undefined ? {} : { bitness }),
      ...(model === undefined ? {} : { model }),
      source: high ? 2 : 1
    };
  }
  if (parsed.browser === undefined && parsed.os === undefined) return undefined;
  const browserVersion = highEntropy ? uaVersion(parsed.browser?.version) : versionComponents(major(parsed.browser?.version));
  return {
    ...(parsed.browser === undefined ? {} : { browsers: [brandVersion(parsed.browser.name, browserVersion)] }),
    ...(parsed.os === undefined ? {} : { platform: brandVersion(parsed.os.name, versionComponents(context.osv)) }),
    ...(context.devicetype === undefined ? {} : { mobile: context.devicetype === 4 ? 1 : 0 }),
    source: 3
  };
}

/**
 * The User-Agent to parse. Behind CloudFront, a User-Agent the origin request policy doesn't forward arrives as
 * `Amazon CloudFront`, which describes the CDN, not the visitor.
 */
function visitorUserAgent(headers: Headers): string | undefined {
  const ua = headers.get('User-Agent')?.trim();
  return ua === undefined || ua === '' || ua === 'Amazon CloudFront' ? undefined : ua;
}

/**
 * Builds the `ua` module: the request's User-Agent Client Hints and User-Agent as the `/v1` payload's OpenRTB 2.6
 * `ortb2.device` (`sua`, `devicetype`, `os`, `osv`, `make`, `model`, and `ua` when enabled), plus the shared traffic
 * signal `device.ext.traffic` for self-identified crawlers. High-entropy fields are left out under
 * `highEntropyDenial`; the traffic signal is always sent. `parser` reads the User-Agent: `botParser` (the default)
 * only detects bots; `bowserParser` from `@sharedid-edge/module-ua/bowser` also reads the browser, OS and device.
 */
export function createUaModule(options: { readonly parser?: UserAgentParser } = {}): EdgeModule {
  const parser = options.parser ?? botParser;
  return defineModule({
    name: 'ua',
    run({ request, consent, config }: ModuleContext): ModuleResult | undefined {
      const settings = uaSettings(config);
      const device = uaDevice(readClientHints(request.headers), visitorUserAgent(request.headers), {
        highEntropy: highEntropyDenial(consent) === undefined,
        includeUa: settings.ua,
        parser
      });
      return device === undefined ? undefined : { ortb2: { device } };
    }
  });
}
