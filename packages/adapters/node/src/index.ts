import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHandler, locationInfo, type HandlerOptions, type LocationSource, type PlatformInfo, type SharedIdEdgeHandler } from '@sharedid-edge/core';

export interface NodeServerOptions extends HandlerOptions {
  /**
   * Take the client IP from the first `X-Forwarded-For` entry, and the location from Cloudflare's visitor location
   * headers (`cf-ipcountry`, `cf-region-code`, `cf-ipcity`, …). Only enable this behind a proxy you control, which
   * overwrites these headers: otherwise clients can set them.
   */
  readonly trustProxy?: boolean;
  /** Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to `http://<Host header>`. */
  readonly publicOrigin?: string;
}

/** An HTTP server that answers every request with the SharedID Edge handler. */
export function createNodeServer(options: NodeServerOptions = {}): Server {
  const handler = createHandler(options);
  return createServer((req, res) => {
    handle(handler, options, req, res).catch((error: unknown) => {
      // Don't echo the error: it may contain request data.
      console.error('sharedid-edge: request failed', error instanceof Error ? error.name : 'unknown error');
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Internal error');
    });
  });
}

async function handle(handler: SharedIdEdgeHandler, options: NodeServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = toRequest(req, options.publicOrigin);
  const response = await handler(request, platformInfo(req, options.trustProxy === true));
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (req.method === 'HEAD' || response.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

function toRequest(req: IncomingMessage, publicOrigin: string | undefined): Request {
  const origin = publicOrigin ?? `http://${req.headers.host ?? 'localhost'}`;
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

function platformInfo(req: IncomingMessage, trustProxy: boolean): PlatformInfo {
  const first = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
  const clientIp = trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    // Cloudflare's visitor location headers, like X-Forwarded-For, can be trusted only behind a proxy that sets them.
    ...(trustProxy ? locationInfo(cloudflareLocation(req)) : {})
  };
}

/**
 * The location from Cloudflare's "add visitor location headers" managed transform. Node.js decodes header values as
 * Latin-1; Cloudflare sends city names as UTF-8, so `cf-ipcity` is decoded again.
 */
function cloudflareLocation(req: IncomingMessage): LocationSource {
  const city = header(req, 'cf-ipcity');
  return {
    country: header(req, 'cf-ipcountry'),
    regionCode: header(req, 'cf-region-code'),
    city: city === undefined ? undefined : utf8(city),
    postalCode: header(req, 'cf-postal-code'),
    metroCode: header(req, 'cf-metro-code'),
    latitude: header(req, 'cf-iplatitude'),
    longitude: header(req, 'cf-iplongitude'),
    timezone: header(req, 'cf-timezone'),
    continent: header(req, 'cf-ipcontinent')
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Re-decodes a Latin-1-decoded header value as UTF-8, keeping it as is when it isn't valid UTF-8. */
function utf8(latin1: string): string {
  const bytes = Buffer.from(latin1, 'latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1;
  }
}
