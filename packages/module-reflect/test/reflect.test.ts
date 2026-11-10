import { createHandler, readConsent, resolveConfig, type ModuleContext, type PayloadV1, type SharedIdEdgeHandler, type StorageDecision } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { isReflectable, rawCookieValue, reflectModule, reflectModuleConfig, RESERVED_COOKIE_NAMES } from '../src/index.js';

// TC strings built with tcString() from packages/core/test/helpers.ts:
// publisherTc([1, 2]): a publisher TC segment consenting to Purposes 1 and 2, so publisher-mode storage is allowed.
const TC_PUBLISHER_1_2 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.eAAAAAAAAA';
// tcString([1, 2]): core-segment consent only, no publisher TC segment, so publisher-mode storage is denied.
const TC_NO_PUBLISHER_SEGMENT = 'CAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAA';

const UID1 = { name: 'uid1', maxAgeDays: 365, domain: 'example.com', httpOnly: false };
const FPID = { name: 'fpid', maxAgeDays: 30, httpOnly: true, deleteOnOptOut: true };

describe('settings', () => {
  it('reads cookies with defaults for the optional keys', () => {
    expect(reflectModuleConfig({ cookies: [UID1, { name: 'x', maxAgeDays: 1 }] })).toEqual({
      cookies: [
        { name: 'uid1', maxAgeDays: 365, domain: 'example.com', httpOnly: false, deleteOnOptOut: false },
        { name: 'x', maxAgeDays: 1, domain: undefined, httpOnly: false, deleteOnOptOut: false }
      ]
    });
    expect(reflectModuleConfig({ cookies: [FPID] }).cookies[0]).toEqual({ ...FPID, domain: undefined });
  });

  it.each([
    ['no settings', {}],
    ['an unknown setting', { cookies: [UID1], other: 1 }],
    ['cookies that isn\'t a list', { cookies: UID1 }],
    ['an empty list', { cookies: [] }],
    ['more than 10 cookies', { cookies: Array.from({ length: 11 }, (_, i) => ({ name: `c${String(i)}`, maxAgeDays: 1 })) }],
    ['an entry that isn\'t an object', { cookies: ['uid1'] }],
    ['an unknown key in an entry', { cookies: [{ ...UID1, path: '/' }] }],
    ['a missing name', { cookies: [{ maxAgeDays: 1 }] }],
    ['an invalid name', { cookies: [{ name: 'a b', maxAgeDays: 1 }] }],
    ['a name with =', { cookies: [{ name: 'a=b', maxAgeDays: 1 }] }],
    ['a name over 64 characters', { cookies: [{ name: 'a'.repeat(65), maxAgeDays: 1 }] }],
    ['a duplicate name', { cookies: [UID1, UID1] }],
    ['a missing lifetime', { cookies: [{ name: 'uid1' }] }],
    ['a lifetime of 0', { cookies: [{ name: 'uid1', maxAgeDays: 0 }] }],
    ['a lifetime over 400 days', { cookies: [{ name: 'uid1', maxAgeDays: 401 }] }],
    ['a fractional lifetime', { cookies: [{ name: 'uid1', maxAgeDays: 1.5 }] }],
    ['a lifetime as a string', { cookies: [{ name: 'uid1', maxAgeDays: '30' }] }],
    ['a domain with a leading dot', { cookies: [{ ...UID1, domain: '.example.com' }] }],
    ['a single-label domain', { cookies: [{ ...UID1, domain: 'localhost' }] }],
    ['a domain with a path', { cookies: [{ ...UID1, domain: 'example.com/x' }] }],
    ['httpOnly as a string', { cookies: [{ ...UID1, httpOnly: 'true' }] }],
    ['deleteOnOptOut as a number', { cookies: [{ ...UID1, deleteOnOptOut: 1 }] }]
  ])('rejects %s', (_, config) => {
    expect(() => reflectModuleConfig(config)).toThrow(TypeError);
  });

  it.each(RESERVED_COOKIE_NAMES)('refuses to reflect %s', name => {
    expect(() => reflectModuleConfig({ cookies: [{ name, maxAgeDays: 1 }] })).toThrow(TypeError);
  });

  it('reserves the SharedID cookies, ts-ec and the TC string cookie', () => {
    expect([...RESERVED_COOKIE_NAMES].sort()).toEqual(['_pubcid', '_pubcid_optout', '_pubcid_sv', 'euconsent-v2', 'ts-ec']);
  });
});

