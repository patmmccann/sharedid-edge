import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHandler, LOCATION_FIELDS, locationWithEU, logRequestFailure, splitHeaders, type HandlerOptions, type LocationField, type LocationHeaders, type LocationSource, type PlatformInfo, type SharedIdEdgeHandler } from '@sharedid-edge/core';

/** Cloudflare's visitor location headers ("Add visitor location headers"): the default. */
export const CLOUDFLARE_LOCATION_HEADERS: LocationHeaders = {
  country: 'cf-ipcountry',
  regionCode: 'cf-region-code',
  city: 'cf-ipcity',
  postalCode: 'cf-postal-code',
  metroCode: 'cf-metro-code',
  latitude: 'cf-iplatitude',
  longitude: 'cf-iplongitude',
  timezone: 'cf-timezone',
  continent: 'cf-ipcontinent'
};

export interface NodeServerOptions extends HandlerOptions {
  /**
   * Take the client IP from the first `X-Forwarded-For` entry, and the location from `locationHeaders`. Only enable
   * this behind a proxy you control, which overwrites these headers: otherwise clients can set them.
   */
  readonly trustProxy?: boolean;
  /**
   * The headers the location comes from, with `trustProxy`: Cloudflare's visitor location headers by default, or a
   * CDN's own (CloudFront's `cloudfront-viewer-country`, say). The country also decides whether GDPR applies when a
   * request has no `gdpr` signal, so behind a proxy, pass the visitor's country on.
   */
  readonly locationHeaders?: LocationHeaders;
  /** Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to `http://<Host header>`. */
  readonly publicOrigin?: string;
}

/** An HTTP server that answers every request with the SharedID Edge handler. */
export function createNodeServer(options: NodeServerOptions = {}): Server {
  const handler = createHandler(options);
  return createServer((req, res) => {
    handle(handler, options, req, res).catch((error: unknown) => {
      logRequestFailure(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Internal error');
    });
  });
}

async function handle(handler: SharedIdEdgeHandler, options: NodeServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = toWebRequest(req, options.publicOrigin ?? `http://${req.headers.host ?? 'localhost'}`);
  const location = options.trustProxy === true ? (options.locationHeaders ?? CLOUDFLARE_LOCATION_HEADERS) : undefined;
  await sendWebResponse(res, await handler(request, platformInfo(req, location)), req.method ?? 'GET');
}

/**
 * Writes a `Response` to a Node.js `ServerResponse` (or Express's `res`), each `Set-Cookie` its own header. HEAD gets
 * no body. Shared with adapters whose platform hands them Node.js requests, like Google Cloud's Functions Framework.
 */
export async function sendWebResponse(res: ServerResponse, response: Response, method: string): Promise<void> {
  const { headers, cookies } = splitHeaders(response.headers);
  res.writeHead(response.status, cookies.length > 0 ? { ...headers, 'set-cookie': cookies } : headers);
  if (method.toUpperCase() === 'HEAD' || response.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Converts a Node.js `IncomingMessage` (or Express's `req`) to a `Request` whose URL has `origin`, keeping repeated
 * headers. Shared with adapters whose platform hands them Node.js requests, like Google Cloud's Functions Framework.
 */
export function toWebRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {})
  });
}

/** `location` is the trusted proxy's location headers, or undefined when the proxy isn't trusted. */
function platformInfo(req: IncomingMessage, location: LocationHeaders | undefined): PlatformInfo {
  const trustProxy = location !== undefined;
  const first = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
  const clientIp = trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    // Location headers, like X-Forwarded-For, can be trusted only behind a proxy that sets them. locationWithEU also
    // sets isEU from the country, which decides whether GDPR applies when the request has no gdpr signal.
    ...(location === undefined ? {} : locationWithEU(locationFrom(req, location)))
  };
}

/**
 * The location from the configured headers. Node.js decodes header values as Latin-1; proxies send city names as
 * UTF-8 (Cloudflare's `cf-ipcity` does), so the city is decoded again.
 */
function locationFrom(req: IncomingMessage, headers: LocationHeaders): LocationSource {
  const source: Partial<Record<LocationField, string>> = {};
  for (const field of LOCATION_FIELDS) {
    const name = headers[field];
    const value = name === undefined ? undefined : header(req, name);
    if (value !== undefined) source[field] = field === 'city' ? utf8(value) : value;
  }
  return source;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Re-decodes a header value Node.js decoded as Latin-1 as UTF-8 (proxies send city names as UTF-8 bytes), keeping it
 * as is when it isn't valid UTF-8.
 */
export function utf8(latin1: string): string {
  const bytes = Buffer.from(latin1, 'latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1;
  }
}
export { loadModulePackages } from './module-packages.js';
