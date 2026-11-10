import { createHandler, resolveConfig, type ConsentContext, type PayloadV1, type PlatformInfo, type SharedIdEdgeHandler, type TcfConsents } from '@sharedid-edge/core';
import { parseIp } from '@sharedid-edge/module-ip';
import { describe, expect, it } from 'vitest';
import { EC_COOKIE, ecDecision, ecModule, ecModuleConfig, ecPassphrase, ecPrefix, isValidEcId, normalizeIp, randomSuffix } from '../src/index.js';

const PASSPHRASE = 'conformance-passphrase-0123456789abcdef';
// Computed independently with Node.js: createHmac('sha256', PASSPHRASE).update(message).digest('hex')
const VECTORS: readonly (readonly [string, string, string])[] = [
  ['192.0.2.77', '192.0.2.77', '7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc'],
  ['2001:db8:85a3:0:8a2e:370:7334:1234', '20010db885a30000', '53535a5d73a52082fa6be4418fff1ca1f0b3986ac180be1ffbfce280a0db284b'],
  ['192.168.1.100', '192.168.1.100', '6d72d453c324416ca19c36e0738596d62d00f531dd0d72961de438fbb5f6030a']
];
const parsed = (text: string): NonNullable<ReturnType<typeof parseIp>> => parseIp(text) ?? expect.unreachable(text);

describe('EC IDs', () => {
  it('normalizes addresses as Trusted Server does', () => {
    expect(normalizeIp(parsed('192.168.1.100'))).toBe('192.168.1.100');
    expect(normalizeIp(parsed('2001:db8:85a3:0:8a2e:370:7334:1234'))).toBe('20010db885a30000');
    expect(normalizeIp(parsed('2001:db8:abcd:1::5'))).toBe('20010db8abcd0001');
    expect(normalizeIp(parsed('::ffff:192.0.2.1'))).toBe('192.0.2.1');
  });
  it.each(VECTORS)('derives the prefix for %s from HMAC-SHA256 of %s', async (ip, message, hex) => {
    expect(normalizeIp(parsed(ip))).toBe(message);
    expect(await ecPrefix(PASSPHRASE, message)).toBe(hex);
  });
  it('draws six alphanumeric suffix characters', () => {
    const suffixes = new Set(Array.from({ length: 200 }, () => randomSuffix()));
    for (const suffix of suffixes) expect(suffix).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(suffixes.size).toBeGreaterThan(190);
  });
  it('validates the format only', () => {
    expect(isValidEcId(`${'a'.repeat(64)}.Ab12z9`)).toBe(true);
    expect(isValidEcId(`${'a'.repeat(64)}.ab-129`)).toBe(false);
    expect(isValidEcId(`${'A'.repeat(64)}.Ab12z9`)).toBe(false);
    expect(isValidEcId(`${'a'.repeat(64)}.Ab12z9.x`)).toBe(false);
    expect(isValidEcId(undefined)).toBe(false);
  });
});

describe('ecDecision', () => {
  const tcf = (purposes: readonly number[]): TcfConsents => ({
    version: 2,
    specialFeatureOptIns: new Set(),
    purposeConsents: new Set(purposes),
    purposeLegitimateInterests: new Set(),
    vendorConsent: () => false,
    publisherPurposeConsents: undefined,
    publisherPurposeLegitimateInterests: undefined
  });
  const consent = (overrides: Partial<ConsentContext> = {}): ConsentContext => ({
    gdprApplies: undefined, tcString: undefined, tcf: undefined, usPrivacy: undefined, gppString: undefined, gppSid: undefined, gpc: false, coppa: false,
    ...overrides
  });
  it('allows without restrictions, or with TCF Purpose 1', () => {
    expect(ecDecision(consent(), false)).toEqual({ allowed: true });
    expect(ecDecision(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([1]) }), false)).toEqual({ allowed: true });
  });
  it('withdraws on opt-out, GPC, COPPA, a US privacy opt-out, or a TC string without Purpose 1', () => {
    expect(ecDecision(consent(), true)).toMatchObject({ reason: 'opt-out', withdraw: true });
    expect(ecDecision(consent({ gpc: true }), false)).toMatchObject({ reason: 'gpc', withdraw: true });
    expect(ecDecision(consent({ coppa: true }), false)).toMatchObject({ reason: 'coppa', withdraw: true });
    expect(ecDecision(consent({ usPrivacy: '1YYN' }), false)).toMatchObject({ reason: 'us-privacy', withdraw: true });
    expect(ecDecision(consent({ tcString: 'x', tcf: tcf([2]) }), false)).toMatchObject({ reason: 'tcf: no consent for purpose 1', withdraw: true });
  });
  it('fails closed without deleting for an undecodable TC string, or GDPR without one', () => {
    expect(ecDecision(consent({ tcString: 'x' }), false)).toMatchObject({ allowed: false, withdraw: false });
    expect(ecDecision(consent({ gdprApplies: true }), false)).toMatchObject({ allowed: false, withdraw: false });
  });
});

