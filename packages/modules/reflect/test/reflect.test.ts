import { createHandler, readConsent, resolveConfig, type ModuleContext, type ModuleCookie, type PayloadV1, type SharedIdEdgeHandler, type StorageDecision } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { cookieTimestamp, decodeKeeper, encodeKeeper, isReflectable, MAX_KEEPER_COOKIE_BYTES, rawCookieValue, reflectModule, reflectModuleConfig, RESERVED_COOKIE_NAMES } from '../src/index.js';

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
        { name: 'uid1', maxAgeDays: 365, domain: 'example.com', httpOnly: false, deleteOnOptOut: false, restore: false, prefer: 'browser', format: undefined },
        { name: 'x', maxAgeDays: 1, domain: undefined, httpOnly: false, deleteOnOptOut: false, restore: false, prefer: 'browser', format: undefined }
      ],
      keeper: { mode: 'master', suffix: '_backup', cookie: '_sid_keep', maxAgeDays: 400, domain: undefined, backupDomain: undefined, backedUp: ['uid1', 'x'] }
    });
    expect(reflectModuleConfig({ cookies: [FPID] }).cookies[0]).toEqual({ ...FPID, domain: undefined, restore: false, prefer: 'browser', format: undefined });
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
    ['deleteOnOptOut as a number', { cookies: [{ ...UID1, deleteOnOptOut: 1 }] }],
    ['restore as a string', { cookies: [{ ...UID1, restore: 'yes' }] }],
    ['a keeper that isn\'t an object', { cookies: [UID1], keeper: '_sid_keep' }],
    ['an unknown key in keeper', { cookies: [UID1], keeper: { name: 'k' } }],
    ['an invalid keeper name', { cookies: [UID1], keeper: { cookie: 'a;b' } }],
    ['a reserved keeper name', { cookies: [UID1], keeper: { cookie: '_pubcid_sv' } }],
    ['a keeper name that\'s also a configured cookie', { cookies: [UID1], keeper: { cookie: 'uid1' } }],
    ['a configured cookie with the default keeper name', { cookies: [{ name: '_sid_keep', maxAgeDays: 1 }] }],
    ['a keeper lifetime over 400 days', { cookies: [UID1], keeper: { maxAgeDays: 730 } }],
    ['a keeper domain with a leading dot', { cookies: [UID1], keeper: { domain: '.example.com' } }],
    ['an unknown prefer', { cookies: [{ ...UID1, restore: true, prefer: 'newer' }] }],
    ['prefer with the wrong case', { cookies: [{ ...UID1, restore: true, prefer: 'Backup' }] }],
    ['prefer as a boolean', { cookies: [{ ...UID1, restore: true, prefer: true }] }],
    ['prefer backup without restore', { cookies: [{ ...UID1, prefer: 'backup' }] }],
    ['prefer older without restore', { cookies: [{ name: '_ga', maxAgeDays: 1, prefer: 'older' }] }],
    ['prefer older on a cookie without a known format', { cookies: [{ ...UID1, restore: true, prefer: 'older' }] }],
    ['prefer older on a name that only looks like _ga', { cookies: [{ name: '_ga_ABC123', maxAgeDays: 1, restore: true, prefer: 'older' }] }],
    ['an unknown format', { cookies: [{ ...UID1, restore: true, prefer: 'older', format: 'uuid' }] }],
    ['format without prefer older', { cookies: [{ name: '_ga', maxAgeDays: 1, restore: true, format: 'ga' }] }],
    ['format with prefer backup', { cookies: [{ name: '_ga', maxAgeDays: 1, restore: true, prefer: 'backup', format: 'ga' }] }]
  ])('rejects %s', (_, config) => {
    expect(() => reflectModuleConfig(config)).toThrow(TypeError);
  });

  it('reads the keeper with defaults, its domain falling back to the first restore cookie\'s', () => {
    const restoring = [
      { name: 'a', maxAgeDays: 1, restore: true },
      { name: 'b', maxAgeDays: 1, domain: 'b.example', restore: true },
      { name: 'c', maxAgeDays: 1, domain: 'c.example', restore: true }
    ];
    expect(reflectModuleConfig({ cookies: restoring }).keeper).toEqual({ mode: 'master', suffix: '_backup', cookie: '_sid_keep', maxAgeDays: 400, domain: undefined, backupDomain: undefined, backedUp: ['a', 'b', 'c'] });
    expect(reflectModuleConfig({ cookies: restoring.slice(1) }).keeper).toEqual({ mode: 'master', suffix: '_backup', cookie: '_sid_keep', maxAgeDays: 400, domain: 'b.example', backupDomain: undefined, backedUp: ['b', 'c'] });
    expect(reflectModuleConfig({ cookies: [UID1, ...restoring.slice(2)] }).keeper.domain).toBe('c.example');
    expect(reflectModuleConfig({ cookies: restoring, keeper: { cookie: 'k', maxAgeDays: 30, domain: 'example.com' } }).keeper)
      .toEqual({ mode: 'master', suffix: '_backup', cookie: 'k', maxAgeDays: 30, domain: 'example.com', backupDomain: 'example.com', backedUp: ['a', 'b', 'c'] });
    expect(reflectModuleConfig({ cookies: [UID1], keeper: {} }).keeper.cookie).toBe('_sid_keep');
  });

  it('reads prefer, with the format from the cookie name or from format', () => {
    const entry = (extra: Record<string, unknown>): Record<string, unknown> => ({ maxAgeDays: 1, restore: true, ...extra });
    const read = (extra: Record<string, unknown>): unknown => {
      const cookie = reflectModuleConfig({ cookies: [entry(extra)] }).cookies[0];
      return { prefer: cookie?.prefer, format: cookie?.format };
    };
    expect(read({ name: 'uid1' })).toEqual({ prefer: 'browser', format: undefined });
    expect(read({ name: 'uid1', prefer: 'browser' })).toEqual({ prefer: 'browser', format: undefined });
    expect(read({ name: 'uid1', prefer: 'backup' })).toEqual({ prefer: 'backup', format: undefined });
    expect(read({ name: '_ga', prefer: 'older' })).toEqual({ prefer: 'older', format: 'ga' });
    expect(read({ name: '_gcl_au', prefer: 'older' })).toEqual({ prefer: 'older', format: 'gcl_au' });
    expect(read({ name: '_gcl_aw', prefer: 'older' })).toEqual({ prefer: 'older', format: 'gcl_aw' });
    // gtag's cookie_prefix renames the cookies; format says which format they have
    expect(read({ name: 'site_ga', prefer: 'older', format: 'ga' })).toEqual({ prefer: 'older', format: 'ga' });
    expect(read({ name: '_ga', prefer: 'older', format: 'gcl_au' })).toEqual({ prefer: 'older', format: 'gcl_au' });
    // prefer browser is allowed without restore: it's the default either way
    expect(reflectModuleConfig({ cookies: [{ ...UID1, prefer: 'browser' }] }).cookies[0]?.prefer).toBe('browser');
  });

  it('keeps configured values out of error messages', () => {
    for (const config of [{ cookies: [{ ...UID1, restore: true, prefer: 'secret-1' }] }, { cookies: [{ ...UID1, restore: true, prefer: 'older', format: 'secret-2' }] }]) {
      expect(() => reflectModuleConfig(config)).toThrow(TypeError);
      expect(() => reflectModuleConfig(config)).not.toThrow(/secret|uid1/);
    }
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
    // only HTTP whitespace is trimmed: a non-breaking space stays, so the value is rejected rather than changed
    expect(rawCookieValue(' \t uid1=abc \t; other=x', 'uid1')).toBe('abc');
    expect(rawCookieValue('uid1=\u00a0abc; other=x', 'uid1')).toBe('\u00a0abc');
    expect(isReflectable('\u00a0abc')).toBe(false);
    // stays fast on a long run of whitespace in a hostile Cookie header
    const started = Date.now();
    expect(rawCookieValue(`uid1=${' '.repeat(100_000)}x${' \t'.repeat(50_000)}`, 'uid1')).toBe('x');
    expect(Date.now() - started).toBeLessThan(500);
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

describe('creation times', () => {
  const NOW = 1_800_000_000;

  it.each([
    ['ga', 'GA1.1.1234567890.1700000000', 1_700_000_000],
    ['ga', 'GA1.2.1234567890.1700000000', 1_700_000_000],
    ['ga', 'GA1.3.987654321.1600000000', 1_600_000_000],
    ['ga', 'GA1.1.1.1000000000', 1_000_000_000],
    ['gcl_au', '1.1.987654321.1700000000', 1_700_000_000],
    ['gcl_au', '1.2.1234567890.1750000000', 1_750_000_000],
    ['gcl_aw', 'GCL.1700000000.Cj0KCQiA-abc_DEF', 1_700_000_000],
    ['gcl_aw', 'GCL.1700000000.EAIaIQobChMI', 1_700_000_000],
    // up to a day after the worker's clock, for clock skew
    ['ga', `GA1.1.123.${String(NOW + 86_400)}`, NOW + 86_400]
  ] as const)('reads %s %s', (format, value, seconds) => {
    expect(cookieTimestamp(format, value, NOW)).toBe(seconds);
  });

  it.each([
    ['ga', ''],
    ['ga', 'GA1.1.1234567890'],
    ['ga', 'GA1.1.1234567890.'],
    ['ga', 'GA1.1..1700000000'],
    ['ga', 'GA1..1234567890.1700000000'],
    ['ga', 'GA1.0.1234567890.1700000000'],
    ['ga', 'GA1.100.1234567890.1700000000'],
    ['ga', 'GA1.2-2.1234567890.1700000000'],
    ['ga', 'GA2.1.1234567890.1700000000'],
    ['ga', 'ga1.1.1234567890.1700000000'],
    ['ga', 'GA1.1.1234567890.1700000000.1'],
    ['ga', 'GA1.1.12345abc.1700000000'],
    ['ga', 'GA1.1.1234567890.-1700000000'],
    ['ga', 'GA1.1.1234567890.170000000'],
    ['ga', 'GA1.1.1234567890.17000000000'],
    ['ga', 'GA1.1.1234567890.1700000000 '],
    ['ga', ' GA1.1.1234567890.1700000000'],
    ['ga', 'GA1.1.1234567890.1.7e9'],
    ['ga', `GA1.1.${'1'.repeat(21)}.1700000000`],
    // far future: later than a day after the worker's clock
    ['ga', `GA1.1.123.${String(NOW + 86_401)}`],
    ['ga', 'GA1.1.1234567890.9999999999'],
    ['ga', '1.1.987654321.1700000000'],
    ['gcl_au', 'GA1.1.987654321.1700000000'],
    ['gcl_au', '1.1.987654321'],
    ['gcl_au', '2.1.987654321.1700000000'],
    ['gcl_au', '1.1.987654321.-1'],
    ['gcl_au', '1.1.987654321.9999999999'],
    ['gcl_aw', 'GCL.1700000000'],
    ['gcl_aw', 'GCL.1700000000.'],
    ['gcl_aw', 'GCL..Cj0KCQiA'],
    ['gcl_aw', 'GCL.-170000000.Cj0KCQiA'],
    ['gcl_aw', 'GCL.170000000.Cj0KCQiA'],
    ['gcl_aw', 'GCL.9999999999.Cj0KCQiA'],
    ['gcl_aw', 'GCL.1700000000.Cj0.KCQiA'],
    ['gcl_aw', 'gcl.1700000000.Cj0KCQiA'],
    ['gcl_aw', 'GA1.1.1234567890.1700000000']
  ] as const)('doesn\'t parse %s %j', (format, value) => {
    expect(cookieTimestamp(format, value, NOW)).toBeUndefined();
  });

  it('never throws, whatever the value', () => {
    for (const value of ['\u0000', '\uD800', 'GA1.1.1.'.repeat(1000), '%E2%9C%93', '"GA1.1.1.1700000000"']) {
      for (const format of ['ga', 'gcl_au', 'gcl_aw'] as const) expect(cookieTimestamp(format, value, NOW)).toBeUndefined();
    }
  });
});

const b64url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (value: string): unknown => JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));

