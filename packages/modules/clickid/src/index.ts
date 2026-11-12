import { defineModule, TCF_COOKIE, type ConsentContext, type EdgeModule, type ModuleContext, type ModuleCookie, type ModuleResult, type StorageDecision } from '@sharedid-edge/core';

/**
 * The `clickid` module keeps ad click IDs (`gclid`, `fbclid`, `msclkid`, …) from the landing page's URL in server-set
 * first-party cookies, so a conversion on a later page view, or a later visit, can still be attributed. The URL comes
 * from the `url` query parameter, else the `Referer` header; on `/sync` (Prebid.js's `pixelUrl`) that's the landing
 * page. Cookies only: click IDs never go into the payload, so they can't reach bidders.
 */

/** The parameters read by default, each kept in `_sid_<name>`. */
export const DEFAULT_PARAMS: readonly string[] = Object.freeze(['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid']);
/** The default lifetime in days, counted from the click: the attribution window of Google, Meta and Microsoft. */
export const DEFAULT_CLICK_AGE_DAYS = 90;
/** At most this many parameters, defaults included. */
export const MAX_PARAMS = 20;
/** At most this many extra hosts in `hosts`. */
export const MAX_HOSTS = 20;
/** A click ID is stored only when it matches this, after one round of URL decoding; otherwise it's ignored. */
const CLICK_ID_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;
/**
 * Cookie names that can't be configured: the SharedID cookies at their default names, `ts-ec` (the `ec` module's), the
 * CMP's TC string, and `_sid_keep` (the `reflect` module's keeper). The same names `reflect` reserves, plus its keeper,
 * listed here rather than imported so a Snippet with `clickid` doesn't bundle `reflect` (a test checks they match).
 * Core separately refuses the worker's configured cookie names.
 */
export const RESERVED_COOKIE_NAMES: readonly string[] = Object.freeze(['_pubcid', '_pubcid_sv', '_pubcid_optout', 'ts-ec', TCF_COOKIE, '_sid_keep']);
/** The IAB US Privacy (CCPA) framework's first-party cookie, read when the request has no `us_privacy` parameter. */
export const US_PRIVACY_COOKIE = 'usprivacy';
/** The TCF purposes the module needs publisher consent for: 1 (store and access information) and 7 (measure ad performance). */
export const CLICKID_PURPOSES: readonly number[] = Object.freeze([1, 7]);

/** One parameter to keep. */
export interface ClickParam {
  /** The query parameter, matched case-sensitively. */
  readonly name: string;
  /** The cookie it's kept in. */
  readonly cookie: string;
}

/** Settings from `SID_MODULE_CONFIG.clickid`, with defaults applied. */
export interface ClickIdModuleConfig {
  /** The enabled parameters, defaults first, then added ones in order. */
  readonly params: readonly ClickParam[];
  /** The cookies deleted when storage isn't allowed and on opt-out: the enabled parameters', and those of parameters switched off. */
  readonly cookies: readonly string[];
  readonly maxAgeDays: number;
  /** Registrable domain without a leading dot, or `host-only`; undefined means `SID_COOKIE_DOMAIN`. */
  readonly domain: string | undefined;
  readonly httpOnly: boolean;
  /** Hosts, besides the request's own, whose URLs are read (lower case). */
  readonly hosts: readonly string[];
}

const SETTINGS: ReadonlySet<string> = new Set(['params', 'maxAgeDays', 'domain', 'httpOnly', 'hosts']);
const PARAM_KEYS: ReadonlySet<string> = new Set(['name', 'cookie', 'enabled']);
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HOST_ONLY = 'host-only';
/** A stored value: the click's time in Unix seconds, a dot, and the ID. */
const STORED = /^[0-9]{1,12}\.(.+)$/;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  // Messages name settings, never configured values or request data.
  throw new TypeError(`clickid: ${message}`);
}

function checkKeys(entry: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, where: string): void {
  if (Object.keys(entry).some(key => !allowed.has(key))) fail(`unknown key in ${where}`);
}

function flag(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`"${key}" must be true or false`);
  return value;
}

