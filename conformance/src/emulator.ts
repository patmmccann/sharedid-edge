// What the local platform stand-ins (lambda-emulator.ts, vercel-emulator.ts) share: loading the adapter's bundle,
// serving it, and turning the cases' client IP and Cloudflare location headers into what the platform would send.
// Each emulator keeps only its platform's own header names and request and response shapes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

/**
 * The client IP the platform would see: the connecting address or (with SID_TRUST_PROXY, as the conformance cases
 * use it to set the client IP) the first X-Forwarded-For entry the client sent.
 */
export function caseClientIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
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
  req: IncomingMessage,
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
export function serve(port: number, failure: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`emulator: ${failure}`, error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(failure);
    });
  });
  server.listen(port, '127.0.0.1');
}
