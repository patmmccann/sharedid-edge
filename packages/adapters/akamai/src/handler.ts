import { createHandler, logRequestFailure, splitHeaders, type HandlerOptions } from '@sharedid-edge/core';
import type { EdgeWorkerRequest, EdgeWorkerResult } from './edgeworkers.js';
import { platformInfo } from './platform.js';

export interface EdgeWorkerHandlerOptions extends HandlerOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to the request's own scheme and
   * `Host` (`request.scheme`, `request.host`), which is right on Akamai: only the scheme decides whether cookies are
   * `Secure`, and the host picks the site's settings with `SID_HOSTS`.
   */
  readonly publicOrigin?: string;
}

/** Answers an EdgeWorkers request with what `responseProvider` passes to `createResponse`. */
export type EdgeWorkerHandler = (request: EdgeWorkerRequest) => Promise<EdgeWorkerResult>;

/** Builds an EdgeWorkers handler around the core SharedID Edge handler. */
export function createEdgeWorkerHandler(options: EdgeWorkerHandlerOptions = {}): EdgeWorkerHandler {
  const handler = createHandler(options);
  return async request => {
    try {
      const webRequest = toRequest(request, options.publicOrigin);
      return await toResult(await handler(webRequest, platformInfo(request)), webRequest.method);
    } catch (error) {
      logRequestFailure(error);
      return internalError('Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): EdgeWorkerResult {
  return {
    status: 500,
    headers: { 'content-type': ['text/plain; charset=utf-8'], 'cache-control': ['no-store'] },
    body: new TextEncoder().encode(message)
  };
}

function toRequest(request: EdgeWorkerRequest, publicOrigin: string | undefined): Request {
  const headers: [string, string][] = [];
  for (const [name, values] of Object.entries(request.getHeaders())) {
    if (values === undefined || values.length === 0) continue;
    // HTTP/2 may send the Cookie header as several lines; they join with "; ". Other repeated headers join with ", ".
    headers.push([name, values.join(name.toLowerCase() === 'cookie' ? '; ' : ', ')]);
  }
  const host = request.host.trim() === '' ? 'localhost' : request.host.trim();
  const origin = new URL(publicOrigin ?? `${request.scheme.toLowerCase() === 'http' ? 'http' : 'https'}://${host}`).origin;
  // Appended rather than resolved against the origin, so a path starting with `//` can't change the host.
  const target = request.url.startsWith('/') ? request.url : `/${request.url}`;
  return new Request(`${origin}${target}`, { method: request.method.toUpperCase(), headers });
}

async function toResult(response: Response, method: string): Promise<EdgeWorkerResult> {
  const split = splitHeaders(response.headers);
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(split.headers)) {
    // The platform sets the length; a wrong one would break the response.
    if (name !== 'content-length') headers[name] = [value];
  }
  // One array entry per Set-Cookie header line: joining them would break the cookies.
  if (split.cookies.length > 0) headers['set-cookie'] = split.cookies;
  const body = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers, body };
}
