import { createHandler, defineModule, resolveConfig, type EdgeModule, type EncryptedIpValue, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import {
  base64url,
  createEncryptedIpModule,
  encryptedIpModule,
  encryptedIpSettings,
  encryptIp,
  fromBase64url,
  IP_KEY_MAX_AGE_MS,
  parseIpKey,
  type EncryptedIpModuleOptions
} from '../src/index.js';
import { open, recipient } from './receiver.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 3_600_000;
const HOST = 'pbs.example.com';
const OTHER_HOST = 'pbs.example.org:8443';
/** TC strings with only a core segment: Special Feature 1 and nothing else; and no special features. */
const TC_SF1 = 'CAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAA';
const TC_NONE = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type Receiver = Awaited<ReturnType<typeof recipient>>;
const google = await recipient('ypXWcw');
const pbs = await recipient('2026-11');
const pbsOther = await recipient('other-1');

const jwks = (r: Receiver): unknown => ({ keys: [r.jwk] });
// A generous time limit: a loaded test machine's first Web Crypto call can take longer than the default 50 ms.
const settings = (config: Record<string, unknown>): Record<string, string> => ({ SID_MODULES: 'encrypted-ip', SID_MODULE_TIMEOUT_MS: '5000', SID_MODULE_CONFIG: JSON.stringify({ 'encrypted-ip': config }) });
const both = settings({ google: { key: jwks(google) }, pbs: { [HOST]: { key: jwks(pbs) } } });

async function payload(env: Record<string, string>, platform: PlatformInfo = { clientIp: '192.0.2.77' }, path = '/_sid/v1', headers: Record<string, string> = {}, extra: { readonly modules?: readonly EdgeModule[]; readonly options?: EncryptedIpModuleOptions } = {}): Promise<PayloadV1> {
  const handler = createHandler({ config: resolveConfig(env), modules: [createEncryptedIpModule({ now: () => NOW, ...extra.options }), ...extra.modules ?? []] });
  return await (await handler(new Request(`https://www.example.com${path}`, { headers }), platform)).json() as PayloadV1;
}
async function decrypt(entry: EncryptedIpValue | undefined, r: Receiver): Promise<string> {
  const bytes = fromBase64url(entry?.value ?? expect.unreachable('no value')) ?? expect.unreachable('not base64url');
  return new TextDecoder().decode(await open(bytes, r.privateKey, r.publicKey));
}
const report = (body: PayloadV1): unknown => body.ext.modules['encrypted-ip'];

describe('base64url', () => {
  it('round-trips every length and refuses padding, other alphabets and stray bits', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) & 0xff);
      const encoded = base64url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).toHaveLength(Math.ceil((length * 4) / 3));
      expect(fromBase64url(encoded)).toEqual(bytes);
    }
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    for (const bad of ['QQ==', 'a+b/', 'A', 'AB', 'A B']) expect(fromBase64url(bad)).toBeUndefined();
    expect(fromBase64url('AA')).toEqual(new Uint8Array([0]));
  });
});

describe('recipient keys', () => {
  const x = google.jwk.x;
  it('reads a JWKS, taking its first X25519 key (the current one), or a single JWK', () => {
    expect(parseIpKey({ keys: [{ kty: 'EC', crv: 'P-256', x }, { kty: 'OKP', crv: 'X25519', x, kid: 'ypXWcw' }, { kty: 'OKP', crv: 'X25519', x: pbs.jwk.x, kid: 'old' }] })).toEqual({ kid: 'ypXWcw', x });
    expect(parseIpKey({ kty: 'OKP', crv: 'X25519', x })).toEqual({ x });
  });
  it.each([
    ['no keys', { keys: [] }],
    ['another curve', { kty: 'OKP', crv: 'Ed25519', x }],
    ['an x that isn\'t 32 bytes', { kty: 'OKP', crv: 'X25519', x: x.slice(0, 40) }],
    ['an x in standard base64', { kty: 'OKP', crv: 'X25519', x: `${x}=` }],
    ['an empty kid', { kty: 'OKP', crv: 'X25519', x, kid: '' }],
    ['a kid with a space', { kty: 'OKP', crv: 'X25519', x, kid: 'a b' }],
    ['not an object', 'key']
  ])('refuses %s', (_name, value) => {
    expect(() => parseIpKey(value)).toThrow(TypeError);
  });
  it('refuses a private key, without naming its value', () => {
    expect(() => parseIpKey({ kty: 'OKP', crv: 'X25519', x, d: 'c2VjcmV0' })).toThrow(/private part/);
    expect(() => parseIpKey({ kty: 'OKP', crv: 'X25519', x, d: 'c2VjcmV0' })).not.toThrow(/c2VjcmV0/);
  });
});

