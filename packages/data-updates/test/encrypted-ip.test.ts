import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { createEncryptedIpModule } from '@sharedid-edge/module-encrypted-ip';
import { cacheMaxAge, GOOGLE_IP_KEY_URL, googleIpKeySource, pbsIpKeySource, validateIpKey } from '../src/encrypted-ip.js';
import { refreshData, SnapshotCache } from '../src/index.js';
import { MemoryStore } from './helpers.js';

const X = 'OQOocFPWwDfHQ1SdhGII-6_DHfAqamg2qC2E5kygfis';
const X2 = 'Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw';
const JWKS = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X, kid: 'ypXWcw' }] });
const PBS_URL = 'https://pbs.example.com/ip_enc_key.json';
const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 3_600_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function serve(body: string, init: ResponseInit = {}, cacheControl: string | null = 'public, max-age=3000'): ReturnType<typeof vi.fn<Fetch>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(cacheControl === null ? {} : { 'Cache-Control': cacheControl }) };
  return vi.fn<Fetch>(() => Promise.resolve(new Response(body, { headers, ...init })));
}

async function stored(store: MemoryStore, name: string): Promise<unknown> {
  const cache = new SnapshotCache(store, name, validateIpKey, 0, () => NOW);
  await cache.reload();
  return cache.current?.data;
}

describe('Cache-Control max-age', () => {
  it.each([
    ['public, max-age=3000', 3000],
    ['max-age="600", must-revalidate', 600],
    ['Public, Max-Age=60', 60],
    ['no-store', 0],
    ['max-age=3000, no-cache', 0],
    ['public', undefined],
    ['max-age=-1', undefined],
    [null, undefined]
  ])('reads %j as %j', (header, expected) => {
    expect(cacheMaxAge(header)).toBe(expected);
  });
});

describe('IP key sources', () => {
  it('downloads Google\'s key file without credentials and publishes its one key with the file\'s max-age', async () => {
    const store = new MemoryStore();
    const fetch = serve(JWKS);
    expect(await refreshData(googleIpKeySource(), { store, fetch, now: () => NOW, secrets: { 'google-ip-key': { unused: 'secret-value' } } })).toEqual({ name: 'google-ip-key', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(GOOGLE_IP_KEY_URL);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(await stored(store, 'google-ip-key')).toEqual({ kid: 'ypXWcw', x: X, maxAgeSeconds: 3000 });
    expect([...store.values.values()].join('')).not.toContain('secret-value');
    // The same key again only refreshes the manifest's check time.
    expect(await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS), now: () => NOW + HOUR })).toEqual({ name: 'google-ip-key', status: 'unchanged' });
  });

  it('publishes a key without a max-age when the file has none', async () => {
    const store = new MemoryStore();
    await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS, {}, null), now: () => NOW });
    expect(await stored(store, 'google-ip-key')).toEqual({ kid: 'ypXWcw', x: X });
  });

  it('downloads a Prebid Server host\'s key file from its URL', async () => {
    const store = new MemoryStore();
    const fetch = serve(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X2, kid: '2026-11' }] }), {}, 'max-age=600');
    const source = pbsIpKeySource({ name: 'pbs-example', url: PBS_URL });
    expect(await refreshData(source, { store, fetch, now: () => NOW })).toEqual({ name: 'pbs-example', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(PBS_URL);
    expect(await stored(store, 'pbs-example')).toEqual({ kid: '2026-11', x: X2, maxAgeSeconds: 600 });
  });

  it.each([
    ['plain http', 'http://pbs.example.com/k.json'],
    ['credentials in the URL', 'https://user:pass@pbs.example.com/k.json']
  ])('refuses a Prebid Server key URL with %s', (_name, url) => {
    expect(() => pbsIpKeySource({ name: 'pbs-example', url })).toThrow(/https, without credentials/);
  });

  it.each([
    ['no key', JSON.stringify({ keys: [] })],
    ['two keys', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X2, kid: 'new' }, { kty: 'OKP', crv: 'X25519', x: X, kid: 'old' }] })],
    ['another key type', JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: X, kid: 'k' }] })],
    ['no kid', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X }] })],
    ['an x of the wrong length', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X.slice(0, 40), kid: 'k' }] })],
    ['a private key', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X, kid: 'k', d: X }] })],
    ['not JSON', '<html>'],
    ['too large', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X, kid: 'k' }], padding: 'x'.repeat(20_000) })]
  ])('fails on %s and keeps the previous key', async (_name, body) => {
    const store = new MemoryStore();
    await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS), now: () => NOW });
    const before = new Map(store.values);
    expect(await refreshData(googleIpKeySource(), { store, fetch: serve(body), now: () => NOW + HOUR })).toEqual({ name: 'google-ip-key', status: 'failed' });
    expect(store.values).toEqual(before);
  });

  it('fails on an HTTP error', async () => {
    expect(await refreshData(googleIpKeySource(), { store: new MemoryStore(), fetch: serve('', { status: 503 }), now: () => NOW })).toEqual({ name: 'google-ip-key', status: 'failed' });
  });

  it('refuses a stored snapshot that isn\'t a key', () => {
    expect(() => validateIpKey({ kid: 'k', x: X, maxAgeSeconds: -1 })).toThrow();
    expect(() => validateIpKey({ x: X })).toThrow(/kid/);
    expect(() => validateIpKey([X])).toThrow();
  });

  describe('feeding the module', () => {
    async function payloadAt(checkedAt: number): Promise<PayloadV1> {
      const store = new MemoryStore();
      await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS), now: () => checkedAt });
      const cache = new SnapshotCache(store, 'google-ip-key', validateIpKey, 0, () => NOW);
      await cache.reload();
      const module = createEncryptedIpModule({ keys: { google: () => cache.current }, now: () => NOW });
      const handler = createHandler({ config: resolveConfig({ SID_MODULES: 'encrypted-ip', SID_MODULE_TIMEOUT_MS: '5000', SID_MODULE_CONFIG: '{"encrypted-ip":{"google":{}}}' }), modules: [module] });
      return await (await handler(new Request('https://www.example.com/_sid/v1'), { clientIp: '203.0.113.42' })).json() as PayloadV1;
    }

    it('uses the key, fresh until the file\'s max-age, then stale, then not at all after 24 hours', async () => {
      const value = expect.stringMatching(/^[A-Za-z0-9_-]{80}$/) as string;
      expect((await payloadAt(NOW - 49 * 60_000)).eip?.google).toEqual({ value, kid: 'ypXWcw' });
      const stale = await payloadAt(NOW - 51 * 60_000);
      expect(stale.eip?.google).toEqual({ value, kid: 'ypXWcw', stale: true });
      expect(stale.ext.modules['encrypted-ip']).toMatchObject({ status: 'ok', stale: true });
      const expired = await payloadAt(NOW - 25 * HOUR);
      expect(expired).not.toHaveProperty('eip');
      expect(expired.ext.modules['encrypted-ip']).toMatchObject({ status: 'empty', stale: true });
    });
  });
});
