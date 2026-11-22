// What the local platform stand-ins (lambda-emulator.ts, vercel-emulator.ts, …, and fastly-viceroy.ts) share: loading the adapter's bundle,
// serving it, and turning the cases' client IP and Cloudflare location headers into what the platform would send.
// Each emulator keeps only its platform's own header names and request and response shapes.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { pathToFileURL } from 'node:url';

/** The Cloudflare visitor location headers the cases send. */
export type CaseLocationHeader =
  | 'cf-ipcountry'
  | 'cf-region-code'
  | 'cf-ipcity'
  | 'cf-postal-code'
  | 'cf-metro-code'
  | 'cf-iplatitude'
  | 'cf-iplongitude'
  | 'cf-timezone'
  | 'cf-ipcontinent';

/**
 * CloudFront's viewer location headers, by the cases' Cloudflare headers (CloudFront has no continent header): for the
 * Lambda stand-ins, regional (lambda-emulator.ts) and Lambda@Edge (lambda-edge-emulator.ts).
 */
export const CLOUDFRONT_LOCATION_HEADERS: Readonly<Partial<Record<CaseLocationHeader, string>>> = {
  'cf-ipcountry': 'cloudfront-viewer-country',
  'cf-region-code': 'cloudfront-viewer-country-region',
  'cf-ipcity': 'cloudfront-viewer-city',
  'cf-postal-code': 'cloudfront-viewer-postal-code',
  'cf-metro-code': 'cloudfront-viewer-metro-code',
  'cf-iplatitude': 'cloudfront-viewer-latitude',
  'cf-iplongitude': 'cloudfront-viewer-longitude',
  'cf-timezone': 'cloudfront-viewer-time-zone'
};

/** The port targets.ts asks the emulator to listen on. */
export function emulatorPort(): number {
  return Number(process.env['PORT'] ?? 8787);
}

/** `SID_TRUST_PROXY`, which the cases use to set the client IP and location. */
export function trustProxyFromEnv(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? '');
}

/**
 * The function `exportName` of the adapter bundle at `bundle`. Throws, naming `command` (which builds the bundle),
 * when the bundle doesn't export one. The caller casts it to the bundle's own type.
 */
export async function loadBundleExport(bundle: string, exportName: string, command: string): Promise<(...args: never[]) => unknown> {
  const loaded: unknown = await import(pathToFileURL(bundle).href);
  const value: unknown = typeof loaded === 'object' && loaded !== null && exportName in loaded ? Reflect.get(loaded, exportName) : undefined;
  if (typeof value !== 'function') throw new Error(`${bundle} doesn't export ${exportName}; run ${command} from the repository root`);
  // Checked to be a function above.
  return value as (...args: never[]) => unknown;
}

/** What `caseClientIp` and `caseLocation` read of a request: its headers, and the connecting address. */
export type CaseRequest = Pick<IncomingMessage, 'headers'> & { readonly socket: { readonly remoteAddress?: string | undefined } };

/**
 * The client IP the platform would see: the connecting address or (with SID_TRUST_PROXY, as the conformance cases
 * use it to set the client IP) the first X-Forwarded-For entry the client sent.
 */
export function caseClientIp(req: CaseRequest, trustProxy: boolean): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
}

/**
 * The visitor location the case sends as Cloudflare's visitor location headers, renamed to the platform's headers
 * by `names` (a header missing from it is one the platform doesn't have). Only with SID_TRUST_PROXY, as in the cases.
 * Node reads header bytes as Latin-1 and the cases send city names as UTF-8, so the city is decoded back to UTF-8.
 */
export function caseLocation(
  req: Pick<IncomingMessage, 'headers'>,
  trustProxy: boolean,
  names: Readonly<Partial<Record<CaseLocationHeader, string>>>
): [name: string, value: string][] {
  if (!trustProxy) return [];
  const headers: [string, string][] = [];
  for (const [from, to] of Object.entries(names)) {
    const value = req.headers[from];
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined) continue;
    headers.push([to, from === 'cf-ipcity' ? Buffer.from(first, 'latin1').toString('utf8') : first]);
  }
  return headers;
}

/** The request body. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

/**
 * Serves `handle` on 127.0.0.1:`port`. A failed invocation is logged and answered with a 502 and `failure`, as the
 * platform would answer a function that crashed.
 */
export function serve(port: number, failure: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`emulator: ${failure}`, error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(failure);
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** A free TCP port on `host`. */
export async function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => { resolve(port); });
    });
  });
}

/** A relayed response. */
export interface Relayed {
  readonly status: number;
  /** Raw headers, without hop-by-hop ones: name, value, name, value… */
  readonly headers: string[];
  readonly body: Buffer;
}

/**
 * Sends a request to `host`:`port` from the local address `from`, for the relays that make a case's client IP the
 * connection's (fastly-viceroy.ts, docker-nginx.ts). `from` must be an address of this machine: on Linux,
 * `sudo ip route add local 192.0.2.0/24 dev lo` makes a whole range local, as CI does for the cases' ranges.
 */
export function forwardFrom(host: string, port: number, from: string, method: string, path: string, headers: readonly string[], body: Buffer): Promise<Relayed> {
  return new Promise((resolve, reject) => {
    const upstream = httpRequest({ host, port, localAddress: from, method, path, headers: [...headers] }, res => {
      readBody(res).then(bytes => {
        const out: string[] = [];
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i] ?? '';
          if (!/^(transfer-encoding|connection|keep-alive)$/i.test(name)) out.push(name, res.rawHeaders[i + 1] ?? '');
        }
        resolve({ status: res.statusCode ?? 502, headers: out, body: bytes });
      }, reject);
    });
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRNOTAVAIL'
        ? new Error(`the case's client IP ${from} isn't an address of this machine (on Linux: sudo ip route add local ${from} dev lo)`)
        : error);
    });
    upstream.end(body);
  });
}

/**
 * Serves `relay`'s answers on 127.0.0.1:`port` (HEAD without a body), for the relays in front of a real runtime
 * (fastly-viceroy.ts, docker-nginx.ts). With `serial`, one request at a time. Returns a function that closes it.
 */
export function serveRelay(port: number, failure: string, relay: (req: IncomingMessage) => Promise<Relayed>, serial = false): () => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  const server = serve(port, failure, async (req, res) => {
    const result = serial ? queue.then(() => relay(req)) : relay(req);
    if (serial) queue = result.catch(() => undefined);
    const { status, headers, body } = await result;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  };
}