function cookieNameSetting(value: unknown): string {
  if (typeof value !== 'string' || !COOKIE_NAME.test(value)) fail('a "cookie" must be a cookie name');
  if (RESERVED_COOKIE_NAMES.includes(value)) fail('a "cookie" is a cookie the worker reserves');
  return value;
}

/** Applies the `params` entries to the default parameters: each overrides a default of its name, or adds one. */
function paramSettings(value: unknown): { params: ClickParam[]; cookies: string[] } {
  if (value !== undefined && !Array.isArray(value)) fail('"params" must be a list');
  const entries: readonly unknown[] = value ?? [];
  const params = new Map<string, ClickParam | undefined>(DEFAULT_PARAMS.map(name => [name, { name, cookie: `_sid_${name}` }]));
  const seen = new Set<string>();
  const off: string[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) fail('each entry in "params" must be an object');
    checkKeys(entry, PARAM_KEYS, 'a "params" entry');
    const name = entry['name'];
    if (typeof name !== 'string' || !PARAM_NAME.test(name)) fail('a "name" in "params" must be a parameter name: a letter, then letters, digits, _ or -');
    if (seen.has(name)) fail('a parameter is listed twice in "params"');
    seen.add(name);
    // The default name is checked too: `_sid_keep` is reflect's keeper, and a long parameter name makes it too long.
    const cookie = cookieNameSetting(entry['cookie'] ?? `_sid_${name}`);
    const enabled = flag(entry['enabled'], 'enabled', true);
    params.set(name, enabled ? { name, cookie } : undefined);
    if (!enabled) off.push(cookie);
  }
  const enabled = [...params.values()].filter(p => p !== undefined);
  if (enabled.length > MAX_PARAMS) fail('at most 20 parameters can be enabled');
  if (new Set(enabled.map(p => p.cookie)).size !== enabled.length) fail('two parameters use the same cookie');
  return { params: enabled, cookies: [...new Set([...enabled.map(p => p.cookie), ...off])] };
}

function hostSettings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_HOSTS) fail('"hosts" must list at most 20 hostnames');
  return value.map((host: unknown) => {
    if (typeof host !== 'string' || !HOST.test(host)) fail('"hosts" must list lower-case hostnames like www.example.com');
    return host;
  });
}

/** Parses and validates the settings; throws a `TypeError` (an `error` status) on anything unexpected. */
export function clickIdModuleConfig(config: Readonly<Record<string, unknown>>): ClickIdModuleConfig {
  checkKeys(config, SETTINGS, 'the settings');
  const age = config['maxAgeDays'] ?? DEFAULT_CLICK_AGE_DAYS;
  if (typeof age !== 'number' || !Number.isInteger(age) || age < 1 || age > 400) fail('"maxAgeDays" must be a whole number from 1 to 400');
  const domain = config['domain'];
  if (domain !== undefined && domain !== HOST_ONLY && (typeof domain !== 'string' || !HOST.test(domain.toLowerCase()))) {
    fail('"domain" must be a domain like example.com, or host-only');
  }
  return {
    ...paramSettings(config['params']),
    maxAgeDays: age,
    domain,
    httpOnly: flag(config['httpOnly'], 'httpOnly', false),
    hosts: hostSettings(config['hosts'])
  };
}

/**
 * Why consent doesn't allow click IDs to be stored, or undefined if it does. Beyond the SharedID's own storage
 * decision: a `us_privacy` opt-out of sale (the parameter, else the `usprivacy` cookie), and, when there's a TC string
 * or GDPR applies, publisher consent for Purposes 1 and 7.
 */
