import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { createEncryptedIpModule } from '@sharedid-edge/module-encrypted-ip';
import { GOOGLE_IP_KEY_URL, googleIpKeySource, pbsIpKeySource, validateIpKey } from '../src/encrypted-ip.js';
import { refreshData, SnapshotCache } from '../src/index.js';
import { MemoryStore } from './helpers.js';

const X = 'OQOocFPWwDfHQ1SdhGII-6_DHfAqamg2qC2E5kygfis';
const X2 = 'Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw';
const JWKS = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X, kid: 'ypXWcw' }] });
const PBS_URL = 'https://pbs.example.com/ip_enc_key.json';
const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 3_600_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function serve(body: string, init: ResponseInit = {}): ReturnType<typeof vi.fn<Fetch>> {
  return vi.fn<Fetch>(() => Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3000' }, ...init })));
}

describe('IP key sources', () => {
  it('downloads Google\'s JWKS without credentials and publishes only its X25519 key', async () => {
    const store = new MemoryStore();
    const fetch = serve(JWKS);
    expect(await refreshData(googleIpKeySource(), { store, fetch, now: () => NOW, secrets: { 'google-ip-key': { unused: 'secret-value' } } })).toEqual({ name: 'google-ip-key', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(GOOGLE_IP_KEY_URL);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    const cache = new SnapshotCache(store, 'google-ip-key', validateIpKey, 0, () => NOW);
    expect(await cache.reload()).toBe(true);
    expect(cache.current?.data).toEqual({ kid: 'ypXWcw', x: X });
    expect([...store.values.values()].join('')).not.toContain('secret-value');
    // The same key again only refreshes the manifest's check time.
    expect(await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS), now: () => NOW + HOUR })).toEqual({ name: 'google-ip-key', status: 'unchanged' });
  });

  it('downloads a Prebid Server host\'s JWKS from its URL, taking the current (first) of its keys', async () => {
    const store = new MemoryStore();
    const fetch = serve(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X2, kid: '2026-11' }, { kty: 'OKP', crv: 'X25519', x: X, kid: '2026-10' }] }));
    const source = pbsIpKeySource({ name: 'pbs-example', url: PBS_URL });
    expect(await refreshData(source, { store, fetch, now: () => NOW })).toEqual({ name: 'pbs-example', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(PBS_URL);
    const cache = new SnapshotCache(store, 'pbs-example', validateIpKey, 0, () => NOW);
    await cache.reload();
    expect(cache.current?.data).toEqual({ kid: '2026-11', x: X2 });
  });

  it.each([
    ['plain http', 'http://pbs.example.com/k.json'],
    ['credentials in the URL', 'https://user:pass@pbs.example.com/k.json']
  ])('refuses a Prebid Server key URL with %s', (_name, url) => {
    expect(() => pbsIpKeySource({ name: 'pbs-example', url })).toThrow(/https, without credentials/);
  });

  it.each([
    ['no X25519 key', JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: X }] })],
    ['an x of the wrong length', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X.slice(0, 40) }] })],
    ['a private key', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X, d: X }] })],
    ['not JSON', '<html>'],
    ['too large', JSON.stringify({ keys: [{ kty: 'OKP', crv: 'X25519', x: X }], padding: 'x'.repeat(20_000) })]
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

  it('feeds the module: a snapshot\'s check time decides staleness, per recipient', async () => {
    const store = new MemoryStore();
    await refreshData(googleIpKeySource(), { store, fetch: serve(JWKS), now: () => NOW - 25 * HOUR });
    const cache = new SnapshotCache(store, 'google-ip-key', validateIpKey, 0, () => NOW);
    await cache.reload();
    const module = createEncryptedIpModule({ keys: { google: () => cache.current }, now: () => NOW });
    const handler = createHandler({ config: resolveConfig({ SID_MODULES: 'encrypted-ip', SID_MODULE_TIMEOUT_MS: '5000', SID_MODULE_CONFIG: '{"encrypted-ip":{"google":{}}}' }), modules: [module] });
    const body = await (await handler(new Request('https://www.example.com/_sid/v1'), { clientIp: '203.0.113.42' })).json() as PayloadV1;
    expect(body.eip?.google).toEqual({ value: expect.stringMatching(/^[A-Za-z0-9_-]{80}$/) as string, kid: 'ypXWcw', stale: true });
    expect(body.ext.modules['encrypted-ip']).toMatchObject({ status: 'ok', stale: true });
  });
});
