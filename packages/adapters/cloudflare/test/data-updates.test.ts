import { expect, it } from 'vitest';
import { refreshData, SnapshotCache, type SnapshotStore, type UpdateSource } from '@sharedid-edge/data-updates';
import { kvStore, r2Store } from '@sharedid-edge/data-updates/cloudflare';

it('validates and hashes snapshots inside workerd, with Workers-compatible storage bindings', async () => {
  // These assignments check the published structural API against the actual generated Workers runtime types.
  const r2: (binding: R2Bucket) => SnapshotStore = r2Store;
  const kv: (binding: KVNamespace) => SnapshotStore = kvStore;
  const values = new Map<string, string>();
  const store = kvStore({
    get: key => Promise.resolve(values.get(key) ?? null),
    put: (key, value) => { values.set(key, value); return Promise.resolve(); },
    delete: key => { values.delete(key); return Promise.resolve(); }
  });
  expect(r2).toBe(r2Store);
  expect(kv).toBe(kvStore);
  const source: UpdateSource<string> = {
    name: 'list', download: () => Promise.resolve({ bytes: new TextEncoder().encode('fixture') }),
    decode: bytes => new TextDecoder().decode(bytes),
    validate: value => {
      if (typeof value !== 'string') throw new TypeError('Invalid fixture');
      return value;
    }
  };
  expect(await refreshData(source, { store })).toEqual({ name: 'list', status: 'updated' });
  const cache = new SnapshotCache(store, 'list', source.validate);
  expect(await cache.reload()).toBe(true);
  expect(cache.current?.data).toBe('fixture');
});
