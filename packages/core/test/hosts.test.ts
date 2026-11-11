import { describe, expect, it } from 'vitest';
import { ConfigError, createHandler, hostKey, hostOverrides, resolveConfig, resolveHosts, settingsFromEnv } from '../src/index.js';
import { cookieNamed } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const HOSTS = JSON.stringify({
  'www.pub-a.example': { SID_COOKIE_DOMAIN: 'pub-a.example' },
  'WWW.Pub-B.Example.': { SID_COOKIE_DOMAIN: 'pub-b.example', SID_COOKIE_NAME: 'sid', SID_MODULE_CONFIG: { geo: { precision: 'coarse' } } }
});

const sync = (host: string): Request => new Request(`https://${host}/_sid/sync?id=pubcid%3A${UUID}`);

describe('SID_HOSTS', () => {
  it('resolves each host on top of the deployment settings, keyed by lower-case hostname', () => {
    const hosts = resolveHosts({ SID_HOSTS: HOSTS, SID_MAX_AGE_DAYS: '30' }, { requireCookieDomain: true });
    expect([...(hosts?.keys() ?? [])]).toEqual(['www.pub-a.example', 'www.pub-b.example']);
    expect(hosts?.get('www.pub-a.example')).toMatchObject({ cookieDomain: 'pub-a.example', cookieName: '_pubcid', maxAgeDays: 30 });
    expect(hosts?.get('www.pub-b.example')).toMatchObject({ cookieDomain: 'pub-b.example', cookieName: 'sid', moduleConfig: { geo: { precision: 'coarse' } } });
    expect(resolveHosts({})).toBeUndefined();
    expect(resolveHosts({ SID_HOSTS: ' ' })).toBeUndefined();
  });

  it('refuses invalid hosts and settings at start-up, naming the host', () => {
    const bad = (value: unknown): (() => unknown) => () => resolveHosts({ SID_HOSTS: JSON.stringify(value) }, { requireCookieDomain: true });
    expect(() => resolveHosts({ SID_HOSTS: 'nope' })).toThrow(/SID_HOSTS must be a JSON object/);
    expect(bad(['www.example.com'])).toThrow(/SID_HOSTS must be a JSON object/);
    expect(bad({ 'not a host': {} })).toThrow(/"not a host" isn't a hostname/);
    expect(bad({ 'a.example': { SID_COOKIE_DOMAIN: 'a.example' }, 'A.example': { SID_COOKIE_DOMAIN: 'a.example' } })).toThrow(/lists a.example twice/);
    expect(bad({ 'a.example': { SID_COOKIE_DOMAIN: 'a.example', SID_MODULE_SECRETS: '{}' } })).toThrow(/SID_MODULE_SECRETS can't be set per host/);
    expect(bad({ 'a.example': { COOKIE: 'x' } })).toThrow(/"COOKIE" isn't a SID_\* setting/);
    // The base path is what the platform routes by (a Worker route, Vercel's middleware): the deployment's, for every site.
    expect(bad({ 'a.example': { SID_COOKIE_DOMAIN: 'a.example', SID_BASE_PATH: '/identity' } })).toThrow(/SID_BASE_PATH can't be set per host/);
    expect(bad({ 'a.example': { SID_MAX_AGE_DAYS: 30 } })).toThrow(/SID_MAX_AGE_DAYS must be a string/);
    // Each host must name its cookie domain, or inherit one.
    expect(bad({ 'a.example': {} })).toThrow(ConfigError);
    expect(bad({ 'a.example': {} })).toThrow(/^SID_HOSTS\["a.example"\]: SID_COOKIE_DOMAIN is required/);
    expect(bad({ 'a.example': { SID_MAX_AGE_DAYS: 'x', SID_COOKIE_DOMAIN: 'a.example' } })).toThrow(/^SID_HOSTS\["a.example"\]: /);
  });

  it("doesn't need a cookie domain in the deployment's own settings when every host has one", () => {
    expect(() => settingsFromEnv({}, { requireCookieDomain: true })).toThrow(/SID_COOKIE_DOMAIN is required/);
    const settings = settingsFromEnv({ SID_HOSTS: HOSTS }, { requireCookieDomain: true });
    expect(settings.hosts?.size).toBe(2);
    expect(settings.config.cookieDomain).toBeUndefined();
  });

  it('serves each listed host with its settings, and answers nothing for any other host', async () => {
    const handler = createHandler(settingsFromEnv({ SID_HOSTS: HOSTS }, { requireCookieDomain: true }));
    const a = await handler(sync('www.pub-a.example'));
    expect(cookieNamed(a, '_pubcid')?.attributes.get('domain')).toBe('pub-a.example');
    const b = await handler(sync('www.pub-b.example:8443'));
    expect(cookieNamed(b, 'sid')?.attributes.get('domain')).toBe('pub-b.example');
    const other = await handler(sync('www.unlisted.example'));
    expect(other.status).toBe(404);
    expect(other.headers.getSetCookie()).toEqual([]);
  });

  it("uses a platform's host configuration when SID_HOSTS has none, and the base without either", async () => {
    const fromPlatform = resolveConfig({ SID_COOKIE_DOMAIN: 'platform.example', SID_COOKIE_NAME: 'psid' });
    const handler = createHandler({
      config: resolveConfig({ SID_COOKIE_DOMAIN: 'base.example' }),
      hostConfig: request => (new URL(request.url).hostname === 'saas.example' ? fromPlatform : undefined)
    });
    expect(cookieNamed(await handler(sync('saas.example')), 'psid')?.attributes.get('domain')).toBe('platform.example');
    // No SID_HOSTS: a host the platform has nothing for gets the deployment's own settings.
    expect(cookieNamed(await handler(sync('www.base.example')), '_pubcid')?.attributes.get('domain')).toBe('base.example');

    // With SID_HOSTS (even empty), only listed hosts and the platform's are served.
    const strict = createHandler({ ...settingsFromEnv({ SID_HOSTS: '{}' }), hostConfig: () => undefined });
    expect((await strict(sync('www.base.example'))).status).toBe(404);
  });

  it('keys hosts by lower-case hostname, without the port or a trailing dot', () => {
    expect(hostKey(new URL('https://WWW.Example.COM.:8443/_sid/sync'))).toBe('www.example.com');
    expect(hostOverrides({ SID_MODULES: 'geo' }, 'x')).toEqual({ SID_MODULES: 'geo' });
  });
});
