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

  it.each([
    'http://localhost:8787', 'http://app.localhost', 'http://127.0.0.1:4310', 'http://192.168.1.20', 'http://[::1]:8787',
    'http://e2e.sharedid.test', 'http://printer.local', 'http://sid.internal', 'http://www.example', 'http://x.invalid',
    'http://app.test.', 'http://localhost.:8787', 'http://printer.local.'
  ])('omits Secure over plain http in local development (%s)', async origin => {
    const response = await handler()(new Request(`${origin}/_sid/sync`));
    expect(cookieNamed(response, '_pubcid')?.attributes.has('secure')).toBe(false);
  });

  it('keeps Secure for a public hostname seen over http (TLS ended at a proxy in front of the worker)', async () => {
    const response = await handler({ SID_COOKIE_DOMAIN: 'example.com' })(new Request('http://www.example.com/_sid/sync', { headers: { Cookie: `uid1=x` } }));
    expect(cookieNamed(response, '_pubcid')?.attributes.has('secure')).toBe(true);
    expect(cookieNamed(response, '_pubcid_sv')?.attributes.has('secure')).toBe(true);
    // Hostnames that only look local don't count: a public name ending in "test" or "local" isn't one of those TLDs.
    for (const origin of ['http://latest.com', 'http://mylocal.net', 'http://example.localhost.com', 'http://www.example.com.']) {
      expect(cookieNamed(await handler()(new Request(`${origin}/_sid/sync`)), '_pubcid')?.attributes.has('secure')).toBe(true);
    }
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

  describe('duplicate ID cookies (a host-only copy next to the domain one)', () => {
    const summary = (response: Response): (string | undefined)[][] =>
      setCookies(response).map(c => [c.name, c.value, c.attributes.get('domain'), c.attributes.get('max-age')]);

    it('keeps the first value, sets it on the domain and deletes the host-only copy', async () => {
      const response = await handler({ SID_COOKIE_DOMAIN: 'example.com', SID_RECOVERY_COOKIE: 'none' })(
        get('/_sid/sync', { Cookie: `_pubcid=${UUID}; _pubcid=${OTHER}` })
      );
      expect(summary(response)).toEqual([
        ['_pubcid', UUID, 'example.com', '31536000'],
        ['_pubcid', '', undefined, '0']
      ]);
    });

    it('deletes a duplicated recovery copy\'s host-only cookie too, keeping it HttpOnly', async () => {
      const response = await handler({ SID_COOKIE_DOMAIN: 'example.com' })(
        get('/_sid/v1', { Cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}; _pubcid_sv=${OTHER}` })
      );
      const cookies = setCookies(response);
      expect(summary(response)).toEqual([
        ['_pubcid', UUID, 'example.com', '31536000'],
        ['_pubcid_sv', UUID, 'example.com', '31536000'],
        ['_pubcid_sv', '', undefined, '0']
      ]);
      expect(cookies[2]?.attributes.has('httponly')).toBe(true);
    });

    it('leaves a single cookie alone', async () => {
      const response = await handler({ SID_COOKIE_DOMAIN: 'example.com', SID_RECOVERY_COOKIE: 'none' })(get('/_sid/sync', { Cookie: `_pubcid=${UUID}` }));
      expect(summary(response)).toEqual([['_pubcid', UUID, 'example.com', '31536000']]);
    });

    it('deletes nothing with host-only cookies (there\'s no other copy to tell apart)', async () => {
      const response = await handler({ SID_COOKIE_DOMAIN: 'host-only', SID_RECOVERY_COOKIE: 'none' })(
        get('/_sid/sync', { Cookie: `_pubcid=${UUID}; _pubcid=${OTHER}` })
      );
      expect(summary(response)).toEqual([['_pubcid', UUID, undefined, '31536000']]);
    });
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
  it('stays fast on a path with a long run of slashes', async () => {
    const started = Date.now();
    expect((await handler()(get(`/_sid/${'/'.repeat(100_000)}x`))).status).toBe(404);
    expect((await handler()(get(`/_sid/sync${'/'.repeat(100_000)}`))).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('rejects other methods', async () => {
    const response = await handler()(new Request('https://www.example.com/_sid/sync', { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });
  it('opts back in by clearing both domain and host-only opt-out cookies', async () => {
    const h = handler({ SID_COOKIE_DOMAIN: '.example.com' });
    const response = await h(get('/_sid/optin', { Cookie: '_pubcid_optout=1' }));
    expect(setCookies(response).map(c => [c.name, c.attributes.get('domain'), c.attributes.get('max-age')])).toEqual([
      ['_pubcid_optout', '.example.com', '0'],
      ['_pubcid_optout', undefined, '0']
    ]);
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

  it('clears both domain and host-only opt-out copies when a cookie domain is configured', async () => {
    const h = handler({ SID_COOKIE_DOMAIN: '.example.com' });
    const response = await h(get('/_sid/optin', { Cookie: '_pubcid_optout=1' }));
    expect(setCookies(response).map(c => [c.name, c.attributes.get('domain'), c.attributes.get('max-age')])).toEqual([
      ['_pubcid_optout', '.example.com', '0'],
      ['_pubcid_optout', undefined, '0']
    ]);
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
      run: ({ cookies, secrets, optedOut, storage }) => {
        seen.push({ existing: cookies.get('mine'), secret: secrets['key'], optedOut, storage });
        return { cookies: [{ name: 'mine', value: 'v1', maxAgeSeconds: 60, httpOnly: true }, { name: 'gone', value: '', maxAgeSeconds: 0, httpOnly: false, domain: '.example.com' }] };
      }
    });
    const h = handler({ SID_MODULES: 'cookie', SID_MODULE_SECRETS: '{"cookie":{"key":"s3cret"}}' }, { modules: [cookieModule] });
    const response = await h(get('/_sid/v1', { Cookie: 'mine=v0' }));
    const body = await response.json() as PayloadV1;
    expect(seen).toEqual([{ existing: 'v0', secret: 's3cret', optedOut: false, storage: { allowed: true } }]);
    expect(body.ext.modules['cookie']?.status).toBe('empty');
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(cookieNamed(response, 'mine')?.attributes).toEqual(new Map([['max-age', '60'], ['expires', expect.any(String) as string], ['path', '/'], ['samesite', 'Lax'], ['secure', ''], ['httponly', '']]));
    expect(cookieNamed(response, 'gone')?.attributes.get('domain')).toBe('.example.com');
    expect(cookieNamed(response, 'gone')?.attributes.get('max-age')).toBe('0');
    await h(get('/_sid/v1', { Cookie: '_pubcid_optout=1' }));
    expect(seen[1]).toEqual({ existing: undefined, secret: 's3cret', optedOut: true, storage: { allowed: false, reason: 'opt-out' } });
    await h(get('/_sid/v1', { 'Sec-GPC': '1' }));
    expect(seen[2]).toMatchObject({ optedOut: false, storage: { allowed: false, reason: 'gpc' } });
    await h(get('/_sid/v1?gdpr=1'));
    expect(seen[3]).toMatchObject({ storage: { allowed: false, reason: 'tcf: GDPR applies and there is no TC string' } });
  });

  it('deletes installed modules\' cookies on opt-out, listed in SID_MODULES or not, and skips bad hooks', async () => {
    const owner = defineModule({ name: 'owner', run: () => undefined, optOutCookies: config => [{ name: 'owned', value: '', maxAgeSeconds: 0, httpOnly: true, domain: String(config['domain']) }] });
    const notADeletion = defineModule({ name: 'keeps', run: () => undefined, optOutCookies: () => [{ name: 'kept', value: 'x', maxAgeSeconds: 60, httpOnly: false }] });
    const throws = defineModule({ name: 'throws', run: () => undefined, optOutCookies: () => { throw new Error('secret'); } });
    const h = handler({ SID_MODULE_CONFIG: '{"owner":{"domain":".example.com"}}' }, { modules: [owner, notADeletion, throws] });
    const response = await h(get('/_sid/optout', { Cookie: 'owned=1; kept=1' }));
    expect(response.status).toBe(204);
    // a cookie the browser didn't send isn't deleted
    expect(setCookies(await h(get('/_sid/optout'))).map(c => c.name)).not.toContain('owned');
    expect(setCookies(response).map(c => [c.name, c.attributes.get('max-age'), c.attributes.get('domain')])).toEqual([
      ['_pubcid_optout', String(365 * 86_400), undefined],
      ['_pubcid', '0', undefined],
      ['_pubcid_sv', '0', undefined],
      ['owned', '0', '.example.com']
    ]);
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

describe('modules on /sync', () => {
  const cookie = (name: string, value = 'x'): { name: string; value: string; maxAgeSeconds: number; httpOnly: boolean } => ({ name, value, maxAgeSeconds: 60, httpOnly: false });

  it('runs only modules whose routes include sync, in SID_MODULES order, and v1-only modules only on /v1', async () => {
    const ran: string[] = [];
    const v1Only = defineModule({ name: 'v1only', run: () => { ran.push('v1only'); return { cookies: [cookie('a')] }; } });
    const both = defineModule({ name: 'both', routes: ['v1', 'sync'], run: () => { ran.push('both'); return { cookies: [cookie('b')] }; } });
    const syncOnly = defineModule({ name: 'synconly', routes: ['sync'], run: () => { ran.push('synconly'); return { cookies: [cookie('c')] }; } });
    const h = handler({ SID_MODULES: 'synconly,v1only,both' }, { modules: [v1Only, both, syncOnly] });

    const sync = await h(get('/_sid/sync'));
    expect(ran).toEqual(['synconly', 'both']);
    expect(setCookies(sync).map(c => c.name)).toEqual(['c', 'b', '_pubcid', '_pubcid_sv']);
    expect(sync.headers.get('X-SharedID-Modules')).toBe('synconly=empty, both=empty');

    ran.length = 0;
    const v1 = await h(get('/_sid/v1'));
    expect(ran).toEqual(['v1only', 'both']);
    expect(((await v1.json()) as PayloadV1).ext.modules['synconly']).toEqual({ ms: 0, status: 'skipped', reason: 'not on /v1' });
  });

  it('sets only the cookies: eids and ortb2 are ignored, and the pixel response is otherwise unchanged', async () => {
    const mixed = defineModule({
      name: 'mixed',
      routes: ['v1', 'sync'],
      run: () => ({
        eids: [{ source: 'example.com', uids: [{ id: 'eid-value', atype: 1 }] }],
        ortb2: { user: { id: 'ortb2-value' } },
        cookies: [{ ...cookie('kept', 'cookie-value'), httpOnly: true }]
      })
    });
    const plain = await handler()(get(`/_sid/sync?id=pubcid:${UUID}`));
    const response = await handler({ SID_MODULES: 'mixed' }, { modules: [mixed] })(get(`/_sid/sync?id=pubcid:${UUID}`));
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(new Uint8Array(await plain.arrayBuffer()));
    expect(body.byteLength).toBe(43);
    for (const header of ['Content-Type', 'Content-Length', 'Cache-Control', 'X-Robots-Tag', 'X-SharedID-Source']) {
      expect(response.headers.get(header)).toBe(plain.headers.get(header));
    }
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(response.headers.get('X-SharedID-Modules')).toBe('mixed=ok');
    expect(setCookies(response)).toContainEqual(expect.objectContaining({ name: 'kept', value: 'cookie-value' }));
    const all = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    expect(all).not.toMatch(/eid-value|ortb2-value/);
  });

  it('adds no X-SharedID-Modules header when no module is selected for /sync', async () => {
    const v1Only = defineModule({ name: 'v1only', run: () => ({ cookies: [cookie('a')] }) });
    expect((await handler()(get('/_sid/sync'))).headers.has('X-SharedID-Modules')).toBe(false);
    expect((await handler({ SID_MODULES: 'v1only' }, { modules: [v1Only] })(get('/_sid/sync'))).headers.has('X-SharedID-Modules')).toBe(false);
  });

  it('follows SID_SYNC_MODULES: none, a subset in SID_MODULES order, and listed modules that are missing or v1-only skipped', async () => {
    const ran: string[] = [];
    const make = (name: string, routes?: readonly ('v1' | 'sync')[]): ReturnType<typeof defineModule> =>
      defineModule({ name, ...(routes === undefined ? {} : { routes }), run: () => { ran.push(name); return { cookies: [cookie(name)] }; } });
    const modules = [make('one', ['v1', 'sync']), make('two', ['v1', 'sync']), make('three', ['v1', 'sync']), make('v1only')];

    const none = await handler({ SID_MODULES: 'one,two', SID_SYNC_MODULES: 'none' }, { modules })(get('/_sid/sync'));
    expect(ran).toEqual([]);
    expect(none.headers.has('X-SharedID-Modules')).toBe(false);
    expect(setCookies(none).map(c => c.name)).toEqual(['_pubcid', '_pubcid_sv']);

    const subset = await handler(
      { SID_MODULES: 'one,two,three,v1only,missing', SID_SYNC_MODULES: 'three,one,v1only,missing' },
      { modules }
    )(get('/_sid/sync'));
    expect(ran).toEqual(['one', 'three']);
    expect(setCookies(subset).map(c => c.name)).toEqual(['one', 'three', '_pubcid', '_pubcid_sv']);
    expect(subset.headers.get('X-SharedID-Modules')).toBe('one=empty, three=empty, v1only=skipped, missing=skipped');
  });

  it('contains failures and timeouts as on /v1: a failed module sets nothing, the rest still do', async () => {
    const bad = defineModule({ name: 'bad', routes: ['sync'], run: () => { throw new Error('secret request data'); } });
    const slow = defineModule({
      name: 'slow',
      routes: ['sync'],
      run: () => new Promise(resolve => { setTimeout(() => { resolve({ cookies: [cookie('late')] }); }, 200); })
    });
    const reserved = defineModule({ name: 'reserved', routes: ['sync'], run: () => ({ cookies: [cookie('fine'), cookie('_pubcid', 'stolen')] }) });
    const ok = defineModule({ name: 'ok', routes: ['sync'], run: () => ({ cookies: [cookie('good')] }) });
    const h = handler({ SID_MODULES: 'bad,slow,reserved,ok', SID_MODULE_TIMEOUT_MS: '20' }, { modules: [bad, slow, reserved, ok] });
    const response = await h(get(`/_sid/sync?id=pubcid:${UUID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SharedID-Modules')).toBe('bad=error, slow=timeout, reserved=error, ok=empty');
    expect(setCookies(response).map(c => `${c.name}=${c.value}`)).toEqual(['good=x', `_pubcid=${UUID}`, `_pubcid_sv=${UUID}`]);
    expect([...response.headers.values()].join('\n')).not.toContain('secret');
  });

  it('gives modules the same context as /v1', async () => {
    const seen: Record<string, unknown>[] = [];
    const probe = defineModule({
      name: 'probe',
      routes: ['v1', 'sync'],
      run: ({ sharedId, storage, optedOut, consent, cookies, platform, config, secrets }) => {
        seen.push({ sharedId, storage, optedOut, gdprApplies: consent.gdprApplies, gpc: consent.gpc, cookie: cookies.get('other'), platform, config, secrets });
        return undefined;
      }
    });
    const h = handler({ SID_MODULES: 'probe', SID_MODULE_CONFIG: '{"probe":{"a":1}}', SID_MODULE_SECRETS: '{"probe":{"key":"k"}}' }, { modules: [probe] });
    const headers = { Cookie: `_pubcid=${UUID}; other=1`, 'Sec-GPC': '1' };
    await h(get('/_sid/v1?gdpr=0', headers), { clientIp: '192.0.2.1', country: 'US' });
    await h(get('/_sid/sync?gdpr=0', headers), { clientIp: '192.0.2.1', country: 'US' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ storage: { allowed: false, reason: 'gpc' }, optedOut: false, gdprApplies: false, cookie: '1', config: { a: 1 }, secrets: { key: 'k' } });

    seen.length = 0;
    await h(get('/_sid/v1', { Cookie: `_pubcid=${UUID}` }));
    await h(get('/_sid/sync', { Cookie: `_pubcid=${UUID}` }));
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ sharedId: UUID, storage: { allowed: true } });
  });

  it('applies deletions when storage is denied, on a response that stays uncached', async () => {
    const owned = defineModule({
      name: 'owned',
      routes: ['v1', 'sync'],
      run: ({ storage, cookies }) => (storage.allowed || !cookies.has('owned') ? undefined : { cookies: [{ name: 'owned', value: '', maxAgeSeconds: 0, httpOnly: true }] })
    });
    const h = handler({ SID_MODULES: 'owned' }, { modules: [owned] });
    const response = await h(get('/_sid/sync', { Cookie: `_pubcid=${UUID}; owned=abc; _pubcid_optout=1` }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: opt-out');
    expect(setCookies(response).find(c => c.name === 'owned')?.attributes.get('max-age')).toBe('0');
  });

  it('validates routes', () => {
    expect(defineModule({ name: 'r', routes: ['sync', 'v1'], run: () => undefined }).routes).toEqual(['sync', 'v1']);
    expect(defineModule({ name: 'r', run: () => undefined }).routes).toBeUndefined();
    expect(() => defineModule({ name: 'r', routes: [], run: () => undefined })).toThrow(/routes/);
    expect(() => defineModule({ name: 'r', routes: ['v1', 'v1'], run: () => undefined })).toThrow(/routes/);
    // @ts-expect-error: an unknown route, as plain JavaScript could pass
    expect(() => defineModule({ name: 'r', routes: ['optout'], run: () => undefined })).toThrow(/routes/);
  });
});