describe('settings', () => {
  it('reads the domain and the passphrase', () => {
    expect(ecModuleConfig({})).toEqual({ domain: undefined });
    expect(ecModuleConfig({ domain: 'example.com' })).toEqual({ domain: 'example.com' });
    expect(() => ecModuleConfig({ domain: '.example.com' })).toThrow(TypeError);
    expect(ecPassphrase({ passphrase: PASSPHRASE })).toBe(PASSPHRASE);
    expect(() => ecPassphrase({ passphrase: 'short' })).toThrow(TypeError);
    expect(() => ecPassphrase({})).toThrow(TypeError);
  });
});

describe('the ec module in the handler', () => {
  const env = { SID_MODULES: 'ec', SID_MODULE_SECRETS: JSON.stringify({ ec: { passphrase: PASSPHRASE } }), SID_MODULE_CONFIG: '{"ec":{"domain":"example.com"}}' };
  const handler = (overrides: Record<string, string> = {}): SharedIdEdgeHandler => createHandler({ config: resolveConfig({ ...env, ...overrides }), modules: [ecModule] });
  const call = async (path: string, platform: PlatformInfo, headers: Record<string, string> = {}, overrides: Record<string, string> = {}): Promise<{ body: PayloadV1; ec: string | undefined }> => {
    const response = await handler(overrides)(new Request(`https://www.example.com${path}`, { headers }), platform);
    const ec = response.headers.getSetCookie().find(c => c.startsWith(`${EC_COOKIE}=`));
    return { body: await response.json() as PayloadV1, ec };
  };

  it('does nothing unless listed in SID_MODULES', async () => {
    const response = await createHandler({ config: resolveConfig({}), modules: [ecModule] })(new Request('https://www.example.com/_sid/v1'), { clientIp: '192.0.2.77' });
    expect(response.headers.getSetCookie().some(c => c.startsWith(`${EC_COOKIE}=`))).toBe(false);
  });
  it('mints an EC from the client IP, sets ts-ec and returns it as ortb2.user.id', async () => {
    const { body, ec } = await call('/_sid/v1', { clientIp: '192.0.2.77' });
    const id = (body.ortb2 as { user: { id: string } }).user.id;
    expect(id).toMatch(/^7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6}$/);
    expect(ec).toMatch(new RegExp(`^ts-ec=${id.replace('.', '\\.')}; Max-Age=31536000; Expires=[^;]+; Path=/; Domain=\\.example\\.com; SameSite=Lax; Secure; HttpOnly$`));
    expect(body.ext.modules['ec']?.status).toBe('ok');
  });
  it('gives clients behind the same address the same prefix and different suffixes', async () => {
    const a = (await call('/_sid/v1', { clientIp: '192.0.2.77' })).body.ortb2 as { user: { id: string } };
    const b = (await call('/_sid/v1', { clientIp: '192.0.2.77' })).body.ortb2 as { user: { id: string } };
    expect(a.user.id.slice(0, 64)).toBe(b.user.id.slice(0, 64));
    expect(a.user.id).not.toBe(b.user.id);
  });
  it('uses an existing EC without refreshing it, and replaces an invalid one', async () => {
    const existing = `${'a'.repeat(64)}.Ab12z9`;
    const kept = await call('/_sid/v1', { clientIp: '192.0.2.77' }, { Cookie: `ts-ec=${existing}` });
    expect(kept.body.ortb2).toEqual({ user: { id: existing } });
    expect(kept.ec).toBeUndefined();
    const replaced = await call('/_sid/v1', { clientIp: '192.0.2.77' }, { Cookie: 'ts-ec=junk' });
    expect(replaced.ec).toMatch(/^ts-ec=7ef9/);
  });
  it('deletes the EC on withdrawal and returns nothing', async () => {
    for (const [path, headers] of [['/_sid/v1', { 'Sec-GPC': '1' }], ['/_sid/v1?coppa=1', {}], ['/_sid/v1', { Cookie: '_pubcid_optout=1' }]] as const) {
      const { body, ec } = await call(path, { clientIp: '192.0.2.77' }, { ...headers, Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9; ${'Cookie' in headers ? headers.Cookie : ''}` });
      expect(ec).toMatch(/^ts-ec=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
      expect(body.ortb2).toBeUndefined();
    }
  });
  it('fails closed without deleting when GDPR applies and there is no TC string', async () => {
    const { body, ec } = await call('/_sid/v1?gdpr=1', { clientIp: '192.0.2.77' }, { Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` });
    expect(ec).toBeUndefined();
    expect(body.ext.modules['ec']?.status).toBe('empty');
  });
  it('reports an error, without details, when the passphrase is missing or short', async () => {
    const { body, ec } = await call('/_sid/v1', { clientIp: '192.0.2.77' }, {}, { SID_MODULE_SECRETS: '{"ec":{"passphrase":"short"}}' });
    expect(body.ext.modules['ec']).toEqual({ ms: expect.any(Number) as number, status: 'error' });
    expect(ec).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('short');
  });
});
