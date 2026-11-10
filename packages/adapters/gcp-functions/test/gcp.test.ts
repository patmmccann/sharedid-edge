import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineModule, resolveConfig } from '@sharedid-edge/core';
import {
  builtInModules,
  clientIp,
  createGcpHandler,
  handlerFromEnv,
  parseLocationHeaders,
  parseTrustedHops,
  platformInfo,
  type GcpHandler,
  type LocationHeaders
} from '../src/index.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';
const LB = '35.191.0.1';
const LOCATION: LocationHeaders = {
  country: 'x-client-region',
  region: 'x-client-region-subdivision',
  city: 'x-client-city',
  latLong: 'x-client-city-lat-long'
};

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string; readonly geo?: Readonly<Record<string, unknown>> } };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

/** A request as the Functions Framework hands it over behind the external Application Load Balancer. */
function lbHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    'host': 'www.example.com',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'referer': 'https://www.example.com/article',
    'via': '1.1 google',
    'x-cloud-trace-context': '0123456789abcdef0123456789abcdef/1234567890123456;o=1',
    'x-forwarded-for': `198.51.100.23,${LB}`,
    'x-forwarded-proto': 'https',
    'x-client-region': 'US',
    'x-client-region-subdivision': 'USWA',
    'x-client-city': 'Seattle',
    'x-client-city-lat-long': '47.606209,-122.332071',
    ...extra
  };
}

function incoming(headers: Readonly<Record<string, string>>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = { ...headers };
  return req;
}

/** Serves `handler` on a random port, as the Functions Framework would, and returns its base URL. */
async function serve(handler: GcpHandler): Promise<{ readonly url: string; readonly server: Server }> {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, server };
}

const servers: Server[] = [];

