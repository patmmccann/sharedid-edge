import { BOT_KINDS, type BotKind } from './traffic.js';

/** The resolved configuration. See {@link resolveConfig} for the environment variables. */
export interface SharedIdEdgeConfig {
  /** Path prefix the worker answers under, e.g. `/_sid`. Never ends with `/`. */
  readonly basePath: string;
  /** The SharedID cookie name; must match `storage.name` in Prebid.js. */
  readonly cookieName: string;
  /** `Domain` attribute for the cookies, or undefined for a host-only cookie. */
  readonly cookieDomain: string | undefined;
  /** Cookie lifetime in days, at most 400. */
  readonly maxAgeDays: number;
  /** Mint a new ID when the request has none. */
  readonly create: boolean;
  /** Name of the `HttpOnly` recovery copy of the ID, or undefined to not set one. */
  readonly recoveryCookieName: string | undefined;
  /** The opt-out cookie Prebid.js also checks. */
  readonly optOutCookieName: string;
  /**
   * The publisher's own TCF Global Vendor List ID, for vendor mode: storage then needs consent for this vendor and
   * vendor consent for the purposes. Undefined for publisher mode, which checks the publisher TC segment.
   */
  readonly vendorId: number | undefined;
  /** Origins allowed to read the JSON endpoint with credentials. */
  readonly allowedOrigins: readonly string[];
  /** `Cache-Control: private, max-age` for a successful sync response, in seconds; limits how often a browser re-syncs. */
  readonly syncCacheSeconds: number;
  /** Names of the modules to run for the JSON endpoint, in order. */
  readonly modules: readonly string[];
  /** Per-module configuration, keyed by module name. */
  readonly moduleConfig: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Per-module secrets (strings), keyed by module name; from a platform secret. Never logged or returned. */
  readonly moduleSecrets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Time limit for each module, in milliseconds. */
  readonly moduleTimeoutMs: number;
  /**
   * Set no SharedID for bots this sure or surer (`verified`, `declared` or `likely`), from the merged traffic signal;
   * undefined to never skip. Existing IDs are never deleted.
   */
  readonly skipBots: BotKind | undefined;
  /** Set no SharedID when the traffic signal's score is at or below this (1 to 99); undefined to never skip. */
  readonly skipBotsScore: number | undefined;
}

export const MAX_COOKIE_AGE_DAYS = 400;

export const DEFAULT_CONFIG: SharedIdEdgeConfig = Object.freeze({
  basePath: '/_sid',
  cookieName: '_pubcid',
  cookieDomain: undefined,
  maxAgeDays: 365,
  create: true,
  recoveryCookieName: '_pubcid_sv',
  optOutCookieName: '_pubcid_optout',
  vendorId: undefined,
  allowedOrigins: Object.freeze([]),
  syncCacheSeconds: 86_400,
  modules: Object.freeze([]),
  moduleConfig: Object.freeze({}),
  moduleSecrets: Object.freeze({}),
  moduleTimeoutMs: 50,
  skipBots: undefined,
  skipBotsScore: undefined
});

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** A cookie name or value token, per RFC 6265. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DOMAIN = /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const BASE_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

type Env = Readonly<Record<string, unknown>>;

function str(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const value = str(env, key);
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${key} must be true or false, not "${value}"`);
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = str(env, key);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be a whole number from ${String(min)} to ${String(max)}, not "${value}"`);
  }
  return n;
}

function cookieName(env: Env, key: string, fallback: string | undefined): string | undefined {
  const value = str(env, key);
  if (value === undefined) return fallback;
  if (!COOKIE_NAME.test(value)) throw new ConfigError(`${key} is not a valid cookie name: "${value}"`);
  return value;
}

function list(env: Env, key: string): string[] {
  const value = str(env, key);
  return value === undefined ? [] : value.split(',').map(s => s.trim()).filter(s => s !== '');
}

/**
 * Resolve configuration from environment variables (strings, as platforms provide them):
 *
 * | Variable | Default | |
 * | --- | --- | --- |
 * | `SID_BASE_PATH` | `/_sid` | path prefix |
 * | `SID_COOKIE_NAME` | `_pubcid` | |
 * | `SID_COOKIE_DOMAIN` | (host-only) | e.g. `.example.com` |
 * | `SID_MAX_AGE_DAYS` | `365` | at most 400 |
 * | `SID_CREATE` | `true` | mint an ID when the request has none |
 * | `SID_RECOVERY_COOKIE` | `_pubcid_sv` | `none` to disable |
 * | `SID_OPTOUT_COOKIE` | `_pubcid_optout` | |
 * | `SID_VENDOR_ID` | (publisher mode) | TCF vendor ID, for vendor mode |
 * | `SID_ALLOWED_ORIGINS` | (none) | comma-separated |
 * | `SID_SYNC_CACHE_SECONDS` | `86400` | |
 * | `SID_MODULES` | (none) | comma-separated module names |
 * | `SID_MODULE_CONFIG` | `{}` | JSON object keyed by module name |
 * | `SID_MODULE_SECRETS` | `{}` | JSON object of string secrets keyed by module name; set as a platform secret |
 * | `SID_MODULE_TIMEOUT_MS` | `50` | |
 * | `SID_SKIP_BOTS` | (off) | `verified`, `declared` or `likely`: no SharedID for bots this sure or surer |
 * | `SID_SKIP_BOTS_SCORE` | (off) | 1 to 99: no SharedID when the traffic score is at or below it |
 *
 * @throws ConfigError when a value is invalid, so a misconfigured deployment fails loudly instead of setting bad cookies.
 */
