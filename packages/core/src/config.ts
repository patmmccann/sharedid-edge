import { BOT_KINDS, type BotKind } from './traffic.js';
import { trimEnd } from './text.js';

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
  /** Names of the modules to run, in order. */
  readonly modules: readonly string[];
  /**
   * Names of the modules to run on `/sync` (`SID_SYNC_MODULES`), each also in `modules`; they run in `modules` order.
   * Omitted means every module in `modules` whose `routes` include `sync`.
   */
  readonly syncModules?: readonly string[];
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

/** One `SID_*` setting {@link resolveConfig} reads, for documentation. */
export interface ConfigSetting {
  /** The environment variable, e.g. `SID_BASE_PATH`. */
  readonly name: string;
  /** The default, as Markdown, e.g. `` `/_sid` `` or `host-only`. */
  readonly default: string;
  /** What it does, as one line of Markdown. */
  readonly description: string;
}

/**
 * Every setting {@link resolveConfig} reads, in documentation order, with its default and description. The
 * configuration reference (`docs/configuration.md`) is generated from this list by `scripts/docs.mjs`, and a unit test
 * checks it names exactly the variables `resolveConfig` reads. It describes the settings; it doesn't drive parsing.
 *
 * A plain array literal rather than a frozen one, so bundlers drop it from workers that don't use it.
 */
export const SETTINGS: readonly ConfigSetting[] = [
  { name: 'SID_BASE_PATH', default: '`/_sid`', description: 'Path prefix the worker answers under. Must match your route.' },
  { name: 'SID_COOKIE_NAME', default: '`_pubcid`', description: 'The SharedID cookie; must match `storage.name` in Prebid.js.' },
  { name: 'SID_COOKIE_DOMAIN', default: '**required**', description: 'The domain Prebid.js writes the SharedID cookie on, which the worker\'s cookies must match: normally your registrable domain, `example.com` (Prebid.js picks the highest domain it can set a cookie on). `host-only` for cookies without a `Domain`, when Prebid.js writes them that way (a site served from an IP address, say). Unset, every request gets a 500.' },
  { name: 'SID_MAX_AGE_DAYS', default: '`365`', description: 'Cookie lifetime in days, 1 to 400 (browsers cap at 400).' },
  { name: 'SID_CREATE', default: '`true`', description: 'Mint an ID when the request has none. With Prebid.js it always sends one, so this rarely matters.' },
  { name: 'SID_RECOVERY_COOKIE', default: '`_pubcid_sv`', description: 'Name of the `HttpOnly` recovery copy; `none` to disable it.' },
  { name: 'SID_OPTOUT_COOKIE', default: '`_pubcid_optout`', description: 'The opt-out cookie; Prebid.js reads `_pubcid_optout`.' },
  { name: 'SID_VENDOR_ID', default: '(empty: publisher mode)', description: 'Your TCF vendor ID (1 to 65535), for vendor mode.' },
  { name: 'SID_ALLOWED_ORIGINS', default: 'none', description: 'Comma-separated origins (like `https://www.example.com`) allowed to read `/_sid/v1` from script on another origin.' },
  { name: 'SID_SYNC_CACHE_SECONDS', default: '`86400`', description: 'How long a browser may reuse a sync response (privately). `0` re-syncs on every call. Also limits how often modules run on `/_sid/sync`, except a sync the `clickid` module runs on, which is never cached.' },
  { name: 'SID_MODULES', default: 'none', description: 'Comma-separated modules to run, in order.' },
  { name: 'SID_SYNC_MODULES', default: 'the modules in `SID_MODULES` that run on `/_sid/sync`', description: 'Comma-separated modules to run on `/_sid/sync`, each also in `SID_MODULES`, or `none`.' },
  { name: 'SID_MODULE_CONFIG', default: '`{}`', description: 'JSON settings per module, keyed by module name.' },
  { name: 'SID_MODULE_SECRETS', default: '`{}`', description: 'JSON secrets (strings) per module, keyed by module name, e.g. the `ec` passphrase. Set it as a platform secret (`wrangler secret put SID_MODULE_SECRETS`), not in plain settings.' },
  { name: 'SID_MODULE_TIMEOUT_MS', default: '`50`', description: 'Time limit for each module, 1 to 10000.' },
  { name: 'SID_SKIP_BOTS', default: 'off', description: '`verified`, `declared` or `likely`: set no SharedID for bots this sure or surer, from the traffic signal. Existing IDs are never deleted.' },
  { name: 'SID_HOSTS', default: 'none (one site)', description: 'Several sites from one deployment: JSON from hostname to that site\x27s `SID_*` settings, which go on top of these, like `{"www.example.com":{"SID_COOKIE_DOMAIN":"example.com"}}`. A host that isn\x27t listed gets a 404 and no cookies. Not `SID_MODULE_SECRETS`. See [Several sites from one deployment](#several-sites-from-one-deployment).' },
  { name: 'SID_SKIP_BOTS_SCORE', default: 'off', description: '1 to 99: set no SharedID when the traffic score (Cloudflare Bot Management) is at or below it.' }
];

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

