import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createHandler,
  defineModule,
  resolveConfig,
  settingsFromEnv,
  trustedUpstreamFromEnv,
  withTrustedUpstream,
  type ModuleCookie,
  type ModuleContext
} from '../src/index.js';
import { cookieNamed, setCookies } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const NOW = new Date('2026-01-01T00:00:00Z');
const SECRET = 'a'.repeat(32) + '0123456789abcdef';

function auto(env: Record<string, string> = {}): ReturnType<typeof createHandler> {
  return createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'auto', ...env }), now: () => NOW, mintId: () => UUID });
}

function sync(host: string, cookieDomain?: string, headers: Record<string, string> = {}): Request {
  const query = cookieDomain === undefined ? '' : `&cookie_domain=${encodeURIComponent(cookieDomain)}`;
  return new Request(`https://${host}/_sid/sync?id=pubcid:${UUID}${query}`, { headers });
}

/** The `Domain` of each `Set-Cookie` of `name`, in order (undefined for host-only). */
function domains(response: Response, name: string): (string | undefined)[] {
  return setCookies(response).filter(c => c.name === name).map(c => c.attributes.get('domain'));
}

describe('SID_COOKIE_DOMAIN=auto', () => {
  it('is accepted, and other words still are not domains', () => {
    expect(resolveConfig({ SID_COOKIE_DOMAIN: 'auto' }).cookieDomain).toBe('auto');
    expect(() => resolveConfig({ SID_COOKIE_DOMAIN: 'automatic' })).toThrow(ConfigError);
  });

  it.each([
    ['a parent of the host', 'www.example.com', 'example.com', 'example.com'],
    ['the host itself', 'www.example.com', 'www.example.com', 'www.example.com'],
    ['a parent two levels up', 'a.b.example.co.uk', 'example.co.uk', 'example.co.uk'],
    ['upper case', 'www.example.com', 'EXAMPLE.com', 'example.com'],
    ['a trailing dot', 'www.example.com', 'example.com.', 'example.com'],
    ['a host with a trailing dot', 'www.example.com.', 'example.com', 'example.com']
  ])('sets the ID cookies on cookie_domain when it is %s', async (_, host, cookieDomain, expected) => {
    const response = await auto()(sync(host, cookieDomain));
    expect(domains(response, '_pubcid')).toEqual([expected]);
    expect(domains(response, '_pubcid_sv')).toEqual([expected]);
    expect(response.headers.get('X-SharedID-Cookie-Domain')).toBe(expected);
  });

  it.each([
    ['another site', 'www.example.com', 'example.org'],
    ['a suffix not at a label boundary', 'www.example.com', 'ample.com'],
    ['a child of the host', 'example.com', 'www.example.com'],
    ['a name that contains the host', 'www.example.com', 'com.evil'],
    ['a top-level domain', 'www.example.com', 'com'],
    ['a port', 'www.example.com', 'example.com:443'],
    ['a scheme', 'www.example.com', 'https://example.com'],
    ['a leading dot', 'www.example.com', '.example.com'],
    ['empty', 'www.example.com', ''],
    ['an IP address host', '192.0.2.10', '192.0.2.10'],
    ['an IP address host and a parent', '192.0.2.10', '0.2.10'],
    ['an IPv6 host', '[2001:db8::1]', '[2001:db8::1]']
  ])('falls back to host-only when cookie_domain is %s', async (_, host, cookieDomain) => {
    const response = await auto()(sync(host, cookieDomain));
    expect(domains(response, '_pubcid')).toEqual([undefined]);
    expect(response.headers.get('X-SharedID-Cookie-Domain')).toBe('host-only: cookie_domain not this host or a parent');
  });

  it('falls back to host-only without cookie_domain', async () => {
    const response = await auto()(sync('www.example.com'));
    expect(domains(response, '_pubcid')).toEqual([undefined]);
    expect(response.headers.get('X-SharedID-Cookie-Domain')).toBe('host-only: no cookie_domain');
  });

  it('takes cookie_domain on /v1 too', async () => {
    const response = await auto()(new Request('https://www.example.com/_sid/v1?cookie_domain=example.com'));
    expect(domains(response, '_pubcid')).toEqual(['example.com']);
  });

  it('never reads the host from X-Forwarded-Host without trusted upstream', async () => {
    const response = await auto()(sync('sid.upstream.example', 'example.com', { 'X-Forwarded-Host': 'www.example.com' }));
    expect(domains(response, '_pubcid')).toEqual([undefined]);
  });

  it('deletes a host-only duplicate once the domain is known', async () => {
    const response = await auto({ SID_RECOVERY_COOKIE: 'none' })(sync('www.example.com', 'example.com', { Cookie: `_pubcid=${UUID}; _pubcid=${UUID}` }));
    expect(domains(response, '_pubcid')).toEqual(['example.com', undefined]);
  });

  it('leaves the other settings alone: a fixed domain ignores cookie_domain', async () => {
    const h = createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }), now: () => NOW });
    const response = await h(sync('www.example.com', 'www.example.com'));
    expect(domains(response, '_pubcid')).toEqual(['example.com']);
    expect(response.headers.has('X-SharedID-Cookie-Domain')).toBe(false);
    const hostOnly = createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' }), now: () => NOW });
    expect(domains(await hostOnly(sync('www.example.com', 'example.com')), '_pubcid')).toEqual([undefined]);
  });

  it('works per site in SID_HOSTS, next to a deployment-wide fixed domain', async () => {
    const env = { SID_COOKIE_DOMAIN: 'example.com', SID_HOSTS: JSON.stringify({ 'www.example.com': {}, 'www.pub.example': { SID_COOKIE_DOMAIN: 'auto' } }) };
    const h = createHandler({ ...settingsFromEnv(env, { requireCookieDomain: true }), now: () => NOW });
    expect(domains(await h(sync('www.pub.example', 'pub.example')), '_pubcid')).toEqual(['pub.example']);
    expect(domains(await h(sync('www.example.com', 'www.example.com')), '_pubcid')).toEqual(['example.com']);
  });

  describe('routes without cookie_domain', () => {
    it('opt-out sets the opt-out cookie and deletes the ID cookies on the host and every domain above it', async () => {
      const response = await auto()(new Request('https://a.www.example.com/_sid/optout'));
      const everywhere = [undefined, 'a.www.example.com', 'www.example.com', 'example.com'];
      expect(domains(response, '_pubcid_optout')).toEqual(everywhere);
      expect(domains(response, '_pubcid')).toEqual(everywhere);
      expect(domains(response, '_pubcid_sv')).toEqual(everywhere);
      expect(cookieNamed(response, '_pubcid')?.attributes.get('max-age')).toBe('0');
    });

    it('opt-in deletes the opt-out cookie everywhere it could be', async () => {
      const response = await auto()(new Request('https://www.example.com/_sid/optin'));
      expect(domains(response, '_pubcid_optout')).toEqual([undefined, 'www.example.com', 'example.com']);
    });

    it('denied consent deletes the ID cookies everywhere, with or without cookie_domain', async () => {
      const response = await auto()(sync('www.example.com', 'example.com', { 'Sec-GPC': '1', Cookie: `_pubcid=${UUID}` }));
      expect(domains(response, '_pubcid')).toEqual([undefined, 'www.example.com', 'example.com']);
    });

    it('an IP address host gets host-only cookies only', async () => {
      const response = await auto()(new Request('https://192.0.2.10/_sid/optout'));
      expect(domains(response, '_pubcid')).toEqual([undefined]);
    });
  });

  describe('module cookies', () => {
    const seen: { context?: ModuleContext } = {};
    const cookie = (name: string, domain?: string): ModuleCookie => ({ name, value: 'x', maxAgeSeconds: 60, httpOnly: true, ...(domain === undefined ? {} : { domain }) });
    const spy = defineModule({
      name: 'spy',
      routes: ['v1', 'sync'],
      run: context => {
        seen.context = context;
        return { cookies: [cookie('core_default'), cookie('own_auto', 'auto'), cookie('own_fixed', '.example.net')] };
      },
      optOutCookies: () => [{ ...cookie('own_auto', 'auto'), value: '', maxAgeSeconds: 0 }]
    });
    const withSpy = (env: Record<string, string>): ReturnType<typeof createHandler> =>
      createHandler({ config: resolveConfig({ SID_MODULES: 'spy', ...env }), modules: [spy], now: () => NOW });

    it('gives modules the auto domain, as core\'s and as their own `auto`', async () => {
      const response = await withSpy({ SID_COOKIE_DOMAIN: 'auto' })(sync('www.example.com', 'example.com'));
      expect(seen.context?.cookieDomain).toBe('example.com');
      expect(seen.context?.autoCookieDomain).toBe('example.com');
      expect(domains(response, 'core_default')).toEqual(['example.com']);
      expect(domains(response, 'own_auto')).toEqual(['example.com']);
      expect(domains(response, 'own_fixed')).toEqual(['.example.net']);
    });

    it('resolves a module\'s own `auto` under a fixed SID_COOKIE_DOMAIN', async () => {
      const response = await withSpy({ SID_COOKIE_DOMAIN: 'example.com' })(sync('shop.www.example.com', 'www.example.com'));
      expect(seen.context?.cookieDomain).toBe('example.com');
      expect(domains(response, 'core_default')).toEqual(['example.com']);
      expect(domains(response, 'own_auto')).toEqual(['www.example.com']);
      const fallback = await withSpy({ SID_COOKIE_DOMAIN: 'example.com' })(sync('www.example.com', 'example.org'));
      expect(domains(fallback, 'own_auto')).toEqual([undefined]);
    });

    it('deletes a module\'s `auto` cookie everywhere on opt-out', async () => {
      const response = await withSpy({ SID_COOKIE_DOMAIN: 'example.com' })(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: 'own_auto=x' } }));
      expect(domains(response, 'own_auto')).toEqual([undefined, 'www.example.com', 'example.com']);
    });
  });

  describe('trusted upstream (an upstream operator\'s endpoint)', () => {
    const ENV = {
      SID_UPSTREAM_SECRETS: JSON.stringify([SECRET]),
      SID_LOCATION_HEADERS: JSON.stringify({ country: 'x-sid-country' }),
      SID_COOKIE_DOMAIN: 'auto',
      SID_HOSTS: JSON.stringify({
        'www.example.com': {},
        'news.example.org': {},
        'www.example.net': { SID_COOKIE_DOMAIN: 'example.net' }
      })
    };
    const upstream = withTrustedUpstream(createHandler({ ...settingsFromEnv(ENV, { requireCookieDomain: true }), now: () => NOW }), trustedUpstreamFromEnv(ENV));
    const forwarded = (site: string, cookieDomain: string, secret = SECRET): Request =>
      sync('sid.upstream.example', cookieDomain, { 'x-sid-upstream-auth': secret, 'x-forwarded-host': site });

    it('checks cookie_domain against the forwarded site, each site getting its own', async () => {
      expect(domains(await upstream(forwarded('www.example.com', 'example.com')), '_pubcid')).toEqual(['example.com']);
      expect(domains(await upstream(forwarded('news.example.org', 'example.org')), '_pubcid')).toEqual(['example.org']);
    });

    it('never against the endpoint\'s own host', async () => {
      expect(domains(await upstream(forwarded('www.example.com', 'upstream.example')), '_pubcid')).toEqual([undefined]);
    });

    it('lets a site\'s fixed domain win over the deployment\'s auto', async () => {
      expect(domains(await upstream(forwarded('www.example.net', 'www.example.net')), '_pubcid')).toEqual(['example.net']);
    });

    it('still refuses a request without the secret', async () => {
      const response = await upstream(forwarded('www.example.com', 'example.com', 'wrong'.repeat(8)));
      expect(response.status).toBe(403);
      expect(setCookies(response)).toEqual([]);
    });
  });
});
