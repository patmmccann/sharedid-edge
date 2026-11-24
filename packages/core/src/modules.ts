import { isRecord, type SharedIdEdgeConfig } from './config.js';
import { unreadableTcString, type ConsentContext, type ConsentSignal, type StorageDecision } from './consent.js';
import { checkForwarding, type ModuleFetch, type ModuleFetching, type ModuleForwarding } from './forwarding.js';
import { trafficReport, type TrafficEntry, type TrafficReport } from './traffic.js';
import type { EncryptedIp, EncryptedIpValue, Eid, ModuleReport, PlatformInfo } from './types.js';

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
   * `SID_COOKIE_DOMAIN`, the `Domain` core gives a module cookie without its own `domain`, or undefined for host-only
   * cookies (`host-only`). A module that tidies up duplicate copies of a cookie needs it, to know whether the cookie it
   * sets is host-only.
   */
  readonly cookieDomain: string | undefined;
  /**
   * The domain a cookie on `auto` gets on this request: the `cookie_domain` Prebid.js sent, when it's the request's host
   * or a parent of it; undefined (host-only) otherwise. With `SID_COOKIE_DOMAIN=auto`, `cookieDomain` is the same.
   */
  readonly autoCookieDomain?: string | undefined;
  /**
   * Whether the worker may store the SharedID for this request: `{ allowed: false, reason }` on opt-out, GPC, COPPA or
   * denied TCF consent, with the reason `X-SharedID-Status` gives. Modules that store or extend an identifier should
   * follow it.
   */
  readonly storage: StorageDecision;
  /** This module's entry from `SID_MODULE_CONFIG`, or `{}`. Frozen all the way down: writing to it throws. */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * This module's entry from `SID_MODULE_SECRETS` (set as a platform secret, not a plain variable), or `{}`. Never put
   * these in the output or in errors. Frozen, like `config`.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * For a module that declares `fetching`: sends a request to one of its declared hosts (spec: "Module requests").
   * Undefined for other modules, and whenever the decision rules requests out for this visitor (opt-out, COPPA, GPC, a
   * consent provider's denial, TCF), so a module checks it before anything else it would send.
   */
  readonly fetch?: ModuleFetch;
}

/**
 * What a consent provider (`EdgeModule.consent`) gets: the request, its URL and cookies, the platform information, the
 * consent signals core read, and the module's `SID_MODULE_CONFIG` entry. No SharedID or storage decision: they come
 * after it.
 */
export type ConsentHookContext = Pick<ModuleContext, 'request' | 'url' | 'platform' | 'consent' | 'cookies' | 'config'>;

/**
 * The consent providers' signal for a request: the modules in `SID_MODULES` with a `consent` hook, in order. The first
 * denial wins (with the module's name before its reason); otherwise a grant, if any; otherwise undefined. A hook that
 * throws or returns something that isn't a signal denies, so a broken provider can't let an ID through.
 *
 * NO_CONSENT_HOOKS: `globalThis.__SID_NO_CONSENT_HOOKS__`, set to `true` with esbuild's `define` by builds whose module
 * list has no consent hook, so the handler calls `storageDecision`, and this and `storageDecisionWith` compile away:
 * the bundled adapters without `--module` (`scripts/bundle-adapter.mjs`), the Cloudflare Worker's npm scripts (its
 * `src/index.ts` and `src/bowser.ts`) and a Snippet whose modules have none. Those lists are the built-in modules, none
 * of which has a hook (`packages/modules/all`'s tests check). Unset everywhere else.
 */