export function clickIdDenial(storage: StorageDecision, consent: ConsentContext, cookies: ReadonlyMap<string, string>): string | undefined {
  if (!storage.allowed) return storage.reason;
  const usPrivacy = consent.usPrivacy ?? cookies.get(US_PRIVACY_COOKIE);
  if (usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  if (consent.tcString !== undefined || consent.gdprApplies === true) {
    const publisher = consent.tcf?.publisherPurposeConsents;
    if (publisher === undefined || CLICKID_PURPOSES.some(p => !publisher.has(p))) return 'tcf';
  }
  return undefined;
}

/** `candidate` as an http(s) URL on the request's own host or one of `hosts`, else undefined. */
function allowedUrl(candidate: string | null, url: URL, hosts: readonly string[]): URL | undefined {
  if (candidate === null || candidate === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.toLowerCase();
  return host === url.hostname.toLowerCase() || hosts.includes(host) ? parsed : undefined;
}

/**
 * The landing page's URL: the `url` query parameter when it's present, else the `Referer` header. Undefined when
 * neither is an http(s) URL on the request's own host or one of `hosts`, and when the request comes from another site
 * (`Sec-Fetch-Site: cross-site`, or a `Referer` that isn't on those hosts): a `url` naming one of them proves nothing
 * about where the request came from, so a link from another site can't plant a click ID through it.
 */
export function landingUrl(request: Request, url: URL, hosts: readonly string[]): URL | undefined {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return undefined;
  const referer = request.headers.get('Referer');
  const fromReferer = allowedUrl(referer, url, hosts);
  if (referer !== null && referer !== '' && fromReferer === undefined) return undefined;
  const param = url.searchParams.get('url');
  return param !== null && param !== '' ? allowedUrl(param, url, hosts) : fromReferer;
}

/**
 * The click ID for `name` in the landing URL: its first value, after the one round of decoding `URLSearchParams`
 * does, when it matches `CLICK_ID_PATTERN`; otherwise undefined. A value that doesn't match is ignored, never fixed.
 */
export function clickIdFrom(landing: URL, name: string): string | undefined {
  const value = landing.searchParams.get(name);
  return value !== null && CLICK_ID_PATTERN.test(value) ? value : undefined;
}

/** The ID part of a stored `<seconds>.<id>` value, or undefined when the value isn't one. */
export function storedClickId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : STORED.exec(value)?.[1];
}

function clickCookie(settings: ClickIdModuleConfig, name: string, value: string, maxAgeSeconds: number): ModuleCookie {
  const { domain } = settings;
  const where = domain === undefined ? {} : domain === HOST_ONLY ? { hostOnly: true } : { domain: `.${domain.toLowerCase()}` };
  return { name, value, maxAgeSeconds, httpOnly: settings.httpOnly, ...where };
}

function run({ request, url, consent, cookies, storage, config }: ModuleContext): ModuleResult {
  const settings = clickIdModuleConfig(config);
  // Every sync must reach the worker: a browser reuses a cached sync for any page, so a later landing would be missed.
  if (clickIdDenial(storage, consent, cookies) !== undefined) {
    // Not allowed: nothing is stored, and click IDs the browser has are deleted.
    const deleted = settings.cookies.filter(name => cookies.has(name)).map(name => clickCookie(settings, name, '', 0));
    return deleted.length === 0 ? { noStore: true } : { cookies: deleted, noStore: true };
  }
  const landing = landingUrl(request, url, settings.hosts);
  if (landing === undefined) return { noStore: true };
  const seconds = Math.floor(Date.now() / 1000);
  const set: ModuleCookie[] = [];
  for (const param of settings.params) {
    const id = clickIdFrom(landing, param.name);
    // The lifetime counts from the click: the same click seen again (a reload, a later visit to the same URL) isn't
    // refreshed; a different one replaces it.
    if (id === undefined || storedClickId(cookies.get(param.cookie)) === id) continue;
    set.push(clickCookie(settings, param.cookie, `${String(seconds)}.${id}`, settings.maxAgeDays * 86_400));
  }
  return set.length === 0 ? { noStore: true } : { cookies: set, noStore: true };
}

/**
 * The `clickid` module. Off until listed in `SID_MODULES`. It sets cookies only, so its status is `empty`; on
 * `/sync` it keeps the response out of the browser's cache (`noStore`).
 */
export const clickIdModule: EdgeModule = defineModule({
  name: 'clickid',
  // Purposes 1 and 7 are checked in run() rather than declared: core skips a module whose purposes lack consent before
  // it runs, and this one must run to delete the click IDs it stored.
  routes: ['v1', 'sync'],
  run,
  optOutCookies: config => {
    const settings = clickIdModuleConfig(config);
    return settings.cookies.map(name => clickCookie(settings, name, '', 0));
  }
});
