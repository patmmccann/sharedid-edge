import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { decodeRangeTable, ipDatabaseModule } from '@sharedid-edge/ip-ranges';
import type * as IpRanges from '@sharedid-edge/ip-ranges';
import { buildCountryData, writeMmdb } from '@sharedid-edge/ip-ranges/build';
import { countrySnapshotModule, validateCountrySnapshot } from '../src/ip-module.js';
import { refreshData, SnapshotCache, type UpdateSource } from '../src/index.js';
import { MemoryStore } from './helpers.js';

// Counts decodes through the package API, and records what the lookup module is built from (a string would be decoded
// inside ipDatabaseModule, during a request).
vi.mock('@sharedid-edge/ip-ranges', async original => {
  const actual = await original<typeof IpRanges>();
  return { ...actual, decodeRangeTable: vi.fn(actual.decodeRangeTable), ipDatabaseModule: vi.fn(actual.ipDatabaseModule) };
});

describe('country snapshot decoding', () => {
  it('decodes the range table once, in the background reload, and never while answering requests', async () => {
    const file = writeMmdb({ databaseType: 'DBIP-Country-Lite', ipVersion: 6, networks: [{ network: '192.0.2.0/24', record: { country: { iso_code: 'FR' } } }] });
    const { data, info } = await buildCountryData(file, { database: () => 'test', attribution: 'Test', ipv4Only: false, databaseType: () => true });
    const source: UpdateSource = { name: 'dbip', validate: validateCountrySnapshot, decode: () => ({ data, info }), download: () => Promise.resolve({ bytes: new Uint8Array() }) };
    const store = new MemoryStore();
    const now = (): number => Date.parse('2026-11-13');
    await refreshData(source, { store, now });
    const cache = new SnapshotCache(store, 'dbip', validateCountrySnapshot, 0, now);
    const decode = vi.mocked(decodeRangeTable);
    decode.mockClear();
    await cache.reload();
    expect(decode).toHaveBeenCalledOnce();
    const module = countrySnapshotModule({ name: 'dbip', snapshot: () => cache.current, maxAgeMs: 1000, now });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'dbip' }) });
    for (let request = 0; request < 2; request++) {
      const body = await (await handler(new Request('https://example.com/_sid/v1'), { clientIp: '192.0.2.7' })).json() as PayloadV1;
      expect(body).toMatchObject({ ortb2: { device: { geo: { country: 'FRA' } } } });
    }
    expect(decode).toHaveBeenCalledOnce();
    const created = vi.mocked(ipDatabaseModule).mock.calls;
    expect(created).toHaveLength(1);
    expect(typeof created[0]?.[0].data).toBe('object');
  });
});
