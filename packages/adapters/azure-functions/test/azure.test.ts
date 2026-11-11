import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModule, resolveConfig, ROUTES } from '@sharedid-edge/core';
import {
  builtInModules,
  clientIp,
  createAzureHandler,
  frontDoorPatterns,
  handlerFromEnv,
  parseFrontDoorIds,
  parseLocationHeaders,
  parseSetCookie,
  platformInfo,
  preservedByHost,
  routeFor,
  routeFromEnv,
  type AzureHttpResponseInit
} from '../src/index.js';
import { FRONT_DOOR_ID, frontDoorRequest } from './requests.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';
const COUNTRY = { country: 'x-sid-country' } as const;

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string; readonly geo?: Readonly<Record<string, unknown>> } };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

function text(result: AzureHttpResponseInit): string {
  return result.body === undefined ? '' : new TextDecoder().decode(result.body);
}

function payload(result: AzureHttpResponseInit): Payload {
  return JSON.parse(text(result)) as Payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAzureHandler', () => {
  it('answers a first-visit sync with the GIF and each Set-Cookie in cookies[]', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}) });
    const result = await handler(frontDoorRequest({ query: `id=pubcid%253A${UUID}` }));
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('image/gif');
    expect(result.headers).not.toHaveProperty('set-cookie');
    expect(result.cookies).toHaveLength(2);
    expect(result.cookies[0]).toMatchObject({ name: '_pubcid', value: UUID, path: '/', sameSite: 'Lax', maxAge: 31536000, secure: true });
    expect(result.cookies[0]?.httpOnly).toBeUndefined();
    expect(result.cookies[0]?.expires).toBeInstanceOf(Date);
    expect(result.cookies[1]).toMatchObject({ name: '_pubcid_sv', value: UUID, httpOnly: true, secure: true });
    expect(result.body?.byteLength).toBe(43);
    expect(new TextDecoder('latin1').decode(result.body?.subarray(0, 6))).toBe('GIF89a');
  });

  it('reads the Cookie header and keeps an existing ID', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}) });
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', headers: { cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}; other=1` } }));
    expect(result.headers['x-sharedid-source']).toBe('cookie');
    expect(payload(result).sharedid).toBe(UUID);
  });

  it('restores the recovery copy over a re-minted ID', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}) });
    const result = await handler(frontDoorRequest({ query: `id=pubcid%253A${OTHER}`, headers: { cookie: `_pubcid_sv=${UUID}` } }));
    expect(result.headers['x-sharedid-source']).toBe('recovery');
    expect(result.cookies[0]).toMatchObject({ name: '_pubcid', value: UUID });
  });

  it('turns a deletion into a cookie with maxAge 0', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}) });
    const result = await handler(frontDoorRequest({ headers: { 'sec-gpc': '1', 'cookie': `_pubcid=${UUID}` } }));
    expect(result.cookies.find(c => c.name === '_pubcid')).toMatchObject({ value: '', maxAge: 0 });
  });

  it('uses the request URL, or publicOrigin; the scheme decides Secure', async () => {
    const seen: string[] = [];
    const probe = defineModule({ name: 'probe', run: ({ url }) => { seen.push(url.href); return undefined; } });
    const config = resolveConfig({ SID_MODULES: 'probe' });
    await createAzureHandler({ config, modules: [probe] })(frontDoorRequest({ path: '/_sid/v1', query: 'a=1' }));
    await createAzureHandler({ config, modules: [probe], publicOrigin: 'https://www.example.com' })(frontDoorRequest({ path: '/_sid/v1', query: 'a=1' }));
    expect(seen).toEqual(['https://sharedid-edge-abc123.azurewebsites.net/_sid/v1?a=1', 'https://www.example.com/_sid/v1?a=1']);
    const plain = await createAzureHandler({ config: resolveConfig({}), publicOrigin: 'http://localhost:7071' })(frontDoorRequest());
    expect(plain.cookies[0]?.secure).toBeUndefined();
  });

  it('answers HEAD without a body, and other methods with 405', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}) });
    const head = await handler(frontDoorRequest({ method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    const post = await handler(frontDoorRequest({ method: 'POST', body: 'x=1' }));
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
  });

  it('answers a CORS preflight for /v1', async () => {
    const handler = createAzureHandler({ config: resolveConfig({ SID_ALLOWED_ORIGINS: 'https://news.example.com' }) });
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', method: 'OPTIONS', headers: { 'origin': 'https://news.example.com', 'access-control-request-method': 'GET' } }));
    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-origin']).toBe('https://news.example.com');
  });

  it('accepts only the configured Front Door profiles when frontDoorIds is set', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}), frontDoorIds: [FRONT_DOOR_ID.toUpperCase()] });
    expect((await handler(frontDoorRequest())).status).toBe(200);
    const other = await handler(frontDoorRequest({ headers: { 'x-azure-fdid': '11111111-2222-4333-8444-555555555555' } }));
    expect(other.status).toBe(403);
    expect(other.cookies).toEqual([]);
    expect(text(other)).toBe('Forbidden');
    expect((await handler(frontDoorRequest({ omitHeaders: ['x-azure-fdid'] }))).status).toBe(403);
  });

  it('returns a generic 500 when the request can\'t be handled, without request data', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createAzureHandler({ config: resolveConfig({}), publicOrigin: 'not a url secret' });
    const result = await handler(frontDoorRequest());
    expect(result.status).toBe(500);
    expect(text(result)).toBe('Internal error');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
  });
});