export function consentSignal(registry: ModuleRegistry, config: SharedIdEdgeConfig, base: Omit<ConsentHookContext, 'config'>): ConsentSignal | undefined {
  let granted: ConsentSignal | undefined;
  for (const name of config.modules) {
    const module = registry.get(name);
    if (module?.consent === undefined) continue;
    let reason = 'error';
    try {
      const signal = module.consent({ ...base, config: config.moduleConfig[name] ?? {} });
      if (signal === undefined) continue;
      // A module written in JavaScript can return anything: only a grant grants, and only a denial with a reason keeps it.
      const kind: unknown = signal.consent;
      const given: unknown = (signal as { readonly reason?: unknown }).reason;
      if (kind === 'granted') {
        granted = signal;
        continue;
      }
      // The reason goes into a header: printable ASCII only, or `error`, so the denial still applies.
      if (kind === 'denied' && typeof given === 'string' && /^[\x20-\x7E]{1,200}$/.test(given)) reason = given;
    } catch {
      // The error isn't reported: it may contain request data.
    }
    return { consent: 'denied', reason: `${name}: ${reason}` };
  }
  return granted;
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
  /**
   * The `Domain` attribute; `SID_COOKIE_DOMAIN` when omitted, host-only when that's `host-only`. `auto`: the request's
   * `autoCookieDomain`, else host-only; a deletion goes to the host and every domain above it.
   */
  readonly domain?: string;
  /** `true`: no `Domain` attribute, whatever `SID_COOKIE_DOMAIN` says (for re-setting a host-only cookie). */
  readonly hostOnly?: boolean;
}

/** What a module adds to the payload. Every field is optional. */
export interface ModuleResult {
  /** Scheduled reference data is missing or past its maximum age; usable previous data may still contribute. */
  readonly stale?: boolean;
  readonly eids?: readonly Eid[];
  /** An OpenRTB 2.x fragment, deep-merged into the payload's `ortb2`. */
  readonly ortb2?: Readonly<Record<string, unknown>>;
  /**
   * The client's IP address encrypted per recipient, returned as the payload's `eip` (not merged into `ortb2`,
   * which pages pass to every bidder). Checked: a value that isn't unpadded base64url of 67 to 124 characters, a bad
   * `kid`, host name or field makes the module an `error`. A later module's value for a recipient replaces an earlier
   * one's. Ignored on `/sync`.
   */
  readonly eip?: EncryptedIp;
  /** Cookies to set (or delete) on the response. */
  readonly cookies?: readonly ModuleCookie[];
  /**
   * What the module found about the traffic: bot, proxy, score or internal traffic. Core merges every module's report,
   * and the platform's, into `ortb2.device.ext.traffic` (most cautious wins) and sets `sources` itself. A module
   * shouldn't write `ortb2.device.ext.traffic` directly; if it does, that's read as its report, never merged as is.
   */
  readonly traffic?: TrafficReport;
  /**
   * `true`: the browser mustn't cache this response. Honoured on `/sync` only (every other response is already
   * `no-store`), for a module that needs to see every sync, such as `clickid`, which reads the landing page's URL from
   * the request's `Referer`: a browser reuses a cached sync for any page. It doesn't change the status, body or other
   * headers.
   */
  readonly noStore?: boolean;
}

/**
 * A module adds IDs or signals to the `{basePath}/v1` payload. Modules work only from what the worker already has
 * (the request, platform data, consent, configuration, bundled data); they make no network calls. A forwarding module
 * (`forwarding`) also passes requests on to the hosts it declares, through core.
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
   * A consent provider: reads a consent signal core doesn't (a CMP's own cookie, say) for the SharedID's storage
   * decision. Called on `/v1` and `/sync`, before the decision and before any module runs, when the module is in
   * `SID_MODULES` (whatever its `routes` and `SID_SYNC_MODULES`), and not when the browser has opted out. Synchronous.
   * Return `{ consent: 'denied', reason }` for an explicit denial, `{ consent: 'granted' }` for an explicit grant, or
   * undefined when there's nothing to read or it can't be read: never `granted` on doubt. A denial applies everywhere;
   * a grant only lifts the denial for want of a TC string where GDPR applies (see `storageDecisionWith`). A hook that
   * throws, or returns anything else, denies storage (reason `<name>: error`).
   */
  consent?(context: ConsentHookContext): ConsentSignal | undefined;
  /**
   * The cookies to delete when the browser opts out at `{basePath}/optout`, given the module's `SID_MODULE_CONFIG`
   * entry. Called for every installed module, listed in `SID_MODULES` or not, so cookies from a module that has since
   * been turned off are cleaned up too. Only cookies the browser sent are deleted. Each must have `maxAgeSeconds: 0`.
   */
  optOutCookies?(config: Readonly<Record<string, unknown>>): readonly ModuleCookie[];
  /**
   * Makes it a forwarding module: it owns the paths its settings name, outside the base path, and answers requests
   * under them by passing them on to the hosts it declares, through core (spec: "Forwarding modules"). Off unless it's in
   * `SID_MODULES` and configured; the adapter must support forwarding (`HandlerOptions.forwardFetch`).
   */
  readonly forwarding?: ModuleForwarding;
  /**
   * Lets its `run` send requests to the hosts it declares, through core (`ModuleContext.fetch`; spec: "Module
   * requests"), under the forwarding decision's privacy rules, with GPC always blocking, and a time limit within
   * `SID_MODULE_TIMEOUT_MS`. The adapter must support it (`HandlerOptions.forwardFetch`).
   */
  readonly fetching?: ModuleFetching;
}

