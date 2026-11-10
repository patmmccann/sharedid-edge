// A local stand-in for Vercel's proxy in front of a route handler, for running the conformance suite against the
// bundled Vercel adapter (packages/adapters/vercel/deploy/sharedid-edge.mjs) without a Vercel account. `vercel dev`
// needs a login, and doesn't set the geolocation headers locally, so it can't run the cases.
//
// Each HTTP request becomes a web-standard Request, with the headers Vercel's proxy sets (x-real-ip,
// x-forwarded-for, x-vercel-ip-*) in place of any the client sent; the handler's Response is written back with each
// Set-Cookie kept separate. Started by targets.ts with the case file's configuration as environment variables (read
// when the handler is built, as on a new instance), plus PORT and SID_PUBLIC_ORIGIN.
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Env, VercelHandler } from '@sharedid-edge/vercel';

// CONFORMANCE_VERCEL_BUNDLE is the bundle's directory: deploy, or deploy-bowser for case files that need Bowser.
const BUNDLE_DIR = process.env['CONFORMANCE_VERCEL_BUNDLE'] === 'deploy-bowser' ? 'deploy-bowser' : 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/vercel', BUNDLE_DIR, 'sharedid-edge.mjs');

async function loadHandler(env: Env): Promise<VercelHandler> {
  const loaded: unknown = await import(pathToFileURL(BUNDLE).href);
  const fromEnv = typeof loaded === 'object' && loaded !== null && 'handlerFromEnv' in loaded ? loaded.handlerFromEnv : undefined;
  if (typeof fromEnv !== 'function') throw new Error(`${BUNDLE} doesn't export handlerFromEnv; run npm run conformance:vercel from the repository root`);
  // Checked to be a function above; the bundle is built from src/bundle.ts, whose handlerFromEnv returns a handler.
  return (fromEnv as (env: Env) => VercelHandler)(env);
}

/**
 * The conformance cases describe the visitor's location with Cloudflare's visitor location headers. Like the
 * workerd runner, which passes them as request.cf, this stand-in passes them the way Vercel's proxy would: as its
 * x-vercel-ip-* geolocation headers. Only with SID_TRUST_PROXY, as in the cases. Vercel has no metro code header.
 */
const LOCATION_HEADERS: Readonly<Record<string, string>> = {
  'cf-ipcountry': 'x-vercel-ip-country',
  'cf-region-code': 'x-vercel-ip-country-region',
  'cf-ipcity': 'x-vercel-ip-city',
  'cf-postal-code': 'x-vercel-ip-postal-code',
  'cf-iplatitude': 'x-vercel-ip-latitude',
  'cf-iplongitude': 'x-vercel-ip-longitude',
  'cf-timezone': 'x-vercel-ip-timezone',
  'cf-ipcontinent': 'x-vercel-ip-continent'
};

/** Headers Vercel's proxy sets itself, replacing whatever the client sent. */
function setByVercel(name: string): boolean {
  return name === 'x-real-ip' || name === 'x-forwarded-for' || name.startsWith('x-vercel-');
}

/**
 * The client IP Vercel would report: the connecting address or (with SID_TRUST_PROXY, as the conformance cases use
 * it to set the client IP) the first X-Forwarded-For entry the client sent.
 */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage, origin: string, trustProxy: boolean): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || setByVercel(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const ip = clientAddress(req, trustProxy);
  if (ip !== undefined) {
    headers.set('x-real-ip', ip);
    headers.set('x-forwarded-for', ip);
    headers.set('x-vercel-forwarded-for', ip);
  }
  headers.set('x-vercel-id', 'dev1::conformance');
  if (trustProxy) {
    for (const [from, to] of Object.entries(LOCATION_HEADERS)) {
      const value = req.headers[from];
      const first = Array.isArray(value) ? value[0] : value;
      if (first === undefined) continue;
      // Node reads header bytes as Latin-1, and the cases send city names as UTF-8. Vercel percent-encodes
      // non-ASCII city names (RFC 3986), so decode the bytes and encode them that way.
      headers.set(to, to === 'x-vercel-ip-city' ? encodeURIComponent(Buffer.from(first, 'latin1').toString('utf8')) : first);
    }
  }
  const method = req.method ?? 'GET';
  const body = await readBody(req);
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(method !== 'GET' && method !== 'HEAD' && body.byteLength > 0 ? { body } : {})
  });
}

const port = Number(process.env['PORT'] ?? 8787);
const origin = `http://127.0.0.1:${String(port)}`;
const handler = await loadHandler(process.env);
const trustProxy = /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? '');
const server = createServer((req, res) => {
  toRequest(req, origin, trustProxy)
    .then(handler)
    .then(async response => {
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') headers[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    })
    .catch((error: unknown) => {
      console.error('vercel emulator: invocation failed', error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Function invocation failed');
    });
});
server.listen(port, '127.0.0.1');
