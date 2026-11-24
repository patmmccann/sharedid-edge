import { AUTO_COOKIE_DOMAIN, DEFAULT_CONFIG, type SharedIdEdgeConfig } from './config.js';
import { HOSTNAME, hostKey } from './hosts.js';
import { readConsent, storageDecision, storageDecisionWith, unreadableTcString, type ConsentContext, type ConsentSignal, type StorageDecision } from './consent.js';
import { cookieValues, parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
import { checkFetching, forwardDecision, forwardedResponse, forwarder, MAX_FORWARD_BODY_BYTES, moduleFetchLimitMs, ownedPaths, ownerOf, type ForwardDecision, type ForwardFetch, type ModuleFetch, type OwnedPath } from './forwarding.js';
import { idFromSyncParam, isValidId, mintId } from './id.js';
import { consentDenial, consentSignal, deepMerge, ModuleRegistry, optOutCookies, runModules, type EdgeModule, type ModuleCookie, type ModuleRunOutput } from './modules.js';
import { trimEnd } from './text.js';
import { mergeTraffic, skipsBot, trafficReport, type TrafficEntry, type TrafficSignal } from './traffic.js';
import type { Eid, PayloadV1, PlatformInfo } from './types.js';

/** The 43-byte transparent GIF the WordPress and Drupal plugins return, so `pixelUrl` image requests load. */
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x90, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21,
  0xf9, 0x04, 0x05, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x04,
  0x01, 0x00, 0x3b
]);

/** The routes under `config.basePath`. */
export const ROUTES: Readonly<{ sync: '/sync'; v1: '/v1'; optout: '/optout'; optin: '/optin' }> =
  Object.freeze({ sync: '/sync', v1: '/v1', optout: '/optout', optin: '/optin' });

type Route = (typeof ROUTES)[keyof typeof ROUTES];

/** The longest path and query `/sync` and `/v1` accept, in bytes: longer gets a `414`. */
export const MAX_URL_BYTES = 8192;
/** The longest `Cookie` header `/sync` and `/v1` accept, in bytes: longer gets a `431`. */
export const MAX_COOKIE_BYTES = 16_384;

/** What a rate limiter is asked about a request to `/sync` or `/v1`. */
export interface RateLimitRequest {
  /** `sync` or `v1`. */
  readonly route: 'sync' | 'v1';
  /** The site's hostname, lower case (in trusted-upstream mode, the forwarded one). */
  readonly host: string;
  /** The visitor's IP address, from the platform information; undefined when it has none. */
  readonly clientIp: string | undefined;
}

/**
 * A rate limiter an adapter wires to its platform's (the Cloudflare Worker's rate limiting bindings): true to answer
 * the request, false to refuse it with a `429`. One that throws or rejects lets the request through.
 */
export type RateLimiter = (request: RateLimitRequest) => boolean | Promise<boolean>;

export interface HandlerOptions {
  readonly config?: SharedIdEdgeConfig;
  /**
   * Several sites from one deployment (`SID_HOSTS`, see `settingsFromEnv`): the configuration for each hostname. A
   * request whose host isn't listed (nor given by `hostConfig`) gets a 404, and no cookies.
   */
  readonly hosts?: ReadonlyMap<string, SharedIdEdgeConfig>;
  /**
   * The configuration a platform supplies for a request's host (Cloudflare for SaaS custom hostname metadata), used
   * when `hosts` has none for it; undefined when it has none either. It may throw a `ConfigError`.
   */
  readonly hostConfig?: (request: Request) => SharedIdEdgeConfig | undefined;
  /** Modules the worker is built with; `config.modules` chooses which run. */
  readonly modules?: Iterable<EdgeModule>;
  /**
   * Asked before `/sync` and `/v1` do any work (never for `/optout` and `/optin`); off when undefined. Builds that never
   * pass one leave its code out (NO_RATE_LIMIT, below).
   */
  readonly rateLimit?: RateLimiter;
  /**
   * Sends a forwarding module's requests (normally `request => fetch(request)`). An adapter whose platform can't send
   * requests to other hosts leaves it out: a forwarding module in `SID_MODULES` is then a configuration error. Builds
   * whose modules don't forward leave the forwarding code out (NO_FORWARDING, below).
   */
  readonly forwardFetch?: ForwardFetch;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** ID generator, for tests. */
  readonly mintId?: () => string;
}

