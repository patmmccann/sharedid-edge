import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { writeMmdb } from '@sharedid-edge/ip-ranges/build';
import { dbipSource, maxmindSource } from '../src/country.js';
import { countrySnapshotModule, validateCountrySnapshot } from '../src/ip-module.js';
import { refreshData, SnapshotCache } from '../src/index.js';
import { MemoryStore } from './helpers.js';

function database(type: string, country = 'FR'): Uint8Array {
  return writeMmdb({ databaseType: type, ipVersion: 6, networks: [
    { network: '192.0.2.0/24', record: { country: { iso_code: country } } },
    { network: '2001:db8::/32', record: { country: { iso_code: 'JP' } } }
  ] });
}

describe('country database sources', () => {
  it('strips authorization on cross-origin archive/checksum redirects, stores no signed URLs, and refuses downgrade redirects', async () => {
    const source = maxmindSource({ attribution: 'test' });
    const file = database('GeoLite2-Country');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', file))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const store = new MemoryStore();
    const secrets = { maxmind: { accountId: 'account', licenseKey: 'private-key' } };
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      const checksum = url.includes('sha256');
      if (new URL(url).hostname === 'download.maxmind.com') {
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('account:private-key')}`);
        return Promise.resolve(new Response(null, { status: 302, headers: { Location: `https://storage.example/${checksum ? 'sha256' : 'archive'}?signature=private-signed-url` } }));
      }
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
      return Promise.resolve(checksum ? new Response(digest) : new Response(file));
    });
    expect(await refreshData(source, { store, secrets, fetch })).toMatchObject({ status: 'updated' });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify([...store.values])).not.toMatch(/private-key|private-signed-url/);
    const previous = store.values.get('maxmind/current.json');
    const downgrade = vi.fn(() => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'http://download.maxmind.com/insecure' } })));
    expect(await refreshData(source, { store, secrets, fetch: downgrade })).toMatchObject({ status: 'failed' });
    expect(downgrade).toHaveBeenCalledTimes(1);
    expect(store.values.get('maxmind/current.json')).toBe(previous);
  });
  it('falls back only on 404, publishes a validated MMDB, and updates IPv4 and IPv6 lookups without downloading in run', async () => {
    const source = dbipSource({ attribution: 'Test attribution' });
    const store = new MemoryStore();
    const fetch = vi.fn((url: string) => Promise.resolve(url.includes('2026-11') ? new Response(null, { status: 404 }) : new Response(database('DBIP-Country-Lite'), { headers: { ETag: 'v1' } })));
    const now = (): number => Date.parse('2026-11-13');
    expect(await refreshData(source, { store, fetch, now })).toMatchObject({ status: 'updated' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz',
      'https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz'
    ]);
    const cache = new SnapshotCache(store, 'dbip', validateCountrySnapshot, 0, now);
    await cache.reload();
    const module = countrySnapshotModule({ name: 'dbip', snapshot: () => cache.current, maxAgeMs: 1000, now });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'dbip' }) });
    const payload = async (ip: string): Promise<PayloadV1> => await (await handler(new Request('https://example.com/_sid/v1'), { clientIp: ip })).json() as PayloadV1;
    const calls = fetch.mock.calls.length;
    const storageCalls = store.get.mock.calls.length;
    expect(await payload('192.0.2.7')).toMatchObject({ ortb2: { device: { geo: { country: 'FRA' } } } });
    expect(await payload('2001:db8::1')).toMatchObject({ ortb2: { device: { geo: { country: 'JPN' } } } });
    expect(fetch.mock.calls).toHaveLength(calls);
    expect(store.get.mock.calls).toHaveLength(storageCalls);
    await refreshData(source, { store, fetch: () => Promise.resolve(new Response(database('DBIP-Country-Lite', 'DE'))), now });
    await cache.reload();
    expect(await payload('192.0.2.7')).toMatchObject({ ortb2: { device: { geo: { country: 'DEU' } } } });
    expect(cache.current?.data.info.attribution).toBe('Test attribution');
  });

  it('uses validators to reject corrupt, mismatched, empty and executable downloads', async () => {
    const source = dbipSource({ attribution: 'Test attribution' });
    for (const bytes of [database('Wrong-Type'), database('DBIP-Country-Lite').subarray(0, 10), new TextEncoder().encode('throw Error("executed")')]) {
      const store = new MemoryStore();
      expect(await refreshData(source, { store, fetch: () => Promise.resolve(new Response(bytes)) })).toMatchObject({ status: 'failed' });
      expect(store.put).not.toHaveBeenCalled();
    }
  });

  it('sends a conditional request only to the same DB-IP release URL', async () => {
    const source = dbipSource({ attribution: 'test' });
    const store = new MemoryStore();
    const options = { store, now: () => Date.parse('2026-11-13') };
    await refreshData(source, { ...options, fetch: () => Promise.resolve(new Response(database('DBIP-Country-Lite'), { headers: { ETag: 'release' } })) });
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('If-None-Match')).toBe('release');
      return Promise.resolve(new Response(null, { status: 304 }));
    });
    expect(await refreshData(source, { ...options, fetch })).toMatchObject({ status: 'unchanged' });
    await refreshData(source, { store, now: () => Date.parse('2026-12-13'), fetch: (_url, init) => {
      expect(new Headers(init?.headers).has('If-None-Match')).toBe(false);
      return Promise.resolve(new Response(database('DBIP-Country-Lite')));
    } });
  });

  it('keeps MaxMind credentials out of storage, checks SHA-256, and fails closed on a bad checksum or rejected key', async () => {
    const bytes = database('GeoLite2-Country');
    const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const source = maxmindSource({ attribution: 'Test MaxMind attribution' });
    const store = new MemoryStore();
    const secrets = { maxmind: { accountId: 'private-account', licenseKey: 'private-key' } };
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('private-account:private-key')}`);
      return Promise.resolve(url.endsWith('.sha256') ? new Response(`${checksum} file.tar.gz`) : new Response(bytes));
    });
    expect(await refreshData(source, { store, secrets, fetch })).toMatchObject({ status: 'updated' });
    const stored = JSON.stringify([...store.values]);
    expect(stored).not.toMatch(/private-account|private-key|Basic/);
    expect(stored).not.toContain(btoa('private-account:private-key'));
    const previous = store.values.get('maxmind/current.json');
    expect(await refreshData(source, { store, secrets, fetch: url => Promise.resolve(url.endsWith('.sha256') ? new Response('bad') : new Response(bytes)) })).toMatchObject({ status: 'failed' });
    expect(await refreshData(source, { store, secrets, fetch: () => Promise.resolve(new Response(null, { status: 401 })) })).toMatchObject({ status: 'failed' });
    expect(await refreshData(source, { store, fetch })).toMatchObject({ status: 'failed' });
    expect(store.values.get('maxmind/current.json')).toBe(previous);
  });

  it('cancels the body of a failed database or checksum response before failing', async () => {
    const failing = (cancel: () => void): Response => new Response(new ReadableStream({ cancel }), { status: 500 });
    const bytes = database('GeoLite2-Country');
    const secrets = { maxmind: { accountId: 'account', licenseKey: 'key' } };
    for (const stage of ['database', 'checksum'] as const) {
      const cancel = vi.fn();
      const fetch = (url: string): Promise<Response> => Promise.resolve(url.endsWith('.sha256') === (stage === 'checksum') ? failing(cancel) : new Response(bytes));
      expect(await refreshData(maxmindSource({ attribution: 'test' }), { store: new MemoryStore(), secrets, fetch })).toMatchObject({ status: 'failed' });
      expect(cancel).toHaveBeenCalledOnce();
    }
    const cancel = vi.fn();
    expect(await refreshData(dbipSource({ attribution: 'test' }), { store: new MemoryStore(), fetch: () => Promise.resolve(failing(cancel)) })).toMatchObject({ status: 'failed' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
