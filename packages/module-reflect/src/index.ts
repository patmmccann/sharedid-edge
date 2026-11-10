import { defineModule, TCF_COOKIE, type EdgeModule, type ModuleContext, type ModuleCookie, type ModuleResult } from '@sharedid-edge/core';

/**
 * The `reflect` module re-sets first-party cookies that other scripts on the page wrote with `document.cookie` (such as
 * an ID vendor's `uid1`). Browsers that cap script-written cookies, like Safari at 7 days, don't cap them the same way
 * once they're set by the server, so the same value comes back in `Set-Cookie` with a new lifetime. It's what the
 * worker does for the SharedID, for cookies the publisher names.
 */

/** At most this many cookies can be configured. */
export const MAX_REFLECTED_COOKIES = 10;
/** Values longer than this aren't reflected. */
export const MAX_REFLECTED_VALUE_LENGTH = 1024;
/** Lifetimes are 1 to 400 days; Chrome caps cookies at 400. */
export const MAX_REFLECT_AGE_DAYS = 400;
/**
 * Cookies that can't be configured: the SharedID cookies at their default names (the worker refuses its configured
 * names too), `ts-ec` (the `ec` module's, which isn't refreshed by design) and the CMP's TC string (consent records
 * have their own lifetime).
 */
export const RESERVED_COOKIE_NAMES: readonly string[] = Object.freeze(['_pubcid', '_pubcid_sv', '_pubcid_optout', 'ts-ec', TCF_COOKIE]);

/** One cookie to reflect, from `SID_MODULE_CONFIG.reflect.cookies`. */
export interface ReflectedCookie {
  readonly name: string;
  readonly maxAgeDays: number;
  /** Registrable domain without a leading dot; the cookie gets `Domain=.{domain}`. */
  readonly domain: string | undefined;
  readonly httpOnly: boolean;
  /** Whether `{basePath}/optout` deletes it. */
  readonly deleteOnOptOut: boolean;
}

/** Settings from `SID_MODULE_CONFIG.reflect`. */
export interface ReflectModuleConfig {
  readonly cookies: readonly ReflectedCookie[];
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
/** RFC 6265 cookie-octets: no control characters, whitespace, `"`, `,`, `;` or `\`. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ENTRY_KEYS: ReadonlySet<string> = new Set(['name', 'maxAgeDays', 'domain', 'httpOnly', 'deleteOnOptOut']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoolean(entry: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = entry[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`reflect: "${key}" must be true or false`);
  return value;
}

function reflectedCookie(entry: unknown): ReflectedCookie {
  if (!isRecord(entry)) throw new TypeError('reflect: each entry in "cookies" must be an object');
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) throw new TypeError('reflect: unknown key in a "cookies" entry');
  }
  const { name, maxAgeDays, domain } = entry;
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) throw new TypeError('reflect: "name" must be a cookie name');
  if (RESERVED_COOKIE_NAMES.includes(name)) throw new TypeError('reflect: "name" is a cookie that can\'t be reflected');
  if (typeof maxAgeDays !== 'number' || !Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MAX_REFLECT_AGE_DAYS) {
    throw new TypeError('reflect: "maxAgeDays" must be a whole number from 1 to 400');
  }
  if (domain !== undefined && (typeof domain !== 'string' || !DOMAIN.test(domain))) {
    throw new TypeError('reflect: "domain" must be a domain like example.com');
  }
  return { name, maxAgeDays, domain, httpOnly: optionalBoolean(entry, 'httpOnly'), deleteOnOptOut: optionalBoolean(entry, 'deleteOnOptOut') };
}

/** Parses and validates the settings; throws a `TypeError` (an `error` status) on anything unexpected. */
export function reflectModuleConfig(config: Readonly<Record<string, unknown>>): ReflectModuleConfig {
  for (const key of Object.keys(config)) {
    if (key !== 'cookies') throw new TypeError('reflect: unknown setting');
  }
  const entries = config['cookies'];
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_REFLECTED_COOKIES) {
    throw new TypeError('reflect: "cookies" must list 1 to 10 cookies');
  }
  const cookies = entries.map(reflectedCookie);
  if (new Set(cookies.map(c => c.name)).size !== cookies.length) throw new TypeError('reflect: a cookie is listed twice');
  return { cookies };
}

/**
 * A cookie's value exactly as the `Cookie` header carries it, or undefined. Unlike `ModuleContext.cookies`, quotes
 * aren't removed, so a quoted value can be recognized and left alone. The first value wins when a name repeats, as in
 * core's `parseCookies`.
 */
export function rawCookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether a value can be set again unchanged: non-empty, at most 1024 characters, and only cookie-octets. */
export function isReflectable(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_REFLECTED_VALUE_LENGTH && COOKIE_VALUE.test(value);
}

function moduleCookie(cookie: ReflectedCookie, value: string, maxAgeSeconds: number): ModuleCookie {
  return { name: cookie.name, value, maxAgeSeconds, httpOnly: cookie.httpOnly, ...(cookie.domain === undefined ? {} : { domain: `.${cookie.domain}` }) };
}

function run({ request, storage, config }: ModuleContext): ModuleResult | undefined {
  const settings = reflectModuleConfig(config);
  // Reflecting extends storage of an identifier, so it follows the SharedID's storage decision. When storage isn't
  // allowed nothing is deleted either: these cookies belong to other scripts.
  if (!storage.allowed) return undefined;
  const header = request.headers.get('Cookie');
  const cookies: ModuleCookie[] = [];
  for (const cookie of settings.cookies) {
    const value = rawCookieValue(header, cookie.name);
    if (isReflectable(value)) cookies.push(moduleCookie(cookie, value, cookie.maxAgeDays * 86_400));
  }
  return cookies.length === 0 ? undefined : { cookies };
}

/**
 * The `reflect` module. Off until listed in `SID_MODULES`; configured with `SID_MODULE_CONFIG.reflect.cookies`. It sets
 * cookies only, so its status is `empty`.
 */
export const reflectModule: EdgeModule = defineModule({
  name: 'reflect',
  run,
  // Only cookies the publisher marked: by default, opting out of the SharedID leaves other parties' cookies alone.
  optOutCookies: config => reflectModuleConfig(config).cookies.filter(c => c.deleteOnOptOut).map(c => moduleCookie(c, '', 0))
});
