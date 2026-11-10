// A local stand-in for Vercel's proxy in front of a route handler, for running the conformance suite against the
// bundled Vercel adapter (packages/adapters/vercel/deploy/sharedid-edge.mjs) without a Vercel account. `vercel dev`
// needs a login, and doesn't set the geolocation headers locally, so it can't run the cases.
//
// Each HTTP request becomes a web-standard Request, with the headers Vercel's proxy sets (x-real-ip,
// x-forwarded-for, x-vercel-ip-*) in place of any the client sent; the handler's Response is written back with each
// Set-Cookie kept separate. Started by targets.ts with the case file's configuration as environment variables (read
// when the handler is built, as on a new instance), plus PORT and SID_PUBLIC_ORIGIN.
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { splitHeaders } from '@sharedid-edge/core';
import type { Env, VercelHandler } from '@sharedid-edge/vercel';
import { caseClientIp, caseLocation, emulatorPort, loadBundleExport, readBody, serve, trustProxyFromEnv, type CaseLocationHeader } from './emulator.js';

// CONFORMANCE_VERCEL_BUNDLE is the bundle's directory: deploy, or deploy-bowser for case files that need Bowser.
const BUNDLE_DIR = process.env['CONFORMANCE_VERCEL_BUNDLE'] === 'deploy-bowser' ? 'deploy-bowser' : 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/vercel', BUNDLE_DIR, 'sharedid-edge.mjs');

async function loadHandler(env: Env): Promise<VercelHandler> {
  // A function, checked by loadBundleExport; the bundle is built from src/bundle.ts, whose handlerFromEnv returns a handler.
  const fromEnv = (await loadBundleExport(BUNDLE, 'handlerFromEnv', 'npm run conformance:vercel')) as (env: Env) => VercelHandler;
  return fromEnv(env);
}

/**
 * The conformance cases describe the visitor's location with Cloudflare's visitor location headers. Like the
 * workerd runner, which passes them as request.cf, this stand-in passes them the way Vercel's proxy would: as its
 * x-vercel-ip-* geolocation headers. Only with SID_TRUST_PROXY, as in the cases. Vercel has no metro code header.
 */
const LOCATION_HEADERS: Readonly<Partial<Record<CaseLocationHeader, string>>> = {
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

async function toRequest(req: IncomingMessage, origin: string, trustProxy: boolean): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || setByVercel(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const ip = caseClientIp(req, trustProxy);
  if (ip !== undefined) {
    headers.set('x-real-ip', ip);
    headers.set('x-forwarded-for', ip);
    headers.set('x-vercel-forwarded-for', ip);
  }
  headers.set('x-vercel-id', 'dev1::conformance');
  for (const [name, value] of caseLocation(req, trustProxy, LOCATION_HEADERS)) {
    // Vercel percent-encodes non-ASCII city names (RFC 3986).
    headers.set(name, name === 'x-vercel-ip-city' ? encodeURIComponent(value) : value);
  }
  const method = req.method ?? 'GET';
  const body = await readBody(req);
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(method !== 'GET' && method !== 'HEAD' && body.byteLength > 0 ? { body } : {})
  });
}

const port = emulatorPort();
const origin = `http://127.0.0.1:${String(port)}`;
const handler = await loadHandler(process.env);
const trustProxy = trustProxyFromEnv();
serve(port, 'Function invocation failed', async (req, res) => {
  const response = await handler(await toRequest(req, origin, trustProxy));
  const { headers, cookies } = splitHeaders(response.headers);
  res.writeHead(response.status, cookies.length > 0 ? { ...headers, 'set-cookie': cookies } : headers);
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
});