/**
 * Build-time flags: the Cloudflare Snippet's (see createHandler), NO_CONSENT_HOOKS (see modules.ts) and
 * NO_RATE_LIMIT: `globalThis.__SID_NO_RATE_LIMIT__`, set to `true` with esbuild's `define` by builds that never pass
 * `rateLimit` (the bundled adapters, the Snippet, and the Worker's npm scripts other than `deploy:rate-limit`), so the
 * rate-limit check compiles away. NO_FORWARDING: `globalThis.__SID_NO_FORWARDING__`, set to `true` by the builds whose
 * module list has no forwarding module (the same builds as NO_CONSENT_HOOKS, and a Snippet without one), so the
 * forwarding code (forwarding.ts) compiles away. Unset everywhere else.
 */
interface SnippetFlags {
  readonly __SID_PREVALIDATED__?: boolean;
  readonly __SID_UNUSED_HOSTS__?: boolean;
  readonly __SID_NO_CONSENT_HOOKS__?: boolean;
  readonly __SID_NO_RATE_LIMIT__?: boolean;
  readonly __SID_NO_FORWARDING__?: boolean;
}

export type SharedIdEdgeHandler = (request: Request, platform?: PlatformInfo) => Promise<Response>;

/** The source of the ID in a response, for the `X-SharedID-Source` debug header. */
type IdSource = 'cookie' | 'recovery' | 'param' | 'minted';

interface IdState {
  readonly id: string | undefined;
  readonly source: IdSource | undefined;
}

const NO_ID: IdState = { id: undefined, source: undefined };

/** The platform's traffic verdict, as source `platform`. One that isn't valid is ignored rather than failing the request. */
function platformTrafficEntries(platform: PlatformInfo): TrafficEntry[] {
  if (platform.traffic === undefined) return [];
  try {
    return [{ source: 'platform', report: trafficReport(platform.traffic) }];
  } catch {
    return [];
  }
}

/**
 * Creates the request handler. Platform adapters call it with the request and what the platform knows about it.
 * It answers every route under `config.basePath` itself and never forwards a request to the origin. The only requests it
 * sends anywhere are a forwarding module's, under that module's own paths, to the hosts it declares.
 */
export function createHandler(options: HandlerOptions = {}): SharedIdEdgeHandler {
  const registry = new ModuleRegistry(options.modules ?? []);
  const { hosts, hostConfig } = options;
  const base = options.config ?? DEFAULT_CONFIG;
  // The Cloudflare Snippet's build sets these flags with esbuild's `define` when its settings have no SID_HOSTS (and it
  // passes no hostConfig), so the per-host handling below compiles away there.
  // (Read from globalThis in place: `define` replaces only the expression `globalThis.__SID_…`.)
  if (((globalThis as SnippetFlags).__SID_PREVALIDATED__ === true && (globalThis as SnippetFlags).__SID_UNUSED_HOSTS__ === true) || (hosts === undefined && hostConfig === undefined)) {
    return configuredHandler(options, base, registry);
  }

  // One handler per configuration, built on first use: SID_HOSTS's are fixed, and a platform's are usually the same
  // object for a host (the Worker caches them).
  const handlers = new WeakMap<SharedIdEdgeConfig, SharedIdEdgeHandler>();
  return (request: Request, platform: PlatformInfo = {}): Promise<Response> => {
    const config = hosts?.get(hostKey(new URL(request.url))) ?? hostConfig?.(request) ?? (hosts === undefined ? base : undefined);
    // A host this deployment doesn't serve: answer nothing, set nothing, as outside the routes.
    if (config === undefined) return Promise.resolve(text(404, 'Not found'));
    let handler = handlers.get(config);
    if (handler === undefined) {
      handler = configuredHandler(options, config, registry);
      handlers.set(config, handler);
    }
    return handler(request, platform);
  };
}

