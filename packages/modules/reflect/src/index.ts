import { defineModule, TCF_COOKIE, type EdgeModule, type ModuleContext, type ModuleCookie, type ModuleResult } from '@sharedid-edge/core';

/**
 * The `reflect` module re-sets first-party cookies that other scripts on the page wrote with `document.cookie` (such as
 * an ID vendor's `uid1`). Browsers that cap script-written cookies, like Safari at 7 days, don't cap them the same way
 * once they're set by the server, so the same value comes back in `Set-Cookie` with a new lifetime. It's what the
 * worker does for the SharedID, for cookies the publisher names.
 *
 * Cookies marked `restore` are also saved in one `HttpOnly` keeper cookie, and set again from it when the browser has
 * deleted them, the way the SharedID's `HttpOnly` recovery copy restores `_pubcid`.
 */

/** At most this many cookies can be configured. */
export const MAX_REFLECTED_COOKIES = 10;
/** Values longer than this aren't reflected. */
export const MAX_REFLECTED_VALUE_LENGTH = 1024;
/** Lifetimes are 1 to 400 days; Chrome caps cookies at 400. */
export const MAX_REFLECT_AGE_DAYS = 400;
/** The keeper cookie's default name. */
export const DEFAULT_KEEPER_COOKIE = '_sid_keep';
/** The keeper cookie's default lifetime in days. */
export const DEFAULT_KEEPER_AGE_DAYS = 400;
/** Browsers keep a cookie only if its name and value together are at most this many bytes; the keeper stays within it. */
export const MAX_KEEPER_COOKIE_BYTES = 4096;
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
  /** Whether it's saved in the keeper cookie and set again from it when the browser has deleted it. */
  readonly restore: boolean;
  /** Which value wins when the browser sends the cookie and the keeper has one too; always `browser` without `restore`. */
  readonly prefer: KeeperPreference;
  /** The value's format, for `prefer: 'older'`; undefined otherwise. */
  readonly format: TimestampFormat | undefined;
}

/**
 * Which value wins when the request carries a `restore` cookie and the keeper also has a value for it: the browser's
 * (the default), the keeper's, or whichever was created first (for values that carry their creation time).
 */
export type KeeperPreference = 'browser' | 'backup' | 'older';
/** Value formats that carry a creation time: Google's `_ga`, `_gcl_au` and `_gcl_aw`. */
export type TimestampFormat = 'ga' | 'gcl_au' | 'gcl_aw';

/** The keeper cookie, from `SID_MODULE_CONFIG.reflect.keeper`, with defaults applied. */
export interface KeeperSettings {
  readonly cookie: string;
  readonly maxAgeDays: number;
  /** `keeper.domain`, else the first `restore` cookie's `domain`; undefined means `SID_COOKIE_DOMAIN`, else host-only. */
  readonly domain: string | undefined;
}

/** Settings from `SID_MODULE_CONFIG.reflect`. */
export interface ReflectModuleConfig {
  readonly cookies: readonly ReflectedCookie[];
  readonly keeper: KeeperSettings;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
/** RFC 6265 cookie-octets: no control characters, whitespace, `"`, `,`, `;` or `\`. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ENTRY_KEYS: ReadonlySet<string> = new Set(['name', 'maxAgeDays', 'domain', 'httpOnly', 'deleteOnOptOut', 'restore', 'prefer', 'format']);
const PREFERENCES: readonly KeeperPreference[] = ['browser', 'backup', 'older'];
const FORMATS: readonly TimestampFormat[] = ['ga', 'gcl_au', 'gcl_aw'];
/** The format `prefer: 'older'` assumes from a cookie's exact name when `format` isn't set. */
const FORMAT_BY_NAME: ReadonlyMap<string, TimestampFormat> = new Map([['_ga', 'ga'], ['_gcl_au', 'gcl_au'], ['_gcl_aw', 'gcl_aw']]);
/**
 * Each format's pattern; the capture is the creation time, exactly 10 digits of Unix seconds (2001 to 2286), so a
 * negative, short or overlong time doesn't parse. `GA1.<d>` and `1.<d>` carry the cookie domain's depth (`GA1.1`,
 * `GA1.2`); a path depth suffix (`GA1.2-2`) doesn't parse, since this module only sets `Path=/`.
 */
const TIMESTAMP_PATTERNS: Readonly<Record<TimestampFormat, RegExp>> = {
  ga: /^GA1\.[1-9][0-9]?\.[0-9]{1,20}\.([0-9]{10})$/,
  gcl_au: /^1\.[1-9][0-9]?\.[0-9]{1,20}\.([0-9]{10})$/,
  gcl_aw: /^GCL\.([0-9]{10})\.[A-Za-z0-9_-]+$/
};
/** Creation times more than this after the worker's clock (a day, for clock skew) don't parse. */
const MAX_TIMESTAMP_SKEW_SECONDS = 86_400;
const KEEPER_KEYS: ReadonlySet<string> = new Set(['cookie', 'maxAgeDays', 'domain']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoolean(entry: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = entry[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`reflect: "${key}" must be true or false`);
  return value;
}

function ageDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_REFLECT_AGE_DAYS) {
    throw new TypeError('reflect: "maxAgeDays" must be a whole number from 1 to 400');
  }
  return value;
}

