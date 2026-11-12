import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ConfigError, createHandler, isHeaderName, LOCATION_FIELDS, locationWithEU, logRequestFailure, parseIp, parseViewerAddress, splitHeaders, type HandlerOptions, type LocationField, type LocationHeaders, type LocationSource, type PlatformInfo, type SharedIdEdgeHandler } from '@sharedid-edge/core';

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
   * Take the client IP from the first `X-Forwarded-For` entry (or from `clientIpHeader`), and the location from
   * `locationHeaders`. Only enable this behind a proxy you control, which overwrites these headers: otherwise clients
   * can set them.
   */
  readonly trustProxy?: boolean;
  /**
   * With `trustProxy`, the header the client IP comes from instead of `X-Forwarded-For`: the proxy's own client-IP
   * header, which it sets and a visitor can't (`Fastly-Client-IP`, `True-Client-IP`, CloudFront's
   * `CloudFront-Viewer-Address`). Use it behind a CDN that appends to `X-Forwarded-For`, where the first entry is
   * whatever the visitor sent. The value must be an IP address; `CloudFront-Viewer-Address` is read as CloudFront
   * writes it, `ip:port`. A missing or invalid value gives no client IP. Setting it without `trustProxy`, or to
   * something that isn't a header name, throws a `ConfigError`.
   */
  readonly clientIpHeader?: string;
  /**
   * The headers the location comes from, with `trustProxy`: Cloudflare's visitor location headers by default, or a
   * CDN's own (CloudFront's `cloudfront-viewer-country`, say). The country also decides whether GDPR applies when a
   * request has no `gdpr` signal, so behind a proxy, pass the visitor's country on. Setting it without `trustProxy`
   * throws a `ConfigError`.
   */
  readonly locationHeaders?: LocationHeaders;
  /** Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to `http://<Host header>`. */
  readonly publicOrigin?: string;
}

/** An HTTP server that answers every request with the SharedID Edge handler. */
export function createNodeServer(options: NodeServerOptions = {}): Server {
  const handler = createHandler(options);
  const trust = trustedHeaders(options);
  return createServer((req, res) => {
    handle(handler, options.publicOrigin, trust, req, res).catch((error: unknown) => {
      logRequestFailure(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Internal error');
    });
  });
}

/** The headers a trusted proxy sets: where the client IP (undefined: `X-Forwarded-For`) and the location come from. */
interface TrustedHeaders {
  readonly clientIp: string | undefined;
  readonly location: LocationHeaders;
}

/** The trusted proxy's headers, or undefined when the proxy isn't trusted. Checks `clientIpHeader` and `locationHeaders`. */
function trustedHeaders(options: NodeServerOptions): TrustedHeaders | undefined {
  const clientIp = options.clientIpHeader?.trim().toLowerCase();
  if (clientIp !== undefined) {
    // Read only from a trusted proxy: without the trust, the setting would silently do nothing.
    if (options.trustProxy !== true) throw new ConfigError('SID_CLIENT_IP_HEADER needs SID_TRUST_PROXY=true: the client IP header is read only from a trusted proxy');
    if (!isHeaderName(clientIp)) throw new ConfigError('SID_CLIENT_IP_HEADER must be a header name, like fastly-client-ip');
  }
  // The same for the location headers: the CLI refuses SID_LOCATION_HEADERS without the trust, and so does the library.
  if (options.locationHeaders !== undefined && options.trustProxy !== true) {
    throw new ConfigError('SID_LOCATION_HEADERS needs SID_TRUST_PROXY=true: location headers are read only from a trusted proxy');
  }
  if (options.trustProxy !== true) return undefined;
  return { clientIp, location: options.locationHeaders ?? CLOUDFLARE_LOCATION_HEADERS };
}

async function handle(handler: SharedIdEdgeHandler, publicOrigin: string | undefined, trust: TrustedHeaders | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = toWebRequest(req, publicOrigin ?? `http://${req.headers.host ?? 'localhost'}`);
  await sendWebResponse(res, await handler(request, platformInfo(req, trust)), req.method ?? 'GET');
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

/** `trust` is the trusted proxy's headers, or undefined when the proxy isn't trusted. */
function platformInfo(req: IncomingMessage, trust: TrustedHeaders | undefined): PlatformInfo {
  const clientIp = trust === undefined ? req.socket.remoteAddress : trustedClientIp(req, trust.clientIp);
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    // Location headers, like X-Forwarded-For, can be trusted only behind a proxy that sets them. locationWithEU also
    // sets isEU from the country, which decides whether GDPR applies when the request has no gdpr signal.
    ...(trust === undefined ? {} : locationWithEU(locationFrom(req, trust.location)))
  };
}

/**
 * The client IP behind a trusted proxy: from its client-IP header when one is configured (nothing when that's missing
 * or not an IP address: falling back would trust what the visitor sent), otherwise the first `X-Forwarded-For` entry,
 * which the proxy must overwrite rather than append to.
 */
function trustedClientIp(req: IncomingMessage, name: string | undefined): string | undefined {
  if (name === undefined) {
    const first = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
    return first !== undefined && first !== '' ? first : req.socket.remoteAddress;
  }
  return clientIpFromHeader(name, header(req, name));
}

/**
 * The client IP in a proxy's client-IP header `name`: CloudFront's `cloudfront-viewer-address` is `ip:port` (IPv6
 * too, with the port after the last colon); any other header holds just the address. Undefined unless it's a valid IP.
 */
export function clientIpFromHeader(name: string, value: string | undefined): string | undefined {
  if (name.toLowerCase() === 'cloudfront-viewer-address') return parseViewerAddress(value);
  const address = value?.trim() ?? '';
  return parseIp(address) === undefined ? undefined : address;
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
