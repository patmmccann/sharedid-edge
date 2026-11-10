import { isRecord, type SharedIdEdgeConfig } from './config.js';
import type { ConsentContext, StorageDecision } from './consent.js';
import type { Eid, ModuleReport, PlatformInfo } from './types.js';

/** What a module gets for one request. Modules see the request but must not modify it. */
export interface ModuleContext {
  readonly request: Request;
  readonly url: URL;
  readonly platform: PlatformInfo;
  /** The SharedID for this request, when storage is allowed. */
  readonly sharedId: string | undefined;
  readonly consent: ConsentContext;
  /** The request's cookies. */
  readonly cookies: ReadonlyMap<string, string>;
  /** Whether the browser has opted out (the SharedID opt-out cookie is present). */
  readonly optedOut: boolean;
  /**
   * Whether the worker may store the SharedID for this request: `{ allowed: false, reason }` on opt-out, GPC, COPPA or
   * denied TCF consent, with the reason `X-SharedID-Status` gives. Modules that store or extend an identifier should
   * follow it.
   */
  readonly storage: StorageDecision;
  /** This module's entry from `SID_MODULE_CONFIG`, or `{}`. */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * This module's entry from `SID_MODULE_SECRETS` (set as a platform secret, not a plain variable), or `{}`. Never put
   * these in the output or in errors.
   */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * A route a module can run on: `v1` (`{basePath}/v1`, the JSON payload) or `sync` (`{basePath}/sync`, Prebid.js's
 * `pixelUrl`, where only the module's cookies are used).
 */
export type ModuleRoute = 'v1' | 'sync';

/** The routes a module runs on when it doesn't declare `routes`. */
const DEFAULT_MODULE_ROUTES: readonly ModuleRoute[] = Object.freeze(['v1']);

/**
 * A cookie a module sets on the response (`/v1`, or `/sync` for modules that run there). The worker adds `Path=/`,
 * `SameSite=Lax`, `Secure` (over https) and `Expires`. Names must be valid cookie names and differ from the worker's own
 * cookies; values must be cookie-octets. `maxAgeSeconds: 0` deletes the cookie.
 */
export interface ModuleCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
  /** The `Domain` attribute; `SID_COOKIE_DOMAIN` when omitted, host-only when that's unset too. */
  readonly domain?: string;
}

/** What a module adds to the payload. Every field is optional. */
export interface ModuleResult {
  readonly eids?: readonly Eid[];
  /** An OpenRTB 2.x fragment, deep-merged into the payload's `ortb2`. */
  readonly ortb2?: Readonly<Record<string, unknown>>;
  /** Cookies to set (or delete) on the response. */
  readonly cookies?: readonly ModuleCookie[];
}

/**
 * A module adds IDs or signals to the `{basePath}/v1` payload. Modules work only from what the worker already has
 * (the request, platform data, consent, configuration, bundled data); they make no network calls.
 */
export interface EdgeModule {
  /** Unique name; also the key in `SID_MODULES` and `SID_MODULE_CONFIG`. Lowercase letters, digits and `-`. */
  readonly name: string;
  /** IAB GVL vendor ID, for modules acting for a TCF vendor. */
  readonly gvlid?: number;
  /** TCF purposes the module needs when GDPR applies. */
  readonly purposes?: readonly number[];
  /**
   * The routes the module runs on; `['v1']` when omitted. Modules that only maintain cookies can add `'sync'`, so they
   * also run when Prebid.js calls `pixelUrl` on page views. On `/sync` only their cookies are used: `eids` and
   * `ortb2` are ignored.
   */
  readonly routes?: readonly ModuleRoute[];
  run(context: ModuleContext): ModuleResult | undefined | Promise<ModuleResult | undefined>;
  /**
   * The cookies to delete when the browser opts out at `{basePath}/optout`, given the module's `SID_MODULE_CONFIG`
   * entry. Called for every installed module, listed in `SID_MODULES` or not, so cookies from a module that has since
   * been turned off are cleaned up too. Only cookies the browser sent are deleted. Each must have `maxAgeSeconds: 0`.
   */
  optOutCookies?(config: Readonly<Record<string, unknown>>): readonly ModuleCookie[];
}

const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Validates a module definition, so mistakes surface when the worker is built rather than per request. */
export function defineModule(module: EdgeModule): EdgeModule {
  if (!MODULE_NAME.test(module.name)) throw new TypeError(`Invalid module name "${module.name}"`);
  for (const purpose of module.purposes ?? []) {
    if (!Number.isInteger(purpose) || purpose < 1 || purpose > 24) throw new TypeError(`Module ${module.name}: invalid TCF purpose ${String(purpose)}`);
  }
  if (module.routes !== undefined) {
    const routes: readonly unknown[] = module.routes;
    if (routes.length === 0 || new Set(routes).size !== routes.length || !routes.every(r => r === 'v1' || r === 'sync')) {
      throw new TypeError(`Module ${module.name}: routes must be a non-empty list of "v1" and "sync" without repeats`);
    }
    return Object.freeze({ ...module, routes: Object.freeze([...module.routes]) });
  }
  return Object.freeze({ ...module });
}

/** Whether a module runs on a route. */
function runsOn(module: EdgeModule, route: ModuleRoute): boolean {
  return (module.routes ?? DEFAULT_MODULE_ROUTES).includes(route);
}

/**
 * The names of the modules to run on a route, in `SID_MODULES` order. On `v1`, every name in `SID_MODULES`. On
 * `sync`, the names in `SID_SYNC_MODULES` when it's set, else the installed modules whose `routes` include `sync`.
 */
function moduleNamesFor(registry: ModuleRegistry, config: SharedIdEdgeConfig, route: ModuleRoute): readonly string[] {
  if (route === 'v1') return config.modules;
  const { syncModules } = config;
  if (syncModules !== undefined) return config.modules.filter(name => syncModules.includes(name));
  return config.modules.filter(name => {
    const module = registry.get(name);
    return module !== undefined && runsOn(module, 'sync');
  });
}

/** The registry of modules a worker is built with. */
export class ModuleRegistry {
  readonly #modules = new Map<string, EdgeModule>();