function optionalDomain(value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !DOMAIN.test(value))) {
    throw new TypeError('reflect: "domain" must be a domain like example.com');
  }
  return value;
}

function cookieName(value: unknown, key: string): string {
  if (typeof value !== 'string' || !COOKIE_NAME.test(value)) throw new TypeError(`reflect: "${key}" must be a cookie name`);
  if (RESERVED_COOKIE_NAMES.includes(value)) throw new TypeError(`reflect: "${key}" is a cookie the worker reserves`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  const match = allowed.find(a => a === value);
  if (match === undefined) throw new TypeError(`reflect: "${key}" must be one of ${allowed.join(', ')}`);
  return match;
}

function reflectedCookie(entry: unknown): ReflectedCookie {
  if (!isRecord(entry)) throw new TypeError('reflect: each entry in "cookies" must be an object');
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) throw new TypeError('reflect: unknown key in a "cookies" entry');
  }
  const name = cookieName(entry['name'], 'name');
  const restore = optionalBoolean(entry, 'restore');
  const prefer = entry['prefer'] === undefined ? 'browser' : oneOf(entry['prefer'], PREFERENCES, 'prefer');
  // Without the keeper there's no backup to prefer.
  if (prefer !== 'browser' && !restore) throw new TypeError('reflect: "prefer" needs "restore": true');
  let format: TimestampFormat | undefined;
  if (entry['format'] !== undefined) {
    if (prefer !== 'older') throw new TypeError('reflect: "format" applies only to "prefer": "older"');
    format = oneOf(entry['format'], FORMATS, 'format');
  } else if (prefer === 'older') {
    format = FORMAT_BY_NAME.get(name);
    if (format === undefined) throw new TypeError('reflect: "prefer": "older" needs "format" for this cookie name');
  }
  return {
    name,
    maxAgeDays: ageDays(entry['maxAgeDays']),
    domain: optionalDomain(entry['domain']),
    httpOnly: optionalBoolean(entry, 'httpOnly'),
    deleteOnOptOut: optionalBoolean(entry, 'deleteOnOptOut'),
    restore,
    prefer,
    format
  };
}

function keeperSettings(value: unknown, cookies: readonly ReflectedCookie[]): KeeperSettings {
  if (value !== undefined && !isRecord(value)) throw new TypeError('reflect: "keeper" must be an object');
  const keeper = value ?? {};
  for (const key of Object.keys(keeper)) {
    if (!KEEPER_KEYS.has(key)) throw new TypeError('reflect: unknown key in "keeper"');
  }
  const cookie = keeper['cookie'] === undefined ? DEFAULT_KEEPER_COOKIE : cookieName(keeper['cookie'], 'keeper.cookie');
  if (cookies.some(c => c.name === cookie)) throw new TypeError('reflect: "keeper.cookie" is also listed in "cookies"');
  const maxAgeDays = keeper['maxAgeDays'] === undefined ? DEFAULT_KEEPER_AGE_DAYS : ageDays(keeper['maxAgeDays']);
  // The keeper covers the same hosts as the cookies it restores unless told otherwise.
  const domain = optionalDomain(keeper['domain']) ?? cookies.find(c => c.restore)?.domain;
  return { cookie, maxAgeDays, domain };
}

