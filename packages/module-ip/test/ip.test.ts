import { createHandler, resolveConfig, type ConsentContext, type PayloadV1, type PlatformInfo, type SharedIdEdgeHandler, type TcfConsents } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { deviceFields, formatIpv6, ipModule, omissionReason, parseIp } from '../src/index.js';

describe('parseIp', () => {
  it('parses IPv4', () => {
    expect(parseIp('192.0.2.1')).toEqual({ version: 4, octets: [192, 0, 2, 1] });
    expect(parseIp(' 255.255.255.255 ')).toEqual({ version: 4, octets: [255, 255, 255, 255] });
  });
  it('parses IPv6 in its textual forms', () => {
    expect(parseIp('2001:db8::1')).toEqual({ version: 6, hextets: [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1] });
    expect(parseIp('2001:DB8:0:0:0:0:0:1')).toEqual(parseIp('2001:db8::1'));
    expect(parseIp('::')).toEqual({ version: 6, hextets: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseIp('::1')).toEqual({ version: 6, hextets: [0, 0, 0, 0, 0, 0, 0, 1] });
    expect(parseIp('fe80::')).toEqual({ version: 6, hextets: [0xfe80, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseIp('64:ff9b::192.0.2.1')).toEqual({ version: 6, hextets: [0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x201] });
  });
  it('treats IPv4-mapped IPv6 as IPv4, as Node.js reports IPv4 clients on a dual-stack socket', () => {
    expect(parseIp('::ffff:192.0.2.1')).toEqual({ version: 4, octets: [192, 0, 2, 1] });
    expect(parseIp('::ffff:c000:0201')).toEqual({ version: 4, octets: [192, 0, 2, 1] });
  });
  it.each(['', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', '2001:db8::1::2', '2001:db8:0:0:0:0:0:0:1', '12345::', 'fe80::1%eth0', '::ffff:1.2.3', 'g::1', '1:2:3:4:5:6:7'])(
    'rejects %j',
    text => {
      expect(parseIp(text)).toBeUndefined();
    }
  );
});

describe('formatIpv6', () => {
  it('writes RFC 5952 text', () => {
    expect(formatIpv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBe('2001:db8::1');
    expect(formatIpv6([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1])).toBe('2001:db8:0:1::1');
    expect(formatIpv6([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1])).toBe('2001:db8::1:0:0:1');
    expect(formatIpv6([0x2001, 0xdb8, 1, 2, 3, 4, 5, 6])).toBe('2001:db8:1:2:3:4:5:6');
    expect(formatIpv6([0, 0, 0, 0, 0, 0, 0, 0])).toBe('::');
    expect(formatIpv6([0x2001, 0xdb8, 0xabcd, 0x1200, 0, 0, 0, 0])).toBe('2001:db8:abcd:1200::');
  });
});

describe('deviceFields', () => {
  const ip = (text: string): NonNullable<ReturnType<typeof parseIp>> => parseIp(text) ?? expect.unreachable(text);
  it('uses ip for IPv4 and ipv6 for IPv6, in full', () => {
    expect(deviceFields(ip('192.0.2.77'))).toEqual({ ip: '192.0.2.77' });
    expect(deviceFields(ip('::ffff:192.0.2.77'))).toEqual({ ip: '192.0.2.77' });
    expect(deviceFields(ip('2001:DB8:abcd:12ff:1:2:3:4'))).toEqual({ ipv6: '2001:db8:abcd:12ff:1:2:3:4' });
  });
});

describe('omissionReason', () => {
  const tcf = (specialFeatures: readonly number[]): TcfConsents => ({
    version: 2,
    specialFeatureOptIns: new Set(specialFeatures),
    purposeConsents: new Set(),
    purposeLegitimateInterests: new Set(),
    vendorConsent: () => false,
    publisherPurposeConsents: undefined,
    publisherPurposeLegitimateInterests: undefined
  });
  const consent = (overrides: Partial<ConsentContext> = {}): ConsentContext => ({
    gdprApplies: undefined,
    tcString: undefined,
    tcf: undefined,
    usPrivacy: undefined,
    gppString: undefined,
    gppSid: undefined,
    gpc: false,
    ...overrides
  });

  it('sends the full address without restrictions', () => {
    expect(omissionReason(consent())).toBeUndefined();
    expect(omissionReason(consent({ gdprApplies: false }))).toBeUndefined();
    expect(omissionReason(consent({ usPrivacy: '1YNN' }))).toBeUndefined();
    expect(omissionReason(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([1]) }))).toBeUndefined();
  });
  it('omits the address with Global Privacy Control or a US privacy opt-out', () => {
    expect(omissionReason(consent({ gpc: true }))).toBe('gpc');
    expect(omissionReason(consent({ usPrivacy: '1YYN' }))).toBe('us-privacy');
    expect(omissionReason(consent({ usPrivacy: '1nyn' }))).toBe('us-privacy');
  });
  it('omits the address without opt-in to precise geolocation (TCF Special Feature 1)', () => {
    expect(omissionReason(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([2]) }))).toBe('tcf: no opt-in to precise geolocation');
    expect(omissionReason(consent({ gdprApplies: false, tcString: 'x', tcf: tcf([]) }))).toBe('tcf: no opt-in to precise geolocation');
    expect(omissionReason(consent({ tcString: 'x' }))).toBe('tcf: invalid TC string');
    expect(omissionReason(consent({ gdprApplies: true }))).toBe('tcf: no TC string');
  });
});

describe('the ip module in the handler', () => {
  const handler = (env: Record<string, string>): SharedIdEdgeHandler => createHandler({ config: resolveConfig(env), modules: [ipModule] });
  const payload = async (env: Record<string, string>, path: string, platform: PlatformInfo, headers: Record<string, string> = {}): Promise<PayloadV1> =>
    await (await handler(env)(new Request(`https://www.example.com${path}`, { headers }), platform)).json() as PayloadV1;

  it('does nothing unless listed in SID_MODULES', async () => {
    const body = await payload({}, '/_sid/v1', { clientIp: '192.0.2.77' });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules).toEqual({});
  });
  it('adds the client IP to ortb2.device', async () => {
    const body = await payload({ SID_MODULES: 'ip' }, '/_sid/v1', { clientIp: '192.0.2.77' });
    expect(body.ortb2).toEqual({ device: { ip: '192.0.2.77' } });
    expect(body.ext.modules['ip']?.status).toBe('ok');
    expect((await payload({ SID_MODULES: 'ip' }, '/_sid/v1', { clientIp: '2001:db8::7' })).ortb2).toEqual({ device: { ipv6: '2001:db8::7' } });
  });
  it('sends nothing, rather than a truncated address, when GDPR applies without a TC string or with GPC', async () => {
    for (const [path, platform, headers] of [
      ['/_sid/v1?gdpr=1', { clientIp: '192.0.2.77' }, {}],
      ['/_sid/v1', { clientIp: '192.0.2.77', isEU: true }, {}],
      ['/_sid/v1', { clientIp: '192.0.2.77' }, { 'Sec-GPC': '1' }],
      ['/_sid/v1?us_privacy=1YYN', { clientIp: '2001:db8::7' }, {}]
    ] as const) {
      const body = await payload({ SID_MODULES: 'ip' }, path, platform, headers);
      expect(body.ortb2).toBeUndefined();
      expect(body.ext.modules['ip']?.status).toBe('empty');
    }
  });
  it('reports empty when the platform has no valid client IP', async () => {
    expect((await payload({ SID_MODULES: 'ip' }, '/_sid/v1', {})).ext.modules['ip']?.status).toBe('empty');
    expect((await payload({ SID_MODULES: 'ip' }, '/_sid/v1', { clientIp: 'not-an-ip' })).ext.modules['ip']?.status).toBe('empty');
  });
  it('adds nothing to the sync pixel', async () => {
    const response = await handler({ SID_MODULES: 'ip' })(new Request('https://www.example.com/_sid/sync'), { clientIp: '192.0.2.77' });
    expect(response.headers.get('Content-Type')).toBe('image/gif');
  });
});
