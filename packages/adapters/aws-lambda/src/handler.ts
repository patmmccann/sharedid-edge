import { createHandler, fetchForward, logRequestFailure, splitHeaders, withTrustedUpstream, type HandlerOptions, type TrustedUpstream } from '@sharedid-edge/core';
import { encodeBody, nonEmpty } from './body.js';
import type { LambdaEventV2, LambdaResultV2 } from './event.js';
import { platformInfo, type PlatformOptions } from './platform.js';

export interface LambdaHandlerOptions extends HandlerOptions, PlatformOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to `https://` and the
   * `X-Forwarded-Host` header, else `Host`, else the event's `domainName`: CloudFront and function URLs only speak
   * https to the function, and the scheme decides whether cookies are `Secure`.
   */
  readonly publicOrigin?: string;
  /**
   * Trusted-upstream mode (`trustedUpstreamFromEnv`), for a function behind a publisher's CDN: requests without the
   * shared secret get a 403, and the client IP, location and host come from the CDN's headers, not
   * `CloudFront-Viewer-*`, which then describe the CDN. Undefined: off.
   */
  readonly upstream?: TrustedUpstream | undefined;
}

/** A Lambda handler for function URL and HTTP API (payload format 2.0) events. */
export type LambdaHandler = (event: LambdaEventV2) => Promise<LambdaResultV2>;

/** Builds a Lambda handler around the core SharedID Edge handler. */
export function createLambdaHandler(options: LambdaHandlerOptions = {}): LambdaHandler {
  const handler = withTrustedUpstream(createHandler({ forwardFetch: fetchForward, ...options }), options.upstream);
  return async event => {
    try {
      const request = toRequest(event, options.publicOrigin);
      return await toResult(await handler(request, platformInfo(event, options)), request.method);
    } catch (error) {
      logRequestFailure(error);
      return internalError('Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function internalError(message: string): LambdaResultV2 {
  return {
    statusCode: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    cookies: [],
    body: message,
    isBase64Encoded: false
  };
}

function toRequest(event: LambdaEventV2, publicOrigin: string | undefined): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  // Payload format 2.0 moves the Cookie header into `cookies`; join it back.
  const cookies = event.cookies ?? [];
  if (cookies.length > 0) {
    const existing = headers.get('cookie');
    headers.set('cookie', [...(existing === null || existing === '' ? [] : [existing]), ...cookies].join('; '));
  }
  const host = nonEmpty(headers.get('x-forwarded-host')?.split(',')[0]?.trim())
    ?? nonEmpty(headers.get('host'))
    ?? nonEmpty(event.requestContext.domainName)
    ?? 'localhost';
  const origin = publicOrigin ?? `https://${host}`;
  const query = event.rawQueryString ?? '';
  const url = new URL(`${event.rawPath}${query === '' ? '' : `?${query}`}`, origin);
  const method = event.requestContext.http.method.toUpperCase();
  // Only a POST keeps its body (a forwarding module's path reads one), as a stream decoded when it's first read: core
  // reads it only when a forwarding module forwards, so no other route decodes it before its 405.
  const { body } = event;
  if (method !== 'POST' || body === undefined || body === '') return new Request(url, { method, headers });
  // A high-water mark of 0, so the stream doesn't pull (and decode) before anything reads it.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(event.isBase64Encoded === true ? Buffer.from(body, 'base64') : new TextEncoder().encode(body));
      controller.close();
    }
  }, { highWaterMark: 0 });
  // `duplex` (Node.js needs it for a stream body) isn't in the DOM library's RequestInit.
  const init: RequestInit & { readonly duplex: 'half' } = { method, headers, body: stream, duplex: 'half' };
  return new Request(url, init);
}

async function toResult(response: Response, method: string): Promise<LambdaResultV2> {
  const { headers, cookies } = splitHeaders(response.headers);
  const { body, base64 } = await encodeBody(response, method);
  return { statusCode: response.status, headers, cookies, body, isBase64Encoded: base64 };
}
