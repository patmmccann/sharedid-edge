import { describe, expect, it } from 'vitest';
import { createHandler, defineModule, resolveConfig, type HandlerOptions, type PayloadV1 } from '../src/index.js';
import { cookieNamed, publisherTc, setCookies, tcString } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';
const MINTED = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-01-01T00:00:00Z');

function handler(env: Record<string, string> = {}, extra: Partial<HandlerOptions> = {}): ReturnType<typeof createHandler> {
  return createHandler({ config: resolveConfig(env), now: () => NOW, mintId: () => MINTED, ...extra });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://www.example.com${path}`, { headers });
}

describe('sync (pixelUrl)', () => {
  it('adopts the id Prebid.js sends on the first visit and sets both cookies', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid%253A${UUID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(43);
    expect(response.headers.get('X-SharedID-Source')).toBe('param');
    const id = cookieNamed(response, '_pubcid');
    expect(id?.value).toBe(UUID);
    expect(id?.attributes.get('max-age')).toBe(String(365 * 86_400));
    expect(id?.attributes.get('samesite')).toBe('Lax');
    expect(id?.attributes.has('secure')).toBe(true);
    expect(id?.attributes.has('httponly')).toBe(false);
    expect(id?.attributes.get('path')).toBe('/');
    const recovery = cookieNamed(response, '_pubcid_sv');
    expect(recovery?.value).toBe(UUID);
    expect(recovery?.attributes.has('httponly')).toBe(true);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=86400');
  });

  it('never replaces an existing valid cookie', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${OTHER}`, { Cookie: `_pubcid=${UUID}` }));
    expect(response.headers.get('X-SharedID-Source')).toBe('cookie');
    expect(cookieNamed(response, '_pubcid')?.value).toBe(UUID);
  });

  it('restores a capped or cleared cookie from the recovery copy', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${OTHER}`, { Cookie: `_pubcid_sv=${UUID}` }));
    expect(response.headers.get('X-SharedID-Source')).toBe('recovery');
    expect(cookieNamed(response, '_pubcid')?.value).toBe(UUID);
  });

  it('restores the original id when the page re-minted the script cookie after it was capped', async () => {
    // Prebid.js writes a new id before calling pixelUrl, so the request carries both.
    const response = await handler()(get(`/_sid/sync?id=pubcid:${OTHER}`, { Cookie: `_pubcid=${OTHER}; _pubcid_sv=${UUID}` }));
    expect(response.headers.get('X-SharedID-Source')).toBe('recovery');
    expect(cookieNamed(response, '_pubcid')?.value).toBe(UUID);
  });

  it('adopts the script cookie when there is no recovery copy yet, as when the worker is first turned on', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${OTHER}`, { Cookie: `_pubcid=${UUID}` }));
    expect(cookieNamed(response, '_pubcid_sv')?.value).toBe(UUID);
  });

  it('mints an id when there is none, unless create is off', async () => {
    expect(cookieNamed(await handler()(get('/_sid/sync')), '_pubcid')?.value).toBe(MINTED);
    const off = await handler({ SID_CREATE: 'false' })(get('/_sid/sync'));
    expect(setCookies(off)).toEqual([]);
    expect(off.headers.get('Cache-Control')).toBe('no-store');
  });

  it('replaces an invalid cookie value', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${UUID}`, { Cookie: '_pubcid=bad value' }));
    expect(cookieNamed(response, '_pubcid')?.value).toBe(UUID);
  });

  it('uses the configured name, domain and lifetime, and no recovery cookie when disabled', async () => {
    const response = await handler({ SID_COOKIE_NAME: 'sid', SID_COOKIE_DOMAIN: '.example.com', SID_MAX_AGE_DAYS: '30', SID_RECOVERY_COOKIE: 'none' })(get('/_sid/sync'));
    expect(setCookies(response).map(c => c.name)).toEqual(['sid']);
    expect(cookieNamed(response, 'sid')?.attributes.get('domain')).toBe('.example.com');
    expect(cookieNamed(response, 'sid')?.attributes.get('max-age')).toBe(String(30 * 86_400));
  });

  it('omits Secure over plain http, for local development', async () => {
    const response = await handler()(new Request('http://localhost:8787/_sid/sync'));
    expect(cookieNamed(response, '_pubcid')?.attributes.has('secure')).toBe(false);
  });

  it('expires the cookies and sets none after an opt-out', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${UUID}`, { Cookie: `_pubcid=${UUID}; _pubcid_optout=1` }));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: opt-out');
    expect(setCookies(response).map(c => [c.name, c.attributes.get('max-age')])).toEqual([['_pubcid', '0'], ['_pubcid_sv', '0']]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets nothing for a new user without consent, and deletes the cookies of an existing one', async () => {
    const denied = await handler()(get(`/_sid/sync?id=pubcid:${UUID}&gdpr=1&gdpr_consent=${publisherTc([2])}`));
    expect(setCookies(denied)).toEqual([]);
    expect(denied.headers.get('X-SharedID-Status')).toBe('denied: tcf: no publisher consent for purpose 1');
    const existing = await handler()(get('/_sid/sync?gdpr=1', { Cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}` }));
    expect(setCookies(existing).map(c => [c.name, c.value, c.attributes.get('max-age'), c.attributes.get('expires')])).toEqual([
      ['_pubcid', '', '0', new Date(0).toUTCString()],
      ['_pubcid_sv', '', '0', new Date(0).toUTCString()]
    ]);
    const allowed = await handler()(get(`/_sid/sync?id=pubcid:${UUID}&gdpr=1&gdpr_consent=${publisherTc([1, 2])}`));
    expect(cookieNamed(allowed, '_pubcid')?.value).toBe(UUID);
  });

  it('checks the configured vendor in vendor mode', async () => {
    const vendor = handler({ SID_VENDOR_ID: '755' });
    const allowed = await vendor(get(`/_sid/sync?id=pubcid:${UUID}&gdpr=1&gdpr_consent=${tcString([1, 2], { vendors: [755] })}`));
    expect(cookieNamed(allowed, '_pubcid')?.value).toBe(UUID);
    const denied = await vendor(get(`/_sid/sync?id=pubcid:${UUID}&gdpr=1&gdpr_consent=${tcString([1, 2], { vendors: [754] })}`));
    expect(setCookies(denied)).toEqual([]);
    expect(denied.headers.get('X-SharedID-Status')).toBe('denied: tcf: no consent for vendor 755');
  });

  it('deletes the cookies and sets none with Global Privacy Control', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${UUID}`, { 'Sec-GPC': '1', Cookie: `_pubcid=${UUID}` }));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: gpc');
    expect(setCookies(response).map(c => [c.name, c.value, c.attributes.get('max-age')])).toEqual([['_pubcid', '', '0'], ['_pubcid_sv', '', '0']]);
  });

  it('deletes the cookies and sets none for a COPPA request', async () => {
    const response = await handler()(get(`/_sid/sync?id=pubcid:${UUID}&coppa=1`, { Cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}` }));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: coppa');
    expect(setCookies(response).map(c => [c.name, c.value, c.attributes.get('max-age')])).toEqual([['_pubcid', '', '0'], ['_pubcid_sv', '', '0']]);
    const payload = await (await handler()(get('/_sid/v1?coppa=1', { Cookie: `_pubcid=${UUID}` }))).json() as PayloadV1;
    expect(payload.sharedid).toBeUndefined();
  });

  it('deletes host-only copies too when a cookie domain is configured', async () => {
    const response = await handler({ SID_COOKIE_DOMAIN: '.example.com' })(get('/_sid/sync', { 'Sec-GPC': '1', Cookie: `_pubcid=${UUID}` }));
    expect(setCookies(response).map(c => [c.name, c.attributes.get('domain'), c.attributes.get('max-age')])).toEqual([
      ['_pubcid', '.example.com', '0'],
      ['_pubcid_sv', '.example.com', '0'],
      ['_pubcid', undefined, '0'],
      ['_pubcid_sv', undefined, '0']
    ]);
  });

  it('uses the platform location to decide whether GDPR applies', async () => {
    expect(setCookies(await handler()(get(`/_sid/sync?id=pubcid:${UUID}`), { isEU: true }))).toEqual([]);
    expect(cookieNamed(await handler()(get(`/_sid/sync?id=pubcid:${UUID}`), { isEU: false }), '_pubcid')?.value).toBe(UUID);
  });
});

