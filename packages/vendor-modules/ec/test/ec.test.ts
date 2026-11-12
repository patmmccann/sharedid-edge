import { createHandler, resolveConfig, type ConsentContext, type PayloadV1, type PlatformInfo, type SharedIdEdgeHandler, type TcfConsents } from '@sharedid-edge/core';
import { parseIp } from '@sharedid-edge/module-ip';
import { describe, expect, it } from 'vitest';
import { EC_COOKIE, EC_EID_SOURCE, EC_PASSPHRASE_PLACEHOLDERS, ecDecision, ecEidAllowed, ecModule, ecModuleConfig, ecPassphrase, ecPrefix, isPlaceholderPassphrase, isValidEcId, normalizeIp, randomSuffix } from '../src/index.js';

const PASSPHRASE = 'conformance-passphrase-0123456789abcdef';
// Computed independently with Node.js: createHmac('sha256', PASSPHRASE).update(message).digest('hex')
const VECTORS: readonly (readonly [string, string, string])[] = [
  ['192.0.2.77', '192.0.2.77', '7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc'],
  ['2001:db8:85a3:0:8a2e:370:7334:1234', '20010db885a30000', '53535a5d73a52082fa6be4418fff1ca1f0b3986ac180be1ffbfce280a0db284b'],
  ['192.168.1.100', '192.168.1.100', '6d72d453c324416ca19c36e0738596d62d00f531dd0d72961de438fbb5f6030a'],
  ['2001:db8:abcd:1:1111:2222:3333:4444', '20010db8abcd0001', '884a602db18c75475e9908442a13fa49f8176700b4e3243c5a00bd462c1df852'],
  ['2001:db8:abcd:1:aaaa:bbbb:cccc:dddd', '20010db8abcd0001', '884a602db18c75475e9908442a13fa49f8176700b4e3243c5a00bd462c1df852'],
  ['::ffff:192.0.2.77', '192.0.2.77', '7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc']
];
/** TC strings with only a core segment: consent for Purposes 1 and 4, and for Purpose 1 only. */
const TC_PURPOSES_1_4 = 'CAAAAAAAAAAAAAAAAAAAAAAAAJAAAAAAAAAAAAAAAAAA';
const TC_PURPOSE_1 = 'CAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAA';
const parsed = (text: string): NonNullable<ReturnType<typeof parseIp>> => parseIp(text) ?? expect.unreachable(text);
/** The EC in a payload's eids (the `EC_EID_SOURCE` entry). */
const ecId = (body: PayloadV1): string => body.eids.find(eid => eid.source === EC_EID_SOURCE)?.uids[0]?.id ?? expect.unreachable('no EC eid');

