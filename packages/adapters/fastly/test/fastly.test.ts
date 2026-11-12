import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '@sharedid-edge/core';
import {
  CONFIG_STORE,
  createFastlyHandler,
  createStoresHandler,
  envFromStores,
  handlerFromEnv,
  platformInfo,
  SECRET_SETTING,
  SECRET_STORE
} from '../src/index.js';
import { REUSABLE_SANDBOX_DEFAULTS, reusableSandboxOptions } from '../src/sandbox.js';
import { AUSTIN, BERLIN, client, request, SAN_FRANCISCO, stores } from './clients.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: {
    readonly device?: {
      readonly ip?: string;
      readonly ipv6?: string;
      readonly geo?: Readonly<Record<string, unknown>>;
    };
  };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

async function payload(response: Response): Promise<Payload> {
  return await response.json() as Payload;
}

const SETTINGS = { SID_COOKIE_DOMAIN: 'example.com' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('platformInfo', () => {
  it('maps an IPv4 client and Fastly geolocation, with isEU from the country', () => {
    expect(platformInfo(client('203.0.113.9'))).toEqual({
      clientIp: '203.0.113.9',
      country: 'US',
      region: 'TX',
      isEU: false,
      city: 'Austin',
      postalCode: '78701',
      metroCode: '635',
      latitude: 30.2672,
      longitude: -97.7431,
      continent: 'NA'
    });
  });

  it('maps an IPv6 client and an EU country', () => {
    expect(platformInfo(client('2001:db8:85a3::8a2e:370:7334', BERLIN))).toEqual({
      clientIp: '2001:db8:85a3::8a2e:370:7334',
      country: 'DE',
      region: 'BE',
      isEU: true,
      city: 'Berlin',
      postalCode: '10115',
      latitude: 52.52,
      longitude: 13.405,
      continent: 'EU'
    });
  });

  it("drops Fastly's placeholders: metro code 0, coordinates 0,0, ? and **", () => {
    expect(platformInfo(client('192.0.2.1', SAN_FRANCISCO))).not.toHaveProperty('metroCode');
    expect(platformInfo(client('192.0.2.1', { ...AUSTIN, latitude: 0, longitude: 0, city: '?', region: '**', continent: '**', country_code: '**' }))).toEqual({
      clientIp: '192.0.2.1',
      postalCode: '78701',
      metroCode: '635'
    });
  });

  it('keeps no location when Fastly has none (null), or only some fields', () => {
    expect(platformInfo(client('192.0.2.1', null))).toEqual({ clientIp: '192.0.2.1' });
    // Viceroy gives an address its configured fields only; the rest are missing, not null.
    expect(platformInfo(client('127.0.0.2', { country_code: 'US', region: 'TX' }))).toEqual({ clientIp: '127.0.0.2', country: 'US', region: 'TX', isEU: false });
    expect(platformInfo(client('192.0.2.1', { ...AUSTIN, city: null, postal_code: null, metro_code: null, latitude: null, longitude: 12 }))).toEqual({
      clientIp: '192.0.2.1', country: 'US', region: 'TX', isEU: false, continent: 'NA'
    });
  });

  it("upper-cases postal codes, which Fastly gives in lowercase when they're alphanumeric", () => {
    expect(platformInfo(client('192.0.2.1', { country_code: 'CA', region: 'ON', postal_code: 'm5v' })).postalCode).toBe('M5V');
  });

  it('drops what core drops, and an address that is not an IP address', () => {
    expect(platformInfo(client('not-an-ip', { country_code: 'T1', region: 'TX!', latitude: 95, longitude: 10 }))).toEqual({});
    expect(platformInfo(client('', null))).toEqual({});
  });
});

describe('createFastlyHandler', () => {
  it('answers a first-visit sync with the GIF and each Set-Cookie as its own header', async () => {
    const handler = createFastlyHandler({ config: resolveConfig(SETTINGS) });
    const response = await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`), client('203.0.113.9'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};.*Domain=example\\.com.*Secure`));
    expect(cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
  });

  it('gives the ip and geo modules the client address and Fastly location, IPv4 and IPv6', async () => {
    const handler = handlerFromEnv({ ...SETTINGS, SID_MODULES: 'ip,geo' });
    const v4 = await payload(await handler(request(), client('203.0.113.9')));
    expect(v4.ortb2?.device?.ip).toBe('203.0.113.9');
    expect(v4.ortb2?.device?.geo).toMatchObject({ country: 'USA', region: 'TX', city: 'Austin', zip: '78701', metro: '635' });
    const v6 = await payload(await handler(request(), client('2001:db8:abcd:12ff::1')));
    expect(v6.ortb2?.device?.ipv6).toBe('2001:db8:abcd:12ff::1');
  });

  it('ignores X-Forwarded-For and Fastly-Client-IP, which the visitor controls', async () => {
    const handler = handlerFromEnv({ ...SETTINGS, SID_MODULES: 'ip' });
    const spoofed = request('/_sid/v1', { headers: { 'x-forwarded-for': '198.51.100.1', 'fastly-client-ip': '198.51.100.2' } });
    expect((await payload(await handler(spoofed, client('203.0.113.9')))).ortb2?.device?.ip).toBe('203.0.113.9');
  });

  it('routes the default base path, a custom one and /', async () => {
    const cases: readonly (readonly [basePath: string | undefined, path: string, status: number])[] = [
      [undefined, '/_sid/v1', 200],
      [undefined, '/v1', 404],
      ['/identity', '/identity/v1', 200],
      ['/identity', '/_sid/v1', 404],
      ['/', '/v1', 200],
      ['/', '/sync', 200],
      ['/', '/about', 404],
      ['/', '/_sid/v1', 404]
    ];
    for (const [basePath, path, status] of cases) {
      const handler = createFastlyHandler({ config: resolveConfig({ ...SETTINGS, ...(basePath === undefined ? {} : { SID_BASE_PATH: basePath }) }) });
      const response = await handler(request(path), client('203.0.113.9'));
      expect([basePath, path, response.status]).toEqual([basePath, path, status]);
    }
  });

  it('uses publicOrigin for the request URL when it is set', async () => {
    const handler = createFastlyHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' }), publicOrigin: 'http://localhost:8080' });
    const response = await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`), client('203.0.113.9'));
    for (const cookie of response.headers.getSetCookie()) expect(cookie).not.toContain('Secure');
  });

  it('answers a generic 500 and logs only the error name when something fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createFastlyHandler({ config: resolveConfig(SETTINGS) });
    const broken = { address: '203.0.113.9', get geo(): never { throw new Error('secret request data'); } };
    const response = await handler(request(), broken);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal error');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(errors).toHaveBeenCalledWith('sharedid-edge: request failed', 'Error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });
});

describe('settings from the config and secret stores', () => {
  it(`reads every SID_* setting from ${CONFIG_STORE}, and ${SECRET_SETTING} from ${SECRET_STORE}`, async () => {
    const env = await envFromStores(stores({ SID_COOKIE_DOMAIN: 'example.com', SID_COOKIE_NAME: 'sid', OTHER: 'x' }, { SID_MODULE_SECRETS: '{"ec":{"passphrase":"p"}}' }));
    expect(env).toMatchObject({ SID_COOKIE_DOMAIN: 'example.com', SID_COOKIE_NAME: 'sid', SID_MODULE_SECRETS: '{"ec":{"passphrase":"p"}}' });
    expect(env['SID_BASE_PATH']).toBeUndefined();
    expect(env).not.toHaveProperty('OTHER');
    // No secret store linked, or one without the key: no module secrets.
    expect((await envFromStores(stores(SETTINGS)))[SECRET_SETTING]).toBeUndefined();
    expect((await envFromStores(stores(SETTINGS, {})))[SECRET_SETTING]).toBeUndefined();
  });

  it('reads the stores with every request and rebuilds the handler only when the settings change', async () => {
    const config: Record<string, string> = { SID_COOKIE_DOMAIN: 'example.com' };
    const linked = stores(config);
    const handler = createStoresHandler(linked);
    expect((await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`), client('203.0.113.9'))).headers.getSetCookie()[0]).toMatch(/^_pubcid=/);
    const reads = linked.reads.count;
    expect(reads).toBeGreaterThan(0);
    config['SID_COOKIE_NAME'] = 'sid';
    expect((await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`), client('203.0.113.9'))).headers.getSetCookie()[0]).toMatch(/^sid=/);
    expect(linked.reads.count).toBe(2 * reads);
  });

  it('answers two visitors through one long-lived handler independently, every built-in module on (a reused sandbox)', async () => {
    // With reusable sandboxes, one handler answers many visitors in turn: nothing of the first may reach the second.
    const handler = createStoresHandler(stores({
      ...SETTINGS,
      SID_MODULES: 'ip,geo,reflect,bot,ua,clickid',
      SID_MODULE_CONFIG: JSON.stringify({ reflect: { cookies: [{ name: 'uid1', maxAgeDays: 365 }] }, clickid: { hosts: ['www.example.com'] } })
    }));
    const first = await handler(request(`/_sid/v1?url=${encodeURIComponent('https://www.example.com/?gclid=FirstClick')}`, {
      headers: { cookie: `_pubcid=${UUID}; uid1=first-visitor`, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }
    }), client('192.0.2.1', AUSTIN));
    const firstText = JSON.stringify([await payload(first), first.headers.getSetCookie()]);
    for (const marker of [UUID, 'first-visitor', 'FirstClick', '192.0.2.1']) expect(firstText).toContain(marker);
    const second = await handler(request('/_sid/v1', { headers: { 'user-agent': 'curl/8.0' } }), client('2001:db8::2', SAN_FRANCISCO));
    const secondPayload = await payload(second);
    const secondText = JSON.stringify([secondPayload, second.headers.getSetCookie()]);
    for (const marker of [UUID, 'first-visitor', 'FirstClick', '192.0.2.1', 'Safari', '"TX"']) expect(secondText).not.toContain(marker);
    expect(secondPayload.sharedid).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondPayload.ortb2?.device?.ipv6).toBe('2001:db8::2');
    expect(secondPayload.ortb2?.device?.geo).toMatchObject({ country: 'USA', region: 'CA' });
  });

  it('answers 500 without a config store, logging why', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createStoresHandler({ config: () => { throw new TypeError("No ConfigStore named 'sharedid_config' exists"); }, secrets: () => undefined });
    const response = await handler(request(), client('203.0.113.9'));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('SharedID Edge is misconfigured');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(String(errors.mock.calls[0]?.[0])).toContain(`no config store is linked to the service as ${CONFIG_STORE}`);
  });

  it('answers 500 when SID_COOKIE_DOMAIN is missing or a setting is invalid, then recovers when fixed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config: Record<string, string> = {};
    const handler = createStoresHandler(stores(config));
    expect((await handler(request(), client('203.0.113.9'))).status).toBe(500);
    expect(String(errors.mock.calls[0]?.[0])).toContain('SID_COOKIE_DOMAIN');
    config['SID_COOKIE_DOMAIN'] = 'example.com';
    config['SID_MAX_AGE_DAYS'] = 'forever';
    expect((await handler(request(), client('203.0.113.9'))).status).toBe(500);
    delete config['SID_MAX_AGE_DAYS'];
    expect((await handler(request(), client('203.0.113.9'))).status).toBe(200);
  });

  it(`answers 500 when ${SECRET_SETTING} is in the config store rather than the secret store`, async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createStoresHandler(stores({ ...SETTINGS, SID_MODULE_SECRETS: '{}' }));
    expect((await handler(request(), client('203.0.113.9'))).status).toBe(500);
    expect(String(errors.mock.calls[0]?.[0])).toContain('must be in the secret store');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('{}');
  });

  it('answers a generic 500 when a store fails, logging only the error name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createStoresHandler({ ...stores(SETTINGS), secrets: () => ({ get: () => Promise.reject(new Error('secret value')) }) });
    const response = await handler(request(), client('203.0.113.9'));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret value');
  });

  it('keeps Cache-Control on every response, so no cache shares one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv(SETTINGS);
    const misconfigured = handlerFromEnv({});
    const responses = [
      await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`), client('203.0.113.9')),
      await handler(request('/_sid/sync', { method: 'HEAD' }), client('203.0.113.9')),
      await handler(request(), client('203.0.113.9')),
      await handler(request('/_sid/optout'), client('203.0.113.9')),
      await handler(request('/_sid/other'), client('203.0.113.9')),
      await handler(request('/_sid/v1', { method: 'POST', body: 'x' }), client('203.0.113.9')),
      await misconfigured(request(), client('203.0.113.9'))
    ];
    for (const response of responses) expect(response.headers.get('cache-control')).toMatch(/\b(no-store|private)\b/);
  });
});

describe('reusable sandboxes (the --reusable-sandbox build)', () => {
  it('has bounded defaults, which the build can override one at a time', () => {
    expect(reusableSandboxOptions()).toEqual({ maxRequests: 50, betweenRequestTimeoutMs: 2000, maxMemoryMiB: 64, sandboxTimeoutMs: 60_000 });
    expect(reusableSandboxOptions({ maxRequests: 10 })).toEqual({ ...REUSABLE_SANDBOX_DEFAULTS, maxRequests: 10 });
    expect(Object.isFrozen(REUSABLE_SANDBOX_DEFAULTS)).toBe(true);
  });
});