/** The handler for one configuration. */
function configuredHandler(options: HandlerOptions, base: SharedIdEdgeConfig, registry: ModuleRegistry): SharedIdEdgeHandler {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.mintId ?? mintId;
  // The forwarding modules' paths, checked once per configuration: an overlap, or a forwarding module on an adapter
  // that can't forward, throws a ConfigError here, which the adapters answer with a 500.
  const owned: readonly OwnedPath[] = (globalThis as SnippetFlags).__SID_NO_FORWARDING__ === true ? []
    : ownedPaths(base.modules.flatMap(name => registry.get(name) ?? []), base, base.basePath === '/' ? ROUTE_LIST : [base.basePath], options.forwardFetch !== undefined);
  // A module that sends requests from `run` (`fetching`) on an adapter that can't: a ConfigError, as for forwarding.
  if ((globalThis as SnippetFlags).__SID_NO_FORWARDING__ !== true) checkFetching(base.modules.flatMap(name => registry.get(name) ?? []), options.forwardFetch !== undefined);

  return async (request: Request, platform: PlatformInfo = {}): Promise<Response> => {
    const url = new URL(request.url);
    const route = routeOf(url.pathname, base.basePath);
    if (route === undefined) {
      // A forwarding module's path (builds without one leave this out: NO_FORWARDING).
      if ((globalThis as SnippetFlags).__SID_NO_FORWARDING__ !== true && options.forwardFetch !== undefined) {
        const owner = ownerOf(url.pathname, owned);
        if (owner !== undefined) return forwardRoute({ request, url, platform, owner, config: base, registry, send: options.forwardFetch });
      }
      return text(404, 'Not found');
    }

    if (request.method === 'OPTIONS' && route === ROUTES.v1) return preflight(request, base);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: route === ROUTES.v1 ? 'GET, HEAD, OPTIONS' : 'GET, HEAD', ...NO_STORE } });
    }

    const cookieHeader = request.headers.get('Cookie');
    // Oversized requests to the routes that run modules and mint IDs get no further, not even the cookie parsing. Opt-out
    // and opt-in are never refused, so they always work.
    if (route === ROUTES.sync || route === ROUTES.v1) {
      const refused = tooLarge(request, url, cookieHeader);
      if (refused !== undefined) return refused;
    }
    const cookies = parseCookies(cookieHeader);
    const secure = secureCookies(url);
    const date = now();
    // SID_COOKIE_DOMAIN=auto: the domain Prebid.js reports (`cookie_domain`) when it's this host or a parent of it, else
    // host-only. The host is the URL's: in trusted-upstream mode, the forwarded one, set only after the secret check.
    const host = hostKey(url);
    const cookieDomainParam = url.searchParams.get('cookie_domain');
    const autoDomain = autoCookieDomain(host, cookieDomainParam);
    const auto = base.cookieDomain === AUTO_COOKIE_DOMAIN;
    const config = auto ? { ...base, cookieDomain: autoDomain } : base;
    // Where deletions go. With auto, a cookie may be on the host or any domain above it (a browser refuses the public
    // suffixes among them), so they go to each.
    // Built only when used: most requests delete nothing.
    const sweep = (): (string | undefined)[] => [undefined, ...hostDomains(host)];
    const domains = (): (string | undefined)[] => auto ? sweep() : config.cookieDomain === undefined ? [undefined] : [config.cookieDomain, undefined];
    // A module cookie's Set-Cookie lines. A deletion on `auto` (its own, or core's) goes everywhere the cookie could be,
    // since the request may not carry the cookie_domain it was set with; an explicitly host-only one stays host-only.
    const moduleCookieLines = (cookie: ModuleCookie): string[] =>
      cookie.maxAgeSeconds === 0 && cookie.hostOnly !== true && (cookie.domain === AUTO_COOKIE_DOMAIN || (auto && cookie.domain === undefined))
        ? sweep().map(domain => serializeModuleCookie(domain === undefined ? { ...cookie, hostOnly: true } : { ...cookie, domain }, config, secure, date, undefined))
        : [serializeModuleCookie(cookie, config, secure, date, autoDomain)];

    switch (route) {
      case ROUTES.optout:
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), [
          // With auto, the opt-out cookie goes wherever an ID cookie could be, as the deletions do.
          ...(auto ? sweep() : [config.cookieDomain]).map(domain => serializeCookie(config.optOutCookieName, '1', { ...cookieOptions(config, secure, false), domain }, date)),
          ...expireIdCookies(config, domains(), secure, date),
          // Only cookies the browser sent: nothing to delete otherwise.
          ...optOutCookies(registry, config).filter(cookie => cookies.has(cookie.name)).flatMap(moduleCookieLines)
        ]);
      case ROUTES.optin:
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), domains().map(domain =>
          serializeCookie(config.optOutCookieName, '', { ...cookieOptions(config, secure, false), maxAgeSeconds: 0, domain }, date)
        ));
      case ROUTES.sync:
      case ROUTES.v1: {
        // A request the rate limiter refuses (429) gets no further: no consent, ID or module.
        if ((globalThis as SnippetFlags).__SID_NO_RATE_LIMIT__ !== true && options.rateLimit !== undefined
          && !await allows(options.rateLimit, { route: route === ROUTES.sync ? 'sync' : 'v1', host: hostKey(url), clientIp: platform.clientIp })) {
          return text(429, 'Too many requests');
        }
        const { consent, optedOut, signal } = privacySignals(request, url, platform, cookies, config, registry);
        const decision: StorageDecision = optedOut ? { allowed: false, reason: 'opt-out' }
          : (globalThis as SnippetFlags).__SID_NO_CONSENT_HOOKS__ === true ? storageDecision(config, consent)
            : storageDecisionWith(config, consent, signal);

        // The platform's verdict is known before anything runs: with SID_SKIP_BOTS it can rule the ID out up front.
        const platformTraffic = platformTrafficEntries(platform);
        let skipped = decision.allowed && skipsBot(config, mergeTraffic(platformTraffic));
        let state: IdState = NO_ID;
        if (decision.allowed && !skipped) {
          state = resolveId(config, cookies, route === ROUTES.sync ? idFromSyncParam(url.searchParams.get('id')) : undefined, newId);
        }

        // Modules run on both routes (on /sync, those configured for it). Their traffic reports join the platform's, so
        // SID_SKIP_BOTS sees the same merged verdict on /sync as on /v1.
        const context = { request, url, platform, sharedId: state.id, consent, cookies, optedOut, cookieDomain: config.cookieDomain, autoCookieDomain: autoDomain, storage: decision };
        // A module that declares `fetching` gets `fetch` when the decision allows requests for this visitor (builds
        // without a forwarding module leave this out: NO_FORWARDING).
        const send = options.forwardFetch;
        const fetchFor = (globalThis as SnippetFlags).__SID_NO_FORWARDING__ === true || send === undefined ? undefined
          : (module: EdgeModule): ModuleFetch | undefined => fetcher(module, config, consent, optedOut, signal, send);
        const modules = await runModules(registry, config, context, () => now().getTime(), route === ROUTES.sync ? 'sync' : 'v1', fetchFor);
        // A forwarding module's report says whether this visitor's requests to its paths are passed on, and a module that
        // sends requests from run whether it may for this visitor; nothing else.
        if ((globalThis as SnippetFlags).__SID_NO_FORWARDING__ !== true) {
          for (const { module } of owned) {
            const report = modules.reports[module.name];
            if (report === undefined || (report.status !== 'ok' && report.status !== 'empty')) continue;
            modules.reports[module.name] = { ...report, forwards: decisionFor(module, config, consent, optedOut, signal).forward };
          }
          for (const name of config.modules) {
            const module = registry.get(name);
            const report = modules.reports[name];
            if (module?.fetching === undefined || report === undefined || (report.status !== 'ok' && report.status !== 'empty')) continue;
            modules.reports[name] = { ...report, forwards: fetchDecision(module, config, consent, optedOut, signal).forward };
          }
        }
        const traffic = mergeTraffic([...platformTraffic, ...modules.traffic]);
        if (decision.allowed && !skipped && skipsBot(config, traffic)) {
          // SID_SKIP_BOTS: set and return no ID, but delete nothing, so a misclassified visitor keeps theirs.
          skipped = true;
          state = NO_ID;
        }

        const setCookies: string[] = [];
        if (state.id !== undefined) {
          setCookies.push(...idCookies(config, state.id, secure, date), ...hostOnlyDuplicates(config, cookieHeader, secure, date));
        } else if (!decision.allowed && (cookies.has(config.cookieName) || (config.recoveryCookieName !== undefined && cookies.has(config.recoveryCookieName)))) {
          setCookies.push(...expireIdCookies(config, domains(), secure, date));
        }

        const response = route === ROUTES.sync
          ? syncResponse({ modules, state, allowed: decision.allowed, config, moduleCookieLines })
          : payloadResponse({ request, modules, traffic, state, config, moduleCookieLines });
        // Which domain auto chose, or why it fell back to host-only.
        if (auto) response.headers.set('X-SharedID-Cookie-Domain', autoDomain ?? (cookieDomainParam !== null ? 'host-only: cookie_domain not this host or a parent' : 'host-only: no cookie_domain'));
        if (!decision.allowed) response.headers.set('X-SharedID-Status', `denied: ${decision.reason}`);
        else if (skipped) response.headers.set('X-SharedID-Status', 'skipped: bot');
        if (state.source !== undefined) response.headers.set('X-SharedID-Source', state.source);
        return withCookies(response, setCookies);
      }
    }
  };
}

