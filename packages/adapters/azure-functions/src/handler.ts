import { createHandler, logRequestFailure, splitHeaders, type HandlerOptions } from '@sharedid-edge/core';
import { parseSetCookie, preservedByHost } from './cookies.js';
import { platformInfo, type PlatformOptions } from './platform.js';
import type { AzureCookie, AzureHttpRequest, AzureHttpResponseInit } from './types.js';

export interface AzureHandlerOptions extends HandlerOptions, PlatformOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to the request's own URL, which
   * behind Front Door is the function app's https URL. Only the scheme matters to the handler: `https` makes cookies
   * `Secure`.
   */
  readonly publicOrigin?: string;
  /**
   * Your Front Door profile's ID (its `X-Azure-FDID` header), or several, to accept requests from those profiles
   * only. Requests with another or no `X-Azure-FDID` get a 403. A second lock besides the function app's access
   * restrictions, which should allow only the `AzureFrontDoor.Backend` service tag.
   */
  readonly frontDoorIds?: readonly string[];
}

/** An Azure Functions v4 HTTP handler. */
export type AzureHandler = (request: AzureHttpRequest, context?: unknown) => Promise<AzureHttpResponseInit>;

/** Builds an Azure Functions v4 HTTP handler around the core SharedID Edge handler. */
export function createAzureHandler(options: AzureHandlerOptions = {}): AzureHandler {
  const handler = createHandler(options);
  const frontDoorIds = options.frontDoorIds?.map(id => id.toLowerCase()) ?? [];
  return async request => {
    try {
      if (frontDoorIds.length > 0 && !frontDoorIds.includes(request.headers.get('x-azure-fdid')?.trim().toLowerCase() ?? '')) {
        return plainText(403, 'Forbidden');
      }
      const response = await handler(await toRequest(request, options.publicOrigin), platformInfo(request.headers, options));
      return await toResponseInit(response, request.method);
    } catch (error) {
      logRequestFailure(error);
      return internalError('Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): AzureHttpResponseInit {
  return plainText(500, message);
}

function plainText(status: number, message: string): AzureHttpResponseInit {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    cookies: [],
    body: new TextEncoder().encode(message)
  };
}

async function toRequest(request: AzureHttpRequest, publicOrigin: string | undefined): Promise<Request> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(publicOrigin === undefined ? url : new URL(`${url.pathname}${url.search}`, publicOrigin), {
    method,
    headers: request.headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {})
  });
}

/**
 * The `Response` as an `HttpResponseInit`. Each `Set-Cookie` becomes an entry of `cookies[]`: the Functions host
 * keeps one value per header name, so cookies in `headers` would be lost or joined.
 */
export async function toResponseInit(response: Response, method: string): Promise<AzureHttpResponseInit> {
  const { headers, cookies: setCookies } = splitHeaders(response.headers);
  const cookies: AzureCookie[] = [];
  let rawCookie: string | undefined;
  for (const header of setCookies) {
    const cookie = parseSetCookie(header);
    if (preservedByHost(cookie.value)) {
      cookies.push(cookie);
    } else {
      // The Functions host percent-encodes Cookie values supplied through cookies[]. Keep the exact Set-Cookie header
      // in the response headers instead. This bypasses that transformation while preserving the cookie byte for byte.
      if (rawCookie === undefined) rawCookie = header;
      else console.error(`sharedid-edge: not setting cookie ${cookie.name}: Azure Functions cannot preserve multiple raw Set-Cookie headers`);
    }
  }
  const outputHeaders = rawCookies.length === 0
    ? headers
    : { ...headers, 'set-cookie': rawCookies.length === 1 ? rawCookies[0] : rawCookies.join('\n') };
  const body = method.toUpperCase() === 'HEAD' || response.body === null ? undefined : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: outputHeaders, cookies, ...(body === undefined || body.byteLength === 0 ? {} : { body }) };
}
