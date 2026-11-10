import { createHandler, resolveConfig, type PayloadV1, type PlatformInfo, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { ALPHA_3, alpha3, deviceGeo, geoModule, geoPrecision, regionCode, utcOffsetMinutes } from '../src/index.js';

describe('alpha3', () => {
  it('covers every officially assigned ISO 3166-1 code, each with a distinct alpha-3 code', () => {
    expect(ALPHA_3.size).toBe(249);
    expect(new Set(ALPHA_3.values()).size).toBe(249);
    for (const [two, three] of ALPHA_3) {
      expect(two).toMatch(/^[A-Z]{2}$/);
      expect(three).toMatch(/^[A-Z]{3}$/);
    }
  });
  it.each([
    ['US', 'USA'], ['GB', 'GBR'], ['DE', 'DEU'], ['FR', 'FRA'], ['JP', 'JPN'], ['CN', 'CHN'], ['BR', 'BRA'], ['IN', 'IND'],
    ['CH', 'CHE'], ['ES', 'ESP'], ['NL', 'NLD'], ['KR', 'KOR'], ['KP', 'PRK'], ['ZA', 'ZAF'], ['AX', 'ALA'], ['BQ', 'BES'],
    ['CW', 'CUW'], ['SS', 'SSD'], ['SX', 'SXM'], ['KM', 'COM'], ['KY', 'CYM'], ['GS', 'SGS'], ['TF', 'ATF'], ['PM', 'SPM'],
    ['YT', 'MYT'], ['RS', 'SRB'], ['ME', 'MNE'], ['TL', 'TLS'], ['AD', 'AND'], ['ZW', 'ZWE']
  ])('%s is %s', (two, three) => {
    expect(alpha3(two)).toBe(three);
  });
  it('accepts lower case, and has nothing for unassigned or special codes', () => {
    expect(alpha3('us')).toBe('USA');
    for (const code of ['XK', 'XX', 'T1', 'EU', 'UK', 'AA', '']) expect(alpha3(code)).toBeUndefined();
  });
});

describe('regionCode', () => {
  it('strips the country prefix and upper-cases', () => {
    expect(regionCode('TX')).toBe('TX');
    expect(regionCode('US-TX')).toBe('TX');
    expect(regionCode('gb-eng')).toBe('ENG');
    expect(regionCode('JP-13')).toBe('13');
    expect(regionCode('FR-75C')).toBe('75C');
    expect(regionCode('be')).toBe('BE');
  });
  it('rejects anything else', () => {
    for (const region of ['', 'Texas', 'US-', 'USA-TX', 'US-TEXA', 'US_TX', 'US-TX-1']) expect(regionCode(region)).toBeUndefined();
  });
});

describe('utcOffsetMinutes', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');
  it('follows daylight saving time', () => {
    expect(utcOffsetMinutes('America/New_York', winter)).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', summer)).toBe(-240);
    expect(utcOffsetMinutes('Europe/Berlin', winter)).toBe(60);
    expect(utcOffsetMinutes('Europe/Berlin', summer)).toBe(120);
    expect(utcOffsetMinutes('Australia/Sydney', winter)).toBe(660);
    expect(utcOffsetMinutes('Australia/Sydney', summer)).toBe(600);
  });
  it('switches at the transition', () => {
    // US daylight saving time starts on 8 March 2026 at 2:00 local time (7:00 UTC).
    expect(utcOffsetMinutes('America/New_York', new Date('2026-03-08T06:59:59Z'))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-03-08T07:00:00Z'))).toBe(-240);
  });
  it('handles zones without daylight saving time, half and quarter hours, and UTC', () => {
    expect(utcOffsetMinutes('America/Phoenix', summer)).toBe(-420);
    expect(utcOffsetMinutes('Asia/Kolkata', summer)).toBe(330);
    expect(utcOffsetMinutes('Asia/Kathmandu', summer)).toBe(345);
    expect(utcOffsetMinutes('UTC', summer)).toBe(0);
    expect(utcOffsetMinutes('Etc/GMT+5', summer)).toBe(-300);
  });
  it('is undefined for an unknown zone', () => {
    expect(utcOffsetMinutes('Mars/Olympus_Mons', summer)).toBeUndefined();
    expect(utcOffsetMinutes('', summer)).toBeUndefined();
  });
});

describe('geoPrecision', () => {
  it('defaults to precise', () => {
    expect(geoPrecision({})).toBe('precise');
    expect(geoPrecision({ precision: 'precise' })).toBe('precise');
    expect(geoPrecision({ precision: 'coarse' })).toBe('coarse');
  });
  it('rejects other values and unknown keys', () => {
    for (const config of [{ precision: 'city' }, { precision: 'COARSE' }, { precision: true }, { precision: null }, { precison: 'coarse' }, { precision: 'coarse', round: 2 }]) {
      expect(() => geoPrecision(config)).toThrow(TypeError);
    }
  });
});

describe('deviceGeo', () => {
  const at = new Date('2026-07-15T12:00:00Z');
  const austin: PlatformInfo = {
    country: 'US',
    region: 'TX',
    city: 'Austin',
    postalCode: '78701',
    metroCode: '635',
    latitude: 30.2713,
    longitude: -97.7426,
    timezone: 'America/Chicago',
    continent: 'NA'
  };
  it('maps every field with precise data allowed', () => {
    expect(deviceGeo(austin, { precise: true, at })).toEqual({
      type: 2, country: 'USA', region: 'TX', metro: '635', utcoffset: -300, city: 'Austin', zip: '78701', lat: 30.2713, lon: -97.7426
    });
  });
  it('leaves out the precise fields, not rounding them, otherwise', () => {
    expect(deviceGeo(austin, { precise: false, at })).toEqual({ type: 2, country: 'USA', region: 'TX', metro: '635', utcoffset: -300 });
  });
  it('leaves out what it cannot map, and returns nothing without any field', () => {
    expect(deviceGeo({ country: 'XK', region: 'Texas', timezone: 'Nowhere/Land', latitude: 1 }, { precise: true, at })).toBeUndefined();
    expect(deviceGeo({ clientIp: '192.0.2.1', isEU: true }, { precise: true, at })).toBeUndefined();
    expect(deviceGeo({ city: 'Austin' }, { precise: false, at })).toBeUndefined();
    expect(deviceGeo({ country: 'DE', region: 'DE-BE' }, { precise: true, at })).toEqual({ type: 2, country: 'DEU', region: 'BE' });
  });
});

describe('the geo module in the handler', () => {
  // Zones without daylight saving time, so utcoffset doesn't depend on the date the tests run.
  const phoenix: PlatformInfo = {
    clientIp: '192.0.2.77', country: 'US', region: 'AZ', city: 'Phoenix', postalCode: '85004', metroCode: '753',
    latitude: 33.44838, longitude: -112.07404, timezone: 'America/Phoenix', continent: 'NA'
  };
  const full = { type: 2, country: 'USA', region: 'AZ', metro: '753', utcoffset: -420, city: 'Phoenix', zip: '85004', lat: 33.44838, lon: -112.07404 };
  const coarse = { type: 2, country: 'USA', region: 'AZ', metro: '753', utcoffset: -420 };
  const handler = (env: Record<string, string>): SharedIdEdgeHandler => createHandler({ config: resolveConfig(env), modules: [geoModule] });
  const payload = async (env: Record<string, string>, path: string, platform: PlatformInfo, headers: Record<string, string> = {}): Promise<PayloadV1> =>
    await (await handler(env)(new Request(`https://www.example.com${path}`, { headers }), platform)).json() as PayloadV1;

  it('does nothing unless listed in SID_MODULES', async () => {
    const body = await payload({}, '/_sid/v1', phoenix);
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules).toEqual({});
  });
  it('adds device.geo with the precise fields', async () => {
    const body = await payload({ SID_MODULES: 'geo' }, '/_sid/v1', phoenix);
    expect(body.ortb2).toEqual({ device: { geo: full } });
    expect(body.ext.modules['geo']?.status).toBe('ok');
  });
  it('sends only the coarse fields when consent rules out precise geolocation', async () => {
    const optIn = 'CAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAA';
    const noSpecialFeatures = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    for (const [path, platform, headers] of [
      ['/_sid/v1?gdpr=1', phoenix, {}],
      ['/_sid/v1', { ...phoenix, isEU: true }, {}],
      ['/_sid/v1', phoenix, { 'Sec-GPC': '1' }],
      ['/_sid/v1?us_privacy=1YYN', phoenix, {}],
      ['/_sid/v1?coppa=1', phoenix, {}],
      [`/_sid/v1?gdpr=1&gdpr_consent=${noSpecialFeatures}`, phoenix, {}],
      ['/_sid/v1?gdpr_consent=invalid', phoenix, {}]
    ] as const) {
      const body = await payload({ SID_MODULES: 'geo' }, path, platform, headers);
      expect(body.ortb2).toEqual({ device: { geo: coarse } });
      expect(body.ext.modules['geo']?.status).toBe('ok');
    }
    expect((await payload({ SID_MODULES: 'geo' }, `/_sid/v1?gdpr=1&gdpr_consent=${optIn}`, phoenix)).ortb2).toEqual({ device: { geo: full } });
  });
  it('sends only the coarse fields with precision coarse', async () => {
    const body = await payload({ SID_MODULES: 'geo', SID_MODULE_CONFIG: '{"geo":{"precision":"coarse"}}' }, '/_sid/v1', phoenix);
    expect(body.ortb2).toEqual({ device: { geo: coarse } });
  });
  it('reports an error, and adds nothing, for an invalid setting', async () => {
    for (const config of ['{"geo":{"precision":"city"}}', '{"geo":{"precison":"coarse"}}']) {
      const body = await payload({ SID_MODULES: 'geo', SID_MODULE_CONFIG: config }, '/_sid/v1', phoenix);
      expect(body.ortb2).toBeUndefined();
      expect(body.ext.modules['geo']?.status).toBe('error');
    }
  });
  it('reports empty without location data', async () => {
    expect((await payload({ SID_MODULES: 'geo' }, '/_sid/v1', { clientIp: '192.0.2.77' })).ext.modules['geo']?.status).toBe('empty');
  });
  it('merges with the ip module into one device object', async () => {
    const ip = { name: 'ip', run: () => ({ ortb2: { device: { ip: '192.0.2.77' } } }) };
    const response = await createHandler({ config: resolveConfig({ SID_MODULES: 'ip,geo' }), modules: [ip, geoModule] })(new Request('https://www.example.com/_sid/v1'), phoenix);
    expect(((await response.json()) as PayloadV1).ortb2).toEqual({ device: { ip: '192.0.2.77', geo: full } });
  });
  it('adds nothing to the sync pixel', async () => {
    const response = await handler({ SID_MODULES: 'geo' })(new Request('https://www.example.com/_sid/sync'), phoenix);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
  });
});