describe('settings', () => {
  it('accepts each recipient on its own or together, with or without a key and fetch time', () => {
    expect(encryptedIpSettings({ google: {} })).toEqual({ google: { key: undefined, keyFetched: undefined }, pbs: {} });
    expect(encryptedIpSettings({ pbs: { [HOST]: { key: pbs.jwk, keyFetched: '2026-11-19T10:00:00.5+01:00' } } })).toEqual({
      google: undefined, pbs: { [HOST]: { key: { kid: '2026-11', x: pbs.jwk.x }, keyFetched: Date.parse('2026-11-19T09:00:00.5Z') } }
    });
    expect(Object.keys(encryptedIpSettings({ google: {}, pbs: { [HOST]: {}, [OTHER_HOST]: {} } }).pbs)).toEqual([HOST, OTHER_HOST]);
  });
  it.each([
    [{}, /no recipient/],
    [{ pbs: {} }, /no recipient/],
    [{ other: 1 }, /unknown setting "other"/],
    [{ google: { url: 'x' } }, /google has an unknown setting "url"/],
    [{ google: { keyFetched: '2026-11-19T10:00:00Z' } }, /needs google.key/],
    [{ google: { key: google.jwk, keyFetched: '2026-11-19' } }, /time zone/],
    [{ google: { key: google.jwk, keyFetched: '2026-11-19T10:00:00' } }, /time zone/],
    [{ google: { key: { kty: 'OKP' } } }, /google.key: No X25519/],
    [{ google: 'on' }, /google must be an object/],
    [{ pbs: [] }, /keyed by Prebid Server host name/],
    [{ pbs: { 'PBS.example.com': {} } }, /lower-case host names/],
    [{ pbs: { 'https://pbs.example.com': {} } }, /lower-case host names/],
    [{ pbs: { [HOST]: { key: { ...pbs.jwk, d: 'c2VjcmV0' } } } }, /private part/]
  ])('refuses %j', (config, message) => {
    expect(() => encryptedIpSettings(config)).toThrow(message);
  });
});

describe('encryption', () => {
  it.each([
    ['203.0.113.42', 'IPv4'],
    ['2001:db8::8a2e:370:7334', 'IPv6'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'the longest IPv6']
  ])('round-trips %s (%s), in GPT\'s length range: 32 + length + 16 bytes', async address => {
    const value = await encryptIp(address, { x: google.jwk.x });
    expect(value).toMatch(/^[A-Za-z0-9_-]{67,124}$/);
    expect(fromBase64url(value)?.byteLength).toBe(32 + address.length + 16);
    expect(await decrypt({ value }, google)).toBe(address);
    expect(await encryptIp(address, { x: google.jwk.x })).not.toBe(value);
  });
});

