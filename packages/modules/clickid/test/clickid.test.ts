import { createHandler, resolveConfig, type PayloadV1, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { DEFAULT_KEEPER_COOKIE, RESERVED_COOKIE_NAMES as REFLECT_RESERVED } from '@sharedid-edge/module-reflect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clickIdFrom,
  clickIdModule,
  clickIdModuleConfig,
  DEFAULT_PARAMS,
  landingUrl,
  RESERVED_COOKIE_NAMES,
  storedClickId
} from '../src/index.js';

// TC strings built with tcString() and publisherTc() from packages/core/test/helpers.ts:
// publisherTc([1, 7]): publisher consent for Purposes 1 and 7, so storage and click IDs are allowed.
const TC_PUBLISHER_1_7 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.cEAAAAAAAA';
// publisherTc([1, 2]): storage is allowed (Purpose 1, and 2), but there's no consent for Purpose 7.
const TC_PUBLISHER_1_2 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.eAAAAAAAAA';

const ID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const GCLID = 'EAIaIQobChMI-Ab_c.9~x';
/** The test clock: 2026-01-01T00:00:00Z. */
const NOW_SECONDS = 1_767_225_600;
const NINETY_DAYS = 90 * 86_400;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_SECONDS * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

function handler(moduleConfig: unknown = {}, env: Record<string, string> = {}): SharedIdEdgeHandler {
  return createHandler({
    config: resolveConfig({ SID_MODULES: 'clickid', SID_MODULE_CONFIG: JSON.stringify({ clickid: moduleConfig }), ...env }),
    modules: [clickIdModule]
  });
}

interface Call {
  readonly path?: string;
  readonly referer?: string;
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
}

function request({ path = '/_sid/v1', referer, cookie, headers = {} }: Call): Request {
  const all: Record<string, string> = { ...headers };
  if (referer !== undefined) all['Referer'] = referer;
  all['Cookie'] = cookie ?? `_pubcid=${ID}`;
  return new Request(`https://www.example.com${path}`, { headers: all });
}

/** The module's own Set-Cookie headers (not the SharedID's). */
function clickCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter(c => c.startsWith('_sid_') || c.startsWith('my_') || c.startsWith('li_'));
}

/** Each of the module's cookies as `name=value`. */
function pairs(response: Response): string[] {
  return clickCookies(response).map(c => c.slice(0, c.indexOf(';')));
}

function v1(url: string): string {
  return `/_sid/v1?url=${encodeURIComponent(url)}`;
}