  constructor(modules: Iterable<EdgeModule> = []) {
    for (const module of modules) this.register(module);
  }

  register(module: EdgeModule): this {
    if (this.#modules.has(module.name)) throw new TypeError(`Module "${module.name}" is registered twice`);
    this.#modules.set(module.name, defineModule(module));
    return this;
  }

  get(name: string): EdgeModule | undefined {
    return this.#modules.get(name);
  }

  names(): string[] {
    return [...this.#modules.keys()];
  }

  modules(): EdgeModule[] {
    return [...this.#modules.values()];
  }
}

/**
 * The cookie deletions every installed module asks for on opt-out. A module whose hook throws, or returns a cookie
 * that isn't a valid deletion, is left out; the others still apply.
 */
export function optOutCookies(registry: ModuleRegistry, config: SharedIdEdgeConfig): ModuleCookie[] {
  const cookies: ModuleCookie[] = [];
  for (const module of registry.modules()) {
    if (module.optOutCookies === undefined) continue;
    try {
      const deletions = module.optOutCookies(config.moduleConfig[module.name] ?? {});
      for (const cookie of deletions) {
        checkModuleCookie(cookie, config);
        if (cookie.maxAgeSeconds !== 0) throw new TypeError('opt-out cookies must be deletions');
      }
      cookies.push(...deletions);
    } catch {
      // Nothing about the failure is returned; the rest of the opt-out still applies.
    }
  }
  return cookies;
}

export interface ModuleRunOutput {
  readonly eids: Eid[];
  readonly cookies: ModuleCookie[];
  readonly ortb2: Record<string, unknown> | undefined;
  readonly reports: Record<string, ModuleReport>;
}

/**
 * Runs the modules configured for a route (`v1` by default; see {@link moduleNamesFor}) in order. A module that's
 * missing, doesn't run on the route, isn't allowed by consent, throws or runs past `moduleTimeoutMs` is reported and
 * left out; the others still contribute. On `sync` the caller uses only the cookies.
 */
export async function runModules(
  registry: ModuleRegistry,
  config: SharedIdEdgeConfig,
  base: Omit<ModuleContext, 'config' | 'secrets'>,
  now: () => number,
  route: ModuleRoute = 'v1'
): Promise<ModuleRunOutput> {
  const eids: Eid[] = [];
  const cookies: ModuleCookie[] = [];
  let ortb2: Record<string, unknown> | undefined;
  const reports: Record<string, ModuleReport> = {};

  for (const name of moduleNamesFor(registry, config, route)) {
    const module = registry.get(name);
    if (module === undefined) {
      reports[name] = { ms: 0, status: 'skipped', reason: 'not installed' };
      continue;
    }
    if (!runsOn(module, route)) {
      reports[name] = { ms: 0, status: 'skipped', reason: `not on /${route}` };
      continue;
    }
    const denied = consentDenial(module, base.consent);
    if (denied !== undefined) {
      reports[name] = { ms: 0, status: 'skipped', reason: denied };
      continue;
    }
    const start = now();
    try {
      const result = await withTimeout(
        Promise.resolve(module.run({ ...base, config: config.moduleConfig[name] ?? {}, secrets: config.moduleSecrets[name] ?? {} })),
        config.moduleTimeoutMs
      );
      const ms = Math.round(now() - start);
      if (result === TIMED_OUT) {
        reports[name] = { ms, status: 'timeout' };
        continue;
      }
      if (result === undefined || (result.eids === undefined && result.ortb2 === undefined && result.cookies === undefined)) {
        reports[name] = { ms, status: 'empty' };
        continue;
      }
      // Checked before anything from this module is used, so a bad cookie leaves the whole result out.
      for (const cookie of result.cookies ?? []) checkModuleCookie(cookie, config);
      if (result.cookies !== undefined) cookies.push(...result.cookies);
      if (result.eids !== undefined) eids.push(...result.eids);
      if (result.ortb2 !== undefined) ortb2 = deepMerge(ortb2 ?? {}, result.ortb2);
      reports[name] = { ms, status: result.eids === undefined && result.ortb2 === undefined ? 'empty' : 'ok' };
    } catch {
      // The error isn't reported to the page: it may contain request data.
      reports[name] = { ms: Math.round(now() - start), status: 'error' };
    }
  }
  return { eids, cookies, ortb2, reports };
}

const MODULE_COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,4096}$/;
const COOKIE_DOMAIN = /^\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Throws on a cookie a module may not set. */
function checkModuleCookie(cookie: ModuleCookie, config: SharedIdEdgeConfig): void {
  const reserved = [config.cookieName, config.recoveryCookieName, config.optOutCookieName];
  if (!MODULE_COOKIE_NAME.test(cookie.name) || reserved.includes(cookie.name)) throw new TypeError('invalid module cookie name');
  if (!COOKIE_VALUE.test(cookie.value)) throw new TypeError('invalid module cookie value');
  if (!Number.isInteger(cookie.maxAgeSeconds) || cookie.maxAgeSeconds < 0 || cookie.maxAgeSeconds > 400 * 86_400) {
    throw new TypeError('invalid module cookie lifetime');
  }
  if (cookie.domain !== undefined && !COOKIE_DOMAIN.test(cookie.domain)) throw new TypeError('invalid module cookie domain');
}

/**
 * Why consent doesn't allow a module to run, or undefined if it does. When GDPR applies, a module's declared purposes
 * must all have publisher consent (modules without a `gvlid` act for the publisher). Vendor consent isn't decoded yet,
 * so a module with a `gvlid` doesn't run when GDPR applies.
 */
function consentDenial(module: EdgeModule, consent: ConsentContext): string | undefined {
  if (consent.gdprApplies !== true) return undefined;
  if (module.gvlid !== undefined) return 'tcf: vendor consent is not checked yet';
  const purposes = module.purposes ?? [];
  if (purposes.length === 0) return undefined;
  const publisher = consent.tcf?.publisherPurposeConsents;
  if (publisher === undefined) return 'tcf: no publisher consent in the TC string';
  const missing = purposes.filter(p => !publisher.has(p));
  return missing.length === 0 ? undefined : `tcf: no publisher consent for purpose ${missing.join(', ')}`;
}

const TIMED_OUT: unique symbol = Symbol('timed out');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => { resolve(TIMED_OUT); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Deep-merges plain objects; arrays and other values from `source` replace those in `target`. */
export function deepMerge(target: Record<string, unknown>, source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}
