import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModule, resolveConfig } from '@sharedid-edge/core';
import {
  builtInModules,
  clientIp,
  createVercelHandler,
  createVercelMiddleware,
  EU_COUNTRY_CODES,
  handlerFromEnv,
  middlewareFromEnv,
  ownsPath,
  platformInfo
} from '../src/index.js';
import { GEO_HEADERS, vercelRequest } from './requests.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string; readonly geo?: Readonly<Record<string, unknown>> } };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

async function payload(response: Response): Promise<Payload> {
  return await response.json() as Payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createVercelHandler', () => {
  it('answers a first-visit sync with the GIF and two separate Set-Cookie headers', async () => {
    const handler = createVercelHandler({ config: resolveConfig({}) });
    const response = await handler(vercelRequest({ query: `id=pubcid%253A${UUID}`, omitHeaders: ['x-vercel-ip-country'] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
    expect(cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
    // The request URL is https on Vercel, so the cookies are Secure.
    for (const cookie of cookies) expect(cookie).toContain('; Secure');
    const gif = new Uint8Array(await response.arrayBuffer());
    expect(gif.byteLength).toBe(43);
    expect(new TextDecoder('latin1').decode(gif.subarray(0, 6))).toBe('GIF89a');
  });

  it('reads the Cookie header and keeps an existing ID', async () => {
    const handler = createVercelHandler({ config: resolveConfig({}) });
    const response = await handler(vercelRequest({ path: '/_sid/v1', headers: { cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}; other=1` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-sharedid-source')).toBe('cookie');
    expect((await payload(response)).sharedid).toBe(UUID);
  });

  it('restores the recovery copy over a re-minted ID', async () => {
    const handler = createVercelHandler({ config: resolveConfig({}) });
    const response = await handler(vercelRequest({
      query: `id=pubcid%253A${OTHER}`,
      headers: { cookie: `_pubcid_sv=${UUID}` },
      omitHeaders: ['x-vercel-ip-country']
    }));
    expect(response.headers.get('x-sharedid-source')).toBe('recovery');
    expect(response.headers.getSetCookie()[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
  });

  it('uses the request URL, or publicOrigin; the scheme decides Secure', async () => {
    const seen: string[] = [];
    const probe = defineModule({ name: 'probe', run: ({ url }) => { seen.push(url.href); return undefined; } });
    const config = resolveConfig({ SID_MODULES: 'probe' });
    await createVercelHandler({ config, modules: [probe] })(vercelRequest({ path: '/_sid/v1', query: 'a=1' }));
    await createVercelHandler({ config, modules: [probe], publicOrigin: 'https://www.example.org' })(vercelRequest({ path: '/_sid/v1', query: 'a=1', origin: 'http://localhost:3000' }));
    expect(seen).toEqual(['https://www.example.com/_sid/v1?a=1', 'https://www.example.org/_sid/v1?a=1']);

    const local = await createVercelHandler({ config: resolveConfig({}) })(vercelRequest({ origin: 'http://localhost:3000', omitHeaders: ['x-vercel-ip-country'] }));
    expect(local.headers.getSetCookie()[0]).not.toContain('Secure');
  });

  it('answers HEAD (the platform drops the body), and other methods with 405, through publicOrigin too', async () => {
    const handler = createVercelHandler({ config: resolveConfig({}), publicOrigin: 'https://www.example.com' });
    const head = await handler(vercelRequest({ method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/gif');
    const post = await handler(new Request('https://www.example.com/_sid/sync', { method: 'POST', body: 'x=1' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers a CORS preflight for /v1', async () => {
    const handler = createVercelHandler({ config: resolveConfig({ SID_ALLOWED_ORIGINS: 'https://news.example.com' }) });
    const response = await handler(vercelRequest({
      path: '/_sid/v1',
      method: 'OPTIONS',
      headers: { 'origin': 'https://news.example.com', 'access-control-request-method': 'GET' }
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://news.example.com');
  });

  it('returns a generic 500 when the request can\'t be handled, without request data', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createVercelHandler({ config: resolveConfig({}), publicOrigin: 'not a url secret' });
    const response = await handler(vercelRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal error');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
  });
});

describe('createVercelMiddleware', () => {
  it('answers the base path and passes everything else on', async () => {
    const mw = createVercelMiddleware({ config: resolveConfig({ SID_BASE_PATH: '/identity' }) });
    expect((await mw(vercelRequest({ path: '/identity/v1' })))?.status).toBe(200);
    expect((await mw(vercelRequest({ path: '/identity/nope' })))?.status).toBe(404);
    expect(await mw(vercelRequest({ path: '/' }))).toBeUndefined();
    expect(await mw(vercelRequest({ path: '/identityx/v1' }))).toBeUndefined();
    expect(await mw(vercelRequest({ path: '/_sid/v1' }))).toBeUndefined();
  });

  it('with the root base path, answers exactly the core routes and passes the rest of the site on', async () => {
    const mw = createVercelMiddleware({ config: resolveConfig({ SID_BASE_PATH: '/' }) });
    for (const path of ['/sync', '/v1', '/optout', '/optin', '/v1/']) expect((await mw(vercelRequest({ path })))?.status, path).not.toBeUndefined();
    expect((await mw(vercelRequest({ path: '/v1' })))?.status).toBe(200);
    for (const path of ['/', '/article', '/sync-later', '/v10', '/_sid/v1']) expect(await mw(vercelRequest({ path })), path).toBeUndefined();
    expect(ownsPath('/sync', '/')).toBe(true);
    expect(ownsPath('/blog', '/')).toBe(false);
    expect(ownsPath('/identity/v1', '/identity')).toBe(true);
    expect(ownsPath('/identityx', '/identity')).toBe(false);
    // linear on long runs of '/' (a regular expression here could backtrack polynomially)
    const started = Date.now();
    expect(ownsPath(`/${'/'.repeat(100_000)}x`, '/')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is configured from the environment, and a misconfiguration fails only the base path', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = middlewareFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_BASE_PATH: '/identity' });
    expect((await ok(vercelRequest({ path: '/identity/v1' })))?.status).toBe(200);
    expect(await ok(vercelRequest({ path: '/_sid/v1' }))).toBeUndefined();

    const bad = middlewareFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MAX_AGE_DAYS: '0' });
    expect((await bad(vercelRequest({ path: '/_sid/sync' })))?.status).toBe(500);
    expect(await bad(vercelRequest({ path: '/article' }))).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();

    const badPath = middlewareFromEnv({ SID_BASE_PATH: 'no-slash' });
    expect((await badPath(vercelRequest({ path: '/_sid/sync' })))?.status).toBe(500);
    expect(await badPath(vercelRequest({ path: '/' }))).toBeUndefined();
  });
});

describe('the ip module on /v1', () => {
  const handler = createVercelHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules });

  it('uses an IPv4 x-real-ip', async () => {
    const body = await payload(await handler(vercelRequest({ path: '/_sid/v1', omitHeaders: GEO_HEADERS })));
    expect(body.ortb2?.device?.ip).toBe('198.51.100.23');
    expect(body.ext.modules['ip']?.status).toBe('ok');
  });

  it('uses an IPv6 x-real-ip', async () => {
    const response = await handler(vercelRequest({
      path: '/_sid/v1',
      headers: { 'x-real-ip': '2001:DB8:0:0:abcd::1', 'x-forwarded-for': '2001:DB8:0:0:abcd::1' },
      omitHeaders: GEO_HEADERS
    }));
    expect((await payload(response)).ortb2?.device?.ipv6).toBe('2001:db8::abcd:0:0:1');
  });

  it('has no client IP when not behind Vercel, whatever the headers say', async () => {
    const outside = createVercelHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules, behindVercel: false });
    const body = await payload(await outside(vercelRequest({ path: '/_sid/v1' })));
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ip']?.status).toBe('empty');
  });

  it('is built in through handlerFromEnv', async () => {
    const response = await handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ip' })(vercelRequest({ path: '/_sid/v1', omitHeaders: GEO_HEADERS }));
    expect((await payload(response)).ortb2?.device?.ip).toBe('198.51.100.23');
  });
});

describe('platformInfo', () => {
  it('reads the client IP and every x-vercel-ip-* location header', () => {
    expect(platformInfo(vercelRequest().headers)).toEqual({
      clientIp: '198.51.100.23', country: 'US', region: 'WA', isEU: false, city: 'Seattle', postalCode: '98101',
      latitude: 47.6062, longitude: -122.3321, timezone: 'America/Los_Angeles', continent: 'NA'
    });
  });

  it('sets isEU from the country', () => {
    const info = platformInfo(vercelRequest({ headers: { 'x-vercel-ip-country': 'fr', 'x-vercel-ip-country-region': 'IDF', 'x-vercel-ip-continent': 'EU' } }).headers);
    expect(info).toMatchObject({ country: 'FR', region: 'IDF', continent: 'EU', isEU: true });
    expect(EU_COUNTRY_CODES.has('FR')).toBe(true);
  });

  it('decodes a percent-encoded city, and drops one that isn\'t valid', () => {
    expect(platformInfo(vercelRequest({ headers: { 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' } }).headers).city).toBe('São Paulo');
    expect(platformInfo(vercelRequest({ headers: { 'x-vercel-ip-city': 'Z%FCrich%' } }).headers)).not.toHaveProperty('city');
  });

  it('drops invalid values through core\'s locationInfo', () => {
    const info = platformInfo(vercelRequest({ headers: { 'x-vercel-ip-country': 'XX', 'x-vercel-ip-latitude': '123', 'x-vercel-ip-timezone': 'not a zone' } }).headers);
    expect(info).not.toHaveProperty('country');
    expect(info).not.toHaveProperty('isEU');
    expect(info).not.toHaveProperty('latitude');
    expect(info).not.toHaveProperty('longitude');
    expect(info).not.toHaveProperty('timezone');
  });

  it('leaves location and isEU undefined when the geo headers are missing', () => {
    const info = platformInfo(vercelRequest({ omitHeaders: GEO_HEADERS }).headers);
    expect(info).toEqual({ clientIp: '198.51.100.23' });
    expect(info.isEU).toBeUndefined();
  });

  it('applies GDPR from the EU flag, and not when the country is unknown', async () => {
    const handler = createVercelHandler({ config: resolveConfig({}) });
    const eu = await handler(vercelRequest({ headers: { 'x-vercel-ip-country': 'DE' } }));
    expect(eu.headers.get('x-sharedid-status')).toBe('denied: tcf: GDPR applies and there is no TC string');
    expect(eu.headers.getSetCookie()).toEqual([]);
    const unknown = await handler(vercelRequest({ omitHeaders: GEO_HEADERS }));
    expect(unknown.headers.getSetCookie()).toHaveLength(2);
  });

  it('takes x-real-ip, else the first x-forwarded-for entry, and ignores anything that isn\'t an address', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' }))).toBe('192.0.2.1');
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 192.0.2.2, 10.0.0.1' }))).toBe('192.0.2.2');
    expect(clientIp(new Headers({ 'x-real-ip': 'unknown', 'x-forwarded-for': '2001:db8::2' }))).toBe('2001:db8::2');
    expect(clientIp(new Headers({ 'x-real-ip': '<script>' }))).toBeUndefined();
    expect(clientIp(new Headers())).toBeUndefined();
  });

  it('ignores every header when not behind Vercel', () => {
    expect(platformInfo(vercelRequest().headers, { behindVercel: false })).toEqual({});
  });

  it('runs the geo module from Vercel\'s headers', async () => {
    const handler = createVercelHandler({ config: resolveConfig({ SID_MODULES: 'geo' }), modules: builtInModules });
    const body = await payload(await handler(vercelRequest({ path: '/_sid/v1' })));
    expect(body.ortb2?.device?.geo).toMatchObject({ type: 2, country: 'USA', region: 'WA', city: 'Seattle' });
  });
});

describe('handlerFromEnv', () => {
  it('answers every request with a 500 when the configuration is invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MAX_AGE_DAYS: '0' });
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).toContain('SID_MAX_AGE_DAYS');
    for (const path of ['/_sid/sync', '/_sid/v1']) {
      const response = await handler(vercelRequest({ path }));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('SharedID Edge is misconfigured');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers every request with a 500 without SID_COOKIE_DOMAIN, naming the setting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv({});
    expect(String(error.mock.calls[0]?.[0])).toContain('SID_COOKIE_DOMAIN');
    expect((await handler(vercelRequest({ path: '/_sid/sync' }))).status).toBe(500);
    error.mockRestore();
  });

  it("doesn't build in ec: listed in SID_MODULES without being added, it's skipped as not installed", async () => {
    const handler = handlerFromEnv({
      SID_COOKIE_DOMAIN: 'host-only',
      SID_MODULES: 'ec',
      SID_MODULE_CONFIG: '{"ec":{"domain":"example.com"}}',
      SID_MODULE_SECRETS: '{"ec":{"passphrase":"conformance-passphrase-0123456789abcdef"}}'
    });
    const response = await handler(vercelRequest({ path: '/_sid/v1', headers: { 'x-real-ip': '192.0.2.77' }, omitHeaders: GEO_HEADERS }));
    // ec is a vendor module: a deployer adds it at build time (conformance/cases/module-ec.json covers that build).
    expect((await payload(response)).ext.modules['ec']).toEqual({ ms: 0, status: 'skipped', reason: 'not installed' });
    expect(response.headers.getSetCookie().find(c => c.startsWith('ts-ec='))).toBeUndefined();
  });

  it('reads SID_PUBLIC_ORIGIN and SID_BEHIND_VERCEL', async () => {
    const handler = handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ip', SID_PUBLIC_ORIGIN: 'http://localhost:3000', SID_BEHIND_VERCEL: 'false' });
    const response = await handler(vercelRequest({ path: '/_sid/v1' }));
    expect((await payload(response)).ortb2).toBeUndefined();
    const sync = await handler(vercelRequest());
    expect(sync.headers.getSetCookie()[0]).not.toContain('Secure');
  });
});

describe('the example', () => {
  const root = join(import.meta.dirname, '..');

  it('lists every SID_* setting core reads in .env.example', () => {
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    // Trusted upstream (SID_UPSTREAM_*, with SID_CLIENT_IP_HEADER and SID_LOCATION_HEADERS): refused here, so not in the example.
    for (const name of [...settings]) if (name === undefined || name.startsWith('SID_UPSTREAM_') || name === 'SID_CLIENT_IP_HEADER' || name === 'SID_LOCATION_HEADERS') settings.delete(name);
    const listed = new Set(Array.from(readFileSync(join(root, 'example/.env.example'), 'utf8').matchAll(/^#? ?(SID_[A-Z_]+)=/gm), m => m[1]));
    expect(settings.size).toBeGreaterThan(10);
    for (const setting of settings) expect(listed).toContain(setting);
  });

  it('mounts the handler on the %5Fsid route (a plain _sid folder is private in the App Router), on GET, HEAD and OPTIONS', () => {
    const route = readFileSync(join(root, 'example/app/%5Fsid/[...path]/route.ts'), 'utf8');
    expect(route).toMatch(/^export const runtime = 'nodejs';$/m);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(route).toMatch(new RegExp(`^export const ${method} = `, 'm'));
  });
});