describe('EC IDs', () => {
  it('normalizes addresses as Trusted Server does', () => {
    expect(normalizeIp(parsed('192.168.1.100'))).toBe('192.168.1.100');
    expect(normalizeIp(parsed('2001:db8:85a3:0:8a2e:370:7334:1234'))).toBe('20010db885a30000');
    expect(normalizeIp(parsed('2001:db8:abcd:1::5'))).toBe('20010db8abcd0001');
    expect(normalizeIp(parsed('::ffff:192.0.2.1'))).toBe('192.0.2.1');
  });
  it('normalizes two interface IDs in one /64 to the same message, as Trusted Server\'s tests do', () => {
    // Trusted Server's normalize_ipv6_different_suffix_same_prefix (ec/generation.rs): privacy extensions rotating the
    // interface ID keep the prefix.
    const a = normalizeIp(parsed('2001:db8:abcd:1:1111:2222:3333:4444'));
    expect(a).toBe('20010db8abcd0001');
    expect(normalizeIp(parsed('2001:db8:abcd:1:aaaa:bbbb:cccc:dddd'))).toBe(a);
    expect(normalizeIp(parsed('2001:db8:abcd:2:1111:2222:3333:4444'))).not.toBe(a);
  });
  it('hashes an IPv4-mapped IPv6 address as its IPv4 address, not as the ::ffff:0:0/64 every mapped address shares', () => {
    expect(normalizeIp(parsed('::ffff:192.0.2.77'))).toBe(normalizeIp(parsed('192.0.2.77')));
    expect(normalizeIp(parsed('::ffff:192.0.2.77'))).not.toBe(normalizeIp(parsed('::ffff:198.51.100.1')));
    expect(normalizeIp(parsed('::ffff:192.0.2.77'))).not.toBe('0000000000000000');
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
  it('returns the EID only with Purposes 1 and 4 when there is a TC string, and outside GDPR without one', () => {
    expect(ecEidAllowed(consent({ tcString: 'x', tcf: tcf([1, 4]) }))).toBe(true);
    expect(ecEidAllowed(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([1, 4]) }))).toBe(true);
    expect(ecEidAllowed(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([1]) }))).toBe(false);
    expect(ecEidAllowed(consent({ gdprApplies: false, tcString: 'x', tcf: tcf([1, 2, 3]) }))).toBe(false);
    expect(ecEidAllowed(consent({ tcString: 'x', tcf: tcf([4]) }))).toBe(false);
    expect(ecEidAllowed(consent({ tcString: 'x' }))).toBe(false);
    expect(ecEidAllowed(consent({ gdprApplies: true }))).toBe(false);
    expect(ecEidAllowed(consent())).toBe(true);
    expect(ecEidAllowed(consent({ gdprApplies: false }))).toBe(true);
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
  it.each(EC_PASSPHRASE_PLACEHOLDERS)('refuses the placeholder %s, in any ASCII case, without echoing it', placeholder => {
    for (const value of [placeholder, placeholder.toUpperCase(), placeholder.charAt(0).toUpperCase() + placeholder.slice(1)]) {
      expect(isPlaceholderPassphrase(value)).toBe(true);
      expect(() => ecPassphrase({ passphrase: value })).toThrow(TypeError);
      try {
        ecPassphrase({ passphrase: value });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        expect(message).toContain('SID_MODULE_SECRETS.ec.passphrase');
        expect(message.toLowerCase()).not.toContain(placeholder);
      }
    }
  });
  it('lists Trusted Server\'s placeholders and the repo\'s examples, and only refuses exact matches', () => {
    expect(EC_PASSPHRASE_PLACEHOLDERS).toEqual(expect.arrayContaining([
      'secret-key', 'secret_key', 'trusted-server', 'trusted-server-placeholder-secret', 'replace-with-random-ec-passphrase',
      'a-local-passphrase-of-at-least-32-characters'
    ]));
    expect(isPlaceholderPassphrase(' trusted-server-placeholder-secret')).toBe(false);
    expect(isPlaceholderPassphrase('trusted-server-placeholder-secret-2')).toBe(false);
    expect(ecPassphrase({ passphrase: 'replace-with-random-ec-passphrase-0d9f8e7a' })).toBe('replace-with-random-ec-passphrase-0d9f8e7a');
    expect(isPlaceholderPassphrase(PASSPHRASE)).toBe(false);
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
  it('mints an EC from the client IP, sets ts-ec and returns it as an EID, never as user.id', async () => {
    const { body, ec } = await call('/_sid/v1', { clientIp: '192.0.2.77' });
    const id = ecId(body);
    const eid = { source: EC_EID_SOURCE, uids: [{ id, atype: 1 }] };
    expect(body.eids).toContainEqual(eid);
    expect(body.ortb2).toEqual({ user: { ext: { eids: [eid] } } });
    expect(id).toMatch(/^7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6}$/);
    expect(ec).toMatch(new RegExp(`^ts-ec=${id.replace('.', '\\.')}; Max-Age=31536000; Expires=[^;]+; Path=/; Domain=\\.example\\.com; SameSite=Lax; Secure; HttpOnly$`));
    expect(body.ext.modules['ec']?.status).toBe('ok');
  });
  it('gives clients behind the same address the same prefix and different suffixes', async () => {
    const a = ecId((await call('/_sid/v1', { clientIp: '192.0.2.77' })).body);
    const b = ecId((await call('/_sid/v1', { clientIp: '192.0.2.77' })).body);
    expect(a.slice(0, 64)).toBe(b.slice(0, 64));
    expect(a).not.toBe(b);
  });
  it('uses an existing EC without refreshing it, and replaces an invalid one', async () => {
    const existing = `${'a'.repeat(64)}.Ab12z9`;
    const kept = await call('/_sid/v1', { clientIp: '192.0.2.77' }, { Cookie: `ts-ec=${existing}` });
    expect(kept.body.ortb2).toEqual({ user: { ext: { eids: [{ source: EC_EID_SOURCE, uids: [{ id: existing, atype: 1 }] }] } } });
    expect(kept.body.eids).toContainEqual({ source: EC_EID_SOURCE, uids: [{ id: existing, atype: 1 }] });
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
  it('deletes ts-ec on /optout, even when ec isn\'t in SID_MODULES', async () => {
    for (const overrides of [{}, { SID_MODULES: '' }]) {
      const response = await handler(overrides)(new Request('https://www.example.com/_sid/optout', { headers: { Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` } }), { clientIp: '192.0.2.77' });
      expect(response.headers.getSetCookie().find(c => c.startsWith('ts-ec='))).toMatch(/^ts-ec=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
    }
  });
  it('fails closed without deleting when GDPR applies and there is no TC string', async () => {
    const { body, ec } = await call('/_sid/v1?gdpr=1', { clientIp: '192.0.2.77' }, { Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` });
    expect(ec).toBeUndefined();
    expect(body.ext.modules['ec']?.status).toBe('empty');
  });
  it('treats a UK, EEA or Turkish visitor without a TC string as GDPR, as core does, keeping an existing EC', async () => {
    for (const country of ['GB', 'NO', 'IS', 'LI', 'TR']) {
      const response = await handler()(new Request('https://www.example.com/_sid/v1', { headers: { Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` } }), { clientIp: '192.0.2.77', country, isEU: false });
      const body = await response.json() as PayloadV1;
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(body.ortb2).toBeUndefined();
      expect(body.ext.modules['ec']?.status).toBe('empty');
    }
  });
  it('treats a visitor in Switzerland, or a UK or Turkish visitor with gdpr=0, as outside GDPR', async () => {
    for (const [path, country] of [['/_sid/v1', 'CH'], ['/_sid/v1?gdpr=0', 'GB'], ['/_sid/v1?gdpr=0', 'TR']] as const) {
      const { body, ec } = await call(path, { clientIp: '192.0.2.77', country, isEU: false });
      expect(ec).toMatch(/^ts-ec=7ef9/);
      expect(body.ortb2).toEqual({ user: { ext: { eids: [{ source: EC_EID_SOURCE, uids: [{ id: ecId(body), atype: 1 }] }] } } });
    }
  });
  it('returns the EID with consent for Purposes 1 and 4', async () => {
    const { body, ec } = await call(`/_sid/v1?gdpr_consent=${TC_PURPOSES_1_4}`, { clientIp: '192.0.2.77', country: 'DE', isEU: true });
    expect(ec).toMatch(/^ts-ec=7ef9/);
    expect(body.ortb2).toEqual({ user: { ext: { eids: [{ source: EC_EID_SOURCE, uids: [{ id: ecId(body), atype: 1 }] }] } } });
    expect(body.ext.modules['ec']?.status).toBe('ok');
  });
  it('sets the cookie but leaves the EID out with consent for Purpose 1 only', async () => {
    const minted = await call(`/_sid/v1?gdpr_consent=${TC_PURPOSE_1}`, { clientIp: '192.0.2.77', country: 'DE', isEU: true });
    expect(minted.ec).toMatch(/^ts-ec=7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6}; Max-Age=31536000;/);
    expect(minted.body.ortb2).toBeUndefined();
    expect(minted.body.eids.some(eid => eid.source === EC_EID_SOURCE)).toBe(false);
    expect(minted.body.ext.modules['ec']?.status).toBe('empty');
    const kept = await call(`/_sid/v1?gdpr=1&gdpr_consent=${TC_PURPOSE_1}`, { clientIp: '192.0.2.77', country: 'US' }, { Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` });
    expect(kept.ec).toBeUndefined();
    expect(kept.body.ortb2).toBeUndefined();
    expect(kept.body.eids.some(eid => eid.source === EC_EID_SOURCE)).toBe(false);
  });
  it('reports an error, without details, for a placeholder passphrase, and still deletes ts-ec on withdrawal', async () => {
    const placeholder = { SID_MODULE_SECRETS: '{"ec":{"passphrase":"A-Local-Passphrase-Of-At-Least-32-Characters"}}' };
    const { body, ec } = await call('/_sid/v1', { clientIp: '192.0.2.77' }, {}, placeholder);
    expect(body.ext.modules['ec']).toEqual({ ms: expect.any(Number) as number, status: 'error' });
    expect(ec).toBeUndefined();
    expect(JSON.stringify(body).toLowerCase()).not.toContain('a-local-passphrase');
    expect((await call('/_sid/v1', { clientIp: '192.0.2.77' }, { 'Sec-GPC': '1', Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` }, placeholder)).ec).toMatch(/^ts-ec=; Max-Age=0;/);
  });
  it('gives two interface IDs in one IPv6 /64 the same prefix', async () => {
    const a = ecId((await call('/_sid/v1', { clientIp: '2001:db8:abcd:1:1111:2222:3333:4444' })).body);
    const b = ecId((await call('/_sid/v1', { clientIp: '2001:db8:abcd:1:aaaa:bbbb:cccc:dddd' })).body);
    expect(a.slice(0, 64)).toBe('884a602db18c75475e9908442a13fa49f8176700b4e3243c5a00bd462c1df852');
    expect(b.slice(0, 64)).toBe(a.slice(0, 64));
  });
  it('reports an error, without details, when the passphrase is missing or short', async () => {
    const { body, ec } = await call('/_sid/v1', { clientIp: '192.0.2.77' }, {}, { SID_MODULE_SECRETS: '{"ec":{"passphrase":"short"}}' });
    expect(body.ext.modules['ec']).toEqual({ ms: expect.any(Number) as number, status: 'error' });
    expect(ec).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('short');
  });
  const sync = async (headers: Record<string, string> = {}, overrides: Record<string, string> = {}): Promise<{ response: Response; ec: string | undefined }> => {
    const response = await handler(overrides)(new Request('https://www.example.com/_sid/sync', { headers }), { clientIp: '192.0.2.77' });
    return { response, ec: response.headers.getSetCookie().find(c => c.startsWith(`${EC_COOKIE}=`)) };
  };
  it('sets ts-ec on /sync, without returning it, and keeps the pixel response', async () => {
    const { response, ec } = await sync();
    expect(ec).toMatch(/^ts-ec=7ef915764608ef290d564ff779c8d166ba4aa91189fe6c5c4368ffad938398dc\.[A-Za-z0-9]{6}; Max-Age=31536000; Expires=[^;]+; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(response.headers.get('X-SharedID-Modules')).toBe('ec=ok');
    expect((await response.arrayBuffer()).byteLength).toBe(43);
  });
  it('on /sync, keeps an existing EC and deletes it on withdrawal', async () => {
    const existing = `ts-ec=${'a'.repeat(64)}.Ab12z9`;
    expect((await sync({ Cookie: existing })).ec).toBeUndefined();
    for (const headers of [{ 'Sec-GPC': '1', Cookie: existing }, { Cookie: `_pubcid_optout=1; ${existing}` }]) {
      const { response, ec } = await sync(headers);
      expect(ec).toMatch(/^ts-ec=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; Domain=\.example\.com; SameSite=Lax; Secure; HttpOnly$/);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('on /sync, still deletes ts-ec on withdrawal with a short passphrase, and otherwise sets nothing', async () => {
    const short = { SID_MODULE_SECRETS: '{"ec":{"passphrase":"short"}}' };
    expect((await sync({ 'Sec-GPC': '1', Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` }, short)).ec).toMatch(/^ts-ec=; Max-Age=0;/);
    const { response, ec } = await sync({}, short);
    expect(ec).toBeUndefined();
    expect(response.headers.get('X-SharedID-Modules')).toBe('ec=error');
  });
  it('doesn\'t run on /sync when SID_SYNC_MODULES leaves it out', async () => {
    expect((await sync({}, { SID_SYNC_MODULES: 'none' })).ec).toBeUndefined();
  });
  it('still deletes ts-ec on withdrawal when the passphrase is missing or short', async () => {
    for (const secrets of ['{"ec":{"passphrase":"short"}}', '{}']) {
      for (const [path, headers] of [['/_sid/v1', { 'Sec-GPC': '1' }], ['/_sid/v1?coppa=1', {}]] as const) {
        const { ec } = await call(path, { clientIp: '192.0.2.77' }, { ...headers, Cookie: `ts-ec=${'a'.repeat(64)}.Ab12z9` }, { SID_MODULE_SECRETS: secrets });
        expect(ec).toMatch(/^ts-ec=; Max-Age=0;/);
      }
    }
  });
});