describe('the encrypted-ip module in the handler', () => {
  it('does nothing unless listed in SID_MODULES', async () => {
    const body = await payload({ SID_MODULE_CONFIG: both['SID_MODULE_CONFIG'] ?? '' });
    expect(body).not.toHaveProperty('eip');
    expect(body.ext.modules).toEqual({});
  });

  it.each([
    ['192.0.2.77', '192.0.2.77'],
    ['::ffff:192.0.2.77', '192.0.2.77'],
    ['2001:DB8:0:0:abcd::1', '2001:db8::abcd:0:0:1']
  ])('encrypts %s as the bare address %s for Google only, outside ortb2', async (clientIp, plaintext) => {
    const body = await payload(settings({ google: { key: jwks(google) } }), { clientIp });
    expect(body.ortb2).toBeUndefined();
    expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
    expect(Object.keys(body.eip ?? {})).toEqual(['google']);
    expect(body.eip?.google?.kid).toBe('ypXWcw');
    expect(fromBase64url(body.eip?.google?.value ?? '')?.byteLength).toBe(32 + plaintext.length + 16);
    expect(await decrypt(body.eip?.google, google)).toBe(plaintext);
  });

  it('encrypts for a Prebid Server host only, keyed by host, to that host\'s key', async () => {
    const body = await payload(settings({ pbs: { [HOST]: { key: pbs.jwk } } }), { clientIp: '2001:db8::7' });
    expect(Object.keys(body.eip ?? {})).toEqual(['pbs']);
    expect(body.eip?.pbs?.[HOST]?.kid).toBe('2026-11');
    expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('2001:db8::7');
    await expect(decrypt(body.eip?.pbs?.[HOST], google)).rejects.toThrow();
  });

  it('encrypts separately for Google and several Prebid Server hosts, each readable only by its recipient', async () => {
    const body = await payload(settings({ google: { key: jwks(google) }, pbs: { [HOST]: { key: jwks(pbs) }, [OTHER_HOST]: { key: jwks(pbsOther) } } }));
    expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
    expect(await decrypt(body.eip?.google, google)).toBe('192.0.2.77');
    expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
    expect(await decrypt(body.eip?.pbs?.[OTHER_HOST], pbsOther)).toBe('192.0.2.77');
    await expect(decrypt(body.eip?.pbs?.[OTHER_HOST], pbs)).rejects.toThrow();
    // Fresh ephemeral keys: no two values share enc.
    const encs = [body.eip?.google, body.eip?.pbs?.[HOST], body.eip?.pbs?.[OTHER_HOST]].map(entry => entry?.value.slice(0, 43));
    expect(new Set(encs).size).toBe(3);
  });

  it('encrypts with opt-in to TCF Special Feature 1, as the ip module sends the address', async () => {
    const body = await payload(both, undefined, `/_sid/v1?gdpr=1&gdpr_consent=${TC_SF1}`);
    expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
  });

  const refuse = defineModule({ name: 'refuse', run: () => undefined, consent: () => ({ consent: 'denied', reason: 'refuse: advertising refused' }) });
  it.each([
    ['GPC', '/_sid/v1', {}, { 'Sec-GPC': '1' }, false],
    ['COPPA', '/_sid/v1?coppa=1', {}, {}, false],
    ['a US privacy opt-out', '/_sid/v1?us_privacy=1YYN', {}, {}, false],
    ['GDPR without a TC string', '/_sid/v1?gdpr=1', {}, {}, false],
    ['an EU visitor without a TC string', '/_sid/v1', { isEU: true }, {}, false],
    ['a TC string without Special Feature 1', `/_sid/v1?gdpr=1&gdpr_consent=${TC_NONE}`, {}, {}, false],
    ['the opt-out cookie', '/_sid/v1', {}, { Cookie: '_pubcid_optout=1' }, false],
    ['a consent provider\'s refusal', '/_sid/v1', {}, {}, true]
  ] as const)('sends nothing, for any recipient, with %s', async (_name, path, platform, headers, provider) => {
    const env = provider ? { ...both, SID_MODULES: 'refuse,encrypted-ip' } : both;
    const body = await payload(env, { clientIp: '192.0.2.77', ...platform }, path, headers, { modules: provider ? [refuse] : [] });
    expect(body).not.toHaveProperty('eip');
    expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'empty' });
  });

  it('sends nothing, without an error, when the platform has no valid client IP', async () => {
    for (const platform of [{}, { clientIp: 'not-an-ip' }]) {
      const body = await payload(both, platform);
      expect(body).not.toHaveProperty('eip');
      expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'empty' });
    }
  });

  it('leaves out a recipient without a key, with no error, and reports stale', async () => {
    const noGoogle = await payload(settings({ google: {}, pbs: { [HOST]: { key: jwks(pbs) } } }));
    expect(Object.keys(noGoogle.eip ?? {})).toEqual(['pbs']);
    expect(report(noGoogle)).toEqual({ ms: expect.any(Number) as number, status: 'ok', stale: true });
    const noPbs = await payload(settings({ google: { key: jwks(google) }, pbs: { [HOST]: {} } }));
    expect(Object.keys(noPbs.eip ?? {})).toEqual(['google']);
    expect(report(noPbs)).toMatchObject({ status: 'ok', stale: true });
    const none = await payload(settings({ google: {} }));
    expect(none).not.toHaveProperty('eip');
    expect(report(none)).toEqual({ ms: expect.any(Number) as number, status: 'empty', stale: true });
    // Consent ruling the address out doesn't hide a missing key.
    expect(report(await payload(settings({ google: {} }), undefined, '/_sid/v1?coppa=1'))).toMatchObject({ status: 'empty', stale: true });
  });

  it('marks only the recipient whose key is over 24 hours old (or too far ahead) stale, and keeps encrypting', async () => {
    const at = (time: number): string => new Date(time).toISOString();
    const fresh = await payload(settings({ google: { key: google.jwk, keyFetched: at(NOW - IP_KEY_MAX_AGE_MS) }, pbs: { [HOST]: { key: pbs.jwk, keyFetched: at(NOW) } } }));
    expect(report(fresh)).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
    for (const time of [NOW - IP_KEY_MAX_AGE_MS - 1, NOW + 6 * 60_000]) {
      const body = await payload(settings({ google: { key: google.jwk, keyFetched: at(NOW) }, pbs: { [HOST]: { key: pbs.jwk, keyFetched: at(time) } } }));
      expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok', stale: true });
      expect(body.eip?.google).not.toHaveProperty('stale');
      expect(body.eip?.pbs?.[HOST]?.stale).toBe(true);
      expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
    }
  });

  it('takes keys from scheduled snapshots for listed recipients, with their own age', async () => {
    const keys = {
      google: () => ({ data: { kid: 'ypXWcw', x: google.jwk.x }, checkedAt: NOW - HOUR }),
      pbs: { [HOST]: () => ({ data: { x: pbs.jwk.x }, checkedAt: NOW - 25 * HOUR }), [OTHER_HOST]: () => ({ data: { x: pbsOther.jwk.x }, checkedAt: NOW }) }
    };
    const body = await payload(settings({ google: {}, pbs: { [HOST]: {} } }), undefined, undefined, undefined, { options: { keys } });
    expect(await decrypt(body.eip?.google, google)).toBe('192.0.2.77');
    expect(body.eip?.google).toEqual({ value: expect.any(String) as string, kid: 'ypXWcw' });
    expect(body.eip?.pbs?.[HOST]?.stale).toBe(true);
    expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
    // The settings decide who's on: a snapshot for a host they don't list is ignored.
    expect(body.eip?.pbs).not.toHaveProperty(OTHER_HOST);
    expect(report(body)).toMatchObject({ status: 'ok', stale: true });
    const missing = await payload(settings({ google: {} }), undefined, undefined, undefined, { options: { keys: { google: () => undefined } } });
    expect(report(missing)).toMatchObject({ status: 'empty', stale: true });
  });

  it('is an error, with no field, on invalid settings, or a key both in settings and a snapshot', async () => {
    expect(report(await payload(settings({ google: { key: { kty: 'OKP' } } })))).toMatchObject({ status: 'error' });
    expect(report(await payload(settings({})))).toMatchObject({ status: 'error' });
    const doubled = await payload(settings({ google: { key: google.jwk } }), undefined, undefined, undefined, { options: { keys: { google: () => undefined } } });
    expect(doubled).not.toHaveProperty('eip');
    expect(report(doubled)).toMatchObject({ status: 'error' });
  });

  it('adds nothing to the sync pixel', async () => {
    const handler = createHandler({ config: resolveConfig(both), modules: [encryptedIpModule] });
    const response = await handler(new Request('https://www.example.com/_sid/sync'), { clientIp: '192.0.2.77' });
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(response.headers.get('X-SharedID-Modules')).toBeNull();
  });
});
