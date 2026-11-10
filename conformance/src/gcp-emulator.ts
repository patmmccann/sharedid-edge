// A local stand-in for Google Cloud's external Application Load Balancer, in front of the real Functions Framework
// running the bundled function (packages/adapters/gcp-functions/deploy/, started by targets.ts on UPSTREAM_PORT), for
// running the conformance suite without a Google Cloud account.
//
// Like the load balancer, it appends `<client>,<load balancer>` to X-Forwarded-For, and sets the backend service's
// custom request headers (named in SID_LOCATION_HEADERS), overwriting copies the client sent. The client is the
// connection's address, or (with SID_TRUST_PROXY, as the cases use it to set the client IP) the first X-Forwarded-For
// entry; the location comes from the cases' Cloudflare-style headers, as the load balancer's {client_region},
// {client_region_subdivision} (`USAZ`), {client_city} and {client_city_lat_long} would give it, and is empty otherwise.
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';

/** The load balancer's own address, which it appends last. */
const LOAD_BALANCER_IP = '35.191.0.1';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function locationHeaders(): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(process.env['SID_LOCATION_HEADERS'] ?? '{}');
  const names: Record<string, string> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [field, name] of Object.entries(parsed)) if (typeof name === 'string') names[field] = name.toLowerCase();
  }
  return names;
}

/** What the load balancer's location variables would hold for the case's visitor. */
function location(req: IncomingMessage, trustProxy: boolean): Readonly<Record<string, string>> {
  if (!trustProxy) return { country: '', region: '', city: '', latLong: '' };
  const country = first(req.headers['cf-ipcountry']) ?? '';
  const region = first(req.headers['cf-region-code']) ?? '';
  const latitude = first(req.headers['cf-iplatitude']);
  const longitude = first(req.headers['cf-iplongitude']);
  return {
    country,
    region: region === '' ? '' : `${country}${region}`,
    // Node reads header bytes as Latin-1 and writes them back the same way, so the UTF-8 bytes pass through.
    city: first(req.headers['cf-ipcity']) ?? '',
    latLong: latitude === undefined || longitude === undefined ? '' : `${latitude},${longitude}`
  };
}

const port = Number(process.env['PORT'] ?? 8787);
const upstreamPort = Number(process.env['UPSTREAM_PORT'] ?? 8080);
const trustProxy = /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? '');
const custom = locationHeaders();

const server = createServer((req, res) => {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !Object.values(custom).includes(name)) headers[name] = value;
  }
  const supplied = first(req.headers['x-forwarded-for']);
  const caseIp = supplied?.split(',')[0]?.trim();
  const client = trustProxy && caseIp !== undefined && caseIp !== '' ? caseIp : req.socket.remoteAddress ?? '';
  // The cases' X-Forwarded-For is the visitor's address itself; otherwise, what the client sent stays in front.
  const prefix = trustProxy || supplied === undefined ? '' : `${supplied},`;
  headers['x-forwarded-for'] = `${prefix}${client},${LOAD_BALANCER_IP}`;
  headers['x-forwarded-proto'] = 'https';
  const values = location(req, trustProxy);
  for (const [field, name] of Object.entries(custom)) headers[name] = values[field] ?? '';

  const upstream = request({ host: '127.0.0.1', port: upstreamPort, method: req.method ?? 'GET', path: req.url ?? '/', headers }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', (error: unknown) => {
    console.error('gcp emulator: upstream failed', error);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad gateway');
  });
  req.pipe(upstream);
});
server.listen(port, '127.0.0.1');
