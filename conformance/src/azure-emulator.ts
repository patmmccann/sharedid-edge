// A local stand-in for Azure Front Door and the Azure Functions host, for running the conformance suite against the
// bundled function app (packages/adapters/azure-functions/deploy/sharedid-edge.mjs) without an Azure account or Azure
// Functions Core Tools. Imported outside the Functions worker, @azure/functions runs in its test mode: the bundle's
// app.http registration is skipped, and this server calls the exported handler with the library's own HttpRequest.
//
// Front Door: client copies of X-Azure-* and of the location headers are dropped, X-Azure-ClientIP is set from the
// connection (or, with SID_TRUST_PROXY, as the cases use it, from the first X-Forwarded-For entry), X-Azure-FDID is the
// profile ID in AZURE_FRONT_DOOR_ID, and the cases' Cloudflare-style location headers become the headers a rule set
// would add (SID_LOCATION_HEADERS). The host: only paths the function's route template matches reach it (others get
// the host's 404), header values are one per name, and cookies[] are written as ASP.NET Core's
// Response.Cookies.Append writes them, percent-encoding the value.
//
// Started by targets.ts with the case file's configuration as environment variables (read when the bundle is
// imported, as on a new instance), plus PORT, SID_PUBLIC_ORIGIN, SID_FRONT_DOOR_ID and SID_LOCATION_HEADERS.
import { HttpRequest, HttpResponse, type Cookie, type HttpResponseInit } from '@azure/functions';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AzureHandler } from '@sharedid-edge/azure-functions';

// CONFORMANCE_AZURE_BUNDLE is the bundle's directory: deploy, or deploy-bowser for case files that need Bowser.
const BUNDLE_DIR = process.env['CONFORMANCE_AZURE_BUNDLE'] === 'deploy-bowser' ? 'deploy-bowser' : 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/azure-functions', BUNDLE_DIR, 'sharedid-edge.mjs');

interface FunctionApp {
  readonly handler: AzureHandler;
  readonly route: string;
}

async function loadApp(): Promise<FunctionApp> {
  const loaded: unknown = await import(pathToFileURL(BUNDLE).href);
  if (typeof loaded !== 'object' || loaded === null || !('handler' in loaded) || !('route' in loaded)) {
    throw new Error(`${BUNDLE} doesn't export handler and route; run npm run bundle -w @sharedid-edge/azure-functions`);
  }
  const { handler, route } = loaded;
  if (typeof handler !== 'function' || typeof route !== 'string') throw new Error(`${BUNDLE}: unexpected exports`);
  // Checked to be a function above; the bundle is built from src/functions.ts, whose `handler` is an AzureHandler.
  return { handler: handler as AzureHandler, route };
}

/** Whether the route template (`_sid/{*path}` or `{*path}`) matches the path, as ASP.NET Core routing does. */
function routeMatches(route: string, pathname: string): boolean {
  const prefix = route.replace(/\/?\{\*path\}$/, '').toLowerCase();
  // Leading slashes off with a loop: the path is request data.
  let start = 0;
  while (start < pathname.length && pathname[start] === '/') start++;
  const path = pathname.slice(start).toLowerCase();
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

/** The cases' Cloudflare-style location headers, by the location field a Front Door rule set would carry. */
const CASE_LOCATION_HEADERS: Readonly<Record<string, string>> = {
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

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

async function toHttpRequest(req: IncomingMessage, origin: string, trustProxy: boolean, frontDoorId: string, locationHeaders: Readonly<Record<string, string>>): Promise<HttpRequest> {
  const dropped = new Set(Object.values(locationHeaders));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith('x-azure-') || dropped.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(name === 'cookie' ? '; ' : ', ') : value;
  }
  const forwarded = first(req.headers['x-forwarded-for'])?.split(',')[0]?.trim();
  const ip = trustProxy && forwarded !== undefined && forwarded !== '' ? forwarded : req.socket.remoteAddress;
  if (ip !== undefined) headers['x-azure-clientip'] = ip;
  headers['x-azure-socketip'] = req.socket.remoteAddress ?? '';
  headers['x-azure-fdid'] = frontDoorId;
  if (trustProxy) {
    for (const [field, name] of Object.entries(locationHeaders)) {
      const from = CASE_LOCATION_HEADERS[field];
      const value = from === undefined ? undefined : first(req.headers[from]);
      // Node reads header bytes as Latin-1, and the cases send city names as UTF-8: pass the bytes on unchanged.
      if (value !== undefined) headers[name] = from === 'cf-ipcity' ? Buffer.from(value, 'latin1').toString('utf8') : value;
    }
  }
  const body = await readBody(req);
  return new HttpRequest({
    method: req.method ?? 'GET',
    url: new URL(req.url ?? '/', origin).href,
    headers,
    ...(body.byteLength > 0 ? { body: { bytes: new Uint8Array(body) } } : {})
  });
}

/** `Uri.EscapeDataString`: percent-encodes everything but the RFC 3986 unreserved characters. */
function escapeDataString(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A cookie as ASP.NET Core's SetCookieHeaderValue writes it (the Functions host's Response.Cookies.Append). */
function setCookie(cookie: Cookie): string {
  const parts = [`${cookie.name}=${escapeDataString(cookie.value)}`];
  if (cookie.expires !== undefined) parts.push(`expires=${new Date(cookie.expires).toUTCString()}`);
  if (cookie.maxAge !== undefined) parts.push(`max-age=${String(cookie.maxAge)}`);
  if (cookie.domain !== undefined) parts.push(`domain=${cookie.domain}`);
  parts.push(`path=${cookie.path ?? '/'}`);
  if (cookie.secure === true) parts.push('secure');
  if (cookie.sameSite !== undefined) parts.push(`samesite=${cookie.sameSite.toLowerCase()}`);
  if (cookie.httpOnly === true) parts.push('httponly');
  return parts.join('; ');
}

async function writeResponse(res: ServerResponse, init: HttpResponseInit, method: string): Promise<void> {
  // The library's own HttpResponse, as the worker builds it from what the handler returned.
  const response = new HttpResponse(init);
  const headers: Record<string, string | string[]> = {};
  // The host gets one value per header name.
  for (const [name, value] of response.headers.entries()) headers[name] = value;
  if (response.cookies.length > 0) headers['set-cookie'] = response.cookies.map(setCookie);
  res.writeHead(response.status, headers);
  res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
}

const port = Number(process.env['PORT'] ?? 8787);
const origin = `http://127.0.0.1:${String(port)}`;
const trustProxy = /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? '');
const frontDoorId = process.env['AZURE_FRONT_DOOR_ID'] ?? '';
const parsed: unknown = JSON.parse(process.env['SID_LOCATION_HEADERS'] ?? '{}');
const locationHeaders: Record<string, string> = {};
if (typeof parsed === 'object' && parsed !== null) {
  for (const [field, name] of Object.entries(parsed)) if (typeof name === 'string') locationHeaders[field] = name.toLowerCase();
}
const app = await loadApp();

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', origin).pathname;
  if (!routeMatches(app.route, pathname)) {
    res.writeHead(404, { 'content-length': '0' });
    res.end();
    return;
  }
  const method = req.method ?? 'GET';
  toHttpRequest(req, origin, trustProxy, frontDoorId, locationHeaders)
    .then(request => app.handler(request))
    .then(init => writeResponse(res, init, method))
    .catch((error: unknown) => {
      console.error('azure emulator: invocation failed', error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Function invocation failed');
    });
});
server.listen(port, '127.0.0.1');