describe('reading values', () => {
  it('returns the raw value, the first when a name repeats', () => {
    expect(rawCookieValue('a=1; uid1=x=y%3D; uid1=second', 'uid1')).toBe('x=y%3D');
    expect(rawCookieValue('uid1="quoted"', 'uid1')).toBe('"quoted"');
    expect(rawCookieValue('xuid1=1', 'uid1')).toBeUndefined();
    expect(rawCookieValue(null, 'uid1')).toBeUndefined();
  });

  it('reflects only non-empty cookie-octet values up to 1024 characters', () => {
    expect(isReflectable('AbC+/z==')).toBe(true);
    expect(isReflectable('a'.repeat(1024))).toBe(true);
    expect(isReflectable('a'.repeat(1025))).toBe(false);
    expect(isReflectable('')).toBe(false);
    expect(isReflectable(undefined)).toBe(false);
    for (const bad of ['"q"', 'a b', 'a,b', 'a\\b', 'é']) expect(isReflectable(bad)).toBe(false);
  });
});

describe('run', () => {
  const context = (cookie: string, storage: StorageDecision, config: Readonly<Record<string, unknown>> = { cookies: [UID1] }): ModuleContext => {
    const request = new Request('https://www.example.com/_sid/v1', { headers: { Cookie: cookie } });
    const url = new URL(request.url);
    return {
      request, url, platform: {}, sharedId: undefined, consent: readConsent(url, request.headers, new Map(), {}),
      cookies: new Map(), optedOut: false, storage, config, secrets: {}
    };
  };

  it('follows the storage decision, without deleting', async () => {
    expect(await reflectModule.run(context('uid1=abc', { allowed: true }))).toEqual({ cookies: [{ name: 'uid1', value: 'abc', maxAgeSeconds: 31_536_000, httpOnly: false, domain: '.example.com' }] });
    for (const reason of ['opt-out', 'gpc', 'coppa', 'tcf: no publisher TC segment']) {
      expect(await reflectModule.run(context('uid1=abc', { allowed: false, reason }))).toBeUndefined();
    }
  });

  it('throws on invalid settings, whatever the storage decision', () => {
    expect(() => reflectModule.run(context('uid1=abc', { allowed: false, reason: 'gpc' }, {}))).toThrow(TypeError);
  });
});