describe('settings', () => {
  it('has the seven default parameters, each in _sid_<name>, 90 days, not HttpOnly', () => {
    expect(clickIdModuleConfig({})).toEqual({
      params: DEFAULT_PARAMS.map(name => ({ name, cookie: `_sid_${name}` })),
      cookies: DEFAULT_PARAMS.map(name => `_sid_${name}`),
      maxAgeDays: 90,
      domain: undefined,
      httpOnly: false,
      hosts: []
    });
    expect(DEFAULT_PARAMS).toEqual(['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid']);
  });

  it('switches defaults off, renames their cookies, and adds parameters', () => {
    const settings = clickIdModuleConfig({
      params: [
        { name: 'dclid', enabled: false },
        { name: 'fbclid', cookie: 'my_fbclid' },
        { name: 'li_fat_id', cookie: 'li_click' },
        { name: 'ScCid' }
      ],
      maxAgeDays: 30,
      domain: 'example.com',
      httpOnly: true,
      hosts: ['shop.example.com']
    });
    expect(settings.params).toEqual([
      { name: 'gclid', cookie: '_sid_gclid' },
      { name: 'gbraid', cookie: '_sid_gbraid' },
      { name: 'wbraid', cookie: '_sid_wbraid' },
      { name: 'fbclid', cookie: 'my_fbclid' },
      { name: 'msclkid', cookie: '_sid_msclkid' },
      { name: 'ttclid', cookie: '_sid_ttclid' },
      { name: 'li_fat_id', cookie: 'li_click' },
      { name: 'ScCid', cookie: '_sid_ScCid' }
    ]);
    // A switched-off parameter's cookie is still cleaned up.
    expect(settings.cookies).toContain('_sid_dclid');
    expect(settings).toMatchObject({ maxAgeDays: 30, domain: 'example.com', httpOnly: true, hosts: ['shop.example.com'] });
  });

  it.each([
    ['an unknown setting', { cookies: [] }],
    ['params that isn\'t a list', { params: { name: 'gclid' } }],
    ['a params entry that isn\'t an object', { params: ['li_fat_id'] }],
    ['an unknown key in a params entry', { params: [{ name: 'x', format: 'vendor' }] }],
    ['a missing parameter name', { params: [{ cookie: 'x' }] }],
    ['a parameter name with =', { params: [{ name: 'a=b' }] }],
    ['a parameter name starting with a digit', { params: [{ name: '1x' }] }],
    ['a parameter name over 64 characters', { params: [{ name: 'a'.repeat(65) }] }],
    ['a parameter listed twice', { params: [{ name: 'x' }, { name: 'x' }] }],
    ['an invalid cookie name', { params: [{ name: 'x', cookie: 'a;b' }] }],
    ['a parameter whose default cookie is reflect\'s keeper', { params: [{ name: 'keep' }] }],
    ['a parameter whose default cookie name is too long', { params: [{ name: 'a'.repeat(60) }] }],
    ['enabled as a string', { params: [{ name: 'gclid', enabled: 'no' }] }],
    ['two parameters with one cookie', { params: [{ name: 'x', cookie: '_sid_gclid' }] }],
    ['more than 20 parameters', { params: Array.from({ length: 14 }, (_, i) => ({ name: `p${String(i)}` })) }],
    ['a lifetime of 0', { maxAgeDays: 0 }],
    ['a lifetime over 400 days', { maxAgeDays: 401 }],
    ['a fractional lifetime', { maxAgeDays: 1.5 }],
    ['a lifetime as a string', { maxAgeDays: '90' }],
    ['a domain with a leading dot', { domain: '.example.com' }],
    ['a single-label domain', { domain: 'localhost' }],
    ['httpOnly as a string', { httpOnly: 'true' }],
    ['hosts that isn\'t a list', { hosts: 'www.example.com' }],
    ['a host with a scheme', { hosts: ['https://www.example.com'] }],
    ['a host in upper case', { hosts: ['WWW.example.com'] }],
    ['more than 20 hosts', { hosts: Array.from({ length: 21 }, (_, i) => `h${String(i)}.example.com`) }]
  ])('rejects %s', (_, config) => {
    expect(() => clickIdModuleConfig(config)).toThrow(TypeError);
  });

  it.each(RESERVED_COOKIE_NAMES)('refuses the reserved cookie name %s', name => {
    expect(() => clickIdModuleConfig({ params: [{ name: 'x', cookie: name }] })).toThrow(TypeError);
  });

  it('reserves the names reflect reserves, and reflect\'s keeper', () => {
    expect(RESERVED_COOKIE_NAMES).toEqual([...REFLECT_RESERVED, DEFAULT_KEEPER_COOKIE]);
  });

  it('keeps configured values out of error messages', () => {
    expect(() => clickIdModuleConfig({ params: [{ name: 'secret-param', cookie: 'secret;cookie' }] })).toThrow(/^clickid: [^;]*$/);
    try {
      clickIdModuleConfig({ hosts: ['SECRET.example.com'] });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });

  it('makes the module an error, setting nothing, on invalid settings', async () => {
    const response = await handler({ maxAgeDays: 0 })(request({ path: v1(`https://www.example.com/?gclid=${GCLID}`) }));
    const body = await response.json() as PayloadV1;
    expect(body.ext.modules['clickid']?.status).toBe('error');
    expect(clickCookies(response)).toEqual([]);
  });
});

describe('the landing URL', () => {
  const site = new URL('https://www.example.com/_sid/v1');

  it('comes from the url parameter, else the Referer', () => {
    const fromParam = new URL(`https://www.example.com/_sid/v1?url=${encodeURIComponent('https://www.example.com/a?gclid=1')}`);
    const withReferer = new Request(fromParam, { headers: { Referer: 'https://www.example.com/b?gclid=2' } });
    expect(landingUrl(withReferer, fromParam, [])?.href).toBe('https://www.example.com/a?gclid=1');
    expect(landingUrl(withReferer, site, [])?.href).toBe('https://www.example.com/b?gclid=2');
    expect(landingUrl(new Request(site), site, [])).toBeUndefined();
  });

  it('must be on the request\'s own host, or a configured one', () => {
    const from = (referer: string, hosts: readonly string[] = []): string | undefined =>
      landingUrl(new Request(site, { headers: { Referer: referer } }), site, hosts)?.hostname;
    expect(from('https://WWW.Example.com/?gclid=1')).toBe('www.example.com');
    expect(from('https://evil.example/?gclid=1')).toBeUndefined();
    expect(from('https://example.com/?gclid=1')).toBeUndefined();
    expect(from('https://www.example.com.evil.example/?gclid=1')).toBeUndefined();
    expect(from('https://shop.example.com/?gclid=1')).toBeUndefined();
    expect(from('https://shop.example.com/?gclid=1', ['shop.example.com'])).toBe('shop.example.com');
    expect(from('ftp://www.example.com/?gclid=1')).toBeUndefined();
    expect(from('javascript:alert(1)')).toBeUndefined();
    expect(from('not a url')).toBeUndefined();
  });
});

describe('click IDs in the URL', () => {
  const id = (query: string): string | undefined => clickIdFrom(new URL(`https://www.example.com/${query}`), 'gclid');

  it('reads the value after one round of URL decoding', () => {
    expect(id(`?gclid=${GCLID}`)).toBe(GCLID);
    expect(id('?gclid=abc%2Ddef')).toBe('abc-def');
    expect(id('?utm_source=x&gclid=abc#frag')).toBe('abc');
  });

  it('ignores a value that is still encoded, or has characters outside the pattern, rather than fixing it', () => {
    expect(id('?gclid=abc%252Fdef')).toBeUndefined();
    expect(id('?gclid=abc%2Fdef')).toBeUndefined();
    expect(id('?gclid=abc+def')).toBeUndefined();
    expect(id('?gclid=abc%20def')).toBeUndefined();
    expect(id('?gclid=%3Cscript%3E')).toBeUndefined();
    expect(id('?gclid=caf%C3%A9')).toBeUndefined();
    expect(id('?gclid=%E0%A4%A')).toBeUndefined();
    expect(id('?gclid=')).toBeUndefined();
    expect(id('?gclid')).toBeUndefined();
  });

  it('takes up to 512 characters', () => {
    expect(id(`?gclid=${'a'.repeat(512)}`)).toBe('a'.repeat(512));
    expect(id(`?gclid=${'a'.repeat(513)}`)).toBeUndefined();
  });

  it('uses the first of repeated parameters, even when it isn\'t valid', () => {
    expect(id('?gclid=first&gclid=second')).toBe('first');
    expect(id('?gclid=bad%20one&gclid=second')).toBeUndefined();
  });

  it('matches parameter names case-sensitively', () => {
    expect(id('?GCLID=abc')).toBeUndefined();
  });

  it('reads the ID from a stored value', () => {
    expect(storedClickId(`${String(NOW_SECONDS)}.${GCLID}`)).toBe(GCLID);
    expect(storedClickId('abc')).toBeUndefined();
    expect(storedClickId(undefined)).toBeUndefined();
  });
});

describe('storing click IDs', () => {
  it('sets the cookie from the url parameter, with the click time and the 90-day lifetime', async () => {
    const response = await handler()(request({ path: v1(`https://www.example.com/landing?gclid=${GCLID}&fbclid=IwAR0_x-y`) }));
    expect(clickCookies(response)).toEqual([
      `_sid_gclid=${String(NOW_SECONDS)}.${GCLID}; Max-Age=${String(NINETY_DAYS)}; Expires=Wed, 01 Apr 2026 00:00:00 GMT; Path=/; SameSite=Lax; Secure`,
      `_sid_fbclid=${String(NOW_SECONDS)}.IwAR0_x-y; Max-Age=${String(NINETY_DAYS)}; Expires=Wed, 01 Apr 2026 00:00:00 GMT; Path=/; SameSite=Lax; Secure`
    ]);
  });

  it('reports empty and adds nothing to the payload: no eids, no ortb2, no ext.clickid', async () => {
    const response = await handler()(request({ path: v1(`https://www.example.com/?gclid=${GCLID}`) }));
    const body = await response.json() as PayloadV1;
    expect(body.ext.modules['clickid']?.status).toBe('empty');
    expect(body.eids).toEqual([{ source: 'pubcid.org', uids: [{ id: ID, atype: 1 }] }]);
    expect(body).not.toHaveProperty('ortb2');
    expect(JSON.stringify(body)).not.toContain(GCLID);
    expect(Object.keys(body.ext)).toEqual(['modules']);
  });

  it('sets the cookie from the Referer', async () => {
    const response = await handler()(request({ referer: `https://www.example.com/landing?msclkid=${GCLID}` }));
    expect(pairs(response)).toEqual([`_sid_msclkid=${String(NOW_SECONDS)}.${GCLID}`]);
  });

  it('prefers the url parameter to the Referer', async () => {
    const response = await handler()(request({ path: v1('https://www.example.com/?gclid=fromparam'), referer: 'https://www.example.com/?gclid=fromreferer' }));
    expect(clickCookies(response)[0]).toContain(`_sid_gclid=${String(NOW_SECONDS)}.fromparam;`);
  });

  it('ignores URLs on other hosts', async () => {
    const response = await handler()(request({ path: v1('https://evil.example/?gclid=abc'), referer: 'https://other.example/?gclid=def' }));
    expect(clickCookies(response)).toEqual([]);
  });

  it('reads URLs on configured hosts', async () => {
    const response = await handler({ hosts: ['shop.example.com'] })(request({ referer: 'https://shop.example.com/?gclid=abc' }));
    expect(clickCookies(response)[0]).toContain('_sid_gclid=');
  });

  it('stores percent-encoded values decoded once, and ignores double-encoded ones', async () => {
    const once = await handler()(request({ path: v1('https://www.example.com/?gclid=abc%2Ddef') }));
    expect(clickCookies(once)[0]).toContain(`_sid_gclid=${String(NOW_SECONDS)}.abc-def;`);
    const twice = await handler()(request({ path: v1('https://www.example.com/?gclid=abc%252Fdef') }));
    expect(clickCookies(twice)).toEqual([]);
  });

  it('stores the first of repeated parameters', async () => {
    const response = await handler()(request({ path: v1('https://www.example.com/?gclid=first&gclid=second') }));
    expect(pairs(response)).toEqual([`_sid_gclid=${String(NOW_SECONDS)}.first`]);
  });

  it('ignores invalid and over-long values, and still stores valid ones', async () => {
    const response = await handler()(request({ path: v1(`https://www.example.com/?gclid=${'a'.repeat(513)}&fbclid=a%3Bb&ttclid=ok`) }));
    expect(pairs(response)).toEqual([`_sid_ttclid=${String(NOW_SECONDS)}.ok`]);
  });

  it('replaces an older click with a newer one of the same parameter', async () => {
    const response = await handler()(request({ path: v1('https://www.example.com/?gclid=newer'), cookie: `_pubcid=${ID}; _sid_gclid=1760000000.older` }));
    expect(pairs(response)).toEqual([`_sid_gclid=${String(NOW_SECONDS)}.newer`]);
    expect(clickCookies(response)[0]).toContain(`; Max-Age=${String(NINETY_DAYS)};`);
  });

  it('doesn\'t refresh a click it already has, nor touch it on later visits without one', async () => {
    const stored = `_pubcid=${ID}; _sid_gclid=1760000000.same`;
    const again = await handler()(request({ path: v1('https://www.example.com/?gclid=same'), cookie: stored }));
    expect(clickCookies(again)).toEqual([]);
    const later = await handler()(request({ path: v1('https://www.example.com/other-page'), cookie: stored }));
    expect(clickCookies(later)).toEqual([]);
  });

  it('applies maxAgeDays, domain and httpOnly', async () => {
    const response = await handler({ maxAgeDays: 30, domain: 'example.com', httpOnly: true })(request({ path: v1('https://www.example.com/?gclid=abc') }));
    expect(clickCookies(response)).toEqual([`_sid_gclid=${String(NOW_SECONDS)}.abc; Max-Age=2592000; Expires=Sat, 31 Jan 2026 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly`]);
  });

  it('uses SID_COOKIE_DOMAIN, unless domain is host-only', async () => {
    const env = { SID_COOKIE_DOMAIN: '.example.com' };
    const shared = await handler({}, env)(request({ path: v1('https://www.example.com/?gclid=abc') }));
    expect(clickCookies(shared)[0]).toContain('; Domain=.example.com;');
    const hostOnly = await handler({ domain: 'host-only' }, env)(request({ path: v1('https://www.example.com/?gclid=abc') }));
    expect(clickCookies(hostOnly)[0]).not.toContain('Domain=');
  });

  it('stores custom parameters, under renamed cookies, and skips switched-off ones', async () => {
    const config = { params: [{ name: 'li_fat_id', cookie: 'li_click' }, { name: 'gclid', cookie: 'my_gclid' }, { name: 'fbclid', enabled: false }] };
    const response = await handler(config)(request({ path: v1('https://www.example.com/?li_fat_id=abc-123&gclid=g1&fbclid=f1') }));
    expect(pairs(response)).toEqual([`my_gclid=${String(NOW_SECONDS)}.g1`, `li_click=${String(NOW_SECONDS)}.abc-123`]);
  });
});

describe('consent', () => {
  const landing = v1(`https://www.example.com/?gclid=${GCLID}`);
  const stored = `_sid_gclid=1760000000.old; _sid_fbclid=1760000000.old2; _sid_ttclid=x`;
  const deletions = [
    '_sid_gclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure',
    '_sid_fbclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure',
    '_sid_ttclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure'
  ];

  it.each<[string, Call]>([
    ['the opt-out cookie', { path: landing, cookie: `_pubcid_optout=1; ${stored}` }],
    ['Global Privacy Control', { path: landing, cookie: stored, headers: { 'Sec-GPC': '1' } }],
    ['COPPA', { path: `${landing}&coppa=1`, cookie: stored }],
    ['a us_privacy opt-out of sale', { path: `${landing}&us_privacy=1YYN`, cookie: stored }],
    ['a us_privacy opt-out of sale in lower case', { path: `${landing}&us_privacy=1nyn`, cookie: stored }],
    ['the usprivacy cookie opting out of sale', { path: landing, cookie: `usprivacy=1YYN; ${stored}` }],
    ['GDPR without a TC string', { path: `${landing}&gdpr=1`, cookie: stored }],
    ['a TC string without Purpose 7', { path: `${landing}&gdpr=1&gdpr_consent=${TC_PUBLISHER_1_2}`, cookie: stored }],
    ['a TC string without Purpose 7, whatever gdpr says', { path: `${landing}&gdpr_consent=${TC_PUBLISHER_1_2}`, cookie: stored }],
    ['an invalid TC string', { path: `${landing}&gdpr=1&gdpr_consent=nonsense`, cookie: stored }],
    ['the EU, by location, without a TC string', { path: landing, cookie: stored, headers: { 'X-EU': '1' } }]
  ])('stores nothing and deletes existing click IDs with %s', async (_, call) => {
    const eu = call.headers?.['X-EU'] === '1';
    const response = await handler()(request(call), eu ? { isEU: true } : {});
    expect(clickCookies(response)).toEqual(deletions);
  });

  it('deletes with the configured Domain and HttpOnly, switched-off parameters included', async () => {
    const config = { domain: 'example.com', httpOnly: true, params: [{ name: 'gclid', enabled: false }] };
    const response = await handler(config)(request({ path: landing, cookie: '_sid_gclid=1760000000.old', headers: { 'Sec-GPC': '1' } }));
    expect(clickCookies(response)).toEqual(['_sid_gclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly']);
  });

  it('sets nothing when denied and the browser has no click IDs', async () => {
    const response = await handler()(request({ path: landing, cookie: 'other=1', headers: { 'Sec-GPC': '1' } }));
    expect(clickCookies(response)).toEqual([]);
  });

  it.each([
    ['publisher consent for Purposes 1 and 7', `&gdpr=1&gdpr_consent=${TC_PUBLISHER_1_7}`],
    ['GDPR not applying', '&gdpr=0'],
    ['us_privacy without an opt-out of sale', '&us_privacy=1YNN'],
    ['us_privacy not applying', '&us_privacy=1---']
  ])('stores with %s', async (_, query) => {
    const response = await handler()(request({ path: `${landing}${query}` }));
    expect(pairs(response)).toEqual([`_sid_gclid=${String(NOW_SECONDS)}.${GCLID}`]);
  });

  it('deletes click IDs on /optout, with the configured attributes, whether or not clickid is in SID_MODULES', async () => {
    const optout = createHandler({ config: resolveConfig({ SID_MODULE_CONFIG: JSON.stringify({ clickid: { domain: 'example.com', params: [{ name: 'li_fat_id' }] } }) }), modules: [clickIdModule] });
    const response = await optout(request({ path: '/_sid/optout', cookie: `_pubcid=${ID}; _sid_gclid=1.a; _sid_li_fat_id=1.b; other=1` }));
    expect(response.status).toBe(204);
    expect(clickCookies(response)).toEqual([
      '_sid_gclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure',
      '_sid_li_fat_id=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure'
    ]);
  });
});

describe('on /sync', () => {
  const sync = `/_sid/sync?id=pubcid%253A${ID}`;

  it('stores click IDs from the Referer, Prebid.js\'s landing page, and keeps the sync out of the browser cache', async () => {
    const response = await handler()(request({ path: sync, referer: `https://www.example.com/landing?gclid=${GCLID}` }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-SharedID-Modules')).toBe('clickid=empty');
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(43);
    expect(pairs(response)).toEqual([`_sid_gclid=${String(NOW_SECONDS)}.${GCLID}`]);
    expect(clickCookies(response)[0]).toContain(`; Max-Age=${String(NINETY_DAYS)};`);
  });

  it('keeps every sync out of the browser cache, with or without a click', async () => {
    const response = await handler()(request({ path: sync, referer: 'https://www.example.com/article' }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(clickCookies(response)).toEqual([]);
  });

  it('leaves the sync cacheable when clickid doesn\'t run there (SID_SYNC_MODULES=none)', async () => {
    const response = await handler({}, { SID_SYNC_MODULES: 'none' })(request({ path: sync, referer: `https://www.example.com/?gclid=${GCLID}` }));
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(clickCookies(response)).toEqual([]);
  });

  it('deletes click IDs on a denied sync', async () => {
    const response = await handler()(request({ path: sync, referer: `https://www.example.com/?gclid=${GCLID}`, cookie: 'usprivacy=1YYN; _sid_gclid=1.old' }));
    expect(clickCookies(response)).toEqual(['_sid_gclid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure']);
  });

  it('declares v1 and sync', () => {
    expect(clickIdModule.routes).toEqual(['v1', 'sync']);
    expect(clickIdModule.purposes).toBeUndefined();
  });
});