/** Parses and validates the settings; throws a `TypeError` (an `error` status) on anything unexpected. */
export function reflectModuleConfig(config: Readonly<Record<string, unknown>>): ReflectModuleConfig {
  for (const key of Object.keys(config)) {
    if (key !== 'cookies' && key !== 'keeper') throw new TypeError('reflect: unknown setting');
  }
  const entries = config['cookies'];
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_REFLECTED_COOKIES) {
    throw new TypeError('reflect: "cookies" must list 1 to 10 cookies');
  }
  const cookies = entries.map(reflectedCookie);
  if (new Set(cookies.map(c => c.name)).size !== cookies.length) throw new TypeError('reflect: a cookie is listed twice');
  return { cookies, keeper: keeperSettings(config['keeper'], cookies) };
}

/**
 * A cookie's value exactly as the `Cookie` header carries it, or undefined. Unlike `ModuleContext.cookies`, quotes
 * aren't removed, so a quoted value can be recognized and left alone. The first value wins when a name repeats, as in
 * core's `parseCookies`. Only HTTP whitespace (space and tab) around the pair is removed, not `trim()`'s wider set: a
 * value with a leading non-breaking space stays as it is, so `isReflectable` rejects it instead of reflecting it
 * changed.
 */
export function rawCookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && trimHttpWhitespace(part.slice(0, eq)) === name) return trimHttpWhitespace(part.slice(eq + 1));
  }
  return undefined;
}

/**
 * `text` without leading or trailing HTTP whitespace (space and tab). A loop rather than `/^[ \t]+|[ \t]+$/`, which
 * backtracks polynomially on a long run of whitespace in a hostile Cookie header.
 */
function trimHttpWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end--;
  return text.slice(start, end);
}

/** Whether a value can be set again unchanged: non-empty, at most 1024 characters, and only cookie-octets. */
export function isReflectable(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_REFLECTED_VALUE_LENGTH && COOKIE_VALUE.test(value);
}

/**
 * The creation time, in Unix seconds, that a value in `format` carries; undefined when the value doesn't match the
 * format exactly, or the time is more than a day after `nowSeconds`. Never throws, and never changes the value.
 */
export function cookieTimestamp(format: TimestampFormat, value: string, nowSeconds: number): number | undefined {
  const digits = TIMESTAMP_PATTERNS[format].exec(value)?.[1];
  if (digits === undefined) return undefined;
  const seconds = Number(digits);
  return seconds > nowSeconds + MAX_TIMESTAMP_SKEW_SECONDS ? undefined : seconds;
}

/** Whether the keeper's saved value wins over the value the browser sent, under the cookie's `prefer`. */
function backupWins(cookie: ReflectedCookie, value: string, stored: string, nowSeconds: number): boolean {
  switch (cookie.prefer) {
    case 'browser':
      return false;
    case 'backup':
      return true;
    case 'older': {
      if (cookie.format === undefined) return false;
      const current = cookieTimestamp(cookie.format, value, nowSeconds);
      const kept = cookieTimestamp(cookie.format, stored, nowSeconds);
      // On a tie, or when either doesn't parse, the browser's value wins, as with `browser`.
      return current !== undefined && kept !== undefined && kept < current;
    }
  }
}

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encodes saved values as the keeper cookie's value: base64url (no padding) of a JSON object `{ name: value }`, in the
 * order given. Entries are added in order while the result stays within `maxLength`; one that doesn't fit is skipped
 * and the next is tried. Returns `''` when nothing fits or there's nothing to save. Names and values must already be
 * valid (cookie names and reflectable values), so the JSON is ASCII.
 */
export function encodeKeeper(entries: Iterable<readonly [string, string]>, maxLength: number): string {
  const saved: Record<string, string> = {};
  let encoded = '';
  for (const [name, value] of entries) {
    const next = base64url(JSON.stringify({ ...saved, [name]: value }));
    if (next.length > maxLength) continue;
    saved[name] = value;
    encoded = next;
  }
  return encoded;
}

/**
 * Decodes a keeper cookie's value. Anything malformed (not base64url, not JSON, not an object, over the size limit)
 * gives an empty map, never an error; entries whose value isn't a reflectable string are dropped.
 */