describe('cookies', () => {
  it('parses every attribute core writes', () => {
    expect(parseSetCookie('a=b.c; Max-Age=60; Expires=Wed, 10 Nov 2027 22:07:24 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly')).toEqual({
      name: 'a', value: 'b.c', maxAge: 60, expires: new Date('2027-11-10T22:07:24Z'), path: '/', domain: '.example.com', sameSite: 'Lax', secure: true, httpOnly: true
    });
    expect(parseSetCookie('a=; Max-Age=0; SameSite=None')).toEqual({ name: 'a', value: '', maxAge: 0, sameSite: 'None' });
    expect(parseSetCookie('a=1; SameSite=Strict; Expires=never; Unknown=x')).toEqual({ name: 'a', value: '1', sameSite: 'Strict' });
  });

  it('knows which values the host sets unchanged', () => {
    for (const value of ['', UUID, 'GA1.1.123.456', 'eyJh-_~', 'ts.AbC9z']) expect(preservedByHost(value)).toBe(true);
    for (const value of ['AbC%2Fx', 'a+b', 'a/b', 'a=b', 'a:b', '"q"', 'a b']) expect(preservedByHost(value)).toBe(false);
  });

  it('puts a cookie the host would encode into a raw Set-Cookie header', async () => {
    const handler = createAzureHandler({
      config: resolveConfig({ SID_MODULES: 'reflect', SID_MODULE_CONFIG: '{"reflect":{"cookies":[{"name":"uid1","maxAgeDays":30},{"name":"fpid","maxAgeDays":30}]}}' }),
      modules: builtInModules
    });
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', headers: { cookie: `_pubcid=${UUID}; uid1=AbC%2Fx+y/z==; fpid=7a1f-0c2e_93b4` } }));
    expect(result.headers['set-cookie']).toMatch(/^uid1=AbC%2Fx\+y\/z==;/);
    expect(result.cookies.map(c => c.name)).toContain('fpid');
    expect(result.cookies.map(c => c.name)).not.toContain('uid1');
  });
});

describe('the ip module on /v1', () => {
  const handler = createAzureHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules });

  it('uses an IPv4 X-Azure-ClientIP', async () => {
    const body = payload(await handler(frontDoorRequest({ path: '/_sid/v1' })));
    expect(body.ortb2?.device?.ip).toBe('198.51.100.23');
    expect(body.ext.modules['ip']?.status).toBe('ok');
  });

  it('uses an IPv6 X-Azure-ClientIP', async () => {
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', headers: { 'x-azure-clientip': '2001:DB8:0:0:abcd::1' } }));
    expect(payload(result).ortb2?.device?.ipv6).toBe('2001:db8::abcd:0:0:1');
  });

  it('ignores X-Forwarded-For and X-Azure-SocketIP', async () => {
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', omitHeaders: ['x-azure-clientip'] }));
    expect(payload(result).ortb2).toBeUndefined();
    expect(payload(result).ext.modules['ip']?.status).toBe('empty');
  });

  it('trusts nothing when not behind Front Door', async () => {
    const outside = createAzureHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules, behindFrontDoor: false });
    expect(payload(await outside(frontDoorRequest({ path: '/_sid/v1' }))).ortb2).toBeUndefined();
  });
});