/**
 * The `/sync` and `/v1` request limits, which forwarding paths share: a `414` for a path and query over
 * `MAX_URL_BYTES` (measured on `request.url`, which every runtime has), a `431` for a Cookie header over
 * `MAX_COOKIE_BYTES`; undefined when the request is within both.
 */
function tooLarge(request: Request, url: URL, cookieHeader: string | null): Response | undefined {
  const status = request.url.length - url.origin.length > MAX_URL_BYTES ? 414 : (cookieHeader?.length ?? 0) > MAX_COOKIE_BYTES ? 431 : 0;
  return status === 0 ? undefined : new Response(null, { status, headers: NO_STORE });
}

/**
 * A request's consent signals, whether the browser opted out, and the consent providers' signal (modules' `consent`
 * hooks), which they give first. Not asked on opt-out, which is denied anyway; a build whose modules have no hook
 * leaves them out (see NO_CONSENT_HOOKS in modules.ts).
 */
function privacySignals(request: Request, url: URL, platform: PlatformInfo, cookies: ReadonlyMap<string, string>, config: SharedIdEdgeConfig, registry: ModuleRegistry): { readonly consent: ConsentContext; readonly optedOut: boolean; readonly signal: ConsentSignal | undefined } {
  const consent = readConsent(url, request.headers, cookies, platform);
  const optedOut = cookies.has(config.optOutCookieName);
  const signal = optedOut || (globalThis as SnippetFlags).__SID_NO_CONSENT_HOOKS__ === true ? undefined : consentSignal(registry, config, { request, url, platform, consent, cookies });
  return { consent, optedOut, signal };
}