const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Validates a module definition, so mistakes surface when the worker is built rather than per request. */
export function defineModule(module: EdgeModule): EdgeModule {
  // The Cloudflare Snippet's build loads its modules before bundling them, which checks them here; in the Snippet, whose
  // esbuild `define` sets this flag, the checks compile away.
  if ((globalThis as { __SID_PREVALIDATED__?: boolean }).__SID_PREVALIDATED__ !== true) {
    if (!MODULE_NAME.test(module.name)) throw new TypeError(`Invalid module name "${module.name}"`);
    for (const purpose of module.purposes ?? []) {
      if (!Number.isInteger(purpose) || purpose < 1 || purpose > 24) throw new TypeError(`Module ${module.name}: invalid TCF purpose ${String(purpose)}`);
    }
    const routes: readonly unknown[] | undefined = module.routes;
    if (routes !== undefined && (routes.length === 0 || new Set(routes).size !== routes.length || !routes.every(r => r === 'v1' || r === 'sync'))) {
      throw new TypeError(`Module ${module.name}: routes must be a non-empty list of "v1" and "sync" without repeats`);
    }
    // Builds without a forwarding module leave the check out (NO_FORWARDING in handler.ts).
    if ((globalThis as { __SID_NO_FORWARDING__?: boolean }).__SID_NO_FORWARDING__ !== true) {
      if (module.forwarding !== undefined) checkForwarding(module.name, module.forwarding);
      if (module.fetching !== undefined) checkForwarding(module.name, module.fetching, 'fetching');
    }
  }
  if (module.routes !== undefined) return Object.freeze({ ...module, routes: Object.freeze([...module.routes]) });
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
  readonly eip: EncryptedIp | undefined;
  /** Each module's traffic report, checked, in module order, for core to merge with the platform's. */
  readonly traffic: TrafficEntry[];
  readonly reports: Record<string, ModuleReport>;
  /** Whether a module that succeeded asked for the response not to be cached (`ModuleResult.noStore`). */
  readonly noStore: boolean;
}

/**
 * Runs the modules configured for a route (`v1` by default; see {@link moduleNamesFor}) in order. A module that's
 * missing, doesn't run on the route, isn't allowed by consent, throws or runs past `moduleTimeoutMs` is reported and
 * left out; the others still contribute. On `sync` the caller uses only the cookies. A module with a `gvlid` that
 * consent skips has the cookies it declares for opt-out deleted, when the browser sent them. `fetchFor` gives a
 * module that declares `fetching` its `ModuleContext.fetch` (undefined when blocked).
 */