describe('the keeper value', () => {
  it('is base64url of a JSON object, in the order given, without padding', () => {
    const value = encodeKeeper([['_ga', 'GA1.1.123.456'], ['_gcl_au', '1.1.789.1700000000']], 4096);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(value).toBe(b64url('{"_ga":"GA1.1.123.456","_gcl_au":"1.1.789.1700000000"}'));
    expect(fromB64url(value)).toEqual({ _ga: 'GA1.1.123.456', _gcl_au: '1.1.789.1700000000' });
    expect(encodeKeeper([], 4096)).toBe('');
  });

  it('round-trips values whose base64 has + and /', () => {
    const entries: [string, string][] = [['a', '>>>???~~~'], ['b', 'x+y/z==%2F']];
    const value = encodeKeeper(entries, 4096);
    expect(value).toMatch(/[-_]/);
    expect([...decodeKeeper(value)]).toEqual(entries);
  });

  it('skips entries that don\'t fit, in order, keeping later ones that do', () => {
    const big = 'b'.repeat(1000);
    const value = encodeKeeper([['a', 'x'], ['b', big], ['c', big], ['d', big], ['e', 'y']], 3000);
    expect(value.length).toBeLessThanOrEqual(3000);
    expect(fromB64url(value)).toEqual({ a: 'x', b: big, c: big, e: 'y' });
    expect(encodeKeeper([['a', 'x']], 5)).toBe('');
  });

  it.each([
    ['nothing', undefined],
    ['an empty value', ''],
    ['characters outside base64url', 'eyJh+IjoiYiJ9'],
    ['padding', btoa('{"a":"bc"}')],
    ['a value over the size limit', 'A'.repeat(MAX_KEEPER_COOKIE_BYTES + 4)],
    ['an invalid base64 length', 'abcde'],
    ['not JSON', b64url('not json')],
    ['a JSON array', b64url('["a","b"]')],
    ['a JSON string', b64url('"a"')],
    ['JSON null', b64url('null')]
  ])('decodes %s as empty, without throwing', (_, raw) => {
    expect(decodeKeeper(raw).size).toBe(0);
  });

  it('drops entries that aren\'t reflectable strings', () => {
    const raw = b64url(JSON.stringify({ a: 'ok', b: 1, c: '', d: 'a b', e: 'x'.repeat(1025), f: { g: 'h' } }));
    expect([...decodeKeeper(raw)]).toEqual([['a', 'ok']]);
  });
});