describe('the reflect module in the handler', () => {
  const env = { SID_MODULES: 'reflect', SID_MODULE_CONFIG: JSON.stringify({ reflect: { cookies: [UID1, FPID] } }) };
  const handler = (overrides: Record<string, string> = {}): SharedIdEdgeHandler => createHandler({ config: resolveConfig({ ...env, ...overrides }), modules: [reflectModule] });
  const call = async (path: string, headers: Record<string, string> = {}, overrides: Record<string, string> = {}): Promise<{ body: PayloadV1; cookies: string[]; response: Response }> => {
    const response = await handler(overrides)(new Request(`https://www.example.com${path}`, { headers }));
    const cookies = response.headers.getSetCookie().filter(c => !c.startsWith('_pubcid'));
    return { body: await response.json() as PayloadV1, cookies, response };
  };

  it('does nothing unless listed in SID_MODULES', async () => {
    const response = await createHandler({ config: resolveConfig({ SID_MODULE_CONFIG: env.SID_MODULE_CONFIG }), modules: [reflectModule] })(new Request('https://www.example.com/_sid/v1', { headers: { Cookie: 'uid1=abc' } }));
    expect(response.headers.getSetCookie().some(c => c.startsWith('uid1='))).toBe(false);
  });

  it.each([
    'AbC%2Fx+y/z==.v1',
    'eyJ2IjoxLCJpZCI6IjEyMyJ9',
    'a=b=c',
    '%E2%9C%93%20ok',
    '0123-abcd_EF.~!#$&\'*^`|'
  ])('reflects %s byte for byte', async value => {
    const { cookies } = await call('/_sid/v1', { Cookie: `uid1=${value}` });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.startsWith(`uid1=${value}; `)).toBe(true);
  });

  it('sets the configured attributes, with Path, SameSite, Secure and Expires from the worker', async () => {
    const { cookies, body } = await call('/_sid/v1', { Cookie: 'uid1=abc; fpid=def' });
    expect(cookies[0]).toMatch(/^uid1=abc; Max-Age=31536000; Expires=[^;]+ GMT; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
    expect(cookies[1]).toMatch(/^fpid=def; Max-Age=2592000; Expires=[^;]+ GMT; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
    expect(body.ext.modules['reflect']).toEqual({ ms: expect.any(Number) as number, status: 'empty' });
    expect(body.ortb2).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/uid1|fpid|abc|def/);
  });

  it('uses SID_COOKIE_DOMAIN for cookies without a domain, and omits Secure over http', async () => {
    const response = await handler({ SID_COOKIE_DOMAIN: '.example.com' })(new Request('http://www.example.com/_sid/v1', { headers: { Cookie: 'fpid=def' } }));
    expect(response.headers.getSetCookie().find(c => c.startsWith('fpid='))).toMatch(/^fpid=def; Max-Age=2592000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; HttpOnly$/);
  });

  it('reflects only configured cookies the request carries, with reflectable values', async () => {
    expect((await call('/_sid/v1', { Cookie: 'other=1; uid1=; fpid=x' })).cookies.map(c => c.split(';')[0])).toEqual(['fpid=x']);
    expect((await call('/_sid/v1', { Cookie: 'uid1="abc"; fpid=a b' })).cookies).toEqual([]);
    expect((await call('/_sid/v1', { Cookie: `uid1=${'a'.repeat(1025)}; fpid=ok` })).cookies.map(c => c.split(';')[0])).toEqual(['fpid=ok']);
    expect((await call('/_sid/v1')).body.ext.modules['reflect']?.status).toBe('empty');
  });

  it('reflects with consent, including a TC string with publisher consent', async () => {
    expect((await call(`/_sid/v1?gdpr=1&gdpr_consent=${TC_PUBLISHER_1_2}`, { Cookie: 'uid1=abc' })).cookies).toHaveLength(1);
    expect((await call('/_sid/v1?gdpr=0', { Cookie: 'uid1=abc' })).cookies).toHaveLength(1);
  });

  it.each([
    ['opt-out', '/_sid/v1', { Cookie: '_pubcid_optout=1; uid1=abc; fpid=def' }],
    ['GPC', '/_sid/v1', { 'Sec-GPC': '1', Cookie: 'uid1=abc; fpid=def' }],
    ['COPPA', '/_sid/v1?coppa=1', { Cookie: 'uid1=abc; fpid=def' }],
    ['GDPR without a TC string', '/_sid/v1?gdpr=1', { Cookie: 'uid1=abc; fpid=def' }],
    ['an invalid TC string', '/_sid/v1?gdpr=1&gdpr_consent=nonsense', { Cookie: 'uid1=abc; fpid=def' }],
    ['a TC string without publisher consent', `/_sid/v1?gdpr=1&gdpr_consent=${TC_NO_PUBLISHER_SEGMENT}`, { Cookie: 'uid1=abc; fpid=def' }],
    ['a TC string in the CMP cookie without publisher consent', '/_sid/v1', { Cookie: `euconsent-v2=${TC_NO_PUBLISHER_SEGMENT}; uid1=abc; fpid=def` }]
  ])('neither reflects nor deletes on %s', async (_, path, headers) => {
    const { cookies, body, response } = await call(path, headers);
    expect(cookies).toEqual([]);
    expect(body.ext.modules['reflect']?.status).toBe('empty');
    expect(response.headers.get('X-SharedID-Status')).toMatch(/^denied: /);
  });

  it('neither reflects nor deletes in vendor mode without the vendor\'s consent', async () => {
    const { cookies } = await call(`/_sid/v1?gdpr=1&gdpr_consent=${TC_PUBLISHER_1_2}`, { Cookie: 'uid1=abc' }, { SID_VENDOR_ID: '755' });
    expect(cookies).toEqual([]);
  });

  it('deletes only deleteOnOptOut cookies on /optout, even when reflect isn\'t in SID_MODULES', async () => {
    for (const overrides of [{}, { SID_MODULES: '' }]) {
      const response = await handler(overrides)(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: 'uid1=abc; fpid=def' } }));
      const cookies = response.headers.getSetCookie();
      expect(cookies.filter(c => c.startsWith('uid1='))).toEqual([]);
      expect(cookies.find(c => c.startsWith('fpid='))).toBe('fpid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure; HttpOnly');
    }
    const notSent = await handler()(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: 'uid1=abc' } }));
    expect(notSent.headers.getSetCookie().some(c => c.startsWith('fpid='))).toBe(false);
  });

  it('reports an error, without details, for invalid settings or a cookie the worker reserves', async () => {
    for (const config of [{ reflect: { cookies: [{ name: 'uid1', maxAgeDays: 999 }] } }, { reflect: { cookies: [{ name: 'myid', maxAgeDays: 30 }] } }]) {
      const { body, cookies } = await call('/_sid/v1', { Cookie: 'uid1=abc; myid=xyz' }, { SID_MODULE_CONFIG: JSON.stringify(config), SID_COOKIE_NAME: 'myid' });
      expect(body.ext.modules['reflect']).toEqual({ ms: expect.any(Number) as number, status: 'error' });
      expect(cookies.filter(c => c.startsWith('uid1='))).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(/abc|999/);
    }
  });

  it('doesn\'t run on /sync', async () => {
    const response = await handler()(new Request('https://www.example.com/_sid/sync', { headers: { Cookie: 'uid1=abc' } }));
    expect(response.headers.getSetCookie().some(c => c.startsWith('uid1='))).toBe(false);
  });
});
