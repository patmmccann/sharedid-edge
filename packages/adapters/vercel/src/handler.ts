import { createHandler, DEFAULT_CONFIG, type HandlerOptions, ROUTES } from '@sharedid-edge/core';
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
  const handler = createHandler(options);
  return async request => {
    try {
      return await handler(await withOrigin(request, options.publicOrigin), platformInfo(request.headers, options));
    } catch (error) {
      // Don't echo or log the error's message: it may contain request data.
      console.error('sharedid-edge: request failed', error instanceof Error ? error.name : 'unknown error');
      return internalError('Internal error');
    }
  };
}

/**
 * Builds middleware: requests under `config.basePath` (`/_sid` by default) get the handler's response, and any
 * other request `undefined`, so a matcher that's broader than the base path doesn't take over the site.
 */
export function createVercelMiddleware(options: VercelHandlerOptions = {}): VercelMiddleware {
  return middleware(createVercelHandler(options), options.config?.basePath ?? DEFAULT_CONFIG.basePath);
}

/**
 * Wraps a handler so it answers only requests under `basePath`. With the root base path (`/`), that's exactly
 * core's routes (`/sync`, `/v1`, `/optout`, `/optin`, with an optional trailing slash): anything else is the
 * site's, so the middleware passes it on.
 */
export function middleware(handler: VercelHandler, basePath: string): VercelMiddleware {
  return async request => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    return ownsPath(pathname, basePath) ? handler(request) : undefined;
  };
}

const CORE_ROUTES: readonly string[] = Object.values(ROUTES);

/** Whether a path belongs to the worker for `basePath`. */
export function ownsPath(pathname: string, basePath: string): boolean {
  if (basePath === '/') return CORE_ROUTES.includes(pathname.replace(/\/+$/, ''));
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): Response {
  return new Response(message, {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/** The request, with its URL moved to `publicOrigin` when one is set. */
async function withOrigin(request: Request, publicOrigin: string | undefined): Promise<Request> {
  if (publicOrigin === undefined) return request;
  const url = new URL(request.url);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(`${url.pathname}${url.search}`, publicOrigin), {
    method: request.method,
    headers: request.headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {})
  });
}