describe('platformInfo', () => {
  const headers = (extra: Readonly<Record<string, string>> = {}): Headers => frontDoorRequest({ headers: extra }).headers;

  it('has the client IP and no location by default: Front Door adds no location headers', () => {
    expect(platformInfo(headers({ 'x-sid-country': 'FR' }))).toEqual({ clientIp: '198.51.100.23' });
  });

  it('reads the location from the configured headers, through core\'s locationInfo, with isEU', () => {
    expect(platformInfo(headers({ 'x-sid-country': 'fr' }), { locationHeaders: COUNTRY })).toEqual({ clientIp: '198.51.100.23', country: 'FR', isEU: true });
    expect(platformInfo(headers({ 'x-sid-country': 'US' }), { locationHeaders: COUNTRY })).toMatchObject({ country: 'US', isEU: false });
    // Front Door's {geo_country} is empty when the location is unknown.
    expect(platformInfo(headers({ 'x-sid-country': '' }), { locationHeaders: COUNTRY })).toEqual({ clientIp: '198.51.100.23' });
    expect(platformInfo(headers({ 'x-sid-country': 'XX' }), { locationHeaders: COUNTRY })).not.toHaveProperty('isEU');
    const all = parseLocationHeaders('{"country":"x-c","regionCode":"x-r","city":"x-city","latitude":"x-lat","longitude":"x-lon","timezone":"x-tz","continent":"x-co","postalCode":"x-p","metroCode":"x-m"}');
    expect(platformInfo(headers({ 'x-c': 'US', 'x-r': 'WA', 'x-city': 'Seattle', 'x-lat': '47.6', 'x-lon': '-122.3', 'x-tz': 'America/Los_Angeles', 'x-co': 'NA', 'x-p': '98101', 'x-m': '819' }), { locationHeaders: all })).toEqual({
      clientIp: '198.51.100.23', country: 'US', region: 'WA', city: 'Seattle', latitude: 47.6, longitude: -122.3, timezone: 'America/Los_Angeles', continent: 'NA', postalCode: '98101', metroCode: '819', isEU: false
    });
  });

  it('applies GDPR from the configured country header, and not without one', async () => {
    const handler = createAzureHandler({ config: resolveConfig({}), locationHeaders: COUNTRY });
    const eu = await handler(frontDoorRequest({ headers: { 'x-sid-country': 'DE' } }));
    expect(eu.headers['x-sharedid-status']).toBe('denied: tcf: GDPR applies and there is no TC string');
    expect(eu.cookies).toEqual([]);
    expect((await handler(frontDoorRequest())).cookies).toHaveLength(2);
  });

  it('takes the client IP only from X-Azure-ClientIP, and only an address', () => {
    expect(clientIp(new Headers({ 'x-azure-clientip': '2001:db8::1', 'x-forwarded-for': '192.0.2.9' }))).toBe('2001:db8::1');
    expect(clientIp(new Headers({ 'x-forwarded-for': '192.0.2.9', 'x-azure-socketip': '192.0.2.8' }))).toBeUndefined();
    expect(clientIp(new Headers({ 'x-azure-clientip': '<x>' }))).toBeUndefined();
  });

  it('ignores every header when not behind Front Door', () => {
    expect(platformInfo(headers({ 'x-sid-country': 'FR' }), { behindFrontDoor: false, locationHeaders: COUNTRY })).toEqual({});
  });
});

