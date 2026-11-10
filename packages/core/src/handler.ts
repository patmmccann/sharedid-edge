import { DEFAULT_CONFIG, type SharedIdEdgeConfig } from './config.js';
import { readConsent, storageDecision, type ConsentContext, type StorageDecision } from './consent.js';
import { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
import { idFromSyncParam, isValidId, mintId } from './id.js';
import { ModuleRegistry, optOutCookies, runModules, type EdgeModule, type ModuleContext, type ModuleCookie } from './modules.js';
import { trimEnd } from './text.js';
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
  /** Modules the worker is built with; `config.modules` chooses which run. */
  readonly modules?: Iterable<EdgeModule>;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** ID generator, for tests. */
  readonly mintId?: () => string;
}

export type SharedIdEdgeHandler = (request: Request, platform?: PlatformInfo) => Promise<Response>;

/** The source of the ID in a response, for the `X-SharedID-Source` debug header. */
type IdSource = 'cookie' | 'recovery' | 'param' | 'minted';

interface IdState {
  readonly id: string | undefined;
  readonly source: IdSource | undefined;
}

/**
 * Creates the request handler. Platform adapters call it with the request and what the platform knows about it.
 * It answers every route under `config.basePath` itself and never forwards a request to the origin.
 */
export function createHandler(options: HandlerOptions = {}): SharedIdEdgeHandler {
  const config = options.config ?? DEFAULT_CONFIG;
  const registry = new ModuleRegistry(options.modules ?? []);
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

    const cookies = parseCookies(request.headers.get('Cookie'));
    const secure = url.protocol === 'https:';
    const date = now();

    switch (route) {
      case ROUTES.optout:
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), [
          serializeCookie(config.optOutCookieName, '1', cookieOptions(config, secure, false), date),
          ...expireIdCookies(config, secure, date),
          // Only cookies the browser sent: nothing to delete otherwise.
          ...optOutCookies(registry, config).filter(cookie => cookies.has(cookie.name)).map(cookie => serializeModuleCookie(cookie, config, secure, date))
        ]);
      case ROUTES.optin:
        return withCookies(new Response(null, { status: 204, headers: NO_STORE }), [
          serializeCookie(config.optOutCookieName, '', { ...cookieOptions(config, secure, false), maxAgeSeconds: 0 }, date)
        ]);
      case ROUTES.sync:
      case ROUTES.v1: {
        const consent = readConsent(url, request.headers, cookies, platform);
        const optedOut = cookies.has(config.optOutCookieName);
        const decision: StorageDecision = optedOut ? { allowed: false, reason: 'opt-out' } : storageDecision(config, consent);

        let state: IdState = { id: undefined, source: undefined };
        const setCookies: string[] = [];
        if (decision.allowed) {
          state = resolveId(config, cookies, route === ROUTES.sync ? idFromSyncParam(url.searchParams.get('id')) : undefined, newId);
          if (state.id !== undefined) setCookies.push(...idCookies(config, state.id, secure, date));
        } else if (cookies.has(config.cookieName) || (config.recoveryCookieName !== undefined && cookies.has(config.recoveryCookieName))) {
          setCookies.push(...expireIdCookies(config, secure, date));
        }

        const context = { request, url, platform, sharedId: state.id, consent, cookies, optedOut, storage: decision };
        const response = route === ROUTES.sync
          ? await syncResponse(config, state, decision.allowed, registry, context, now, secure, date)
          : await payloadResponse({ request, url, platform, consent, cookies, optedOut, storage: decision, state, registry, config, now, secure, date });
        if (!decision.allowed) response.headers.set('X-SharedID-Status', `denied: ${decision.reason}`);
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
 * otherwise it isn't cached. Modules that run on `/sync` add only their cookies, and `X-SharedID-Modules` gives each
 * one's name and status, never cookie names, values or reasons.
 */
async function syncResponse(
  config: SharedIdEdgeConfig,
  state: IdState,
  allowed: boolean,
  registry: ModuleRegistry,
  context: Omit<ModuleContext, 'config' | 'secrets'>,
  now: () => Date,
  secure: boolean,
  date: Date
): Promise<Response> {
  const modules = await runModules(registry, config, context, () => now().getTime(), 'sync');
  const cacheable = allowed && state.id !== undefined && config.syncCacheSeconds > 0;
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
  // Cookies only: there's no payload for eids or ortb2.
  for (const cookie of modules.cookies) response.headers.append('Set-Cookie', serializeModuleCookie(cookie, config, secure, date));
  return response;
}

interface PayloadInputs {
  readonly request: Request;
  readonly url: URL;
  readonly platform: PlatformInfo;
  readonly consent: ConsentContext;
  readonly cookies: ReadonlyMap<string, string>;
  readonly optedOut: boolean;
  readonly storage: StorageDecision;
  readonly state: IdState;
  readonly registry: ModuleRegistry;
  readonly config: SharedIdEdgeConfig;
  readonly now: () => Date;
  readonly secure: boolean;
  readonly date: Date;
}

async function payloadResponse(inputs: PayloadInputs): Promise<Response> {
  const { request, url, platform, consent, cookies, optedOut, storage, state, registry, config, now, secure, date } = inputs;
  const modules = await runModules(registry, config, { request, url, platform, sharedId: state.id, consent, cookies, optedOut, storage }, () => now().getTime());
  const eids: Eid[] = state.id === undefined ? [] : [{ source: 'pubcid.org', uids: [{ id: state.id, atype: 1 }] }];
  eids.push(...modules.eids);
  const payload: PayloadV1 = {
    v: 1,
    ...(state.id === undefined ? {} : { sharedid: state.id }),
    eids,
    ...(modules.ortb2 === undefined ? {} : { ortb2: modules.ortb2 }),
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
    domain: cookie.domain ?? config.cookieDomain,
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

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
}