/**
 * `ModuleContext.fetch` for a module that declares `fetching` (spec: "Module requests"): the forwarding decision, with
 * GPC always blocking, and the module's consent checked as for running it; undefined when blocked.
 */
function fetcher(module: EdgeModule, config: SharedIdEdgeConfig, consent: ConsentContext, optedOut: boolean, signal: ConsentSignal | undefined, send: ForwardFetch): ModuleFetch | undefined {
  if (module.fetching === undefined) return undefined;
  const decision = fetchDecision(module, config, consent, optedOut, signal);
  return decision.forward ? forwarder(module.fetching.hosts, decision, send, moduleFetchLimitMs(config.moduleTimeoutMs)) : undefined;
}

/** Whether a module that declares `fetching` may send requests for this visitor: the forwarding decision, GPC blocking. */
function fetchDecision(module: EdgeModule, config: SharedIdEdgeConfig, consent: ConsentContext, optedOut: boolean, signal: ConsentSignal | undefined): ForwardDecision {
  return forwardDecision({}, config.moduleConfig[module.name] ?? {}, consent, optedOut, signal, consentDenial(module, consent), unreadableTcString());
}

/** A forwarding module's decision for a request (forwarding.ts), with the module's purposes checked where GDPR applies. */
function decisionFor(module: OwnedPath['module'], config: SharedIdEdgeConfig, consent: ConsentContext, optedOut: boolean, signal: ConsentSignal | undefined): ForwardDecision {
  return forwardDecision(module.forwarding, config.moduleConfig[module.name] ?? {}, consent, optedOut, signal, consentDenial(module, consent), unreadableTcString());
}

interface ForwardRouteInputs {
  readonly request: Request;
  readonly url: URL;
  readonly platform: PlatformInfo;
  readonly owner: OwnedPath;
  readonly config: SharedIdEdgeConfig;
  readonly registry: ModuleRegistry;
  readonly send: ForwardFetch;
}

/** A `POST` body for a forwarding module, within `MAX_FORWARD_BODY_BYTES`, or the response refusing it (`411`, `413`). */
async function forwardBody(request: Request): Promise<Uint8Array<ArrayBuffer> | Response> {
  const length = request.headers.get('Content-Length')?.trim();
  if (length === undefined) return new Response(null, { status: 411, headers: NO_STORE });
  if (!/^\d{1,6}$/.test(length) || Number(length) > MAX_FORWARD_BODY_BYTES) return new Response(null, { status: 413, headers: NO_STORE });
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > MAX_FORWARD_BODY_BYTES ? new Response(null, { status: 413, headers: NO_STORE }) : body;
}

