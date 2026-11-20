import { createHandler, defineModule, resolveConfig, type EdgeModule, type EncryptedIpValue, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import {
  base64url,
  createEncryptedIpModule,
  encryptedIpModule,
  encryptedIpSettings,
  encryptIp,
  fromBase64url,
  importIpKey,
  IP_KEY_MAX_AGE_MS,
  keyAge,
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
  const file = (...keys: unknown[]): Record<string, unknown> => ({ keys });
  it('reads a key file with exactly one X25519 key, as Google publishes it', () => {
    expect(parseIpKey(file({ kty: 'OKP', crv: 'X25519', x, kid: 'ypXWcw' }))).toEqual({ kid: 'ypXWcw', x });
    // Other members of the key, or of the file, are ignored.
    expect(parseIpKey({ ...file({ kty: 'OKP', crv: 'X25519', x, kid: 'k', use: 'enc' }), note: 1 })).toEqual({ kid: 'k', x });
  });
  it.each([
    ['no key', file(), /exactly one key; it has 0/],
    ['two keys, even both X25519', file(google.jwk, pbs.jwk), /exactly one key; it has 2/],
    ['a single JWK rather than a key file', google.jwk, /Not a key file/],
    ['another curve', file({ kty: 'OKP', crv: 'Ed25519', x, kid: 'k' }), /X25519/],
    ['an x that is not 32 bytes', file({ kty: 'OKP', crv: 'X25519', x: x.slice(0, 40), kid: 'k' }), /32 bytes/],
    ['an x in standard base64', file({ kty: 'OKP', crv: 'X25519', x: `${x}=`, kid: 'k' }), /32 bytes/],
    ['no kid', file({ kty: 'OKP', crv: 'X25519', x }), /kid/],
    ['an empty kid', file({ kty: 'OKP', crv: 'X25519', x, kid: '' }), /kid/],
    ['a kid with a space', file({ kty: 'OKP', crv: 'X25519', x, kid: 'a b' }), /kid/],
    ['not an object', 'key', /Not a key file/]
  ])('refuses %s', (_name, value, message) => {
    expect(() => parseIpKey(value)).toThrow(message);
  });
  it('refuses a private key, without naming its value', () => {
    expect(() => parseIpKey(file({ kty: 'OKP', crv: 'X25519', x, kid: 'k', d: 'c2VjcmV0' }))).toThrow(/private part/);
    expect(() => parseIpKey(file({ kty: 'OKP', crv: 'X25519', x, kid: 'k', d: 'c2VjcmV0' }))).not.toThrow(/c2VjcmV0/);
  });
});

describe('key age', () => {
  const at = (ms: number): ReturnType<typeof keyAge> => keyAge(NOW - ms, undefined, NOW);
  it('keeps a key fresh until its refresh time: an hour without a max-age, else the max-age, held to 1 minute to 24 hours', () => {
    expect(at(HOUR)).toEqual({ usable: true, stale: false });
    expect(at(HOUR + 1)).toEqual({ usable: true, stale: true });
    expect(keyAge(NOW - 3000_000, 3000, NOW)).toEqual({ usable: true, stale: false });
    expect(keyAge(NOW - 3000_001, 3000, NOW)).toEqual({ usable: true, stale: true });
    expect(keyAge(NOW - 61_000, 0, NOW).stale).toBe(true);
    expect(keyAge(NOW - 59_000, 0, NOW).stale).toBe(false);
    expect(keyAge(NOW - 2 * HOUR, 7 * 86_400, NOW).stale).toBe(false);
  });
  it('stops using a key fetched over 24 hours ago', () => {
    expect(at(IP_KEY_MAX_AGE_MS)).toEqual({ usable: true, stale: true });
    expect(at(IP_KEY_MAX_AGE_MS + 1)).toEqual({ usable: false, stale: true });
    expect(keyAge(NOW - IP_KEY_MAX_AGE_MS - 1, 7 * 86_400, NOW).usable).toBe(false);
  });
  it('marks a key more than 5 minutes ahead of the clock stale, and a key without a fetch time fresh', () => {
    expect(at(-5 * 60_000)).toEqual({ usable: true, stale: false });
    expect(at(-5 * 60_000 - 1)).toEqual({ usable: true, stale: true });
    expect(keyAge(undefined, undefined, NOW)).toEqual({ usable: true, stale: false });
  });
});