async function call(handler: GcpHandler, path: string, init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {}): Promise<Response> {
  const { url, server } = await serve(handler);
  servers.push(server);
  return fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: lbHeaders(init.headers) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe('createGcpHandler', () => {
  it('answers a first-visit sync with the GIF and two separate Set-Cookie headers, Secure over https', async () => {
    const response = await call(createGcpHandler({ config: resolveConfig({}) }), `/_sid/sync?id=pubcid%253A${UUID}`, { headers: { 'x-client-region': '' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};.*; Secure`));
    expect(cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
    expect((await response.arrayBuffer()).byteLength).toBe(43);
  });

  it('restores the recovery copy over a re-minted ID', async () => {
    const response = await call(createGcpHandler({ config: resolveConfig({}) }), `/_sid/sync?id=pubcid%253A${OTHER}`, { headers: { 'cookie': `_pubcid_sv=${UUID}`, 'x-client-region': '' } });
    expect(response.headers.get('x-sharedid-source')).toBe('recovery');
    expect(response.headers.getSetCookie()[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
  });

  it('uses https and the Host header, or publicOrigin', async () => {
    const seen: string[] = [];
    const probe = defineModule({ name: 'probe', run: ({ url }) => { seen.push(url.href); return undefined; } });
    const config = resolveConfig({ SID_MODULES: 'probe' });
    await call(createGcpHandler({ config, modules: [probe] }), '/_sid/v1?a=1');
    await call(createGcpHandler({ config, modules: [probe], publicOrigin: 'http://localhost:8080' }), '/_sid/v1?a=1');
    // fetch sends its own Host (the test server's), which the function puts behind https://.
    expect(seen[0]).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/_sid\/v1\?a=1$/);
    expect(seen[1]).toBe('http://localhost:8080/_sid/v1?a=1');
  });

  it('answers HEAD without a body, and other methods with 405', async () => {
    const handler = createGcpHandler({ config: resolveConfig({}) });
    const head = await call(handler, '/_sid/sync', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const post = await call(handler, '/_sid/sync', { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it.each([['/identity', '/identity/v1'], ['/', '/v1']])('answers under SID_BASE_PATH=%s only', async (basePath, path) => {
    const handler = handlerFromEnv({ SID_BASE_PATH: basePath });
    expect((await call(handler, path)).status).toBe(200);
    expect((await call(handler, '/_sid/v1')).status).toBe(404);
  });

  it('returns a generic 500 when the request can\'t be handled, without request data', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(createGcpHandler({ config: resolveConfig({}), publicOrigin: 'not a url secret' }), '/_sid/v1');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal error');
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
  });
});

describe('the ip module on /v1', () => {
  const handler = createGcpHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules });

  it('uses the second-to-last X-Forwarded-For entry, never the visitor\'s own first entry', async () => {
    const body = await (await call(handler, '/_sid/v1', { headers: { 'x-forwarded-for': `203.0.113.66, 198.51.100.23,${LB}` } })).json() as Payload;
    expect(body.ortb2?.device?.ip).toBe('198.51.100.23');
  });

  it('uses an IPv6 client', async () => {
    const body = await (await call(handler, '/_sid/v1', { headers: { 'x-forwarded-for': `2001:DB8:0:0:abcd::1,${LB}` } })).json() as Payload;
    expect(body.ortb2?.device?.ipv6).toBe('2001:db8::abcd:0:0:1');
  });
});

describe('platformInfo', () => {
  it('reads the client IP and the load balancer\'s location headers', () => {
    expect(platformInfo(incoming(lbHeaders()), { locationHeaders: LOCATION })).toEqual({
      clientIp: '198.51.100.23', country: 'US', region: 'WA', isEU: false, city: 'Seattle', latitude: 47.606209, longitude: -122.332071
    });
  });

  it('reads no location unless its headers are configured: visitors could send them', () => {
    expect(platformInfo(incoming(lbHeaders()))).toEqual({ clientIp: '198.51.100.23' });
  });

  it('sets isEU from the country, and handles subdivision forms', () => {
    const fr = platformInfo(incoming(lbHeaders({ 'x-client-region': 'FR', 'x-client-region-subdivision': 'FRIDF' })), { locationHeaders: LOCATION });
    expect(fr).toMatchObject({ country: 'FR', region: 'IDF', isEU: true });
    expect(platformInfo(incoming(lbHeaders({ 'x-client-region-subdivision': 'US-WA' })), { locationHeaders: LOCATION }).region).toBe('US-WA');
    expect(platformInfo(incoming(lbHeaders({ 'x-client-region-subdivision': 'CAON' })), { locationHeaders: LOCATION })).not.toHaveProperty('region');
  });

  it('leaves location and isEU out when the load balancer has none', () => {
    const info = platformInfo(incoming(lbHeaders({ 'x-client-region': '', 'x-client-region-subdivision': '', 'x-client-city': '', 'x-client-city-lat-long': '' })), { locationHeaders: LOCATION });
    expect(info).toEqual({ clientIp: '198.51.100.23' });
  });

  it('decodes a UTF-8 city and drops bad coordinates through core', () => {
    const city = Buffer.from('São Paulo', 'utf8').toString('latin1');
    expect(platformInfo(incoming(lbHeaders({ 'x-client-city': city })), { locationHeaders: LOCATION }).city).toBe('São Paulo');
    expect(platformInfo(incoming(lbHeaders({ 'x-client-city-lat-long': '123,4' })), { locationHeaders: LOCATION })).not.toHaveProperty('latitude');
    expect(platformInfo(incoming(lbHeaders({ 'x-client-city-lat-long': 'nonsense' })), { locationHeaders: LOCATION })).not.toHaveProperty('latitude');
  });

  it('applies GDPR from the country header', async () => {
    const handler = createGcpHandler({ config: resolveConfig({}), locationHeaders: LOCATION });
    const eu = await call(handler, '/_sid/sync', { headers: { 'x-client-region': 'DE' } });
    expect(eu.headers.get('x-sharedid-status')).toBe('denied: tcf: GDPR applies and there is no TC string');
    expect(eu.headers.getSetCookie()).toEqual([]);
  });

  it('counts trusted hops from the end of X-Forwarded-For', () => {
    const req = incoming({ 'x-forwarded-for': '203.0.113.66, 198.51.100.23, 192.0.2.10, 35.191.0.1' });
    expect(clientIp(req)).toBe('192.0.2.10');
    expect(clientIp(req, { trustedHops: 2 })).toBe('198.51.100.23');
    expect(clientIp(req, { trustedHops: 0 })).toBe('35.191.0.1');
    expect(clientIp(incoming({ 'x-forwarded-for': '198.51.100.23' }))).toBeUndefined();
    expect(clientIp(incoming({}))).toBeUndefined();
    expect(clientIp(incoming({ 'x-forwarded-for': `<x>,${LB}` }))).toBeUndefined();
  });

  it('prefers a client IP header when configured', () => {
    const req = incoming({ 'x-forwarded-for': `203.0.113.66,${LB}`, 'x-client-ip': '198.51.100.99' });
    expect(clientIp(req, { clientIpHeader: 'x-client-ip' })).toBe('198.51.100.99');
    expect(clientIp(incoming({ 'x-forwarded-for': `203.0.113.66,${LB}` }), { clientIpHeader: 'x-client-ip' })).toBeUndefined();
  });

  it('trusts nothing when not behind the load balancer', () => {
    expect(platformInfo(incoming(lbHeaders()), { behindLoadBalancer: false, locationHeaders: LOCATION })).toEqual({});
  });
});

describe('handlerFromEnv', () => {
  it('parses its settings', () => {
    expect(parseTrustedHops(undefined)).toBe(1);
    expect(parseTrustedHops('2')).toBe(2);
    for (const bad of ['-1', 'x', '11', '1.5']) expect(() => parseTrustedHops(bad)).toThrow(/SID_TRUSTED_HOPS/);
    expect(parseLocationHeaders('{"country":"X-Client-Region"}')).toEqual({ country: 'x-client-region' });
    for (const bad of ['[]', '{"countryCode":"x"}', '{"country":"bad header"}', 'nope']) expect(() => parseLocationHeaders(bad)).toThrow(/SID_LOCATION_HEADERS/);
  });

  it('answers every request with a 500 when the configuration is invalid', async () => {
    for (const env of [{ SID_MAX_AGE_DAYS: '0' }, { SID_TRUSTED_HOPS: 'x' }, { SID_LOCATION_HEADERS: '{' }, { SID_CLIENT_IP_HEADER: 'a b' }]) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const handler = handlerFromEnv(env);
      expect(error).toHaveBeenCalledOnce();
      const response = await call(handler, '/_sid/sync');
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('SharedID Edge is misconfigured');
      expect(response.headers.getSetCookie()).toEqual([]);
      error.mockRestore();
    }
  });

  it('builds in the ec module, with its secret from SID_MODULE_SECRETS', async () => {
    const handler = handlerFromEnv({
      SID_MODULES: 'ec',
      SID_MODULE_CONFIG: '{"ec":{"domain":"example.com"}}',
      SID_MODULE_SECRETS: '{"ec":{"passphrase":"conformance-passphrase-0123456789abcdef"}}'
    });
    const response = await call(handler, '/_sid/v1', { headers: { 'x-forwarded-for': `192.0.2.77,${LB}` } });
    expect(((await response.json()) as Payload).ext.modules['ec']?.status).toBe('ok');
    expect(response.headers.getSetCookie().find(c => c.startsWith('ts-ec='))).toMatch(/^ts-ec=7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6};/);
  });

  it('reads the adapter\'s own settings', async () => {
    const handler = handlerFromEnv({
      SID_MODULES: 'ip,geo',
      SID_TRUSTED_HOPS: '2',
      SID_LOCATION_HEADERS: JSON.stringify(LOCATION),
      SID_PUBLIC_ORIGIN: 'http://localhost:8080'
    });
    const response = await call(handler, '/_sid/v1', { headers: { 'x-forwarded-for': `198.51.100.23,192.0.2.10,${LB}` } });
    expect(((await response.json()) as Payload).ortb2?.device).toMatchObject({ ip: '198.51.100.23', geo: { country: 'USA', region: 'WA', city: 'Seattle' } });
    const header = handlerFromEnv({ SID_MODULES: 'ip', SID_CLIENT_IP_HEADER: 'X-Client-IP' });
    expect(((await (await call(header, '/_sid/v1', { headers: { 'x-client-ip': '198.51.100.99' } })).json()) as Payload).ortb2?.device?.ip).toBe('198.51.100.99');
    const outside = handlerFromEnv({ SID_MODULES: 'ip', SID_BEHIND_LOAD_BALANCER: 'false' });
    expect(((await (await call(outside, '/_sid/v1')).json()) as Payload).ortb2).toBeUndefined();
  });
});

describe('terraform', () => {
  const root = join(import.meta.dirname, '..');
  let tf = '';
  beforeAll(() => {
    tf = ['main.tf', 'variables.tf'].map(file => readFileSync(join(root, 'terraform', file), 'utf8')).join('\n');
  });

  it('passes every SID_* setting core reads, and the adapter\'s own, to the function', () => {
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    for (const own of ['SID_TRUSTED_HOPS', 'SID_LOCATION_HEADERS']) settings.add(own);
    const plain = Array.from(tf.matchAll(/^ {6}(SID_[A-Z_]+) +=/gm), m => m[1]);
    const secret = Array.from(tf.matchAll(/^ +key += *"(SID_[A-Z_]+)"/gm), m => m[1]);
    expect(settings.size).toBeGreaterThan(10);
    expect([...plain, ...secret].sort()).toEqual([...settings].sort());
    expect(secret).toEqual(['SID_MODULE_SECRETS']);
  });

  it('lists every setting in env.example.yaml, for gcloud --env-vars-file, with SID_MODULE_SECRETS left to Secret Manager', () => {
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    settings.delete('SID_MODULE_SECRETS');
    for (const own of ['SID_TRUSTED_HOPS', 'SID_LOCATION_HEADERS']) settings.add(own);
    const yaml = readFileSync(join(root, 'env.example.yaml'), 'utf8');
    const listed = Array.from(yaml.matchAll(/^(SID_[A-Z_]+): /gm), m => m[1]);
    expect(listed.sort()).toEqual([...settings].sort());
    expect(yaml).toMatch(/^SID_LOCATION_HEADERS: '{"country":"x-client-region",/m);
  });

  it('keeps the function behind the load balancer, uncached, with the location headers', () => {
    expect(tf).toMatch(/ingress_settings += *"ALLOW_INTERNAL_AND_GCLB"/);
    expect(tf).toMatch(/enable_cdn += *false/);
    expect(tf).toMatch(/runtime += *"nodejs24"/);
    for (const variable of ['{client_region}', '{client_region_subdivision}', '{client_city}', '{client_city_lat_long}']) expect(tf).toContain(variable);
  });
});
