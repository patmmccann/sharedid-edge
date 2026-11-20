import { createHandler, DEFAULT_CONFIG, fetchForward, forwardingPaths, hostKey, logRequestFailure, type EdgeModule, type HandlerOptions, ROUTES, type SharedIdEdgeConfig, withPublicOrigin } from '@sharedid-edge/core';
import { platformInfo, type PlatformOptions } from './platform.js';

export interface VercelHandlerOptions extends HandlerOptions, PlatformOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to the request's own URL, which on
   * Vercel is the https URL the visitor asked for. Only the scheme matters to the handler: `https` makes cookies
   * `Secure`.
   */
  readonly publicOrigin?: string;
}

/**
 * A web-standard handler: a Next.js route handler (`export const GET = handler`), a Vercel Function's `fetch`, or
 * anything else that takes a `Request` and returns a `Response`.
 */
export type VercelHandler = (request: Request) => Promise<Response>;

/**
 * Routing Middleware (or a Next.js `proxy.ts`/`middleware.ts`): answers requests under the base path and returns
 * `undefined` for every other request, so the caller lets them continue to the site.
 */
export type VercelMiddleware = (request: Request) => Promise<Response | undefined>;

/** Builds a handler around the core SharedID Edge handler. It answers every request it gets. */
export function createVercelHandler(options: VercelHandlerOptions = {}): VercelHandler {
  const handler = createHandler({ forwardFetch: fetchForward, ...options });
  return async request => {
    try {
      return await handler(await withPublicOrigin(request, options.publicOrigin), platformInfo(request.headers, options));
    } catch (error) {
      logRequestFailure(error);
      return internalError('Internal error');
    }
  };
}

/**
 * Builds middleware: requests under `config.basePath` (`/_sid` by default) get the handler's response, and any
 * other request `undefined`, so a matcher that's broader than the base path doesn't take over the site.
 */
export function createVercelMiddleware(options: VercelHandlerOptions = {}): VercelMiddleware {
  const config = options.config ?? DEFAULT_CONFIG;
  return middleware(createVercelHandler(options), config.basePath, forwardingPathsFor(config, options.hosts, options.modules ?? [], options.publicOrigin));
}

/** The forwarding paths a request may be under: see `forwardingPathsFor`. */
export type ForwardingPathsFor = (request: Request) => readonly string[];

/**
 * The paths of the forwarding modules (such as `tag-gateway`'s `/metrics`) for a request: those of its site's
 * settings, picked as the handler picks them (`SID_HOSTS` by the request's host, on `publicOrigin` when it's set),
 * else the deployment's; none for a host `SID_HOSTS` doesn't list. Worked out once per configuration.
 */
export function forwardingPathsFor(config: SharedIdEdgeConfig, hosts: ReadonlyMap<string, SharedIdEdgeConfig> | undefined, modules: Iterable<EdgeModule>, publicOrigin?: string): ForwardingPathsFor {
  const list = [...modules];
  const known = new WeakMap<SharedIdEdgeConfig, readonly string[]>();
  return request => {
    const site = hosts === undefined ? config : hosts.get(hostKey(new URL(publicOrigin ?? request.url)));
    if (site === undefined) return [];
    let paths = known.get(site);
    if (paths === undefined) {
      paths = forwardingPaths(site, list);
      known.set(site, paths);
    }
    return paths;
  };
}

/**
 * Wraps a handler so it answers only requests under `basePath`, and under the paths `forwarding` gives for the
 * request, those of the forwarding modules in its site's `SID_MODULES` (such as `tag-gateway`'s `/metrics`). With the root base path (`/`), that's exactly
 * core's routes (`/sync`, `/v1`, `/optout`, `/optin`, with an optional trailing slash): anything else is the
 * site's, so the middleware passes it on.
 */
export function middleware(handler: VercelHandler, basePath: string, forwarding: ForwardingPathsFor = () => []): VercelMiddleware {
  return async request => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    return ownsPath(pathname, basePath) || forwarding(request).some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)) ? handler(request) : undefined;
  };
}

const CORE_ROUTES: readonly string[] = Object.values(ROUTES);

/** `path` without trailing `/`s. A loop, not a regular expression, so it stays linear on long runs of `/`. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

/** Whether a path belongs to the worker for `basePath`. */
export function ownsPath(pathname: string, basePath: string): boolean {
  if (basePath === '/') return CORE_ROUTES.includes(withoutTrailingSlashes(pathname));
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): Response {
  return new Response(message, {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}