describe('settings', () => {
  it('parses SID_LOCATION_HEADERS and rejects anything else', () => {
    expect(parseLocationHeaders(undefined)).toEqual({});
    expect(parseLocationHeaders('{"country":"X-SID-Country"}')).toEqual({ country: 'x-sid-country' });
    for (const bad of ['[]', 'nope', '{"county":"x"}', '{"country":"bad header"}', '{"country":1}']) {
      expect(() => parseLocationHeaders(bad)).toThrow(/SID_LOCATION_HEADERS/);
    }
  });

  it('parses SID_FRONT_DOOR_ID', () => {
    expect(parseFrontDoorIds('')).toEqual([]);
    expect(parseFrontDoorIds(` ${FRONT_DOOR_ID} ,${FRONT_DOOR_ID}`)).toEqual([FRONT_DOOR_ID, FRONT_DOOR_ID]);
    expect(() => parseFrontDoorIds('not-an-id')).toThrow(/SID_FRONT_DOOR_ID/);
  });

  it('derives the route template from the base path', () => {
    expect(routeFor('/_sid')).toBe('_sid/{*path}');
    expect(routeFor('/identity/sync-v2')).toBe('identity/sync-v2/{*path}');
    expect(routeFor('/')).toBe('{*path}');
    expect(routeFor('//identity//')).toBe('identity/{*path}');
    expect(routeFromEnv({})).toBe('_sid/{*path}');
    expect(routeFromEnv({ SID_BASE_PATH: '/identity/' })).toBe('identity/{*path}');
    expect(routeFromEnv({ SID_BASE_PATH: '/' })).toBe('{*path}');
    expect(routeFromEnv({ SID_BASE_PATH: 'no-slash' })).toBe('_sid/{*path}');
  });

  it('trims long runs of slashes in linear time (no backtracking regular expression)', () => {
    const slashes = '/'.repeat(200_000);
    const start = performance.now();
    expect(routeFor(`${slashes}identity${slashes}`)).toBe('identity/{*path}');
    expect(routeFor(slashes)).toBe('{*path}');
    expect(routeFor(`${slashes}x`)).toBe('x/{*path}');
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('builds the Front Door patterns from the base path as core normalizes it, matching the function route', () => {
    expect(frontDoorPatterns('/_sid')).toEqual(['/_sid', '/_sid/*']);
    expect(frontDoorPatterns('/identity/')).toEqual(['/identity', '/identity/*']);
    expect(frontDoorPatterns('/identity')).toEqual(['/identity', '/identity/*']);
    // The root path: only core's routes, so the rest of the site stays on its origin.
    expect(frontDoorPatterns('/')).toEqual(['/sync', '/sync/', '/v1', '/v1/', '/optout', '/optout/', '/optin', '/optin/']);
    for (const basePath of ['/_sid', '/identity/', '/identity']) {
      // The function's route is the first pattern without its leading slash, plus the catch-all.
      expect(routeFromEnv({ SID_BASE_PATH: basePath })).toBe(`${frontDoorPatterns(basePath)[0]?.slice(1) ?? ''}/{*path}`);
    }
    for (const bad of ['identity', '/identity//', '/a b']) expect(() => frontDoorPatterns(bad)).toThrow(/SID_BASE_PATH/);
  });

  it.each([['/identity', '/identity/sync'], ['/', '/sync']])('answers under SID_BASE_PATH=%s', async (basePath, path) => {
    const handler = handlerFromEnv({ SID_BASE_PATH: basePath });
    expect((await handler(frontDoorRequest({ path, query: `id=pubcid%3A${UUID}` }))).cookies[0]).toMatchObject({ name: '_pubcid', value: UUID });
    expect((await handler(frontDoorRequest({ path: '/_sid/sync' }))).status).toBe(404);
  });
});

describe('handlerFromEnv', () => {
  it('answers every request with a 500 when the configuration is invalid', async () => {
    for (const env of [{ SID_MAX_AGE_DAYS: '0' }, { SID_LOCATION_HEADERS: '{"country":' }, { SID_FRONT_DOOR_ID: 'x' }]) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const handler = handlerFromEnv(env);
      expect(error).toHaveBeenCalledOnce();
      const result = await handler(frontDoorRequest());
      expect(result.status).toBe(500);
      expect(text(result)).toBe('SharedID Edge is misconfigured');
      expect(result.cookies).toEqual([]);
      error.mockRestore();
    }
  });

  it('builds in the ec module, with its secret from SID_MODULE_SECRETS', async () => {
    const handler = handlerFromEnv({
      SID_MODULES: 'ec',
      SID_MODULE_CONFIG: '{"ec":{"domain":"example.com"}}',
      SID_MODULE_SECRETS: '{"ec":{"passphrase":"conformance-passphrase-0123456789abcdef"}}'
    });
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', headers: { 'x-azure-clientip': '192.0.2.77' } }));
    expect(payload(result).ext.modules['ec']?.status).toBe('ok');
    // HMAC-SHA256 of 192.0.2.77 with that passphrase, as in conformance/cases/module-ec.json.
    expect(result.cookies.find(c => c.name === 'ts-ec')?.value).toMatch(/^7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6}$/);
  });

  it('reads the adapter\'s own settings', async () => {
    const handler = handlerFromEnv({
      SID_MODULES: 'ip,geo',
      SID_PUBLIC_ORIGIN: 'http://localhost:7071',
      SID_FRONT_DOOR_ID: FRONT_DOOR_ID,
      SID_LOCATION_HEADERS: '{"country":"x-sid-country"}'
    });
    const result = await handler(frontDoorRequest({ path: '/_sid/v1', headers: { 'x-sid-country': 'US' } }));
    expect(payload(result).ortb2?.device).toMatchObject({ ip: '198.51.100.23', geo: { country: 'USA' } });
    expect((await handler(frontDoorRequest({ omitHeaders: ['x-azure-fdid'] }))).status).toBe(403);
    expect((await handler(frontDoorRequest())).cookies[0]?.secure).toBeUndefined();
    const outside = handlerFromEnv({ SID_MODULES: 'ip', SID_BEHIND_FRONT_DOOR: 'false' });
    expect(payload(await outside(frontDoorRequest({ path: '/_sid/v1' }))).ortb2).toBeUndefined();
  });
});