/**
 * A request under a forwarding module's path (spec: "Forwarding modules"): the method and size checks, the forwarding
 * decision, the body of a `POST` (read only when the decision forwards), then the module's answer. No SharedID is
 * chosen and no cookie of the worker's is set. A module that throws, or whose outbound request fails, gives a `502`.
 */
async function forwardRoute(inputs: ForwardRouteInputs): Promise<Response> {
  const { request, url, platform, owner, config, registry, send } = inputs;
  const { method } = request;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, POST', ...NO_STORE } });
  const cookieHeader = request.headers.get('Cookie');
  const refused = tooLarge(request, url, cookieHeader);
  if (refused !== undefined) return refused;
  const cookies = parseCookies(cookieHeader);
  const { consent, optedOut, signal } = privacySignals(request, url, platform, cookies, config, registry);
  const { module, prefix } = owner;
  const decision = decisionFor(module, config, consent, optedOut, signal);
  const body = decision.forward && method === 'POST' ? await forwardBody(request) : undefined;
  if (body instanceof Response) return body;
  let response: Response;
  try {
    response = await module.forwarding.serve({
      request, url, platform, consent, cookies, optedOut, prefix, decision, body,
      config: config.moduleConfig[module.name] ?? {},
      secrets: config.moduleSecrets[module.name] ?? {},
      forward: forwarder(module.forwarding.hosts, decision, send)
    });
  } catch {
    // Nothing about the failure is returned or logged: it may contain request data.
    const failed = text(502, 'Bad gateway');
    failed.headers.set('X-SharedID-Forwarding', 'error');
    return failed;
  }
  return forwardedResponse(response, decision, method === 'HEAD');
}

/** Whether `limiter` lets the request through. It does when the limiter fails, so a platform outage refuses nobody. */
async function allows(limiter: RateLimiter, request: RateLimitRequest): Promise<boolean> {
  try {
    return await limiter(request);
  } catch {
    return true;
  }
}

const ROUTE_LIST: readonly Route[] = Object.values(ROUTES);

function routeOf(pathname: string, basePath: string): Route | undefined {
  const prefix = basePath === '/' ? '' : basePath;
  if (!pathname.startsWith(prefix + '/')) return undefined;
  const rest = trimEnd(pathname.slice(prefix.length), '/');
  return ROUTE_LIST.find(route => route === rest);
}

/**
 * The ID for this request, in order of preference:
 *
 * 1. The `HttpOnly` recovery copy. Only this worker writes it, so when it differs from the script-readable cookie,
 *    that cookie was capped or cleared (Safari) and re-minted by the page: the original is restored.
 * 2. The script-readable cookie. When the worker is first turned on there's no recovery copy yet, so an existing ID
 *    is adopted and nobody's ID is reset.
 * 3. The ID Prebid.js sends in `?id=` (on a first visit it calls `pixelUrl` before writing its own cookie).
 * 4. With `create`, a new one.
 */
function resolveId(config: SharedIdEdgeConfig, cookies: ReadonlyMap<string, string>, paramId: string | undefined, newId: () => string): IdState {
  const recoveryId = config.recoveryCookieName === undefined ? undefined : cookies.get(config.recoveryCookieName);
  const cookieId = cookies.get(config.cookieName);
  if (isValidId(recoveryId)) return { id: recoveryId, source: recoveryId === cookieId ? 'cookie' : 'recovery' };
  if (isValidId(cookieId)) return { id: cookieId, source: 'cookie' };
  if (paramId !== undefined) return { id: paramId, source: 'param' };
  if (config.create) return { id: newId(), source: 'minted' };
  return { id: undefined, source: undefined };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * `cookie_domain` for `auto`: a hostname of two labels or more (no port, scheme or IP address) that is `host` or a
 * parent of it at a label boundary, in lower case without a trailing dot; otherwise undefined.
 */
function autoCookieDomain(host: string, value: string | null): string | undefined {
  const domain = value?.toLowerCase().replace(/\.$/, '');
  if (domain === undefined || !domain.includes('.') || !HOSTNAME.test(domain) || IPV4.test(host)) return undefined;
  return host === domain || host.endsWith('.' + domain) ? domain : undefined;
}

/**
 * The host and each domain above it, short of the top level: `www.example.com`, `example.com`. None for an IP address,
 * or for a host that isn't a valid hostname (at most 253 characters), which also bounds the work.
 */
function hostDomains(host: string): string[] {
  if (!HOSTNAME.test(host) || IPV4.test(host)) return [];
  const labels = host.split('.');
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));
}

