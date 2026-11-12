import { describe, expect, it } from 'vitest';
import {
  clientIpFromHeader,
  ConfigError,
  createHandler,
  defineModule,
  forwardedPlatformInfo,
  parseForwardedHost,
  refuseTrustedUpstream,
  settingsFromEnv,
  trustedUpstreamFromEnv,
  utf8Header,
  withTrustedUpstream,
  type PlatformInfo,
  type SharedIdEdgeHandler
} from '../src/index.js';
import { cookieNamed, setCookies } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const SECRET = 'a'.repeat(32) + '0123456789abcdef';
const ROTATED = 'b'.repeat(40);
const LOCATION = JSON.stringify({ country: 'x-sid-country', regionCode: 'x-sid-region', city: 'x-sid-city' });
const ENV = {
  SID_UPSTREAM_SECRETS: JSON.stringify([SECRET, ROTATED]),
  SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
  SID_LOCATION_HEADERS: LOCATION,
  SID_COOKIE_DOMAIN: 'host-only',
  SID_HOSTS: JSON.stringify({
    'www.example.com': { SID_COOKIE_DOMAIN: 'example.com' },
    'www.example.org': { SID_COOKIE_DOMAIN: 'example.org', SID_COOKIE_NAME: 'sid' }
  })
};

/** The handler as an adapter builds it, recording the platform information and request each module run sees. */
function build(env: Readonly<Record<string, string>> = ENV): { handler: SharedIdEdgeHandler; seen: { platform?: PlatformInfo; request?: Request } } {
  const seen: { platform?: PlatformInfo; request?: Request } = {};
  const spy = defineModule({
    name: 'spy',
    routes: ['v1', 'sync'],
    run: context => {
      seen.platform = context.platform;
      seen.request = context.request;
      return undefined;
    }
  });
  const handler = withTrustedUpstream(
    createHandler({ ...settingsFromEnv({ ...env, SID_MODULES: 'spy' }, { requireCookieDomain: true }), modules: [spy] }),
    trustedUpstreamFromEnv(env)
  );
  return { handler, seen };
}

const PLATFORM: PlatformInfo = { clientIp: '198.51.100.1', country: 'DE', isEU: true, traffic: { bot: true, botKind: 'verified' } };

function request(path: string, headers: Record<string, string>): Request {
  return new Request(`https://sid.sales-house.example${path}`, { headers });
}