describe('run', () => {
  const context = (cookie: string, storage: StorageDecision, config: Readonly<Record<string, unknown>> = { cookies: [UID1] }, cookieDomain?: string): ModuleContext => {
    const request = new Request('https://www.example.com/_sid/v1', { headers: { Cookie: cookie } });
    const url = new URL(request.url);
    return {
      request, url, platform: {}, sharedId: undefined, consent: readConsent(url, request.headers, new Map(), {}),
      cookies: new Map(), optedOut: false, cookieDomain, storage, config, secrets: {}
    };
  };

describe('duplicates (a host-only copy next to the domain one)', () => {
    const ALLOWED = { allowed: true } as const;
    const hostOnlyDeletion = (name: string, httpOnly = false): ModuleCookie => ({ name, value: '', maxAgeSeconds: 0, httpOnly, hostOnly: true });

    it('with the same value twice, reflects it on its domain and deletes the host-only copy', async () => {
      expect(await reflectModule.run(context('uid1=abc; uid1=abc', ALLOWED))).toEqual({
        cookies: [{ name: 'uid1', value: 'abc', maxAgeSeconds: 31_536_000, httpOnly: false, domain: '.example.com' }, hostOnlyDeletion('uid1')]
      });
    });

    it('with different values, reflects the first and deletes neither (the other may be its owner\'s newer write)', async () => {
      expect(await reflectModule.run(context('uid1=old; uid1=new', ALLOWED))).toEqual({
        cookies: [{ name: 'uid1', value: 'old', maxAgeSeconds: 31_536_000, httpOnly: false, domain: '.example.com' }]
      });
    });

    it('uses SID_COOKIE_DOMAIN for a cookie without its own domain', async () => {
      const config = { cookies: [{ name: 'uid1', maxAgeDays: 365 }] };
      expect(await reflectModule.run(context('uid1=abc; uid1=abc', ALLOWED, config, 'example.com'))).toEqual({
        cookies: [{ name: 'uid1', value: 'abc', maxAgeSeconds: 31_536_000, httpOnly: false }, hostOnlyDeletion('uid1')]
      });
    });

    it('deletes nothing when the copy it sets is host-only', async () => {
      const hostOnly = { cookies: [{ name: 'uid1', maxAgeDays: 365, domain: 'host-only' }] };
      expect((await reflectModule.run(context('uid1=abc; uid1=abc', ALLOWED, hostOnly, 'example.com')))?.cookies).toEqual([
        { name: 'uid1', value: 'abc', maxAgeSeconds: 31_536_000, httpOnly: false, hostOnly: true }
      ]);
      const noDomain = { cookies: [{ name: 'uid1', maxAgeDays: 365 }] };
      expect((await reflectModule.run(context('uid1=abc; uid1=abc', ALLOWED, noDomain)))?.cookies).toHaveLength(1);
    });

    it('leaves a single cookie alone, and keeps HttpOnly on the deletion of an HttpOnly cookie', async () => {
      expect((await reflectModule.run(context('uid1=only', ALLOWED)))?.cookies).toHaveLength(1);
      const config = { cookies: [{ ...FPID, domain: 'example.com' }] };
      expect((await reflectModule.run(context('fpid=a; fpid=a', ALLOWED, config)))?.cookies?.[1]).toEqual(hostOnlyDeletion('fpid', true));
    });

    it('deletes a duplicated keeper\'s host-only copy too, whatever the values (the keeper is the worker\'s own)', async () => {
      const config = { cookies: [{ ...UID1, restore: true }] };
      const keeper = encodeKeeper([['uid1', 'old']], 4000);
      const cookies = (await reflectModule.run(context(`uid1=old; _sid_keep=${keeper}; _sid_keep=${keeper}`, ALLOWED, config)))?.cookies ?? [];
      expect(cookies.map(c => [c.name, c.value === '' ? 'deleted' : 'set', c.hostOnly === true ? 'host-only' : (c.domain ?? 'default')])).toEqual([
        ['uid1', 'set', '.example.com'],
        ['_sid_keep', 'set', '.example.com'],
        ['_sid_keep', 'deleted', 'host-only']
      ]);
    });
  });

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
  // A fixed SharedID: a random one can contain abc or def, which some tests check the payload leaves out.
  const handler = (overrides: Record<string, string> = {}): SharedIdEdgeHandler => createHandler({ config: resolveConfig({ ...env, ...overrides }), modules: [reflectModule], mintId: () => '11111111-2222-4333-8444-555555555555' });
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

  it('uses SID_COOKIE_DOMAIN for cookies without a domain, and omits Secure over http in local development', async () => {
    const response = await handler({ SID_COOKIE_DOMAIN: '.example.com' })(new Request('http://localhost/_sid/v1', { headers: { Cookie: 'fpid=def' } }));
    expect(response.headers.getSetCookie().find(c => c.startsWith('fpid='))).toMatch(/^fpid=def; Max-Age=2592000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; HttpOnly$/);
  });

  it('keeps a cookie set to "domain": "host-only" host-only, even with SID_COOKIE_DOMAIN', async () => {
    const reflectConfig = { reflect: { cookies: [{ name: 'uid1', maxAgeDays: 30, domain: 'host-only' }, FPID] } };
    const response = await createHandler({
      config: resolveConfig({ SID_MODULES: 'reflect', SID_COOKIE_DOMAIN: 'example.com', SID_MODULE_CONFIG: JSON.stringify(reflectConfig) }),
      modules: [reflectModule]
    })(new Request('https://www.example.com/_sid/v1', { headers: { Cookie: 'uid1=abc; fpid=def' } }));
    const cookies = response.headers.getSetCookie();
    expect(cookies.find(c => c.startsWith('uid1='))).not.toMatch(/Domain=/);
    expect(cookies.find(c => c.startsWith('fpid='))).toMatch(/; Domain=example\.com;/);
  });

  it('reflects only configured cookies the request carries, with reflectable values', async () => {
    expect((await call('/_sid/v1', { Cookie: 'other=1; uid1=; fpid=x' })).cookies.map(c => c.split(';')[0])).toEqual(['fpid=x']);
    expect((await call('/_sid/v1', { Cookie: 'uid1="abc"; fpid=a b' })).cookies).toEqual([]);
    expect((await call('/_sid/v1', { Cookie: `uid1=${'a'.repeat(1025)}; fpid=ok` })).cookies.map(c => c.split(';')[0])).toEqual(['fpid=ok']);
    // a leading non-breaking space is part of the value, not whitespace: skipped, never reflected as "abc"
    expect((await call('/_sid/v1', { Cookie: 'uid1= abc; fpid=ok' })).cookies.map(c => c.split(';')[0])).toEqual(['fpid=ok']);
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

  it('runs on /sync too: Prebid.js\'s pixel call reflects with the same attributes, and the pixel stays a cached GIF', async () => {
    const sync = await handler()(new Request('https://www.example.com/_sid/sync?id=pubcid%253Ac29cb2ae-769d-42f6-891a-f53cadee823d', { headers: { Cookie: 'uid1=AbC%2Fx+y/z==; fpid=f' } }));
    const v1 = await call('/_sid/v1', { Cookie: 'uid1=AbC%2Fx+y/z==; fpid=f' });
    const strip = (c: string): string => c.replace(/; Expires=[^;]+/, '');
    expect(sync.headers.getSetCookie().filter(c => !c.startsWith('_pubcid')).map(strip)).toEqual(v1.cookies.map(strip));
    expect(sync.headers.getSetCookie().find(c => c.startsWith('uid1='))).toMatch(/^uid1=AbC%2Fx\+y\/z==; Max-Age=31536000; /);
    expect(sync.headers.get('Content-Type')).toBe('image/gif');
    expect(sync.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(sync.headers.get('X-SharedID-Modules')).toBe('reflect=empty');
    expect((await sync.arrayBuffer()).byteLength).toBe(43);
  });

  it('doesn\'t run on /sync with SID_SYNC_MODULES=none', async () => {
    const response = await handler({ SID_SYNC_MODULES: 'none' })(new Request('https://www.example.com/_sid/sync', { headers: { Cookie: 'uid1=abc' } }));
    expect(response.headers.getSetCookie().some(c => c.startsWith('uid1='))).toBe(false);
    expect(response.headers.has('X-SharedID-Modules')).toBe(false);
  });

  it('reports an error on /sync for invalid settings, and sets nothing', async () => {
    const response = await handler({ SID_MODULE_CONFIG: '{"reflect":{"cookies":[]}}' })(new Request('https://www.example.com/_sid/sync', { headers: { Cookie: 'uid1=abc' } }));
    expect(response.headers.get('X-SharedID-Modules')).toBe('reflect=error');
    expect(response.headers.getSetCookie().filter(c => !c.startsWith('_pubcid'))).toEqual([]);
  });
});

describe('the keeper in the handler', () => {
  const GA = { name: '_ga', maxAgeDays: 400, domain: 'example.com', restore: true };
  const GCL_AW = { name: '_gcl_aw', maxAgeDays: 90, domain: 'example.com', restore: true };
  const GCL_AU = { name: '_gcl_au', maxAgeDays: 90, domain: 'example.com', restore: true };
  const config = { reflect: { cookies: [GA, GCL_AW, GCL_AU, UID1] } };
  const handler = (moduleConfig: unknown = config, extra: Record<string, string> = {}): SharedIdEdgeHandler =>
    createHandler({ config: resolveConfig({ SID_MODULES: 'reflect', SID_MODULE_CONFIG: JSON.stringify(moduleConfig), ...extra }), modules: [reflectModule] });
  const call = async (path: string, headers: Record<string, string> = {}, moduleConfig?: unknown, extra?: Record<string, string>): Promise<{ cookies: string[]; body: PayloadV1 }> => {
    const response = await handler(moduleConfig, extra)(new Request(`https://www.example.com${path}`, { headers }));
    return { cookies: response.headers.getSetCookie().filter(c => !c.startsWith('_pubcid')), body: await response.json() as PayloadV1 };
  };
  const pairs = (cookies: string[]): (string | undefined)[] => cookies.map(c => c.split(';')[0]);
  const keeperOf = (cookies: string[], name = '_sid_keep'): string | undefined => cookies.find(c => c.startsWith(`${name}=`));
  const savedIn = (cookies: string[]): unknown => fromB64url(keeperOf(cookies)?.split(';')[0]?.slice('_sid_keep='.length) ?? '');
  const saved = (values: Record<string, string>): string => b64url(JSON.stringify(values));
  const ga = 'GA1.1.1234567890.1700000000';
  const aw = 'GCL.1700000000.Cj0KCQiA-abc_DEF';
  const au = '1.1.987654321.1700000000';
  const DELETED_KEEPER = '_sid_keep=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly';

  it('saves present restore cookies in an HttpOnly keeper, in configured order, and refreshes them', async () => {
    const { cookies, body } = await call('/_sid/v1', { Cookie: `uid1=u; _gcl_au=${au}; _ga=${ga}` });
    expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, 'uid1=u', `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}`]);
    expect(keeperOf(cookies)).toMatch(/; Max-Age=34560000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
    expect(savedIn(cookies)).toEqual({ _ga: ga, _gcl_au: au });
    expect(body.ext.modules['reflect']?.status).toBe('empty');
    expect(JSON.stringify(body)).not.toMatch(/GA1|_ga|_sid_keep/);
  });

  it('restores missing cookies from the keeper with their configured attributes; present values win', async () => {
    const { cookies } = await call('/_sid/v1', { Cookie: `_sid_keep=${saved({ _ga: ga, _gcl_aw: aw, _gcl_au: au })}; _gcl_au=1.1.new.1` });
    expect(cookies.find(c => c.startsWith('_ga='))).toMatch(/^_ga=GA1\.1\.1234567890\.1700000000; Max-Age=34560000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
    expect(cookies.find(c => c.startsWith('_gcl_aw='))).toMatch(/^_gcl_aw=GCL\.1700000000\.Cj0KCQiA-abc_DEF; Max-Age=7776000; /);
    expect(cookies.find(c => c.startsWith('_gcl_au='))?.split(';')[0]).toBe('_gcl_au=1.1.new.1');
    expect(savedIn(cookies)).toEqual({ _ga: ga, _gcl_aw: aw, _gcl_au: '1.1.new.1' });
  });

  it('rewrites the keeper on every call, so its expiry is refreshed even when nothing changed', async () => {
    const keeper = saved({ _ga: ga });
    const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${ga}; _sid_keep=${keeper}` });
    expect(keeperOf(cookies)?.split(';')[0]).toBe(`_sid_keep=${keeper}`);
  });

  it('treats a malformed keeper as empty and overwrites it, or deletes it when there\'s nothing to keep', async () => {
    for (const bad of ['%%%', 'bm90IGpzb24', saved({ _ga: 'a b' }), '"quoted"']) {
      const withGa = await call('/_sid/v1', { Cookie: `_sid_keep=${bad}; _ga=${ga}` });
      expect(pairs(withGa.cookies)).toEqual([`_ga=${ga}`, `_sid_keep=${saved({ _ga: ga })}`]);
      const alone = await call('/_sid/v1', { Cookie: `_sid_keep=${bad}` });
      expect(alone.cookies).toEqual([DELETED_KEEPER]);
      expect(alone.body.ext.modules['reflect']?.status).toBe('empty');
    }
  });

  it('restores only restore cookies, and drops a saved value whose cookie is present but can\'t be copied', async () => {
    const { cookies } = await call('/_sid/v1', { Cookie: `_sid_keep=${saved({ uid1: 'x', other: 'y', _ga: ga, _gcl_au: au })}; _ga="quoted"` });
    expect(pairs(cookies)).toEqual([`_gcl_au=${au}`, `_sid_keep=${saved({ _gcl_au: au })}`]);
  });

  it('sets no keeper when nothing is configured to restore, and deletes a stale one', async () => {
    const plain = { reflect: { cookies: [UID1] } };
    expect(pairs((await call('/_sid/v1', { Cookie: 'uid1=u' }, plain)).cookies)).toEqual(['uid1=u']);
    const stale = await call('/_sid/v1', { Cookie: `uid1=u; _sid_keep=${saved({ uid1: 'old' })}` }, plain);
    expect(pairs(stale.cookies)).toEqual(['uid1=u', '_sid_keep=']);
  });

  it('uses the keeper settings: name, lifetime and domain', async () => {
    const custom = { reflect: { cookies: [{ name: 'fp', maxAgeDays: 30, restore: true }], keeper: { cookie: 'kp', maxAgeDays: 100, domain: 'example.org' } } };
    const { cookies } = await call('/_sid/v1', { Cookie: 'fp=1' }, custom);
    expect(keeperOf(cookies, 'kp')).toMatch(/^kp=[A-Za-z0-9_-]+; Max-Age=8640000; Expires=[^;]+; Path=\/; Domain=\.example\.org; SameSite=Lax; Secure; HttpOnly$/);
    expect(keeperOf(cookies, 'kp')?.split(';')[0]).toBe(`kp=${saved({ fp: '1' })}`);
    // a host-only restore cookie and no keeper domain: the keeper is host-only too
    const hostOnly = await call('/_sid/v1', { Cookie: 'fp=1' }, { reflect: { cookies: [{ name: 'fp', maxAgeDays: 30, restore: true }] } });
    expect(keeperOf(hostOnly.cookies)).toMatch(/; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
  });

  it('keeps the keeper within 4096 bytes, skipping cookies that don\'t fit in configured order', async () => {
    const names = ['k1', 'k2', 'k3', 'k4'];
    const big = { reflect: { cookies: names.map(name => ({ name, maxAgeDays: 1, restore: true })) } };
    const value = (n: string): string => n.repeat(500);
    const { cookies } = await call('/_sid/v1', { Cookie: names.map(n => `${n}=${value(n)}`).join('; ') }, big);
    expect(cookies.filter(c => /^k\d=/.test(c))).toHaveLength(4);
    expect((keeperOf(cookies)?.split(';')[0] ?? '').length).toBeLessThanOrEqual(MAX_KEEPER_COOKIE_BYTES + 1);
    expect(savedIn(cookies)).toEqual({ k1: value('k1'), k2: value('k2'), k3: value('k3') });
  });

  it.each([
    ['opt-out', '/_sid/v1', { Cookie: `_pubcid_optout=1; _ga=${ga}; _sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }],
    ['GPC', '/_sid/v1', { 'Sec-GPC': '1', Cookie: `_ga=${ga}; _sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }],
    ['COPPA', '/_sid/v1?coppa=1', { Cookie: `_ga=${ga}; _sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }],
    ['GDPR without a TC string', '/_sid/v1?gdpr=1', { Cookie: `_ga=${ga}; _sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }],
    ['a TC string without publisher consent', `/_sid/v1?gdpr=1&gdpr_consent=${TC_NO_PUBLISHER_SEGMENT}`, { Cookie: `_ga=${ga}; _sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }]
  ])('on %s, deletes the keeper but neither restores, reflects nor deletes the originals', async (_, path, headers) => {
    const { cookies, body } = await call(path, headers);
    expect(cookies).toEqual([DELETED_KEEPER]);
    expect(body.ext.modules['reflect']?.status).toBe('empty');
  });

  it('sets nothing when storage is denied and the browser has no keeper', async () => {
    expect((await call('/_sid/v1', { 'Sec-GPC': '1', Cookie: `_ga=${ga}` })).cookies).toEqual([]);
  });

  it('deletes the keeper on /optout, without deleteOnOptOut, even when reflect isn\'t in SID_MODULES', async () => {
    for (const extra of [{}, { SID_MODULES: '' }]) {
      const response = await handler(config, extra)(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: `_ga=${ga}; _sid_keep=${saved({ _ga: ga })}` } }));
      const cookies = response.headers.getSetCookie();
      expect(cookies.filter(c => c.startsWith('_ga='))).toEqual([]);
      expect(keeperOf(cookies)).toBe(DELETED_KEEPER);
    }
    // the default name is deleted even with no restore cookies configured
    const plain = await handler({ reflect: { cookies: [UID1] } })(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: '_sid_keep=x' } }));
    expect(plain.headers.getSetCookie().some(c => c.startsWith('_sid_keep=; Max-Age=0'))).toBe(true);
    const notSent = await handler()(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: `_ga=${ga}` } }));
    expect(notSent.headers.getSetCookie().some(c => c.startsWith('_sid_keep='))).toBe(false);
  });

  it('reports an error when the keeper uses one of the worker\'s configured cookie names', async () => {
    const { body, cookies } = await call('/_sid/v1', { Cookie: `_ga=${ga}` }, { reflect: { cookies: [GA], keeper: { cookie: 'myid' } } }, { SID_COOKIE_NAME: 'myid' });
    expect(body.ext.modules['reflect']?.status).toBe('error');
    // only the worker's own ID cookie, renamed to myid
    expect(cookies.filter(c => !c.startsWith('myid='))).toEqual([]);
  });

  const sync = async (headers: Record<string, string>, moduleConfig?: unknown): Promise<string[]> => {
    const response = await handler(moduleConfig)(new Request('https://www.example.com/_sid/sync', { headers }));
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    return response.headers.getSetCookie().filter(c => !c.startsWith('_pubcid'));
  };

  it('saves and restores on /sync, as on /v1', async () => {
    const saving = await sync({ Cookie: `_gcl_au=${au}; _ga=${ga}` });
    expect(pairs(saving)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}`]);
    const restoring = await sync({ Cookie: `_sid_keep=${saved({ _ga: ga, _gcl_aw: aw })}` });
    expect(pairs(restoring)).toEqual([`_ga=${ga}`, `_gcl_aw=${aw}`, `_sid_keep=${saved({ _ga: ga, _gcl_aw: aw })}`]);
    expect(restoring.find(c => c.startsWith('_ga='))).toMatch(/; Max-Age=34560000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
  });

  it('on /sync with storage denied, deletes the keeper only', async () => {
    for (const headers of [{ 'Sec-GPC': '1' }, { Cookie: '_pubcid_optout=1' }]) {
      const cookie = `_ga=${ga}; _sid_keep=${saved({ _ga: ga })}`;
      const cookies = await sync({ ...headers, Cookie: 'Cookie' in headers ? `${headers.Cookie}; ${cookie}` : cookie });
      expect(cookies).toEqual([DELETED_KEEPER]);
    }
  });

  describe('prefer', () => {
    const newGa = 'GA1.1.555555555.1750000000';
    const newAu = '1.1.444444444.1750000000';
    const newAw = 'GCL.1750000000.EAIaIQobChMI';
    // uid1 has no format with a creation time, so it keeps the default with older
    const withPrefer = (prefer: string): unknown => ({
      reflect: { cookies: [...[GA, GCL_AW, GCL_AU].map(c => ({ ...c, prefer })), { ...UID1, restore: true, ...(prefer === 'older' ? {} : { prefer }) }] }
    });

    it('browser (the default): a present value wins and replaces the saved one', async () => {
      for (const moduleConfig of [config, withPrefer('browser')]) {
        const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${newGa}; _sid_keep=${saved({ _ga: ga })}` }, moduleConfig);
        expect(pairs(cookies)).toEqual([`_ga=${newGa}`, `_sid_keep=${saved({ _ga: newGa })}`]);
      }
    });

    it('backup: the saved value is restored over the present one, byte for byte, with the configured attributes, and kept', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `uid1=new; _ga=${newGa}; _gcl_au=${au}; _sid_keep=${saved({ _ga: ga, uid1: 'o+l/d%3D=' })}` }, withPrefer('backup'));
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, 'uid1=o+l/d%3D=', `_sid_keep=${saved({ _ga: ga, _gcl_au: au, uid1: 'o+l/d%3D=' })}`]);
      expect(cookies.find(c => c.startsWith('_ga='))).toMatch(/^_ga=GA1\.1\.1234567890\.1700000000; Max-Age=34560000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
      expect(cookies.find(c => c.startsWith('uid1='))).toMatch(/^uid1=o\+l\/d%3D=; Max-Age=31536000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
    });

    it('backup: restores over a present value that can\'t be reflected', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga="quoted"; _sid_keep=${saved({ _ga: ga })}` }, withPrefer('backup'));
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_sid_keep=${saved({ _ga: ga })}`]);
    });

    it('backup: with nothing saved, the present value is reflected and saved', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${newGa}` }, withPrefer('backup'));
      expect(pairs(cookies)).toEqual([`_ga=${newGa}`, `_sid_keep=${saved({ _ga: newGa })}`]);
    });

    it('older: a re-minted (newer) value is replaced by the older saved one, for each format', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${newGa}; _gcl_aw=${newAw}; _gcl_au=${newAu}; _sid_keep=${saved({ _ga: ga, _gcl_aw: aw, _gcl_au: au })}` }, withPrefer('older'));
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_aw=${aw}`, `_gcl_au=${au}`, `_sid_keep=${saved({ _ga: ga, _gcl_aw: aw, _gcl_au: au })}`]);
      expect(cookies.find(c => c.startsWith('_gcl_au='))).toMatch(/^_gcl_au=1\.1\.987654321\.1700000000; Max-Age=7776000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure$/);
    });

    it('older: an older present value wins and replaces the saved one', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${ga}; _gcl_au=${au}; _sid_keep=${saved({ _ga: newGa, _gcl_au: newAu })}` }, withPrefer('older'));
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}`]);
    });

    it('older: on equal times the browser\'s value wins', async () => {
      const sameTime = 'GA1.1.999999999.1700000000';
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${sameTime}; _sid_keep=${saved({ _ga: ga })}` }, withPrefer('older'));
      expect(pairs(cookies)).toEqual([`_ga=${sameTime}`, `_sid_keep=${saved({ _ga: sameTime })}`]);
    });

    it.each([
      ['a present value that doesn\'t parse', 'GA1.1.custom-id', ga],
      ['a present value with a far-future time', 'GA1.1.555555555.9999999999', ga],
      ['a saved value that doesn\'t parse', newGa, 'GA1.1.custom-id'],
      ['a saved value with a far-future time', newGa, 'GA1.1.123.9999999999'],
      ['a saved value in another format', newGa, au]
    ])('older: falls back to the browser\'s value with %s', async (_, present, kept) => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${present}; _sid_keep=${saved({ _ga: kept })}` }, withPrefer('older'));
      expect(pairs(cookies)).toEqual([`_ga=${present}`, `_sid_keep=${saved({ _ga: present })}`]);
    });

    it('older: a missing cookie is restored, as in every mode', async () => {
      for (const prefer of ['browser', 'backup', 'older']) {
        const { cookies } = await call('/_sid/v1', { Cookie: `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }, { reflect: { cookies: [{ ...GA, prefer }, { ...GCL_AU, prefer }] } });
        expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}`]);
      }
    });

    it('older: uses format for a renamed cookie', async () => {
      const renamed = { reflect: { cookies: [{ name: 'site_ga', maxAgeDays: 400, restore: true, prefer: 'older', format: 'ga' }] } };
      const { cookies } = await call('/_sid/v1', { Cookie: `site_ga=${newGa}; _sid_keep=${saved({ site_ga: ga })}` }, renamed);
      expect(pairs(cookies)).toEqual([`site_ga=${ga}`, `_sid_keep=${saved({ site_ga: ga })}`]);
    });

    it('a restored backup that no longer fits the keeper is still restored, and later cookies are still saved', async () => {
      const big = (c: string): string => c.repeat(1020);
      const sized = { reflect: { cookies: [
        { name: 'k1', maxAgeDays: 1, restore: true },
        { name: 'k2', maxAgeDays: 1, restore: true },
        { name: 'k3', maxAgeDays: 1, restore: true, prefer: 'backup' },
        { name: 'k4', maxAgeDays: 1, restore: true }
      ] } };
      // k1 and k2 grew since the keeper was written; k3's saved value wins but no longer fits
      const keeper = saved({ k1: 'a', k2: 'b', k3: big('c') });
      const { cookies } = await call('/_sid/v1', { Cookie: `k1=${big('a')}; k2=${big('b')}; k3=new; k4=d; _sid_keep=${keeper}` }, sized);
      expect(pairs(cookies).slice(0, 4)).toEqual([`k1=${big('a')}`, `k2=${big('b')}`, `k3=${big('c')}`, 'k4=d']);
      expect((keeperOf(cookies)?.split(';')[0] ?? '').length).toBeLessThanOrEqual(MAX_KEEPER_COOKIE_BYTES + 1);
      expect(savedIn(cookies)).toEqual({ k1: big('a'), k2: big('b'), k4: 'd' });
    });

    it.each([
      ['backup', 'GPC', '/_sid/v1', { 'Sec-GPC': '1' }, ''],
      ['older', 'GPC', '/_sid/v1', { 'Sec-GPC': '1' }, ''],
      ['backup', 'opt-out', '/_sid/v1', {}, '_pubcid_optout=1; '],
      ['older', 'a TC string without publisher consent', `/_sid/v1?gdpr=1&gdpr_consent=${TC_NO_PUBLISHER_SEGMENT}`, {}, '']
    ])('%s: on %s, restores nothing and deletes the keeper', async (prefer, _, path, headers, extraCookie) => {
      const { cookies } = await call(path, { ...headers, Cookie: `${extraCookie}_ga=${newGa}; _sid_keep=${saved({ _ga: ga })}` }, withPrefer(prefer));
      expect(cookies).toEqual([DELETED_KEEPER]);
    });
  });

  describe('per-cookie backups (keeper.mode: "per-cookie")', () => {
    const perCookie = { reflect: { cookies: [GA, GCL_AU, UID1], keeper: { mode: 'per-cookie' } } };
    const backupOf = (cookies: string[], name: string): string | undefined => cookies.find(c => c.startsWith(`${name}=`));

    it('backs each restore cookie up in its own HttpOnly <name>_backup, value as is, and sets no master keeper', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `uid1=u; _gcl_au=${au}; _ga=${ga}` }, perCookie);
      // Backups follow the cookies, as the master keeper does.
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, 'uid1=u', `_ga_backup=${ga}`, `_gcl_au_backup=${au}`]);
      expect(backupOf(cookies, '_ga_backup')).toMatch(/; Max-Age=34560000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
      expect(keeperOf(cookies)).toBeUndefined();
    });

    it('restores a missing cookie from its backup; a present value wins', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga_backup=${ga}; _gcl_au_backup=${au}; _gcl_au=1.1.new.1` }, perCookie);
      expect(backupOf(cookies, '_ga')).toMatch(/^_ga=GA1\.1\.1234567890\.1700000000; Max-Age=34560000; /);
      expect(pairs(cookies)).toContain('_gcl_au=1.1.new.1');
      expect(pairs(cookies)).toContain('_gcl_au_backup=1.1.new.1');
    });

    it('migrates from a master keeper: restores from it, writes backups, and deletes it', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_sid_keep=${saved({ _ga: ga, _gcl_au: au })}` }, perCookie);
      expect(pairs(cookies)).toEqual([`_ga=${ga}`, `_gcl_au=${au}`, `_ga_backup=${ga}`, `_gcl_au_backup=${au}`, '_sid_keep=']);
      expect(keeperOf(cookies)).toBe(DELETED_KEEPER);
    });

    it('migrates back: master mode reads per-cookie backups, saves them in the keeper, and deletes them', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga_backup=${ga}; _gcl_au_backup=${au}` }, { reflect: { cookies: [GA, GCL_AU] } });
      expect(savedIn(cookies)).toEqual({ _ga: ga, _gcl_au: au });
      expect(backupOf(cookies, '_ga_backup')).toMatch(/^_ga_backup=; Max-Age=0; /);
      expect(backupOf(cookies, '_gcl_au_backup')).toMatch(/^_gcl_au_backup=; Max-Age=0; /);
    });

    it('deletes the backups, and leaves the cookies, when storage is denied (GPC)', async () => {
      const { cookies } = await call('/_sid/v1', { Cookie: `_ga=${ga}; _ga_backup=${ga}`, 'Sec-GPC': '1' }, perCookie);
      expect(pairs(cookies)).toEqual(['_ga_backup=']);
    });

    it('deletes both forms on opt-out', async () => {
      const response = await handler(perCookie)(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: `_ga_backup=${ga}; _sid_keep=x` } }));
      const names = response.headers.getSetCookie().map(c => c.split('=')[0]);
      expect(names).toEqual(expect.arrayContaining(['_ga_backup', '_sid_keep']));
    });

    it('uses a custom suffix, and refuses suffixes that collide or are invalid', () => {
      expect(reflectModuleConfig({ cookies: [GA], keeper: { mode: 'per-cookie', suffix: '_k' } }).keeper.suffix).toBe('_k');
      expect(() => reflectModuleConfig({ cookies: [GA, { name: '_ga_backup', maxAgeDays: 1 }], keeper: { mode: 'per-cookie' } })).toThrow('is already a cookie; choose another "keeper.suffix"');
      expect(() => reflectModuleConfig({ cookies: [GA], keeper: { mode: 'per-cookie', suffix: 'a;b' } })).toThrow(/keeper.suffix/);
      expect(() => reflectModuleConfig({ cookies: [GA], keeper: { mode: 'both' } })).toThrow(TypeError);
    });

    it("switching to master keeps a backup whose value doesn't fit in the keeper, and refreshes it", async () => {
      const big = (c: string): string => c.repeat(1024);
      const three = ['_a', '_b', '_c'].map(name => ({ name, maxAgeDays: 30, domain: 'example.com', restore: true }));
      const { cookies } = await call('/_sid/v1', { Cookie: `_a_backup=${big('a')}; _b_backup=${big('b')}; _c_backup=${big('c')}` }, { reflect: { cookies: three } });
      // The keeper's 4096 bytes fit two of the three 1024-character values; the third stays in its backup.
      const inKeeper = Object.keys(savedIn(cookies) as Record<string, string>);
      expect(inKeeper).toHaveLength(2);
      const left = ['_a', '_b', '_c'].find(name => !inKeeper.includes(name)) ?? '';
      expect(backupOf(cookies, `${left}_backup`)).toMatch(new RegExp(`^${left}_backup=${left.slice(1).repeat(1024)}; Max-Age=34560000; `));
      for (const name of inKeeper) expect(backupOf(cookies, `${name}_backup`)).toMatch(new RegExp(`^${name}_backup=; Max-Age=0; `));
    });

    it('cleans up a backup left over after restore was turned off: on denied storage and on opt-out', async () => {
      const noRestore = { reflect: { cookies: [{ ...GA, restore: false }], keeper: { mode: 'per-cookie' } } };
      const denied = await call('/_sid/v1', { Cookie: `_ga=${ga}; _ga_backup=${ga}`, 'Sec-GPC': '1' }, noRestore);
      expect(pairs(denied.cookies)).toEqual(['_ga_backup=']);
      // Allowed, with nothing to restore: the backup is deleted too, and _ga is just reflected.
      const allowed = await call('/_sid/v1', { Cookie: `_ga=${ga}; _ga_backup=${ga}` }, noRestore);
      expect(pairs(allowed.cookies)).toEqual([`_ga=${ga}`, '_ga_backup=']);
      const optout = await handler(noRestore)(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: `_ga_backup=${ga}` } }));
      expect(optout.headers.getSetCookie().map(c => c.split('=')[0])).toContain('_ga_backup');
    });

    it('names no configured cookie in its errors', () => {
      for (const config of [
        { cookies: [{ ...GA, name: 'secret_cookie_name_that_is_rather_long_for_a_backup_name_x' }], keeper: { mode: 'per-cookie' } },
        { cookies: [GA, { name: '_ga_backup', maxAgeDays: 1 }] }
      ]) {
        expect(() => reflectModuleConfig(config)).toThrow(TypeError);
        try { reflectModuleConfig(config); } catch (error) { expect(String(error)).not.toMatch(/secret_cookie|_ga_backup/); }
      }
    });
  });
});