describe('infrastructure', () => {
  const root = join(import.meta.dirname, '..');
  const bicep = readFileSync(join(root, 'infra/main.bicep'), 'utf8');

  it('passes every SID_* setting core reads, and the adapter\'s own, to the function app', () => {
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    for (const own of ['SID_FRONT_DOOR_ID', 'SID_LOCATION_HEADERS']) settings.add(own);
    const passed = new Set(Array.from(bicep.matchAll(/name: '(SID_[A-Z_]+)'/g), m => m[1]));
    expect(settings.size).toBeGreaterThan(10);
    expect([...passed].sort()).toEqual([...settings].sort());
  });

  it('lists every SID_* setting core reads, and the adapter\'s own, in local.settings.example.json', () => {
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    for (const own of ['SID_FRONT_DOOR_ID', 'SID_LOCATION_HEADERS', 'SID_PUBLIC_ORIGIN', 'SID_BEHIND_FRONT_DOOR']) settings.add(own);
    const example = JSON.parse(readFileSync(join(root, 'local.settings.example.json'), 'utf8')) as { Values: Record<string, string> };
    expect(Object.keys(example.Values).filter(name => name.startsWith('SID_')).sort()).toEqual([...settings].sort());
    // Locally there's no Front Door: its headers aren't trusted, and http cookies aren't Secure.
    expect(example.Values).toMatchObject({ SID_BEHIND_FRONT_DOOR: 'false', SID_PUBLIC_ORIGIN: 'http://localhost:7071' });
    // Every value is empty (the default) or valid: the example must not give a misconfigured handler.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handlerFromEnv(example.Values);
    expect(error).not.toHaveBeenCalled();
  });

  describe('base path (infra/basepath.bicep)', () => {
    const basepath = readFileSync(join(root, 'infra/basepath.bicep'), 'utf8');
    const frontdoor = readFileSync(join(root, 'infra/frontdoor.bicep'), 'utf8');

    /**
     * Evaluates one of basepath.bicep's one-line functions in JavaScript. The Bicep expressions use only functions
     * with JavaScript equivalents below, and lambdas, operators and ternaries with the same syntax; string
     * interpolation ('${p}/') becomes a template literal. int() of a non-number fails, as it does in ARM.
     */
    function bicepFunction(name: string): (argument: unknown) => unknown {
      const match = new RegExp(`^func ${name}\\((\\w+) \\w+\\) \\w+ => (.+)$`, 'm').exec(basepath.replace(/\r\n/g, '\n'));
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`no one-line func ${name} in basepath.bicep`);
      const parameter = match[1];
      const body = match[2].replace(/'([^']*\$\{[^']*)'/g, '`$1`');
      return argument => runInNewContext(body, {
        [parameter]: argument,
        startsWith: (s: string, prefix: string) => s.startsWith(prefix),
        endsWith: (s: string, suffix: string) => s.endsWith(suffix),
        contains: (s: string, part: string) => s.includes(part),
        length: (s: string) => s.length,
        substring: (s: string, start: number, count: number) => s.substring(start, start + count),
        empty: (array: readonly unknown[]) => array.length === 0,
        range: (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i),
        filter: (array: readonly unknown[], test: (item: unknown) => boolean) => array.filter(test),
        map: (array: readonly unknown[], fn: (item: unknown) => unknown) => array.map(fn),
        flatten: (array: readonly (readonly unknown[])[]) => array.flat(),
        string: (value: unknown) => String(value),
        int: (value: string) => {
          if (!/^-?\d{1,18}$/.test(value)) throw new Error(value);
          return Number(value);
        }
      }) as unknown;
    }
    const normalizeBasePath = bicepFunction('normalizeBasePath');
    const patternsFor = bicepFunction('frontDoorPatterns');

    it.each(['/_sid', '/identity/', '/identity', '/', '/a/b.c_d~e-f'])('renders the same Front Door patterns as frontDoorPatterns for %s', basePath => {
      const normalized = normalizeBasePath(basePath);
      expect(normalized).toBe(resolveConfig({ SID_BASE_PATH: basePath }).basePath);
      expect(patternsFor(normalized)).toEqual(frontDoorPatterns(basePath));
    });

    it('fails the deployment for every base path core rejects', () => {
      for (const bad of ['identity', '/identity//', '//', '/a b', '/a?b', '/%5Fsid', '/é']) {
        expect(() => resolveConfig({ SID_BASE_PATH: bad })).toThrow(/SID_BASE_PATH/);
        expect(() => normalizeBasePath(bad)).toThrow(/^Invalid sidBasePath/);
      }
      // Every printable ASCII character: allowed in the template exactly when core allows it.
      const accepts = (check: (path: string) => unknown): string[] => {
        const accepted: string[] = [];
        for (let code = 0x21; code < 0x7f; code++) {
          const char = String.fromCharCode(code);
          try {
            check(`/a${char}b`);
            accepted.push(char);
          } catch {
            // rejected
          }
        }
        return accepted;
      };
      expect(accepts(normalizeBasePath)).toEqual(accepts(path => resolveConfig({ SID_BASE_PATH: path })));
    });

    it('builds the route from the normalized path, and gives the function app the same value', () => {
      expect(frontdoor).toContain('var normalizedBasePath = normalizeBasePath(basePath)');
      expect(frontdoor).toContain('var patterns = frontDoorPatterns(normalizedBasePath)');
      expect(frontdoor).toMatch(/patternsToMatch: patterns$/m);
      expect(bicep).toContain('var basePath = normalizeBasePath(sidBasePath)');
      expect(bicep).toContain("{ name: 'SID_BASE_PATH', value: basePath }");
      expect(bicep).toMatch(/^ {4}basePath: basePath$/m);
      // The root path's routes are core's.
      expect(basepath).toContain(`[${Object.values(ROUTES).map(route => `'${route}'`).join(', ')}]`);
    });
  });

  it('keeps the module secrets parameter secure, and the route uncached and locked to Front Door', () => {
    expect(bicep).toMatch(/@secure\(\)\nparam sidModuleSecrets string/);
    expect(bicep).not.toMatch(/cacheConfiguration: \{/);
    expect(bicep).toContain("tag: 'ServiceTag'");
    expect(bicep).toContain("ipAddress: 'AzureFrontDoor.Backend'");
    expect(bicep).toContain("'x-azure-fdid': [");
    expect(bicep).toContain("ipSecurityRestrictionsDefaultAction: 'Deny'");
  });
});
