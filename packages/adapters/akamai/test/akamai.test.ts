import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, SETTINGS } from '@sharedid-edge/core';
import {
  createEdgeWorkerHandler,
  createVariablesHandler,
  envFromVariables,
  handlerFromEnv,
  platformInfo,
  postalCodeFromZip,
  SETTING_NAMES,
  VARIABLE_PREFIX,
  type EdgeWorkerRequest,
  type EdgeWorkerResult
} from '../src/index.js';
import { CAMBRIDGE, edgeWorkerRequest } from './requests.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';

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

function text(result: EdgeWorkerResult): string {
  return new TextDecoder().decode(result.body);
}

function payload(result: EdgeWorkerResult): Payload {
  return JSON.parse(text(result)) as Payload;
}

function header(result: EdgeWorkerResult, name: string): string | undefined {
  return result.headers[name]?.join(', ');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEdgeWorkerHandler', () => {
  it('answers a first-visit sync with the 43-byte GIF and each Set-Cookie as its own header line', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ url: `/_sid/sync?id=pubcid%253A${UUID}` }));
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toEqual(['image/gif']);
    expect(result.headers).not.toHaveProperty('content-length');
    const cookies = result.headers['set-cookie'] ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};.*Domain=example\\.com`));
    expect(cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
    // The visitor's scheme is https, so the cookies are Secure.
    for (const cookie of cookies) expect(cookie).toContain('; Secure');
    expect(result.body.byteLength).toBe(43);
    expect(new TextDecoder('latin1').decode(result.body.subarray(0, 6))).toBe('GIF89a');
  });

  it('joins Cookie header lines (HTTP/2 sends one per cookie) into one Cookie header', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ headers: { cookie: [`_pubcid=${UUID}`, `_pubcid_sv=${UUID}`, 'other=1'] } }));
    expect(result.status).toBe(200);
    expect(header(result, 'x-sharedid-source')).toBe('cookie');
    expect(payload(result).sharedid).toBe(UUID);
  });

  it('keeps an existing ID and restores it from the recovery cookie', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ url: `/_sid/sync?id=pubcid%3A${OTHER}`, headers: { cookie: [`_pubcid_sv=${UUID}`] } }));
    expect(result.headers['set-cookie']?.[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
  });

  it('answers HEAD with the headers and cookies but no body', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ method: 'HEAD', url: `/_sid/sync?id=pubcid%3A${UUID}` }));
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toEqual(['image/gif']);
    expect(result.headers['set-cookie']).toHaveLength(2);
    expect(result.body.byteLength).toBe(0);
  });

  it('answers the CORS preflight for /v1 from an allowed origin', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com', SID_ALLOWED_ORIGINS: 'https://news.example.com' }) });
    const result = await handler(edgeWorkerRequest({ method: 'OPTIONS', headers: { origin: ['https://news.example.com'] } }));
    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-origin']).toEqual(['https://news.example.com']);
    expect(result.body.byteLength).toBe(0);
  });

  it('builds http URLs for http requests: cookies on a public hostname are still Secure', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ scheme: 'http', url: `/_sid/sync?id=pubcid%3A${UUID}` }));
    for (const cookie of result.headers['set-cookie'] ?? []) expect(cookie).toContain('; Secure');
  });

  it('uses publicOrigin for the request URL when it is set', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' }), publicOrigin: 'http://localhost:8080' });
    const result = await handler(edgeWorkerRequest({ url: `/_sid/sync?id=pubcid%3A${UUID}` }));
    for (const cookie of result.headers['set-cookie'] ?? []) expect(cookie).not.toContain('Secure');
  });

  it('keeps the host when the path starts with //', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com', SID_HOSTS: '{"www.example.com":{}}' }) });
    const result = await handler(edgeWorkerRequest({ url: '//evil.example/_sid/v1' }));
    expect(result.status).toBe(404);
    expect(result.headers).not.toHaveProperty('set-cookie');
  });

  it('answers 405 to other methods without reading a body', async () => {
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const result = await handler(edgeWorkerRequest({ method: 'POST' }));
    expect(result.status).toBe(405);
  });

  it('answers a generic 500 and logs only the error name when the request object fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }) });
    const request: EdgeWorkerRequest = {
      ...edgeWorkerRequest(),
      getHeaders: () => { throw new Error('secret request data'); }
    };
    const result = await handler(request);
    expect(result.status).toBe(500);
    expect(text(result)).toBe('Internal error');
    expect(result.headers['cache-control']).toEqual(['no-store']);
    expect(errors).toHaveBeenCalledWith('sharedid-edge: request failed', 'Error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });

  it('routes the default base path, a custom one and /', async () => {
    const cases: readonly (readonly [basePath: string | undefined, url: string, status: number])[] = [
      [undefined, '/_sid/v1', 200],
      [undefined, '/v1', 404],
      ['/identity', '/identity/v1', 200],
      ['/identity', '/_sid/v1', 404],
      ['/', '/v1', 200],
      ['/', '/sync', 200],
      ['/', '/about', 404],
      ['/', '/_sid/v1', 404]
    ];
    for (const [basePath, url, status] of cases) {
      const handler = createEdgeWorkerHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com', ...(basePath === undefined ? {} : { SID_BASE_PATH: basePath }) }) });
      const result = await handler(edgeWorkerRequest({ url }));
      expect([basePath, url, result.status]).toEqual([basePath, url, status]);
    }
  });
});

describe('platformInfo', () => {
  it('maps an IPv4 client and EdgeScape location, with isEU from the country', () => {
    expect(platformInfo({ clientIp: '198.51.100.10', userLocation: CAMBRIDGE })).toEqual({
      clientIp: '198.51.100.10',
      country: 'US',
      region: 'MA',
      city: 'CAMBRIDGE',
      postalCode: '02138',
      metroCode: '506',
      latitude: 42.364948,
      longitude: -71.088783,
      timezone: 'America/New_York',
      continent: 'NA',
      isEU: false
    });
  });

  it('maps an IPv6 client and an EU country', () => {
    expect(platformInfo({ clientIp: '2001:db8::7', userLocation: { country: 'FR', region: 'IDF', city: 'PARIS', continent: 'EU', zipCode: '75001', timezone: 'Europe/Paris' } })).toEqual({
      clientIp: '2001:db8::7',
      country: 'FR',
      region: 'IDF',
      city: 'PARIS',
      postalCode: '75001',
      timezone: 'Europe/Paris',
      continent: 'EU',
      isEU: true
    });
  });

  it('drops what core drops, and anything that is not an IP address', () => {
    expect(platformInfo({ clientIp: 'unknown', userLocation: { country: 'XX', latitude: '91', longitude: '0', dma: 'boston', continent: 'ZZ' } })).toEqual({});
    expect(platformInfo({ clientIp: ' ', userLocation: {} })).toEqual({});
    expect(platformInfo({})).toEqual({});
  });

  it('keeps a single postal code, but not several or a range', () => {
    expect(postalCodeFromZip('02138')).toBe('02138');
    expect(postalCodeFromZip('M5V')).toBe('M5V');
    expect(postalCodeFromZip('02114+02134+02138-02142+02163+02238')).toBeUndefined();
    expect(postalCodeFromZip('10001-10003')).toBeUndefined();
    expect(postalCodeFromZip('')).toBeUndefined();
    expect(postalCodeFromZip(undefined)).toBeUndefined();
  });

  it('gives the ip module the client IP, IPv4 and IPv6', async () => {
    const handler = createVariablesHandler();
    const variables = { PMUSER_SID_MODULES: 'ip' };
    const v4 = payload(await handler(edgeWorkerRequest({ variables })));
    expect(v4.ortb2?.device?.ip).toBe('198.51.100.10');
    const v6 = payload(await handler(edgeWorkerRequest({ variables, clientIp: '2001:DB8:0:0::7' })));
    expect(v6.ortb2?.device?.ipv6).toBe('2001:db8::7');
  });

  it('gives the geo module the EdgeScape location', async () => {
    const handler = createVariablesHandler();
    const result = payload(await handler(edgeWorkerRequest({ variables: { PMUSER_SID_MODULES: 'geo' } })));
    expect(result.ortb2?.device?.geo).toMatchObject({ country: 'USA', region: 'MA', metro: '506', zip: '02138', lat: 42.364948, lon: -71.088783 });
  });
});

describe('configuration from PMUSER_ variables', () => {
  it('reads every SID_* setting from PMUSER_SID_*', () => {
    expect(SETTING_NAMES).toEqual([...SETTINGS.map(setting => setting.name), 'SID_PUBLIC_ORIGIN']);
    // Property Manager variable names are at most 32 characters.
    for (const name of SETTING_NAMES) expect(`${VARIABLE_PREFIX}${name}`.length).toBeLessThanOrEqual(32);
    const env = envFromVariables({ getVariable: name => name === 'PMUSER_SID_COOKIE_NAME' ? 'sid' : undefined });
    expect(env['SID_COOKIE_NAME']).toBe('sid');
    expect(env['SID_BASE_PATH']).toBeUndefined();
  });

  it('answers 500 when SID_COOKIE_DOMAIN is missing, logging the setting once per configuration', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createVariablesHandler();
    const request = edgeWorkerRequest({ variables: { PMUSER_SID_COOKIE_DOMAIN: '' } });
    for (let i = 0; i < 2; i++) {
      const result = await handler(request);
      expect(result.status).toBe(500);
      expect(text(result)).toBe('SharedID Edge is misconfigured');
      expect(result.headers).not.toHaveProperty('set-cookie');
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('SID_COOKIE_DOMAIN');
    // Fixing the variable takes effect on the next request.
    const fixed = await handler(edgeWorkerRequest());
    expect(fixed.status).toBe(200);
  });

  it('answers 500 for an invalid setting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv({ SID_COOKIE_DOMAIN: 'example.com', SID_MAX_AGE_DAYS: 'forever' });
    expect((await handler(edgeWorkerRequest())).status).toBe(500);
  });

  it('applies the variables: base path, cookie name and public origin', async () => {
    const handler = createVariablesHandler();
    const result = await handler(edgeWorkerRequest({
      url: `/identity/sync?id=pubcid%3A${UUID}`,
      variables: { PMUSER_SID_BASE_PATH: '/identity', PMUSER_SID_COOKIE_NAME: 'sid', PMUSER_SID_COOKIE_DOMAIN: 'host-only', PMUSER_SID_PUBLIC_ORIGIN: 'http://localhost:8080' }
    }));
    expect(result.status).toBe(200);
    const cookies = result.headers['set-cookie'] ?? [];
    expect(cookies[0]).toMatch(new RegExp(`^sid=${UUID};`));
    for (const cookie of cookies) {
      expect(cookie).not.toContain('Domain=');
      expect(cookie).not.toContain('Secure');
    }
  });
});
