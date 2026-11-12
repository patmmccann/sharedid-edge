import { Buffer } from 'node:buffer';
import { createHandler, logRequestFailure, splitHeaders, withTrustedUpstream, type HandlerOptions, type TrustedUpstream } from '@sharedid-edge/core';
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
  const handler = withTrustedUpstream(createHandler(options), options.upstream);
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
  const hasBody = method !== 'GET' && method !== 'HEAD' && event.body !== undefined;
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: event.isBase64Encoded === true ? Buffer.from(event.body ?? '', 'base64') : event.body } : {})
  });
}

async function toResult(response: Response, method: string): Promise<LambdaResultV2> {
  const { headers, cookies } = splitHeaders(response.headers);
  const bytes = method === 'HEAD' || response.body === null ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
  // Text stays text, so it's readable in logs and tests; anything else (the sync GIF) is base64.
  const text = bytes.byteLength === 0 || isText(response.headers.get('content-type'));
  return {
    statusCode: response.status,
    headers,
    cookies,
    body: text ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'),
    isBase64Encoded: !text
  };
}

function isText(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json');
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}
