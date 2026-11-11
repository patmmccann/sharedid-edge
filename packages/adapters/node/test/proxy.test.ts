// The Node.js server behind a stand-in for a CDN that isn't Cloudflare, as in the sales-house setup where the
// publisher's CDN routes /_sid/* to a server the sales house runs. The stand-in behaves like CloudFront: it forwards
// only /_sid/*, overwrites its client-IP and country headers with what its edge saw, appends the connecting address to
// X-Forwarded-For (so the first entry is whatever the visitor sent), and passes Cookie and Set-Cookie through.
import type { AddressInfo } from 'node:net';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, defineModule, resolveConfig, type PlatformInfo } from '@sharedid-edge/core';
import { clientIpFromHeader, createNodeServer, type NodeServerOptions } from '../src/index.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const NOW = new Date('2026-01-15T12:00:00Z');

/** What the stand-in CDN's edge saw: written over whatever the visitor sent. */
interface Edge {
  /** The CDN's client-IP header and the value it writes. */
  readonly clientIpHeader: string;
  readonly clientIp: string;
  readonly country: string;
}

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  const open = servers.splice(0);
  await Promise.all(open.map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => { resolve(); });
  })));
});

/** The stand-in CDN in front of `origin`. */
function cdn(origin: string, edge: Edge): Server {
  const target = new URL(origin);
  return createServer((req, res) => {
    if (!(req.url ?? '').startsWith('/_sid/')) {
      res.writeHead(404).end();
      return;
    }
    const headers: IncomingHttpHeaders = { ...req.headers };
    headers[edge.clientIpHeader] = edge.clientIp;
    headers['cloudfront-viewer-country'] = edge.country;
    // Appended, as CloudFront does: the visitor's own entries stay first.
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'] ?? [], '192.0.2.200'].flat().join(', ');
    const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, response => {
      // Node.js keeps Set-Cookie as an array: written back as is, each cookie stays its own header.
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502).end(); });
    req.pipe(upstream);
  });
}

/** Echoes the platform data the handler got. */
const echo = defineModule({ name: 'platform', run: ({ platform }) => ({ ortb2: { platform } }) });

/** The server, with the platform echo and a fixed clock, behind a stand-in CDN. */
async function behindCdn(edge: Edge, options: NodeServerOptions = {}): Promise<{ readonly origin: string; readonly cdn: string }> {
  const origin = await listen(createNodeServer({
    config: resolveConfig({ SID_MODULES: 'platform', SID_COOKIE_DOMAIN: 'host-only' }),
    modules: [echo],
    now: () => NOW,
    trustProxy: true,
    locationHeaders: { country: 'cloudfront-viewer-country' },
    ...options
  }));
  return { origin, cdn: await listen(cdn(origin, edge)) };
}

async function platformVia(base: string, headers: Record<string, string> = {}): Promise<PlatformInfo> {
  const response = await fetch(`${base}/_sid/v1`, { headers });
  return ((await response.json()) as { ortb2: { platform: PlatformInfo } }).ortb2.platform;
}

/** A visitor trying to choose their own IP and country. */
const SPOOFED = { 'x-forwarded-for': '198.51.100.66', 'cloudfront-viewer-address': '198.51.100.77:1234', 'fastly-client-ip': '198.51.100.88', 'cloudfront-viewer-country': 'US' };