/** Names reserved for local and private use (RFC 6761, RFC 6762, and ICANN's .internal), never a public site. */
const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.example', '.invalid'];

/**
 * Whether cookies get `Secure`. On https, always. On plain http only local development omits it (a browser drops a
 * `Secure` cookie from an insecure origin): `localhost`, an IP address, or a name reserved for local use. A public
 * hostname over http means TLS ended in front of the worker (a proxy or load balancer, without SID_PUBLIC_ORIGIN), and
 * the visitor is on https, so the cookies are `Secure`, rather than set without it on a live site.
 */
function secureCookies(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  // An absolute name (`app.test.`) is the same host: drop the trailing dot before matching the suffixes.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const local = host === 'localhost' || host.startsWith('[') || IPV4.test(host) || LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix));
  return !local;
}

function cookieOptions(config: SharedIdEdgeConfig, secure: boolean, httpOnly: boolean): CookieOptions {
  return { maxAgeSeconds: config.maxAgeDays * 86_400, domain: config.cookieDomain, secure, httpOnly, sameSite: 'Lax' };
}

function idCookies(config: SharedIdEdgeConfig, id: string, secure: boolean, date: Date): string[] {
  const cookies = [serializeCookie(config.cookieName, id, cookieOptions(config, secure, false), date)];
  if (config.recoveryCookieName !== undefined) {
    cookies.push(serializeCookie(config.recoveryCookieName, id, cookieOptions(config, secure, true), date));
  }
  return cookies;
}

/**
 * With `SID_COOKIE_DOMAIN` set to a domain, deletes the host-only copy of an ID cookie the browser sent more than once.
 * A host-only `_pubcid` from before the domain was configured (from Prebid.js, or from this worker's old host-only
 * default) sits next to the domain cookie; the browser sends both, and the page and the worker can each read a different
 * one. The worker keeps the value it chose and sets it on the domain (idCookies); this removes the host-only copy, which
 * the deletion's missing `Domain` attribute targets without touching the domain cookie.
 */
function hostOnlyDuplicates(config: SharedIdEdgeConfig, cookieHeader: string | null, secure: boolean, date: Date): string[] {
  if (config.cookieDomain === undefined) return [];
  const names = [config.cookieName, ...(config.recoveryCookieName === undefined ? [] : [config.recoveryCookieName])];
  return names
    .filter(name => cookieValues(cookieHeader, name).length > 1)
    .map(name => serializeCookie(name, '', { ...cookieOptions(config, secure, name !== config.cookieName), maxAgeSeconds: 0, domain: undefined }, date));
}

/**
 * Deletes the ID cookies: an empty value, `Max-Age=0` and an `Expires` in the past. With `SID_COOKIE_DOMAIN`, a
 * host-only copy is deleted too, since Prebid.js may have written one before the worker was configured.
 */
