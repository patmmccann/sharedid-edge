import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  decodeTcf,
  deepMerge,
  EU_COUNTRY_CODES,
  handlerOrMisconfigured,
  headerValue,
  isHeaderName,
  idFromSyncParam,
  isValidId,
  locationWithEU,
  logRequestFailure,
  booleanFromEnv,
  parseCookies,
  parseHeaderMap,
  publicOriginFromEnv,
  readConsent,
  resolveConfig,
  serializeCookie,
  SETTINGS,
  splitHeaders,
  storageDecision,
  type SharedIdEdgeConfig,
  type StorageDecision, settingsFromEnv } from '../src/index.js';
import { publisherTc, tcString } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';

describe('idFromSyncParam', () => {
  it('reads the pubcid: prefix Prebid.js sends', () => {
    expect(idFromSyncParam(`pubcid:${UUID}`)).toBe(UUID);
  });
  it('decodes the extra percent-encoding Prebid.js adds', () => {
    expect(idFromSyncParam(`pubcid%3A${UUID}`)).toBe(UUID);
    expect(idFromSyncParam(`pubcid%253A${UUID}`)).toBe(UUID);
  });
  it('rejects values without the prefix, unsafe ids and bad encoding', () => {
    expect(idFromSyncParam(UUID)).toBeUndefined();
    expect(idFromSyncParam('pubcid:')).toBeUndefined();
    expect(idFromSyncParam('pubcid:a;b=c')).toBeUndefined();
    expect(idFromSyncParam('pubcid:%E0%A4%A')).toBeUndefined();
    expect(idFromSyncParam(null)).toBeUndefined();
  });
});

describe('isValidId', () => {
  it('accepts UUIDs and older PubCID formats', () => {
    expect(isValidId(UUID)).toBe(true);
    expect(isValidId('A1b2.C3_d4-e5')).toBe(true);
  });
  it('rejects empty, overlong and cookie-breaking values', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId('a'.repeat(129))).toBe(false);
    expect(isValidId('-leading')).toBe(false);
    expect(isValidId('a b')).toBe(false);
    expect(isValidId('a;b')).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses a Cookie header, keeping the first of repeated names', () => {
    const cookies = parseCookies(`a=1; _pubcid=${UUID}; b="2"; a=3; junk; =x`);
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('_pubcid')).toBe(UUID);
    expect(cookies.get('b')).toBe('2');
    expect(cookies.size).toBe(3);
  });
  it('handles a missing header', () => {
    expect(parseCookies(null).size).toBe(0);
  });
});

describe('booleanFromEnv', () => {
  it('uses the fallback for missing or blank values and recognizes true/false tokens', () => {
    expect(booleanFromEnv(undefined, true)).toBe(true);
    expect(booleanFromEnv('', true)).toBe(true);
    expect(booleanFromEnv(' false ', true)).toBe(false);
    expect(booleanFromEnv('OFF', true)).toBe(false);
    expect(booleanFromEnv('yes', false)).toBe(true);
    expect(booleanFromEnv('on', false)).toBe(true);
    expect(booleanFromEnv('unexpected', true)).toBe(true);
    expect(booleanFromEnv('unexpected', false)).toBe(false);
    expect(booleanFromEnv(' true ', false)).toBe(true);
  });
});

describe('serializeCookie', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('writes every attribute', () => {
    expect(serializeCookie('_pubcid', UUID, { maxAgeSeconds: 86_400, domain: '.example.com', secure: true, httpOnly: true, sameSite: 'Lax' }, now))
      .toBe(`_pubcid=${UUID}; Max-Age=86400; Expires=Fri, 02 Jan 2026 00:00:00 GMT; Path=/; Domain=.example.com; SameSite=Lax; Secure; HttpOnly`);
  });
  it('expires a cookie with Max-Age 0 and an Expires in the past', () => {
    expect(serializeCookie('_pubcid', '', { maxAgeSeconds: 0, domain: undefined, secure: false, httpOnly: false, sameSite: 'Lax' }, now))
      .toBe('_pubcid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax');
  });
});