export async function runModules(
  registry: ModuleRegistry,
  config: SharedIdEdgeConfig,
  base: Omit<ModuleContext, 'config' | 'secrets' | 'fetch'>,
  now: () => number,
  route: ModuleRoute = 'v1',
  fetchFor?: (module: EdgeModule) => ModuleFetch | undefined
): Promise<ModuleRunOutput> {
  const eids: Eid[] = [];
  const cookies: ModuleCookie[] = [];
  let ortb2: Record<string, unknown> | undefined;
  let eip: EncryptedIp | undefined;
  const traffic: TrafficEntry[] = [];
  const reports: Record<string, ModuleReport> = {};
  let noStore = false;

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
      // A vendor's identifier mustn't outlast the vendor's consent: delete what the module declares for opt-out.
      if (module.gvlid !== undefined) cookies.push(...optOutCookies(new ModuleRegistry([module]), config).filter(cookie => base.cookies.has(cookie.name)));
      continue;
    }
    const start = now();
    try {
      const fetch = module.fetching === undefined ? undefined : fetchFor?.(module);
      const result = await withTimeout(
        Promise.resolve(module.run({ ...base, config: config.moduleConfig[name] ?? {}, secrets: config.moduleSecrets[name] ?? {}, ...(fetch === undefined ? {} : { fetch }) })),
        config.moduleTimeoutMs
      );
      const ms = Math.round(now() - start);
      if (result === TIMED_OUT) {
        reports[name] = { ms, status: 'timeout' };
        continue;
      }
      // A module written in JavaScript can return anything here; it counts only once the whole result has passed.
      const flag: unknown = result?.noStore;
      const stale: unknown = result?.stale;
      for (const value of [flag, stale]) {
        if (value !== undefined && typeof value !== 'boolean') throw new TypeError();
      }
      if (result === undefined || (result.eids === undefined && result.ortb2 === undefined && result.eip === undefined && result.cookies === undefined && result.traffic === undefined)) {
        if (flag === true) noStore = true;
        reports[name] = { ms, status: 'empty', ...(stale === true ? { stale: true } : {}) };
        continue;
      }
      // Checked before anything from this module is used, so a bad cookie leaves the whole result out.
      for (const cookie of result.cookies ?? []) checkModuleCookie(cookie, config);
      const encrypted = result.eip === undefined ? undefined : checkEncryptedIp(result.eip);
      const split = result.ortb2 === undefined ? { rest: undefined, traffic: undefined } : takeTraffic(result.ortb2);
      const reported = [result.traffic, split.traffic].flatMap(value => (value === undefined ? [] : [{ source: name, report: trafficReport(value) }]));
      if (result.cookies !== undefined) cookies.push(...result.cookies);
      if (result.eids !== undefined) eids.push(...result.eids);
      if (split.rest !== undefined) ortb2 = deepMerge(ortb2 ?? {}, split.rest);
      if (encrypted !== undefined) eip = mergeEncryptedIp(eip, encrypted);
      traffic.push(...reported);
      if (flag === true) noStore = true;
      const added = result.eids !== undefined || split.rest !== undefined || encrypted !== undefined || reported.some(entry => Object.keys(entry.report).length > 0);
      reports[name] = { ms, status: added ? 'ok' : 'empty', ...(stale === true ? { stale: true } : {}) };
    } catch {
      // The error isn't reported to the page: it may contain request data.
      reports[name] = { ms: Math.round(now() - start), status: 'error' };
    }
  }
  return { eids, cookies, ortb2, eip, traffic, reports, noStore };
}

/** The format Google Publisher Tag accepts, as the payload sends it: unpadded base64url, 67 to 124 characters. */
const ENCRYPTED_IP = /^[A-Za-z0-9_-]{67,124}$/;
/** A JWK `kid`: printable ASCII without spaces, at most 256 characters. */
const KEY_ID = /^[!-~]{1,256}$/;
/** A Prebid Server host's name: a lower-case host name, optionally with a port. */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

function encryptedIpValue(value: unknown): EncryptedIpValue {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'value' && key !== 'kid' && key !== 'stale')) throw new TypeError('invalid eip entry');
  const { value: text, kid, stale } = value;
  if (typeof text !== 'string' || !ENCRYPTED_IP.test(text)) throw new TypeError('invalid eip value');
  if (kid !== undefined && (typeof kid !== 'string' || !KEY_ID.test(kid))) throw new TypeError('invalid eip kid');
  if (stale !== undefined && stale !== true) throw new TypeError('invalid eip stale');
  return { value: text, ...(kid === undefined ? {} : { kid }), ...(stale === undefined ? {} : { stale }) };
}