describe('behind a CDN that appends to X-Forwarded-For', () => {
  it("takes the client IP from CloudFront-Viewer-Address, not what the visitor sent", async () => {
    for (const [address, ip] of [['203.0.113.7:46532', '203.0.113.7'], ['2001:db8::1:443', '2001:db8::1'], ['[2001:db8::2]:443', '2001:db8::2']] as const) {
      const { cdn: base } = await behindCdn({ clientIpHeader: 'cloudfront-viewer-address', clientIp: address, country: 'US' }, { clientIpHeader: 'CloudFront-Viewer-Address' });
      expect(await platformVia(base, SPOOFED)).toEqual({ clientIp: ip, country: 'US', isEU: false });
    }
  });

  it('takes the client IP from a bare client-IP header (Fastly-Client-IP, True-Client-IP), IPv4 and IPv6', async () => {
    for (const ip of ['203.0.113.8', '2001:db8::8']) {
      const { cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: ip, country: 'US' }, { clientIpHeader: 'fastly-client-ip' });
      expect((await platformVia(base, SPOOFED)).clientIp).toBe(ip);
    }
  });

  it('without the setting, the first X-Forwarded-For entry is the visitor\'s own', async () => {
    const { cdn: base } = await behindCdn({ clientIpHeader: 'cloudfront-viewer-address', clientIp: '203.0.113.7:46532', country: 'US' });
    expect((await platformVia(base, SPOOFED)).clientIp).toBe('198.51.100.66');
    expect((await platformVia(base)).clientIp).toBe('192.0.2.200');
  });

  it('gives no client IP when the header is missing or not an IP address', async () => {
    const { cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: 'unknown', country: 'US' }, { clientIpHeader: 'fastly-client-ip' });
    expect(await platformVia(base, SPOOFED)).toEqual({ country: 'US', isEU: false });
    const { origin } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: '203.0.113.8', country: 'US' }, { clientIpHeader: 'true-client-ip' });
    expect(await platformVia(origin, { 'x-forwarded-for': '198.51.100.66' })).toEqual({});
  });

  it('passes cookies through: Cookie to the server, each Set-Cookie back unchanged', async () => {
    const { origin, cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: '203.0.113.8', country: 'US' }, { clientIpHeader: 'fastly-client-ip' });
    const path = `/_sid/sync?id=pubcid%253A${UUID}`;
    const viaCdn = await fetch(`${base}${path}`);
    const direct = await fetch(`${origin}${path}`, { headers: { 'fastly-client-ip': '203.0.113.8', 'cloudfront-viewer-country': 'US' } });
    expect(viaCdn.headers.getSetCookie()).toHaveLength(2);
    expect(viaCdn.headers.getSetCookie()).toEqual(direct.headers.getSetCookie());
    expect(viaCdn.headers.getSetCookie()[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
    expect(viaCdn.headers.getSetCookie()[1]).toMatch(/^_pubcid_sv=.*HttpOnly$/);

    const v1 = await fetch(`${base}/_sid/v1`, { headers: { cookie: `_pubcid=${UUID}` } });
    expect(v1.headers.get('x-sharedid-source')).toBe('cookie');
    expect(((await v1.json()) as { eids: { uids: { id: string }[] }[] }).eids[0]?.uids[0]?.id).toBe(UUID);
  });

  it("uses the edge's country: an EU visitor without a TC string gets no ID cookie and loses existing ones", async () => {
    const { cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: '203.0.113.8', country: 'DE' }, { clientIpHeader: 'fastly-client-ip' });
    // The visitor claims to be in the US; the edge says Germany.
    const response = await fetch(`${base}/_sid/sync`, { headers: { ...SPOOFED, cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}` } });
    expect(response.headers.get('x-sharedid-status')).toBe('denied: tcf: GDPR applies and there is no TC string');
    const cookies = response.headers.getSetCookie();
    expect(cookies.map(c => c.slice(0, c.indexOf(';')))).toEqual(['_pubcid=', '_pubcid_sv=']);
    for (const cookie of cookies) expect(cookie).toContain('Max-Age=0');
  });

  it("uses the edge's country: a US visitor gets the ID cookie, whatever country they send", async () => {
    const { cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: '203.0.113.8', country: 'US' }, { clientIpHeader: 'fastly-client-ip' });
    const response = await fetch(`${base}/_sid/sync`, { headers: { 'cloudfront-viewer-country': 'DE' } });
    expect(response.headers.getSetCookie().map(c => c.slice(0, c.indexOf('=')))).toEqual(['_pubcid', '_pubcid_sv']);
  });

  it('forwards only /_sid/*', async () => {
    const { cdn: base } = await behindCdn({ clientIpHeader: 'fastly-client-ip', clientIp: '203.0.113.8', country: 'US' });
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});

describe('clientIpHeader', () => {
  it('needs trustProxy and a header name', () => {
    expect(() => createNodeServer({ clientIpHeader: 'fastly-client-ip' })).toThrow(ConfigError);
    expect(() => createNodeServer({ clientIpHeader: 'fastly client ip', trustProxy: true })).toThrow(ConfigError);
    // Location headers too, as the CLI refuses SID_LOCATION_HEADERS without SID_TRUST_PROXY.
    expect(() => createNodeServer({ locationHeaders: { country: 'cloudfront-viewer-country' } })).toThrow(/SID_LOCATION_HEADERS needs SID_TRUST_PROXY/);
    expect(() => createNodeServer({ clientIpHeader: 'Fastly-Client-IP', trustProxy: true })).not.toThrow();
  });

  it('reads CloudFront-Viewer-Address as ip:port and other headers as a bare address', () => {
    expect(clientIpFromHeader('cloudfront-viewer-address', '192.0.2.1:443')).toBe('192.0.2.1');
    expect(clientIpFromHeader('CloudFront-Viewer-Address', '2001:db8::1:443')).toBe('2001:db8::1');
    expect(clientIpFromHeader('cloudfront-viewer-address', '192.0.2.1')).toBeUndefined();
    expect(clientIpFromHeader('true-client-ip', ' 192.0.2.1 ')).toBe('192.0.2.1');
    expect(clientIpFromHeader('true-client-ip', '2001:db8::1')).toBe('2001:db8::1');
    for (const bad of [undefined, '', 'unknown', '192.0.2.1:443', '192.0.2.1, 198.51.100.1', '999.0.0.1']) {
      expect(clientIpFromHeader('fastly-client-ip', bad)).toBeUndefined();
    }
  });
});
