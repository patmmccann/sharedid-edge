import { createHandler, logRequestFailure, withPublicOrigin, type HandlerOptions } from '@sharedid-edge/core';
import type { FastlyClientInfo } from './fastly.js';
import { platformInfo } from './platform.js';

export interface FastlyHandlerOptions extends HandlerOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to the request's own URL, which on
   * Fastly Compute is the https URL the visitor asked for, with the visitor's `Host`: the scheme decides whether
   * cookies are `Secure`, and the host picks the site's settings with `SID_HOSTS`.
   */
  readonly publicOrigin?: string;
}

/** Answers a Compute request (`event.request`) for the client that sent it (`event.client`). */
export type FastlyHandler = (request: Request, client: FastlyClientInfo) => Promise<Response>;

/**
 * Builds a Fastly Compute handler around the core SharedID Edge handler. It answers every request it gets and never
 * throws: anything that fails becomes a generic 500. Call it from your own Compute app's fetch listener for requests
 * under the base path, or deploy the package's entry point (`deploy/main.wasm`), which answers every request it gets.
 */
export function createFastlyHandler(options: FastlyHandlerOptions = {}): FastlyHandler {
  const handler = createHandler(options);
  return async (request, client) => {
    try {
      return await handler(await withPublicOrigin(request, options.publicOrigin), platformInfo(client));
    } catch (error) {
      logRequestFailure(error);
      return internalError('Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): Response {
  return new Response(message, {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}