/**
 * A module's `eip`, checked and copied: only `google` and `pbs` (by host name). Throws otherwise;
 * undefined when it has no value at all.
 */
function checkEncryptedIp(value: unknown): EncryptedIp | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'google' && key !== 'pbs')) throw new TypeError('invalid eip');
  const { google, pbs } = value;
  if (pbs !== undefined && !isRecord(pbs)) throw new TypeError('invalid eip pbs');
  const hosts = Object.entries(pbs ?? {}).map(([host, entry]): [string, EncryptedIpValue] => {
    if (!HOST.test(host)) throw new TypeError('invalid eip host');
    return [host, encryptedIpValue(entry)];
  });
  if (google === undefined && hosts.length === 0) return undefined;
  return {
    ...(google === undefined ? {} : { google: encryptedIpValue(google) }),
    ...(hosts.length === 0 ? {} : { pbs: Object.fromEntries(hosts) })
  };
}

/** A later module's value for a recipient replaces an earlier one's. */
function mergeEncryptedIp(earlier: EncryptedIp | undefined, later: EncryptedIp): EncryptedIp {
  const google = later.google ?? earlier?.google;
  const pbs = earlier?.pbs === undefined ? later.pbs : { ...earlier.pbs, ...later.pbs };
  return { ...(google === undefined ? {} : { google }), ...(pbs === undefined ? {} : { pbs }) };
}

/**
 * Splits `device.ext.traffic` out of a module's OpenRTB fragment: core writes that field from the merged signal, so a
 * module's own value is read as its report instead of being merged as is. Objects left empty are dropped.
 */
function takeTraffic(fragment: Readonly<Record<string, unknown>>): { rest: Record<string, unknown> | undefined; traffic: unknown } {
  const { device, ...others } = fragment;
  if (!isRecord(device)) return { rest: { ...fragment }, traffic: undefined };
  const { ext, ...deviceOthers } = device;
  if (!isRecord(ext) || !('traffic' in ext)) return { rest: { ...fragment }, traffic: undefined };
  const { traffic, ...extOthers } = ext;
  const newDevice: Record<string, unknown> = Object.keys(extOthers).length === 0 ? deviceOthers : { ...deviceOthers, ext: extOthers };
  const rest: Record<string, unknown> = Object.keys(newDevice).length === 0 ? others : { ...others, device: newDevice };
  return { rest: Object.keys(rest).length === 0 ? undefined : rest, traffic };
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
  if (cookie.domain !== undefined && cookie.domain !== 'auto' && !COOKIE_DOMAIN.test(cookie.domain)) throw new TypeError('invalid module cookie domain');
}

/**
 * Why consent doesn't allow a module to run, or undefined if it does. When GDPR applies, a module without a `gvlid`
 * acts for the publisher: its declared purposes must all have publisher consent. A module with a `gvlid` acts for that
 * TCF vendor: it needs a TC string that can be read, the vendor's consent in the core segment, and consent there for
 * each of its declared purposes.
 */
export function consentDenial(module: EdgeModule, consent: ConsentContext): string | undefined {
  if (consent.gdprApplies !== true) return undefined;
  const purposes = module.purposes ?? [];
  if (module.gvlid !== undefined) {
    const { tcf } = consent;
    if (tcf === undefined) return consent.tcString === undefined ? 'tcf: GDPR applies and there is no TC string' : unreadableTcString();
    if (!tcf.vendorConsent(module.gvlid)) return `tcf: no consent for vendor ${String(module.gvlid)}`;
    const missing = purposes.filter(p => !tcf.purposeConsents.has(p));
    return missing.length === 0 ? undefined : `tcf: no vendor consent for purpose ${missing.join(', ')}`;
  }
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