describe('settings', () => {
  it('accepts each recipient on its own or together, with or without a key, fetch time and max-age', () => {
    expect(encryptedIpSettings({ google: {} })).toEqual({ google: { key: undefined, keyFetched: undefined, keyMaxAge: undefined }, pbs: {} });
    expect(encryptedIpSettings({ pbs: { [HOST]: { key: jwks(pbs), keyFetched: '2026-11-19T10:00:00.5+01:00', keyMaxAge: 3000 } } })).toEqual({
      google: undefined, pbs: { [HOST]: { key: { kid: '2026-11', x: pbs.jwk.x }, keyFetched: Date.parse('2026-11-19T09:00:00.5Z'), keyMaxAge: 3000 } }
    });
    expect(Object.keys(encryptedIpSettings({ google: {}, pbs: { [HOST]: {}, [OTHER_HOST]: {} } }).pbs)).toEqual([HOST, OTHER_HOST]);
  });
  it.each([
    [{}, /no recipient/],
    [{ pbs: {} }, /no recipient/],
    [{ other: 1 }, /unknown setting "other"/],
    [{ google: { url: 'x' } }, /google has an unknown setting "url"/],
    [{ google: { keyFetched: '2026-11-19T10:00:00Z' } }, /needs google.key/],
    [{ google: { key: jwks(google), keyMaxAge: 3000 } }, /keyMaxAge needs google.keyFetched/],
    [{ google: { key: jwks(google), keyFetched: '2026-11-19T10:00:00Z', keyMaxAge: '3000' } }, /whole number of seconds/],
    [{ google: { key: jwks(google), keyFetched: '2026-11-19' } }, /time zone/],
    [{ google: { key: jwks(google), keyFetched: '2026-11-19T10:00:00' } }, /time zone/],
    [{ google: { key: google.jwk } }, /google.key: Not a key file/],
    [{ google: { key: { keys: [google.jwk, pbs.jwk] } } }, /google.key: A key file must hold exactly one key/],
    [{ google: 'on' }, /google must be an object/],
    [{ pbs: [] }, /keyed by Prebid Server host name/],
    [{ pbs: { 'PBS.example.com': {} } }, /lower-case host names/],
    [{ pbs: { 'https://pbs.example.com': {} } }, /lower-case host names/],
    [{ pbs: { [HOST]: { key: { keys: [{ ...pbs.jwk, d: 'c2VjcmV0' }] } } } }, /private part/]
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

describe('importing keys ahead of use', () => {
  it('imports a key once and encrypts with it, and rejects one that cannot be imported without keeping it', async () => {
    await expect(importIpKey({ x: google.jwk.x })).resolves.toBeUndefined();
    expect(await decrypt({ value: await encryptIp('192.0.2.1', { x: google.jwk.x }) }, google)).toBe('192.0.2.1');
    await expect(importIpKey({ x: 'not base64url!' })).rejects.toThrow();
    await expect(importIpKey({ x: 'not base64url!' })).rejects.toThrow();
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
    const body = await payload(settings({ pbs: { [HOST]: { key: jwks(pbs) } } }), { clientIp: '2001:db8::7' });
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

  it('marks a value stale past the refresh time of its key, per recipient, and still encrypts', async () => {
    const at = (time: number): string => new Date(time).toISOString();
    const fresh = await payload(settings({ google: { key: jwks(google), keyFetched: at(NOW - HOUR) }, pbs: { [HOST]: { key: jwks(pbs), keyFetched: at(NOW - 40 * 60_000), keyMaxAge: 3000 } } }));
    expect(report(fresh)).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
    for (const [time, maxAge] of [[NOW - HOUR - 1, undefined], [NOW - 3000_001, 3000], [NOW - 11 * 60_000, 600], [NOW + 6 * 60_000, undefined]] as const) {
      const body = await payload(settings({ google: { key: jwks(google), keyFetched: at(NOW) }, pbs: { [HOST]: { key: jwks(pbs), keyFetched: at(time), ...(maxAge === undefined ? {} : { keyMaxAge: maxAge }) } } }));
      expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok', stale: true });
      expect(body.eip?.google).not.toHaveProperty('stale');
      expect(body.eip?.pbs?.[HOST]).toMatchObject({ kid: '2026-11', stale: true });
      expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
    }
  });

  it('gives no value for a key fetched over 24 hours ago, whatever its max-age, and reports stale', async () => {
    const old = new Date(NOW - IP_KEY_MAX_AGE_MS - 1).toISOString();
    const body = await payload(settings({ google: { key: jwks(google), keyFetched: old, keyMaxAge: 7 * 86_400 }, pbs: { [HOST]: { key: jwks(pbs) } } }));
    expect(Object.keys(body.eip ?? {})).toEqual(['pbs']);
    expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok', stale: true });
    const only = await payload(settings({ google: { key: jwks(google), keyFetched: old } }));
    expect(only).not.toHaveProperty('eip');
    expect(report(only)).toEqual({ ms: expect.any(Number) as number, status: 'empty', stale: true });
  });

  it('treats a key setting without keyFetched as fresh', async () => {
    const body = await payload(settings({ google: { key: jwks(google) } }));
    expect(report(body)).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
  });

  it('takes keys from scheduled snapshots for listed recipients, with their own age and max-age', async () => {
    const keys = {
      google: () => ({ data: { kid: 'ypXWcw', x: google.jwk.x, maxAgeSeconds: 3000 }, checkedAt: NOW - 49 * 60_000 }),
      pbs: {
        [HOST]: () => ({ data: { kid: '2026-11', x: pbs.jwk.x }, checkedAt: NOW - 2 * HOUR }),
        [OTHER_HOST]: () => ({ data: { kid: 'other-1', x: pbsOther.jwk.x }, checkedAt: NOW })
      }
    };
    const body = await payload(settings({ google: {}, pbs: { [HOST]: {} } }), undefined, undefined, undefined, { options: { keys } });
    expect(await decrypt(body.eip?.google, google)).toBe('192.0.2.77');
    expect(body.eip?.google).toEqual({ value: expect.any(String) as string, kid: 'ypXWcw' });
    expect(body.eip?.pbs?.[HOST]?.stale).toBe(true);
    expect(await decrypt(body.eip?.pbs?.[HOST], pbs)).toBe('192.0.2.77');
    // The settings decide who's on: a snapshot for a host they don't list is ignored.
    expect(body.eip?.pbs).not.toHaveProperty(OTHER_HOST);
    expect(report(body)).toMatchObject({ status: 'ok', stale: true });
    const expired = await payload(settings({ google: {} }), undefined, undefined, undefined, { options: { keys: { google: () => ({ data: { kid: 'k', x: google.jwk.x }, checkedAt: NOW - 25 * HOUR }) } } });
    expect(expired).not.toHaveProperty('eip');
    expect(report(expired)).toMatchObject({ status: 'empty', stale: true });
    const missing = await payload(settings({ google: {} }), undefined, undefined, undefined, { options: { keys: { google: () => undefined } } });
    expect(report(missing)).toMatchObject({ status: 'empty', stale: true });
  });

  it('is an error, with no field, on invalid settings, or a key both in settings and a snapshot', async () => {
    expect(report(await payload(settings({ google: { key: { kty: 'OKP' } } })))).toMatchObject({ status: 'error' });
    expect(report(await payload(settings({ google: { key: { keys: [google.jwk, pbs.jwk] } } })))).toMatchObject({ status: 'error' });
    expect(report(await payload(settings({})))).toMatchObject({ status: 'error' });
    const doubled = await payload(settings({ google: { key: jwks(google) } }), undefined, undefined, undefined, { options: { keys: { google: () => undefined } } });
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