describe('routes', () => {
  it('answers only under the base path, and 404s anything else', async () => {
    expect((await handler()(get('/'))).status).toBe(404);
    expect((await handler()(get('/_sid/unknown'))).status).toBe(404);
    expect((await handler()(get('/_sidsync'))).status).toBe(404);
    expect((await handler({ SID_BASE_PATH: '/id' })(get('/id/sync'))).status).toBe(200);
  });
  it('accepts a trailing slash, like the WordPress endpoint requires', async () => {
    expect((await handler()(get('/_sid/sync/'))).status).toBe(200);
  });
  it('rejects other methods', async () => {
    const response = await handler()(new Request('https://www.example.com/_sid/sync', { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });
  it('opts out and back in', async () => {
    const out = await handler()(get('/_sid/optout', { Cookie: `_pubcid=${UUID}` }));
    expect(out.status).toBe(204);
    expect(setCookies(out).map(c => [c.name, c.value, c.attributes.get('max-age')])).toEqual([
      ['_pubcid_optout', '1', String(365 * 86_400)],
      ['_pubcid', '', '0'],
      ['_pubcid_sv', '', '0']
    ]);
    const back = await handler()(get('/_sid/optin', { Cookie: '_pubcid_optout=1' }));
    expect(setCookies(back).map(c => [c.name, c.attributes.get('max-age')])).toEqual([['_pubcid_optout', '0']]);
  });
});

describe('v1 payload', () => {
  it('returns the SharedID as an eid, with the cookie', async () => {
    const response = await handler()(get('/_sid/v1', { Cookie: `_pubcid=${UUID}` }));
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const payload = await response.json() as PayloadV1;
    expect(payload).toEqual({ v: 1, sharedid: UUID, eids: [{ source: 'pubcid.org', uids: [{ id: UUID, atype: 1 }] }], ext: { modules: {} } });
    expect(cookieNamed(response, '_pubcid')?.value).toBe(UUID);
  });

  it('allows credentialed CORS only for configured origins', async () => {
    const h = handler({ SID_ALLOWED_ORIGINS: 'https://www.example.com' });
    const allowed = await h(get('/_sid/v1', { Origin: 'https://www.example.com' }));
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://www.example.com');
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(allowed.headers.get('Vary')).toBe('Origin');
    const other = await h(get('/_sid/v1', { Origin: 'https://evil.example' }));
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const preflight = await h(new Request('https://www.example.com/_sid/v1', { method: 'OPTIONS', headers: { Origin: 'https://www.example.com' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD');
  });

  it('runs the configured modules in order and merges their output', async () => {
    const geo = defineModule({ name: 'geo', run: ({ platform }) => ({ ortb2: { device: { geo: { country: platform.country } } } }) });
    const ids = defineModule({ name: 'ids', run: ({ config }) => ({ eids: [{ source: 'example.com', uids: [{ id: String(config['id']), atype: 1 }] }], ortb2: { device: { ext: { a: 1 } } } }) });
    const h = handler({ SID_MODULES: 'geo,ids,missing', SID_MODULE_CONFIG: '{"ids":{"id":"x1"}}' }, { modules: [geo, ids] });
    const payload = await (await h(get('/_sid/v1'), { country: 'US' })).json() as PayloadV1;
    expect(payload.eids.map(e => e.source)).toEqual(['pubcid.org', 'example.com']);
    expect(payload.ortb2).toEqual({ device: { geo: { country: 'US' }, ext: { a: 1 } } });
    expect(Object.fromEntries(Object.entries(payload.ext.modules).map(([k, v]) => [k, v.status]))).toEqual({ geo: 'ok', ids: 'ok', missing: 'skipped' });
  });

  it('isolates a module that throws or runs too long', async () => {
    const bad = defineModule({ name: 'bad', run: () => { throw new Error('secret request data'); } });
    const slow = defineModule({ name: 'slow', run: () => new Promise(resolve => { setTimeout(() => { resolve({ ortb2: { late: true } }); }, 200); }) });
    const ok = defineModule({ name: 'ok', run: () => ({ ortb2: { fine: true } }) });
    const h = handler({ SID_MODULES: 'bad,slow,ok', SID_MODULE_TIMEOUT_MS: '10' }, { modules: [bad, slow, ok], now: () => new Date() });
    const payload = await (await h(get('/_sid/v1'))).json() as PayloadV1;
    expect(payload.ortb2).toEqual({ fine: true });
    expect(payload.ext.modules['bad']?.status).toBe('error');
    expect(payload.ext.modules['slow']?.status).toBe('timeout');
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('skips modules whose TCF purposes lack publisher consent, and vendor modules when GDPR applies', async () => {
    const needs4 = defineModule({ name: 'needs4', purposes: [1, 4], run: () => ({ ortb2: { a: 1 } }) });
    const vendor = defineModule({ name: 'vendor', gvlid: 1, run: () => ({ ortb2: { b: 1 } }) });
    const h = handler({ SID_MODULES: 'needs4,vendor' }, { modules: [needs4, vendor] });
    const payload = await (await h(get(`/_sid/v1?gdpr=1&gdpr_consent=${tcString([1, 4], { publisher: [1, 2] })}`))).json() as PayloadV1;
    expect(payload.ext.modules['needs4']).toEqual({ ms: 0, status: 'skipped', reason: 'tcf: no publisher consent for purpose 4' });
    expect(payload.ext.modules['vendor']?.reason).toBe('tcf: vendor consent is not checked yet');
    const outsideGdpr = await (await h(get('/_sid/v1?gdpr=0'))).json() as PayloadV1;
    expect(outsideGdpr.ortb2).toEqual({ a: 1, b: 1 });
  });

  it('lets modules set cookies, read cookies, secrets and the opt-out state', async () => {
    const seen: unknown[] = [];
    const cookieModule = defineModule({
      name: 'cookie',
      run: ({ cookies, secrets, optedOut }) => {
        seen.push({ existing: cookies.get('mine'), secret: secrets['key'], optedOut });
        return { cookies: [{ name: 'mine', value: 'v1', maxAgeSeconds: 60, httpOnly: true }, { name: 'gone', value: '', maxAgeSeconds: 0, httpOnly: false, domain: '.example.com' }] };
      }
    });
    const h = handler({ SID_MODULES: 'cookie', SID_MODULE_SECRETS: '{"cookie":{"key":"s3cret"}}' }, { modules: [cookieModule] });
    const response = await h(get('/_sid/v1', { Cookie: 'mine=v0' }));
    const body = await response.json() as PayloadV1;
    expect(seen).toEqual([{ existing: 'v0', secret: 's3cret', optedOut: false }]);
    expect(body.ext.modules['cookie']?.status).toBe('empty');
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(cookieNamed(response, 'mine')?.attributes).toEqual(new Map([['max-age', '60'], ['expires', expect.any(String) as string], ['path', '/'], ['samesite', 'Lax'], ['secure', ''], ['httponly', '']]));
    expect(cookieNamed(response, 'gone')?.attributes.get('domain')).toBe('.example.com');
    expect(cookieNamed(response, 'gone')?.attributes.get('max-age')).toBe('0');
    await h(get('/_sid/v1', { Cookie: '_pubcid_optout=1' }));
    expect(seen[1]).toEqual({ existing: undefined, secret: 's3cret', optedOut: true });
  });

  it('rejects module cookies that clash with the worker\'s or are malformed, leaving the module out', async () => {
    const make = (name: string, value = 'x'): ReturnType<typeof defineModule> => defineModule({
      name: `bad-${String(name.length)}-${String(value.length)}`,
      run: () => ({ ortb2: { leaked: true }, cookies: [{ name, value, maxAgeSeconds: 60, httpOnly: false }] })
    });
    for (const module of [make('_pubcid'), make('_pubcid_optout'), make('bad name'), make('ok', 'semi;colon')]) {
      const response = await handler({ SID_MODULES: module.name }, { modules: [module] })(get('/_sid/v1'));
      const body = await response.json() as PayloadV1;
      expect(body.ext.modules[module.name]?.status).toBe('error');
      expect(body.ortb2).toBeUndefined();
      expect(setCookies(response).map(c => c.name)).toEqual(['_pubcid', '_pubcid_sv']);
    }
  });

  it('omits the SharedID after an opt-out but still runs modules that don\'t need consent', async () => {
    const plain = defineModule({ name: 'plain', run: ({ sharedId }) => ({ ortb2: { hasId: sharedId !== undefined } }) });
    const payload = await (await handler({ SID_MODULES: 'plain' }, { modules: [plain] })(get('/_sid/v1', { Cookie: '_pubcid_optout=1' }))).json() as PayloadV1;
    expect(payload.sharedid).toBeUndefined();
    expect(payload.eids).toEqual([]);
    expect(payload.ortb2).toEqual({ hasId: false });
  });

  it('rejects duplicate and badly named modules', () => {
    const m = defineModule({ name: 'dup', run: () => undefined });
    expect(() => createHandler({ modules: [m, m] })).toThrow(/registered twice/);
    expect(() => defineModule({ name: 'Bad Name', run: () => undefined })).toThrow(/Invalid module name/);
    expect(() => defineModule({ name: 'p', purposes: [25], run: () => undefined })).toThrow(/purpose/);
  });
});
