import { DEFAULT_CONFIG, type SharedIdEdgeConfig } from './config.js';
import { hostKey } from './hosts.js';
import { readConsent, storageDecision, type StorageDecision } from './consent.js';
import { cookieValues, parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
import { idFromSyncParam, isValidId, mintId } from './id.js';
import { deepMerge, ModuleRegistry, optOutCookies, runModules, type EdgeModule, type ModuleCookie, type ModuleRunOutput } from './modules.js';
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
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** ID generator, for tests. */
  readonly mintId?: () => string;
}

/** The Cloudflare Snippet build's flags (see createHandler); unset everywhere else. */
interface SnippetFlags {
  readonly __SID_PREVALIDATED__?: boolean;
  readonly __SID_UNUSED_HOSTS__?: boolean;
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
 * It answers every route under `config.basePath` itself and never forwards a request to the origin.
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
function configuredHandler(options: HandlerOptions, config: SharedIdEdgeConfig, registry: ModuleRegistry): SharedIdEdgeHandler {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.mintId ?? mintId;

  return async (request: Request, platform: PlatformInfo = {}): Promise<Response> => {
    const url = new URL(request.url);
    const route = routeOf(url.pathname, config.basePath);
    if (route === undefined) return text(404, 'Not found');

    if (request.method === 'OPTIONS' && route === ROUTES.v1) return preflight(request, config);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: route === ROUTES.v1 ? 'GET, HEAD, OPTIONS' : 'GET, HEAD', ...NO_STORE } });
    }

    const cookieHeader = request.headers.get('Cookie');
    const cookies = parseCookies(cookieHeader);
    const secure = secureCookies(url);
    const date = now();

    switch (route) {
      case ROUTES.optout:
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), [
          serializeCookie(config.optOutCookieName, '1', cookieOptions(config, secure, false), date),
          ...expireIdCookies(config, secure, date),
          // Only cookies the browser sent: nothing to delete otherwise.
          ...optOutCookies(registry, config).filter(cookie => cookies.has(cookie.name)).map(cookie => serializeModuleCookie(cookie, config, secure, date))
        ]);
      case ROUTES.optin: {
        const domains = config.cookieDomain === undefined ? [undefined] : [config.cookieDomain, undefined];
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), domains.map(domain =>
          serializeCookie(config.optOutCookieName, '', { ...cookieOptions(config, secure, false), maxAgeSeconds: 0, domain }, date)
        ));
      }
      case ROUTES.sync:
      case ROUTES.v1: {
        const consent = readConsent(url, request.headers, cookies, platform);
        const optedOut = cookies.has(config.optOutCookieName);
        const decision: StorageDecision = optedOut ? { allowed: false, reason: 'opt-out' } : storageDecision(config, consent);

        // The platform's verdict is known before anything runs: with SID_SKIP_BOTS it can rule the ID out up front.
        const platformTraffic = platformTrafficEntries(platform);
        let skipped = decision.allowed && skipsBot(config, mergeTraffic(platformTraffic));
        let state: IdState = NO_ID;
        if (decision.allowed && !skipped) {
          state = resolveId(config, cookies, route === ROUTES.sync ? idFromSyncParam(url.searchParams.get('id')) : undefined, newId);
        }

        // Modules run on both routes (on /sync, those configured for it). Their traffic reports join the platform's, so
        // SID_SKIP_BOTS sees the same merged verdict on /sync as on /v1.
        const context = { request, url, platform, sharedId: state.id, consent, cookies, optedOut, cookieDomain: config.cookieDomain, storage: decision };
        const modules = await runModules(registry, config, context, () => now().getTime(), route === ROUTES.sync ? 'sync' : 'v1');
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
          setCookies.push(...expireIdCookies(config, secure, date));
        }

        const response = route === ROUTES.sync
          ? syncResponse({ modules, state, allowed: decision.allowed, config, secure, date })
          : payloadResponse({ request, modules, traffic, state, config, secure, date });
        if (!decision.allowed) response.headers.set('X-SharedID-Status', `denied: ${decision.reason}`);
        else if (skipped) response.headers.set('X-SharedID-Status', 'skipped: bot');
        if (state.source !== undefined) response.headers.set('X-SharedID-Source', state.source);
        return withCookies(response, setCookies);
      }
    }
  };
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

/** Names reserved for local and private use (RFC 6761, RFC 6762, and ICANN's .internal), never a public site. */
const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.example', '.invalid'];
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

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
function expireIdCookies(config: SharedIdEdgeConfig, secure: boolean, date: Date): string[] {
  const domains = config.cookieDomain === undefined ? [undefined] : [config.cookieDomain, undefined];
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
  readonly secure: boolean;
  readonly date: Date;
}

function syncResponse(inputs: SyncInputs): Response {
  const { modules, state, allowed, config, secure, date } = inputs;
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
  for (const cookie of modules.cookies) response.headers.append('Set-Cookie', serializeModuleCookie(cookie, config, secure, date));
  return response;
}

interface PayloadInputs {
  readonly request: Request;
  readonly modules: ModuleRunOutput;
  /** The merged traffic signal: the platform's verdict and the modules' reports. */
  readonly traffic: TrafficSignal | undefined;
  readonly state: IdState;
  readonly config: SharedIdEdgeConfig;
  readonly secure: boolean;
  readonly date: Date;
}

function payloadResponse(inputs: PayloadInputs): Response {
  const { request, modules, traffic, state, config, secure, date } = inputs;
  const eids: Eid[] = state.id === undefined ? [] : [{ source: 'pubcid.org', uids: [{ id: state.id, atype: 1 }] }];
  eids.push(...modules.eids);
  // Written by core from the merged signal, after the modules' fragments, so no module's output can replace it.
  const ortb2 = traffic === undefined ? modules.ortb2 : deepMerge(modules.ortb2 ?? {}, { device: { ext: { traffic } } });
  const payload: PayloadV1 = {
    v: 1,
    ...(state.id === undefined ? {} : { sharedid: state.id }),
    eids,
    ...(ortb2 === undefined ? {} : { ortb2 }),
    ext: { modules: modules.reports }
  };
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE, 'X-Robots-Tag': 'noindex' }
  });
  applyCors(request, config, response.headers);
  for (const cookie of modules.cookies) response.headers.append('Set-Cookie', serializeModuleCookie(cookie, config, secure, date));
  return response;
}

function serializeModuleCookie(cookie: ModuleCookie, config: SharedIdEdgeConfig, secure: boolean, date: Date): string {
  const options: CookieOptions = {
    maxAgeSeconds: cookie.maxAgeSeconds,
    domain: cookie.hostOnly === true ? undefined : (cookie.domain ?? config.cookieDomain),
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

/** A plain-text response that isn't stored, for errors (`404 Not found`, and trusted upstream's `403` and `400`). */
export function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
}