/** `SID_COOKIE_DOMAIN` value for cookies without a `Domain` attribute. */
const HOST_ONLY = 'host-only';

export interface ResolveConfigOptions {
  /**
   * Throw a `ConfigError` when `SID_COOKIE_DOMAIN` is unset. Adapters pass it for the deployment's configuration:
   * Prebid.js writes the SharedID cookie on the registrable domain, so a deployment has to say which domain (or
   * `host-only`) rather than default to host-only cookies that split the ID in two.
   */
  readonly requireCookieDomain?: boolean;
}

/**
 * Resolve configuration from environment variables (strings, as platforms provide them). The variables, with their
 * defaults and descriptions, are listed in {@link SETTINGS} (and, generated from it, in `docs/configuration.md`). An
 * empty value means the default.
 *
 * @throws ConfigError when a value is invalid, so a misconfigured deployment fails loudly instead of setting bad cookies.
 */
export function resolveConfig(env: Env, options: ResolveConfigOptions = {}): SharedIdEdgeConfig {
  const basePath = str(env, 'SID_BASE_PATH') ?? DEFAULT_CONFIG.basePath;
  if (!BASE_PATH.test(basePath) || basePath.includes('//')) {
    throw new ConfigError(`SID_BASE_PATH must be a path like /_sid, not "${basePath}"`);
  }

  const cookieDomainSetting = str(env, 'SID_COOKIE_DOMAIN');
  if (cookieDomainSetting === undefined && options.requireCookieDomain === true) {
    throw new ConfigError(
      'SID_COOKIE_DOMAIN is required: set it to the domain Prebid.js writes the SharedID cookie on, normally your registrable domain (example.com), or to host-only'
    );
  }
  const cookieDomain = cookieDomainSetting === HOST_ONLY ? undefined : cookieDomainSetting;
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

  const modules = list(env, 'SID_MODULES');
  let syncModules: string[] | undefined;
  if (str(env, 'SID_SYNC_MODULES') === 'none') {
    syncModules = [];
  } else if (str(env, 'SID_SYNC_MODULES') !== undefined) {
    syncModules = list(env, 'SID_SYNC_MODULES');
    for (const name of syncModules) {
      // Running a module on /sync that's off for /v1 would be surprising, and a typo would silently run nothing.
      if (!modules.includes(name)) throw new ConfigError(`SID_SYNC_MODULES lists "${name}", which isn't in SID_MODULES`);
    }
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
    modules: Object.freeze(modules),
    ...(syncModules === undefined ? {} : { syncModules: Object.freeze(syncModules) }),
    // Frozen all the way down: modules get these objects by reference for as long as the handler lives, which can
    // be many requests (an adapter's cached handler, a reused Fastly sandbox). A module that changed its config
    // would change it for every later request; frozen, the change throws and that module's run fails instead.
    moduleConfig: deepFreeze(moduleConfig),
    moduleSecrets: deepFreeze(moduleSecrets),
    moduleTimeoutMs: int(env, 'SID_MODULE_TIMEOUT_MS', DEFAULT_CONFIG.moduleTimeoutMs, 1, 10_000),
    skipBots,
    skipBotsScore: str(env, 'SID_SKIP_BOTS_SCORE') === undefined ? undefined : int(env, 'SID_SKIP_BOTS_SCORE', 0, 1, 99)
  });
}

/** Freezes parsed JSON, and every object and array in it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function trimTrailingSlashes(path: string): string {
  const trimmed = trimEnd(path, '/');
  return trimmed === '' ? '/' : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