export function resolveConfig(env: Env): SharedIdEdgeConfig {
  const basePath = str(env, 'SID_BASE_PATH') ?? DEFAULT_CONFIG.basePath;
  if (!BASE_PATH.test(basePath) || basePath.includes('//')) {
    throw new ConfigError(`SID_BASE_PATH must be a path like /_sid, not "${basePath}"`);
  }

  const cookieDomain = str(env, 'SID_COOKIE_DOMAIN');
  if (cookieDomain !== undefined && !DOMAIN.test(cookieDomain)) {
    throw new ConfigError(`SID_COOKIE_DOMAIN is not a valid domain: "${cookieDomain}"`);
  }

  const recovery = str(env, 'SID_RECOVERY_COOKIE');
  const recoveryCookieName = recovery === 'none' ? undefined : cookieName(env, 'SID_RECOVERY_COOKIE', DEFAULT_CONFIG.recoveryCookieName);

  const allowedOrigins = list(env, 'SID_ALLOWED_ORIGINS');
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`SID_ALLOWED_ORIGINS has an invalid origin: "${origin}"`);
    }
    if (parsed.origin !== origin) throw new ConfigError(`SID_ALLOWED_ORIGINS entries must be bare origins like https://example.com, not "${origin}"`);
  }

  const moduleConfigText = str(env, 'SID_MODULE_CONFIG');
  let moduleConfig: Record<string, Readonly<Record<string, unknown>>> = {};
  if (moduleConfigText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(moduleConfigText);
    } catch {
      throw new ConfigError('SID_MODULE_CONFIG must be a JSON object');
    }
    if (!isRecord(parsed) || !Object.values(parsed).every(isRecord)) {
      throw new ConfigError('SID_MODULE_CONFIG must be a JSON object of objects, keyed by module name');
    }
    moduleConfig = parsed as Record<string, Readonly<Record<string, unknown>>>;
  }

  const moduleSecretsText = str(env, 'SID_MODULE_SECRETS');
  let moduleSecrets: Record<string, Readonly<Record<string, string>>> = {};
  if (moduleSecretsText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(moduleSecretsText);
    } catch {
      // Don't echo the value: it's a secret.
      throw new ConfigError('SID_MODULE_SECRETS must be a JSON object');
    }
    if (!isRecord(parsed) || !Object.values(parsed).every(v => isRecord(v) && Object.values(v).every(s => typeof s === 'string'))) {
      throw new ConfigError('SID_MODULE_SECRETS must be a JSON object of objects of strings, keyed by module name');
    }
    moduleSecrets = parsed as Record<string, Readonly<Record<string, string>>>;
  }

  const skipBotsText = str(env, 'SID_SKIP_BOTS')?.toLowerCase();
  const skipBots = BOT_KINDS.find(kind => kind === skipBotsText);
  if (skipBotsText !== undefined && skipBots === undefined) {
    throw new ConfigError(`SID_SKIP_BOTS must be verified, declared or likely, not "${skipBotsText}"`);
  }

  const cookie = cookieName(env, 'SID_COOKIE_NAME', DEFAULT_CONFIG.cookieName) ?? DEFAULT_CONFIG.cookieName;
  const optOut = cookieName(env, 'SID_OPTOUT_COOKIE', DEFAULT_CONFIG.optOutCookieName) ?? DEFAULT_CONFIG.optOutCookieName;
  if (recoveryCookieName === cookie || optOut === cookie) {
    throw new ConfigError('SID_RECOVERY_COOKIE and SID_OPTOUT_COOKIE must differ from SID_COOKIE_NAME');
  }
  if (recoveryCookieName === optOut) {
    // The recovery copy would be read as an opt-out, and /optout would expire its own cookie.
    throw new ConfigError('SID_RECOVERY_COOKIE must differ from SID_OPTOUT_COOKIE');
  }

  return Object.freeze({
    basePath: trimTrailingSlashes(basePath),
    cookieName: cookie,
    cookieDomain,
    maxAgeDays: int(env, 'SID_MAX_AGE_DAYS', DEFAULT_CONFIG.maxAgeDays, 1, MAX_COOKIE_AGE_DAYS),
    create: bool(env, 'SID_CREATE', DEFAULT_CONFIG.create),
    recoveryCookieName,
    optOutCookieName: optOut,
    vendorId: str(env, 'SID_VENDOR_ID') === undefined ? undefined : int(env, 'SID_VENDOR_ID', 0, 1, 65_535),
    allowedOrigins: Object.freeze(allowedOrigins),
    syncCacheSeconds: int(env, 'SID_SYNC_CACHE_SECONDS', DEFAULT_CONFIG.syncCacheSeconds, 0, 31_536_000),
    modules: Object.freeze(list(env, 'SID_MODULES')),
    moduleConfig: Object.freeze(moduleConfig),
    moduleSecrets: Object.freeze(moduleSecrets),
    moduleTimeoutMs: int(env, 'SID_MODULE_TIMEOUT_MS', DEFAULT_CONFIG.moduleTimeoutMs, 1, 10_000),
    skipBots,
    skipBotsScore: str(env, 'SID_SKIP_BOTS_SCORE') === undefined ? undefined : int(env, 'SID_SKIP_BOTS_SCORE', 0, 1, 99)
  });
}

function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