export function decodeKeeper(raw: string | undefined): Map<string, string> {
  const saved = new Map<string, string>();
  if (raw === undefined || raw.length > MAX_KEEPER_COOKIE_BYTES || !BASE64URL.test(raw)) return saved;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return saved;
  }
  if (!isRecord(parsed)) return saved;
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && isReflectable(value)) saved.set(name, value);
  }
  return saved;
}

function moduleCookie(cookie: ReflectedCookie, value: string, maxAgeSeconds: number): ModuleCookie {
  return { name: cookie.name, value, maxAgeSeconds, httpOnly: cookie.httpOnly, ...(cookie.domain === undefined ? {} : { domain: `.${cookie.domain}` }) };
}

function keeperCookie(keeper: KeeperSettings, value: string, maxAgeSeconds: number): ModuleCookie {
  return { name: keeper.cookie, value, maxAgeSeconds, httpOnly: true, ...(keeper.domain === undefined ? {} : { domain: `.${keeper.domain}` }) };
}

function run({ request, storage, config }: ModuleContext): ModuleResult | undefined {
  const { cookies: configured, keeper } = reflectModuleConfig(config);
  const header = request.headers.get('Cookie');
  const kept = rawCookieValue(header, keeper.cookie);
  // Reflecting and restoring extend storage of identifiers, so they follow the SharedID's storage decision. When
  // storage isn't allowed, the keeper (this worker's own store) is deleted, like the SharedID cookies; the original
  // cookies are left alone, since they belong to other scripts.
  if (!storage.allowed) return kept === undefined ? undefined : { cookies: [keeperCookie(keeper, '', 0)] };

  const restoring = configured.some(c => c.restore);
  const saved = restoring ? decodeKeeper(kept) : new Map<string, string>();
  const cookies: ModuleCookie[] = [];
  const save: [string, string][] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const cookie of configured) {
    const value = rawCookieValue(header, cookie.name);
    const stored = cookie.restore ? saved.get(cookie.name) : undefined;
    if (stored !== undefined && (value === undefined || backupWins(cookie, value, stored, nowSeconds))) {
      // Missing (Safari deleted or expired it), or present but `prefer` picks the backup (the page re-minted it):
      // restored from the keeper byte for byte, and kept there.
      cookies.push(moduleCookie(cookie, stored, cookie.maxAgeDays * 86_400));
      save.push([cookie.name, stored]);
    } else if (isReflectable(value)) {
      cookies.push(moduleCookie(cookie, value, cookie.maxAgeDays * 86_400));
      if (cookie.restore) save.push([cookie.name, value]);
    }
    // Present but not reflectable: left alone, and its saved value is dropped so an outdated one is never restored.
  }
  // Rewritten on every call, so its expiry is refreshed with the cookies it keeps. With nothing to keep, a keeper the
  // browser sent is deleted.
  const encoded = restoring ? encodeKeeper(save, MAX_KEEPER_COOKIE_BYTES - keeper.cookie.length) : '';
  if (encoded !== '') cookies.push(keeperCookie(keeper, encoded, keeper.maxAgeDays * 86_400));
  else if (kept !== undefined) cookies.push(keeperCookie(keeper, '', 0));
  return cookies.length === 0 ? undefined : { cookies };
}

/**
 * The `reflect` module. Off until listed in `SID_MODULES`; configured with `SID_MODULE_CONFIG.reflect.cookies`. It sets
 * cookies only, so its status is `empty`.
 */
export const reflectModule: EdgeModule = defineModule({
  name: 'reflect',
  // Also on /sync, so Prebid.js's pixelUrl call refreshes and restores cookies on page views without a /v1 call.
  routes: ['v1', 'sync'],
  run,
  // Only cookies the publisher marked: by default, opting out of the SharedID leaves other parties' cookies alone. The
  // keeper is this worker's own, so it's always deleted (core deletes only cookies the browser sent).
  optOutCookies: config => {
    const { cookies, keeper } = reflectModuleConfig(config);
    return [...cookies.filter(c => c.deleteOnOptOut).map(c => moduleCookie(c, '', 0)), keeperCookie(keeper, '', 0)];
  }
});