function expireIdCookies(config: SharedIdEdgeConfig, domains: readonly (string | undefined)[], secure: boolean, date: Date): string[] {
  const cookies: string[] = [];
  for (const domain of domains) {
    const expired = { ...cookieOptions(config, secure, false), maxAgeSeconds: 0, domain };
    cookies.push(serializeCookie(config.cookieName, '', expired, date));
    if (config.recoveryCookieName !== undefined) {
      cookies.push(serializeCookie(config.recoveryCookieName, '', { ...expired, httpOnly: true }, date));
    }
  }
  return cookies;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The `pixelUrl` response: a 1x1 GIF, like the WordPress and Drupal plugins. When an ID was set, the browser may cache
 * it privately for `syncCacheSeconds`, which limits how often it re-syncs (and so how often modules run here);
 * otherwise it isn't cached, nor when a module that ran asked for that (`noStore`). Modules that run on `/sync` add only
 * their cookies (and that flag), and `X-SharedID-Modules` gives each
 * one's name and status, never cookie names, values or reasons. Their traffic reports count only towards
 * `SID_SKIP_BOTS`: there's no payload to return the signal in.
 */
interface SyncInputs {
  readonly modules: ModuleRunOutput;
  readonly state: IdState;
  readonly allowed: boolean;
  readonly config: SharedIdEdgeConfig;
  /** A module cookie's Set-Cookie lines for this request. */
  readonly moduleCookieLines: (cookie: ModuleCookie) => string[];
}

function syncResponse(inputs: SyncInputs): Response {
  const { modules, state, allowed, config, moduleCookieLines } = inputs;
  // A module that must see every sync (`noStore`) keeps it out of the browser's cache.
  const cacheable = allowed && state.id !== undefined && config.syncCacheSeconds > 0 && !modules.noStore;
  const response = new Response(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.byteLength),
      'Cache-Control': cacheable ? `private, max-age=${String(config.syncCacheSeconds)}` : 'no-store',
      'X-Robots-Tag': 'noindex'
    }
  });
  const statuses = Object.entries(modules.reports).map(([name, report]) => `${name}=${report.status}`);
  if (statuses.length > 0) response.headers.set('X-SharedID-Modules', statuses.join(', '));
  // Cookies only: there's no payload for eids, ortb2 or the traffic signal.
  for (const line of modules.cookies.flatMap(moduleCookieLines)) response.headers.append('Set-Cookie', line);
  return response;
}

interface PayloadInputs {
  readonly request: Request;
  readonly modules: ModuleRunOutput;
  /** The merged traffic signal: the platform's verdict and the modules' reports. */
  readonly traffic: TrafficSignal | undefined;
  readonly state: IdState;
  readonly config: SharedIdEdgeConfig;
  readonly moduleCookieLines: (cookie: ModuleCookie) => string[];
}

function payloadResponse(inputs: PayloadInputs): Response {
  const { request, modules, traffic, state, config, moduleCookieLines } = inputs;
  const eids: Eid[] = state.id === undefined ? [] : [{ source: 'pubcid.org', uids: [{ id: state.id, atype: 1 }] }];
  eids.push(...modules.eids);
  // Written by core from the merged signal, after the modules' fragments, so no module's output can replace it.
  const ortb2 = traffic === undefined ? modules.ortb2 : deepMerge(modules.ortb2 ?? {}, { device: { ext: { traffic } } });
  const payload: PayloadV1 = {
    v: 1,
    ...(state.id === undefined ? {} : { sharedid: state.id }),
    eids,
    ...(ortb2 === undefined ? {} : { ortb2 }),
    ...(modules.eip === undefined ? {} : { eip: modules.eip }),
    ext: { modules: modules.reports }
  };
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE, 'X-Robots-Tag': 'noindex' }
  });
  applyCors(request, config, response.headers);
  for (const line of modules.cookies.flatMap(moduleCookieLines)) response.headers.append('Set-Cookie', line);
  return response;
}

/** A module cookie's `Set-Cookie`. A `domain` of `auto` is the request's `auto` domain, or host-only. */
function serializeModuleCookie(cookie: ModuleCookie, config: SharedIdEdgeConfig, secure: boolean, date: Date, autoDomain: string | undefined): string {
  const options: CookieOptions = {
    maxAgeSeconds: cookie.maxAgeSeconds,
    domain: cookie.hostOnly === true ? undefined : cookie.domain === AUTO_COOKIE_DOMAIN ? autoDomain : (cookie.domain ?? config.cookieDomain),
    secure,
    httpOnly: cookie.httpOnly,
    sameSite: 'Lax'
  };
  return serializeCookie(cookie.name, cookie.value, options, date);
}

function applyCors(request: Request, config: SharedIdEdgeConfig, headers: Headers): void {
  const origin = request.headers.get('Origin');
  headers.append('Vary', 'Origin');
  if (origin !== null && config.allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
}

function preflight(request: Request, config: SharedIdEdgeConfig): Response {
  const response = new Response(null, { status: 204, headers: { ...NO_STORE, 'Access-Control-Max-Age': '600' } });
  applyCors(request, config, response.headers);
  if (response.headers.has('Access-Control-Allow-Origin')) response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD');
  return response;
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}

/**
 * A plain-text response that isn't stored, for errors (`404 Not found`; the request limits' `414` and `431`; the rate
 * limiter's `429`; trusted upstream's `403` and `400`). The body never contains request data.
 */
export function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
}
