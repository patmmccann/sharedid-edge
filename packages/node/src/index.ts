import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHandler, type HandlerOptions, type PlatformInfo, type SharedIdEdgeHandler } from '@sharedid-edge/core';

export interface NodeServerOptions extends HandlerOptions {
  /**
   * Take the client IP from the first `X-Forwarded-For` entry. Only enable this behind a proxy you control,
   * which overwrites the header: otherwise clients can set it.
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
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const clientIp = trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
  return clientIp === undefined ? {} : { clientIp };
}