describe('trusted upstream: settings', () => {
  it('is off without SID_UPSTREAM_SECRETS', () => {
    expect(trustedUpstreamFromEnv({})).toBeUndefined();
    expect(trustedUpstreamFromEnv({ SID_UPSTREAM_SECRETS: ' ' })).toBeUndefined();
  });

  it('reads the secrets, headers and defaults', () => {
    expect(trustedUpstreamFromEnv(ENV)).toEqual({
      authHeader: 'x-sid-upstream-auth',
      hostHeader: 'x-forwarded-host',
      secrets: [SECRET, ROTATED],
      forwarded: { clientIp: 'x-sid-client-ip', location: { country: 'x-sid-country', regionCode: 'x-sid-region', city: 'x-sid-city' } }
    });
    expect(trustedUpstreamFromEnv({ ...ENV, SID_UPSTREAM_AUTH_HEADER: 'X-Pub-Auth', SID_UPSTREAM_HOST_HEADER: 'X-Pub-Host', SID_CLIENT_IP_HEADER: '' }))
      .toMatchObject({ authHeader: 'x-pub-auth', hostHeader: 'x-pub-host', forwarded: { clientIp: undefined } });
  });

  it('refuses bad secrets without showing them', () => {
    const bad = (secrets: string): (() => unknown) => () => trustedUpstreamFromEnv({ ...ENV, SID_UPSTREAM_SECRETS: secrets });
    expect(bad('not json')).toThrow(/must be a JSON array/);
    expect(bad('[]')).toThrow(/must be a JSON array/);
    expect(bad(JSON.stringify(SECRET))).toThrow(/must be a JSON array/);
    expect(bad('["short"]')).toThrow(/secret 1 must be 32 to 256/);
    expect(bad(JSON.stringify([SECRET, `${'c'.repeat(32)}, x`]))).toThrow(/secret 2 must be/);
    expect(bad(JSON.stringify([SECRET, 7]))).toThrow(/secret 2 must be/);
    try {
      bad(JSON.stringify([`${SECRET} `]))();
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it('needs the country header, and x- headers that all differ', () => {
    const bad = (overrides: Record<string, string>): (() => unknown) => () => trustedUpstreamFromEnv({ ...ENV, ...overrides });
    expect(bad({ SID_LOCATION_HEADERS: '' })).toThrow(/must name the country header/);
    expect(bad({ SID_LOCATION_HEADERS: '{"regionCode":"x-sid-region"}' })).toThrow(/must name the country header/);
    expect(bad({ SID_LOCATION_HEADERS: '{"country":"cf-ipcountry"}' })).toThrow(/SID_LOCATION_HEADERS: .*starting with x-/);
    expect(bad({ SID_CLIENT_IP_HEADER: 'cf-connecting-ip' })).toThrow(/SID_CLIENT_IP_HEADER: .*starting with x-/);
    expect(bad({ SID_CLIENT_IP_HEADER: 'x-forwarded-for' })).toThrow(/SID_CLIENT_IP_HEADER: .*not "x-forwarded-for"/);
    expect(bad({ SID_UPSTREAM_AUTH_HEADER: 'authorization' })).toThrow(/SID_UPSTREAM_AUTH_HEADER/);
    expect(bad({ SID_UPSTREAM_HOST_HEADER: 'host' })).toThrow(/SID_UPSTREAM_HOST_HEADER/);
    expect(bad({ SID_CLIENT_IP_HEADER: 'x-sid-country' })).toThrow(/used twice/);
    expect(bad({ SID_UPSTREAM_AUTH_HEADER: 'x-forwarded-host' })).toThrow(/used twice/);
    expect(bad({ SID_CLIENT_IP_HEADER: 'not a header' })).toThrow(/must be a header name/);
  });

  it('refuses its headers without SID_UPSTREAM_SECRETS, unless a trusted proxy reads them', () => {
    expect(() => trustedUpstreamFromEnv({ SID_UPSTREAM_AUTH_HEADER: 'x-a' })).toThrow(/SID_UPSTREAM_AUTH_HEADER needs SID_UPSTREAM_SECRETS/);
    expect(() => trustedUpstreamFromEnv({ SID_UPSTREAM_HOST_HEADER: 'x-a' })).toThrow(/needs SID_UPSTREAM_SECRETS/);
    expect(() => trustedUpstreamFromEnv({ SID_CLIENT_IP_HEADER: 'x-a' })).toThrow(/SID_CLIENT_IP_HEADER is read only from an authenticated upstream/);
    expect(() => trustedUpstreamFromEnv({ SID_LOCATION_HEADERS: LOCATION })).toThrow(/SID_LOCATION_HEADERS is read only/);
    expect(trustedUpstreamFromEnv({ SID_CLIENT_IP_HEADER: 'fastly-client-ip', SID_LOCATION_HEADERS: LOCATION }, { trustProxy: true })).toBeUndefined();
  });

  it('is refused by adapters without it, and per host', () => {
    for (const name of ['SID_UPSTREAM_SECRETS', 'SID_UPSTREAM_AUTH_HEADER', 'SID_UPSTREAM_HOST_HEADER']) {
      expect(() => refuseTrustedUpstream({ [name]: 'x' })).toThrow(ConfigError);
      expect(() => refuseTrustedUpstream({ [name]: 'x' })).toThrow(new RegExp(`^${name}: trusted-upstream mode isn't available`));
    }
    // A secret's value never appears in the error.
    expect(() => refuseTrustedUpstream({ SID_UPSTREAM_SECRETS: JSON.stringify([SECRET]) })).toThrow(/^((?!aaaa).)*$/);
    // The adapters without it refuse it through this, not settingsFromEnv.
    expect(settingsFromEnv({ SID_UPSTREAM_SECRETS: JSON.stringify([SECRET]), SID_COOKIE_DOMAIN: 'host-only' }).config.cookieDomain).toBeUndefined();
    const env = { SID_UPSTREAM_SECRETS: ' ', SID_COOKIE_DOMAIN: 'host-only', SID_OTHER: undefined };
    expect(refuseTrustedUpstream(env)).toBe(env);
    for (const name of ['SID_UPSTREAM_SECRETS', 'SID_CLIENT_IP_HEADER', 'SID_LOCATION_HEADERS']) {
      const hosts = JSON.stringify({ 'a.example': { SID_COOKIE_DOMAIN: 'a.example', [name]: 'x' } });
      expect(() => settingsFromEnv({ SID_HOSTS: hosts })).toThrow(new RegExp(`${name} can't be set per host`));
    }
  });
});

describe('trusted upstream: requests', () => {
  const authenticated = { 'x-sid-upstream-auth': SECRET, 'x-forwarded-host': 'www.example.com' };

  it('answers 403 without one of the secrets, with no cookies, whatever the path or host', async () => {
    const { handler, seen } = build();
    for (const headers of [{}, { 'x-sid-upstream-auth': '' }, { 'x-sid-upstream-auth': SECRET.slice(0, -1) }, { 'x-sid-upstream-auth': `${SECRET}x` }, { 'x-sid-upstream-auth': SECRET.toUpperCase() }]) {
      for (const path of [`/_sid/sync?id=pubcid%3A${UUID}`, '/_sid/v1', '/_sid/optout', '/elsewhere']) {
        const response = await handler(request(path, { ...headers, 'x-forwarded-host': 'www.example.com', 'x-sid-country': 'US' }), PLATFORM);
        expect(response.status).toBe(403);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('Forbidden');
      }
    }
    expect(seen.platform).toBeUndefined();
  });

  it('refuses a repeated auth header, even when each copy is a secret', async () => {
    const { handler } = build();
    const headers = new Headers({ 'x-forwarded-host': 'www.example.com' });
    headers.append('x-sid-upstream-auth', SECRET);
    headers.append('x-sid-upstream-auth', SECRET);
    const response = await handler(new Request('https://sid.sales-house.example/_sid/v1', { headers }), PLATFORM);
    expect(response.status).toBe(403);
  });

  it('accepts any of the secrets (rotation)', async () => {
    const { handler } = build();
    for (const secret of [SECRET, ROTATED]) {
      const response = await handler(request('/_sid/v1', { ...authenticated, 'x-sid-upstream-auth': secret }), PLATFORM);
      expect(response.status).toBe(200);
    }
  });

  it("uses the forwarded client IP and location, never the platform's", async () => {
    const { handler, seen } = build();
    await handler(request('/_sid/v1', { ...authenticated, 'x-sid-client-ip': '203.0.113.5', 'x-sid-country': 'us', 'x-sid-region': 'CA', 'x-sid-city': 'San JosÃ©' }), PLATFORM);
    expect(seen.platform).toEqual({ clientIp: '203.0.113.5', country: 'US', region: 'CA', city: 'San José', isEU: false });
    await handler(request('/_sid/v1', authenticated), PLATFORM);
    expect(seen.platform).toEqual({});
    await handler(request('/_sid/v1', { ...authenticated, 'x-sid-client-ip': '203.0.113.5, 198.51.100.9', 'x-sid-country': 'XX' }), PLATFORM);
    expect(seen.platform).toEqual({});
  });

  it('decides GDPR from the forwarded country', async () => {
    const { handler } = build();
    const eu = await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`, { ...authenticated, 'x-sid-country': 'DE' }), { country: 'US', isEU: false });
    expect(setCookies(eu)).toEqual([]);
    const us = await handler(request(`/_sid/sync?id=pubcid%3A${UUID}`, { ...authenticated, 'x-sid-country': 'US' }), PLATFORM);
    expect(cookieNamed(us, '_pubcid')?.value).toBe(UUID);
  });

  it("picks the site, cookie domain and Secure by the forwarded host, and hides the secret from modules", async () => {
    const { handler, seen } = build();
    const http = (host: string): Request => new Request(`http://127.0.0.1:8787/_sid/sync?id=pubcid%3A${UUID}`, { headers: { 'x-sid-upstream-auth': SECRET, 'x-forwarded-host': host, 'x-sid-country': 'US' } });
    const a = await handler(http('WWW.Example.COM.:443'), {});
    expect(cookieNamed(a, '_pubcid')?.attributes.get('domain')).toBe('example.com');
    expect(cookieNamed(a, '_pubcid')?.attributes.has('secure')).toBe(true);
    expect(seen.request?.url).toBe(`http://www.example.com/_sid/sync?id=pubcid%3A${UUID}`);
    expect(seen.request?.headers.has('x-sid-upstream-auth')).toBe(false);
    const b = await handler(http('www.example.org'), {});
    expect(cookieNamed(b, 'sid')?.attributes.get('domain')).toBe('example.org');
    expect((await handler(http('www.example.net'), {})).status).toBe(404);
  });

  it('answers 400 for a forwarded host that is not one hostname, and keeps the URL without one', async () => {
    const { handler } = build();
    for (const host of ['www.example.com, evil.example', '[2001:db8::1]', 'bad_host', 'www.example.com:99999', '']) {
      const response = await handler(request('/_sid/v1', { 'x-sid-upstream-auth': SECRET, 'x-forwarded-host': host }), PLATFORM);
      expect(response.status, host).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    // No header: the request's own host, which SID_HOSTS doesn't list.
    expect((await handler(request('/_sid/v1', { 'x-sid-upstream-auth': SECRET }), PLATFORM)).status).toBe(404);
  });

  it('changes nothing when off', () => {
    const plain = createHandler({ ...settingsFromEnv({ SID_COOKIE_DOMAIN: 'host-only' }) });
    expect(withTrustedUpstream(plain, undefined)).toBe(plain);
  });
});

describe('forwarded headers', () => {
  it('reads client IPs as each header holds them', () => {
    expect(clientIpFromHeader('x-sid-client-ip', '2001:db8::1')).toBe('2001:db8::1');
    expect(clientIpFromHeader('x-sid-client-ip', ' 192.0.2.1 ')).toBe('192.0.2.1');
    expect(clientIpFromHeader('x-sid-client-ip', '192.0.2.1:443')).toBeUndefined();
    expect(clientIpFromHeader('x-sid-client-ip', '192.0.2.1, 192.0.2.2')).toBeUndefined();
    expect(clientIpFromHeader('X-Forwarded-For', '192.0.2.1, 192.0.2.2')).toBe('192.0.2.1');
    expect(clientIpFromHeader('cloudfront-viewer-address', '2001:db8::1:46532')).toBe('2001:db8::1');
    expect(clientIpFromHeader('x-sid-client-ip', null)).toBeUndefined();
  });

  it('decodes UTF-8 read as Latin-1, and leaves anything else alone', () => {
    expect(utf8Header('MÃ¼nchen')).toBe('München');
    expect(utf8Header('Austin')).toBe('Austin');
    expect(utf8Header('München')).toBe('München');
    expect(utf8Header('東京')).toBe('東京');
  });

  it('builds platform information from the headers', () => {
    const headers = new Headers({ 'x-ip': '192.0.2.4', 'x-country': 'fr', 'x-lat': '48.85', 'x-lon': '2.35' });
    expect(forwardedPlatformInfo(headers, { clientIp: 'x-ip', location: { country: 'x-country', latitude: 'x-lat', longitude: 'x-lon' } }))
      .toEqual({ clientIp: '192.0.2.4', country: 'FR', isEU: true, latitude: 48.85, longitude: 2.35 });
    expect(forwardedPlatformInfo(headers, { location: {} })).toEqual({});
  });

  it('parses forwarded hosts', () => {
    expect(parseForwardedHost('www.example.com')).toBe('www.example.com');
    expect(parseForwardedHost(' WWW.Example.com.:8443 ')).toBe('www.example.com');
    expect(parseForwardedHost('192.0.2.1')).toBe('192.0.2.1');
    for (const bad of ['', 'a b', 'a,b', '[::1]', '::1', 'example.com:', 'example.com:x', '-a.example']) expect(parseForwardedHost(bad), bad).toBeUndefined();
  });
});