describe('resolveConfig', () => {
  it('reads exactly the variables SETTINGS documents', () => {
    const read = new Set<string>();
    const env = new Proxy<Record<string, unknown>>({}, {
      get(_target, key) {
        if (typeof key === 'string') read.add(key);
        return undefined;
      }
    });
    // Adapters read their settings through settingsFromEnv: resolveConfig's, and SID_HOSTS.
    settingsFromEnv(env);
    expect([...read].sort()).toEqual(SETTINGS.map(setting => setting.name).sort());
    expect(new Set(SETTINGS.map(setting => setting.name)).size).toBe(SETTINGS.length);
  });
  it('uses the defaults for an empty environment', () => {
    const config = resolveConfig({});
    expect(config).toMatchObject({ basePath: '/_sid', cookieName: '_pubcid', maxAgeDays: 365, create: true, recoveryCookieName: '_pubcid_sv' });
  });
  it('reads every variable', () => {
    const config = resolveConfig({
      SID_BASE_PATH: '/id/',
      SID_COOKIE_NAME: 'sid',
      SID_COOKIE_DOMAIN: '.example.com',
      SID_MAX_AGE_DAYS: '400',
      SID_CREATE: 'false',
      SID_RECOVERY_COOKIE: 'none',
      SID_OPTOUT_COOKIE: 'sid_optout',
      SID_VENDOR_ID: '1234',
      SID_ALLOWED_ORIGINS: 'https://example.com, https://www.example.com',
      SID_SYNC_CACHE_SECONDS: '0',
      SID_MODULES: 'ip, geo',
      SID_SYNC_MODULES: 'geo',
      SID_MODULE_CONFIG: '{"ip":{"field":"ipv6"}}',
      SID_MODULE_SECRETS: '{"ec":{"passphrase":"p"}}',
      SID_MODULE_TIMEOUT_MS: '20',
      SID_SKIP_BOTS: 'Declared',
      SID_SKIP_BOTS_SCORE: '10'
    });
    expect(config).toEqual({
      basePath: '/id',
      cookieName: 'sid',
      cookieDomain: '.example.com',
      maxAgeDays: 400,
      create: false,
      recoveryCookieName: undefined,
      optOutCookieName: 'sid_optout',
      vendorId: 1234,
      allowedOrigins: ['https://example.com', 'https://www.example.com'],
      syncCacheSeconds: 0,
      modules: ['ip', 'geo'],
      syncModules: ['geo'],
      moduleConfig: { ip: { field: 'ipv6' } },
      moduleSecrets: { ec: { passphrase: 'p' } },
      moduleTimeoutMs: 20,
      skipBots: 'declared',
      skipBotsScore: 10
    } satisfies SharedIdEdgeConfig);
  });
  it('reads SID_SYNC_MODULES: omitted by default, none for an empty list, names from SID_MODULES', () => {
    expect(resolveConfig({ SID_MODULES: 'reflect' })).not.toHaveProperty('syncModules');
    expect(resolveConfig({ SID_MODULES: 'reflect', SID_SYNC_MODULES: '' })).not.toHaveProperty('syncModules');
    expect(resolveConfig({ SID_MODULES: 'reflect', SID_SYNC_MODULES: 'none' }).syncModules).toEqual([]);
    expect(resolveConfig({ SID_MODULES: 'ec, reflect', SID_SYNC_MODULES: 'reflect,ec' }).syncModules).toEqual(['reflect', 'ec']);
  });
  it.each([
    ['a name not in SID_MODULES', 'reflect', 'reflect,ec'],
    ['a name with SID_MODULES unset', '', 'reflect'],
    ['none with other names', 'reflect', 'none,reflect']
  ])('rejects SID_SYNC_MODULES with %s', (_, modules, sync) => {
    expect(() => resolveConfig({ SID_MODULES: modules, SID_SYNC_MODULES: sync })).toThrow(ConfigError);
  });
  it('never echoes SID_MODULE_SECRETS in errors', () => {
    expect(() => resolveConfig({ SID_MODULE_SECRETS: 'hunter2-not-json' })).toThrow(/^(?!.*hunter2)/);
  });
  it.each([
    ['SID_MAX_AGE_DAYS', '401'],
    ['SID_MAX_AGE_DAYS', 'soon'],
    ['SID_COOKIE_NAME', 'bad name'],
    ['SID_COOKIE_DOMAIN', 'https://example.com'],
    ['SID_BASE_PATH', 'sid'],
    ['SID_CREATE', 'perhaps'],
    ['SID_VENDOR_ID', '0'],
    ['SID_VENDOR_ID', 'abc'],
    ['SID_ALLOWED_ORIGINS', 'https://example.com/path'],
    ['SID_MODULE_CONFIG', '[1]'],
    ['SID_MODULE_SECRETS', '{"ec":{"passphrase":1}}'],
    ['SID_MODULE_SECRETS', 'not json'],
    ['SID_RECOVERY_COOKIE', '_pubcid'],
    ['SID_RECOVERY_COOKIE', '_pubcid_optout'],
    ['SID_SKIP_BOTS', 'yes'],
    ['SID_SKIP_BOTS', 'all'],
    ['SID_SKIP_BOTS_SCORE', '0'],
    ['SID_SKIP_BOTS_SCORE', '100'],
    ['SID_SKIP_BOTS_SCORE', 'low']
  ])('rejects %s=%s', (key, value) => {
    expect(() => resolveConfig({ [key]: value })).toThrow(ConfigError);
  });

  describe('SID_COOKIE_DOMAIN', () => {
    it('is required for a deployment (requireCookieDomain), naming the setting', () => {
      expect(() => resolveConfig({}, { requireCookieDomain: true })).toThrow(/SID_COOKIE_DOMAIN is required/);
      expect(() => resolveConfig({ SID_COOKIE_DOMAIN: '' }, { requireCookieDomain: true })).toThrow(ConfigError);
    });
    it('host-only gives cookies without a Domain', () => {
      expect(resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' }, { requireCookieDomain: true }).cookieDomain).toBeUndefined();
    });
    it('takes a registrable domain, with or without the leading dot', () => {
      expect(resolveConfig({ SID_COOKIE_DOMAIN: 'example.com' }, { requireCookieDomain: true }).cookieDomain).toBe('example.com');
      expect(resolveConfig({ SID_COOKIE_DOMAIN: '.example.com' }, { requireCookieDomain: true }).cookieDomain).toBe('.example.com');
    });
    it('stays optional for a programmatic configuration (host-only when unset)', () => {
      expect(resolveConfig({}).cookieDomain).toBeUndefined();
    });
  });
});

describe('decodeTcf', () => {
  it('reads the core purpose consents', () => {
    const decoded = decodeTcf(tcString([1, 2, 7, 10, 24]));
    expect([...(decoded?.purposeConsents ?? [])]).toEqual([1, 2, 7, 10, 24]);
    expect(decoded?.publisherPurposeConsents).toBeUndefined();
  });
  it('reads the publisher TC segment\'s purpose consents', () => {
    const decoded = decodeTcf(tcString([1, 2, 3], { publisher: [1, 4, 10] }));
    expect([...(decoded?.purposeConsents ?? [])]).toEqual([1, 2, 3]);
    expect([...(decoded?.publisherPurposeConsents ?? [])]).toEqual([1, 4, 10]);
  });
  it('skips other segments, such as disclosed vendors', () => {
    expect(decodeTcf(`${tcString([1])}.IFoEUQQgAIQwgIwQABAEAAAAOIAACAIAAAAQAIAgEAACEAAAAAgAQBAAAAAAAGBAAgAAAAAAAFAAECAAAgAAQARAEQAAAAAJAAIAAgAAAYQEAAAQmAgBC3ZAYzUw`)?.publisherPurposeConsents).toBeUndefined();
  });
  it('reads special feature opt-ins', () => {
    expect([...(decodeTcf(tcString([1], { specialFeatures: [1, 12] }))?.specialFeatureOptIns ?? [])]).toEqual([1, 12]);
    expect(decodeTcf(tcString([1]))?.specialFeatureOptIns.size).toBe(0);
  });
  it('reads legitimate interests in both segments', () => {
    const decoded = decodeTcf(tcString([1], { legitimateInterests: [2, 7], publisher: [1], publisherLegitimateInterests: [8, 10] }));
    expect([...(decoded?.purposeLegitimateInterests ?? [])]).toEqual([2, 7]);
    expect([...(decoded?.publisherPurposeLegitimateInterests ?? [])]).toEqual([8, 10]);
  });
  it('reads vendor consents in bit field and range encodings', () => {
    for (const vendorEncoding of ['bitfield', 'range'] as const) {
      const decoded = decodeTcf(tcString([1], { vendors: [3, 755, 756, 757, 1000], vendorEncoding }));
      expect([1, 2, 3, 4, 754, 755, 756, 757, 758, 999, 1000, 1001].filter(v => decoded?.vendorConsent(v) === true)).toEqual([3, 755, 756, 757, 1000]);
    }
    expect(decodeTcf(tcString([1]))?.vendorConsent(1)).toBe(false);
  });
  it('rejects truncated strings, so malformed CMP data fails closed', () => {
    const full = tcString([1, 2], { publisher: [1, 2], vendors: [755] });
    const [core = '', publisher = ''] = full.split('.');
    expect(decodeTcf(full)).toBeDefined();
    // cut inside the vendor consent bit field, the vendor legitimate interest section and the publisher restrictions
    for (let length = 30; length < core.length; length++) {
      expect(decodeTcf(`${core.slice(0, length)}.${publisher}`)).toBeUndefined();
    }
    expect(decodeTcf(`${core}.${publisher.slice(0, 8)}`)).toBeUndefined();
    // the example from review: consent bits, but no vendor section
    expect(decodeTcf('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.eAAAA')).toBeUndefined();
  });
  it('rejects a range-encoded vendor section with missing entries', () => {
    const full = tcString([1], { vendors: [3, 755, 756, 757], vendorEncoding: 'range' });
    expect(decodeTcf(full)?.vendorConsent(756)).toBe(true);
    expect(decodeTcf(full.slice(0, -8))).toBeUndefined();
  });
  it('rejects other versions, short strings and bad characters', () => {
    expect(decodeTcf(tcString([1], { version: 1 }))).toBeUndefined();
    expect(decodeTcf('CAAA')).toBeUndefined();
    expect(decodeTcf(`${tcString([1])}!`)).toBeUndefined();
    expect(decodeTcf(`${tcString([1])}.!`)).toBeUndefined();
    expect(decodeTcf('')).toBeUndefined();
  });
});

describe('storageDecision', () => {
  const consent = (query: string, opts: { cookie?: string; gpc?: boolean; isEU?: boolean } = {}): ReturnType<typeof readConsent> =>
    readConsent(
      new URL(`https://example.com/_sid/sync?${query}`),
      new Headers(opts.gpc === true ? { 'Sec-GPC': '1' } : {}),
      parseCookies(opts.cookie ?? null),
      opts.isEU === undefined ? {} : { isEU: opts.isEU }
    );
  const denied = (reason: string): StorageDecision => ({ allowed: false, reason });
  const publisherMode = { vendorId: undefined };
  const vendorMode = { vendorId: 755 };

  it('allows storage with no signals, or when GDPR doesn\'t apply and there is no TC string', () => {
    expect(storageDecision(publisherMode, consent(''))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent('gdpr=0'))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent('', { isEU: false }))).toEqual({ allowed: true });
  });
  it('denies storage with Global Privacy Control, whatever the TC string says', () => {
    expect(storageDecision(publisherMode, consent('', { gpc: true }))).toEqual(denied('gpc'));
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1, 2])}`, { gpc: true }))).toEqual(denied('gpc'));
  });
  it('accepts legitimate interest for purposes 2-10, but not for purpose 1', () => {
    const tc = (consents: readonly number[], li: readonly number[]): string => tcString([], { publisher: consents, publisherLegitimateInterests: li });
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tc([1], [2, 7])}`))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tc([1], [10])}`))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tc([2], [1])}`))).toEqual(denied('tcf: no publisher consent for purpose 1'));
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tc([1], [11])}`))).toEqual(denied('tcf: no publisher consent or legitimate interest for any of purposes 2-10'));
    // vendor legitimate interests don't count in publisher mode, nor publisher ones in vendor mode
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tcString([], { publisher: [1], legitimateInterests: [2] })}`)).allowed).toBe(false);
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tcString([1], { vendors: [755], legitimateInterests: [2] })}`))).toEqual({ allowed: true });
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tcString([1], { vendors: [755], publisherLegitimateInterests: [2] })}`)).allowed).toBe(false);
  });
  it('requires publisher consent for purpose 1 and at least one of purposes 2-10', () => {
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1, 2])}`))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1, 10])}`))).toEqual({ allowed: true });
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([2, 3])}`))).toEqual(denied('tcf: no publisher consent for purpose 1'));
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1])}`))).toEqual(denied('tcf: no publisher consent or legitimate interest for any of purposes 2-10'));
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1, 11])}`))).toEqual(denied('tcf: no publisher consent or legitimate interest for any of purposes 2-10'));
  });
  it('doesn\'t count vendor purpose consents in the core segment', () => {
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tcString([1, 2, 3])}`))).toEqual(denied('tcf: no publisher TC segment'));
    expect(storageDecision(publisherMode, consent(`gdpr=1&gdpr_consent=${tcString([1, 2], { publisher: [] })}`))).toEqual(denied('tcf: no publisher consent for purpose 1'));
  });
  it('checks a TC string whenever there is one, even with gdpr=0', () => {
    expect(storageDecision(publisherMode, consent(`gdpr=0&gdpr_consent=${publisherTc([])}`)).allowed).toBe(false);
    expect(storageDecision(publisherMode, consent(`gdpr_consent=${publisherTc([1, 2])}`)).allowed).toBe(true);
    expect(storageDecision(publisherMode, consent('gdpr_consent=not-a-tc-string'))).toEqual(denied('tcf: invalid TC string'));
  });
  it('denies storage for a COPPA request, like GPC, whatever the TC string says', () => {
    expect(storageDecision(publisherMode, consent('coppa=1'))).toEqual(denied('coppa'));
    expect(storageDecision(publisherMode, consent(`coppa=1&gdpr=1&gdpr_consent=${publisherTc([1, 2])}`))).toEqual(denied('coppa'));
    expect(storageDecision(vendorMode, consent('coppa=1'))).toEqual(denied('coppa'));
    expect(storageDecision(publisherMode, consent('coppa=0')).allowed).toBe(true);
  });
  it('denies storage when GDPR applies and there is no TC string', () => {
    expect(storageDecision(publisherMode, consent('gdpr=1'))).toEqual(denied('tcf: GDPR applies and there is no TC string'));
    expect(storageDecision(publisherMode, consent('', { isEU: true }))).toEqual(denied('tcf: GDPR applies and there is no TC string'));
  });
  it('in vendor mode, requires consent for the vendor, and vendor consent for purpose 1 and one of purposes 2-10', () => {
    const tc = (vendors: readonly number[], purposes: readonly number[]): string => tcString(purposes, { vendors, publisher: [1, 2] });
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tc([755], [1, 2])}`))).toEqual({ allowed: true });
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tc([1, 2], [1, 2])}`))).toEqual(denied('tcf: no consent for vendor 755'));
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tc([755], [2, 3])}`))).toEqual(denied('tcf: no vendor consent for purpose 1'));
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tc([755], [1, 11])}`))).toEqual(denied('tcf: no vendor consent or legitimate interest for any of purposes 2-10'));
    // publisher consent alone isn't enough in vendor mode
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${publisherTc([1, 2])}`)).allowed).toBe(false);
    expect(storageDecision(vendorMode, consent('gdpr=1'))).toEqual(denied('tcf: GDPR applies and there is no TC string'));
    expect(storageDecision(vendorMode, consent(`gdpr=1&gdpr_consent=${tc([755], [1, 2])}`, { gpc: true }))).toEqual(denied('gpc'));
  });
  it('parses only non-empty numeric GPP section IDs', () => {
    const consent = readConsent(new URL('https://example.com/_sid/v1?gpp_sid=2,,6,x'), new Headers(), new Map(), {});
    expect(consent.gppSid).toEqual([2, 6]);
  });

  it('reads the TC string from the CMP cookie', () => {
    expect(storageDecision(publisherMode, consent('', { cookie: `euconsent-v2=${publisherTc([1, 2])}`, isEU: true })).allowed).toBe(true);
    expect(storageDecision(publisherMode, consent('', { cookie: `euconsent-v2=${publisherTc([2])}`, isEU: true })).allowed).toBe(false);
  });
});

describe('deepMerge', () => {
  it('merges nested objects and ignores prototype keys', () => {
    const merged = deepMerge({ device: { geo: { country: 'USA' } } }, JSON.parse('{"device":{"geo":{"region":"NY"},"ip":"1.2.3.4"},"__proto__":{"polluted":true}}') as Record<string, unknown>);
    expect(merged).toEqual({ device: { geo: { country: 'USA', region: 'NY' }, ip: '1.2.3.4' } });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('EU_COUNTRY_CODES', () => {
  it('lists the 27 EU member states, not the wider EEA or the UK', () => {
    expect(EU_COUNTRY_CODES.size).toBe(27);
    for (const code of ['DE', 'FR', 'IE', 'HR', 'CY']) expect(EU_COUNTRY_CODES.has(code)).toBe(true);
    for (const code of ['GB', 'NO', 'IS', 'LI', 'CH', 'US']) expect(EU_COUNTRY_CODES.has(code)).toBe(false);
  });
});

describe('adapter helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('splitHeaders keeps each Set-Cookie separate and the other headers by name', () => {
    const headers = new Headers({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT');
    expect(splitHeaders(headers)).toEqual({
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      cookies: ['a=1; Path=/', 'b=2; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT']
    });
    expect(splitHeaders(new Headers())).toEqual({ headers: {}, cookies: [] });
  });

  it('logRequestFailure logs the error type, never its message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRequestFailure(new TypeError('203.0.113.1 sent a bad cookie'));
    logRequestFailure('a string');
    expect(log.mock.calls).toEqual([
      ['sharedid-edge: request failed', 'TypeError'],
      ['sharedid-edge: request failed', 'unknown error']
    ]);
  });

  it('handlerOrMisconfigured falls back on a ConfigError only, and logs its message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(handlerOrMisconfigured(() => 'built', () => 'fallback')).toBe('built');
    expect(log).not.toHaveBeenCalled();
    expect(handlerOrMisconfigured<unknown>(() => resolveConfig({ SID_MAX_AGE_DAYS: 'x' }), () => 'fallback')).toBe('fallback');
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^sharedid-edge: SID_MAX_AGE_DAYS/);
    expect(() => handlerOrMisconfigured(() => { throw new RangeError('bug'); }, () => 'fallback')).toThrow(RangeError);
  });
});

describe('more adapter helpers', () => {
  it('headerValue trims, and treats a blank header as missing', () => {
    const headers = new Headers({ 'x-a': '  DE ', 'x-b': '   ' });
    expect(headerValue(headers, 'x-a')).toBe('DE');
    expect(headerValue(headers, 'x-b')).toBeUndefined();
    expect(headerValue(headers, 'x-c')).toBeUndefined();
  });

  it('publicOriginFromEnv leaves out an unset or empty SID_PUBLIC_ORIGIN', () => {
    expect(publicOriginFromEnv({ SID_PUBLIC_ORIGIN: 'https://www.example.com' })).toEqual({ publicOrigin: 'https://www.example.com' });
    expect(publicOriginFromEnv({ SID_PUBLIC_ORIGIN: '' })).toEqual({});
    expect(publicOriginFromEnv({})).toEqual({});
  });

  it('locationWithEU adds isEU from a valid country only', () => {
    expect(locationWithEU({ country: 'de', city: 'Berlin' })).toEqual({ country: 'DE', city: 'Berlin', isEU: true });
    expect(locationWithEU({ country: 'GB' })).toEqual({ country: 'GB', isEU: false });
    expect(locationWithEU({ country: 'XX', city: 'Nowhere' })).toEqual({ city: 'Nowhere' });
  });
});

describe('parseHeaderMap', () => {
  const fields = ['country', 'city'] as const;
  it('maps known fields to lowercase header names', () => {
    expect(parseHeaderMap('{"country":"X-Geo-Country"}', 'SID_LOCATION_HEADERS', fields, '{}')).toEqual({ country: 'x-geo-country' });
    expect(parseHeaderMap(undefined, 'SID_LOCATION_HEADERS', fields, '{}')).toEqual({});
    expect(parseHeaderMap('  ', 'SID_LOCATION_HEADERS', fields, '{}')).toEqual({});
    expect(isHeaderName('x-geo-country')).toBe(true);
    expect(isHeaderName('x geo')).toBe(false);
  });

  it('throws a ConfigError for anything else', () => {
    for (const value of ['not json', '[]', '"x"', '{"region":"x-r"}', '{"city":"bad header"}', '{"city":1}']) {
      expect(() => parseHeaderMap(value, 'SID_LOCATION_HEADERS', fields, '{"country":"x-c"}')).toThrow(ConfigError);
    }
  });
});
