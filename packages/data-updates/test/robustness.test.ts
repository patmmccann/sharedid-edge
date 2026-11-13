import { describe, expect, it, vi } from 'vitest';
import { readSnapshot, refreshData, runUpdates, SnapshotCache, type UpdateSource } from '../src/index.js';
import { listSource, MemoryStore, numbers } from './helpers.js';

const bodies = (store: MemoryStore): string[] => [...store.values.keys()].filter(key => key !== 'list/current.json');
const changing = (values: readonly number[]): UpdateSource<readonly number[]> => ({
  ...listSource(), download: () => Promise.resolve({ bytes: new TextEncoder().encode(JSON.stringify(values)) })
});

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try { return { result: await work(), logged: log.mock.calls }; } finally { log.mockRestore(); }
}

describe('manifest and storage failures', () => {
  it.each([
    ['corrupt', '{"version":1,"source":"li'],
    ['future-schema', JSON.stringify({ version: 2, source: 'list', hash: 'a'.repeat(64), checkedAt: 1 })]
  ])('republishes over a %s manifest instead of failing forever, logging a fixed message', async (_kind, manifest) => {
    const store = new MemoryStore();
    store.values.set('list/current.json', manifest);
    const { result, logged } = await quietly(() => refreshData(listSource(), { store, now: () => 1000 }));
    expect(result).toEqual({ name: 'list', status: 'updated' });
    expect(logged).toEqual([['list: unreadable snapshot manifest; republishing']]);
    expect(await readSnapshot(store, 'list', numbers)).toMatchObject({ data: [1, 2], checkedAt: 1000 });
  });

  it('still fails without publishing when storage cannot be read', async () => {
    const store = new MemoryStore();
    const source = listSource();
    store.get.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await refreshData(source, { store })).toMatchObject({ status: 'failed' });
    expect(source.download).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('rejects an invalid timeout before running any source', async () => {
    const source = listSource();
    for (const timeoutMs of [0, 1.5, 300_001, Number.NaN]) {
      await expect(runUpdates([source], { store: new MemoryStore(), timeoutMs })).rejects.toThrow('Invalid update timeout');
    }
    expect(source.download).not.toHaveBeenCalled();
  });

  it.each(['manifest read', 'body read', 'body write', 'manifest write'] as const)('times out a hung store during the %s', async stage => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store });
    const previous = store.values.get('list/current.json');
    const get = store.get.getMockImplementation();
    const put = store.put.getMockImplementation();
    if (get === undefined || put === undefined) throw new Error('Missing test store');
    const hang = (): Promise<never> => new Promise<never>(() => undefined);
    const manifest = stage.startsWith('manifest');
    store.get.mockImplementation(key => stage.endsWith('read') && manifest === key.endsWith('current.json') ? hang() : get(key));
    store.put.mockImplementation((key, value) => stage.endsWith('write') && manifest === key.endsWith('current.json') ? hang() : put(key, value));
    expect(await refreshData(changing([3]), { store, timeoutMs: 20 })).toMatchObject({ status: 'failed' });
    expect(store.values.get('list/current.json')).toBe(previous);
  });
});

describe('previous body checks', () => {
  it('checks the previous body by hash without validating it again, reusing the manifest read', async () => {
    const store = new MemoryStore();
    const validate = vi.fn(numbers);
    const source = { ...listSource(), validate };
    await refreshData(source, { store });
    validate.mockClear();
    store.get.mockClear();
    expect(await refreshData({ ...source, download: () => Promise.resolve(undefined) }, { store })).toMatchObject({ status: 'unchanged' });
    expect(validate).not.toHaveBeenCalled();
    expect(store.get).toHaveBeenCalledTimes(2); // The manifest once and the body once, for its hash.
  });

  it('downloads unconditionally and rewrites a corrupt previous body', async () => {
    const store = new MemoryStore();
    const source = listSource();
    await refreshData(source, { store });
    const [body] = bodies(store);
    if (body === undefined) throw new Error('Missing test body');
    store.values.set(body, 'corrupt');
    expect(await refreshData({ ...source, download: context => {
      expect(context.previous).toBeUndefined();
      return source.download(context);
    } }, { store })).toMatchObject({ status: 'updated' });
    expect(await readSnapshot(store, 'list', numbers)).toMatchObject({ data: [1, 2] });
  });
});

describe('superseded bodies', () => {
  it('deletes the replaced body only after the new manifest is published, never the current one', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store });
    const [first] = bodies(store);
    const order: string[] = [];
    store.put.mockImplementation((key, value) => { order.push(`put ${key}`); store.values.set(key, value); return Promise.resolve(); });
    store.delete.mockImplementation(key => { order.push(`delete ${key}`); store.values.delete(key); return Promise.resolve(); });
    expect(await refreshData(changing([3]), { store })).toMatchObject({ status: 'updated' });
    expect(order.slice(-2)).toEqual(['put list/current.json', `delete ${String(first)}`]);
    expect(bodies(store)).toHaveLength(1);
    expect(await readSnapshot(store, 'list', numbers)).toMatchObject({ data: [3] });
    expect(await refreshData(changing([3]), { store })).toMatchObject({ status: 'unchanged' });
    expect(bodies(store)).toHaveLength(1);
    expect(await readSnapshot(store, 'list', numbers)).toMatchObject({ data: [3] });
  });

  it('retries a failed deletion on the next run without failing the update', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store });
    const [first] = bodies(store);
    if (first === undefined) throw new Error('Missing test body');
    store.delete.mockRejectedValueOnce(new Error('denied'));
    const { result, logged } = await quietly(() => refreshData(changing([3]), { store }));
    expect(result).toMatchObject({ status: 'updated' });
    expect(logged).toEqual([['list: could not delete superseded snapshot bodies; retrying on the next run']]);
    expect(store.values.has(first)).toBe(true);
    expect(JSON.parse(store.values.get('list/current.json') ?? '{}')).toMatchObject({ superseded: [first.slice('list/'.length, -'.json'.length)] });
    expect(await refreshData(changing([3]), { store })).toMatchObject({ status: 'unchanged' });
    expect(store.values.has(first)).toBe(false);
    expect(JSON.parse(store.values.get('list/current.json') ?? '{}')).not.toHaveProperty('superseded');
  });

  it('keeps the old body while the new manifest does not read back yet (eventually consistent storage)', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store });
    const [first] = bodies(store);
    const previous = store.values.get('list/current.json');
    const get = store.get.getMockImplementation();
    if (first === undefined || get === undefined) throw new Error('Missing test body');
    let reads = 0;
    store.get.mockImplementation(key => key.endsWith('current.json') && ++reads === 2 ? Promise.resolve(previous) : get(key));
    expect(await refreshData(changing([3]), { store })).toMatchObject({ status: 'updated' });
    expect(store.values.has(first)).toBe(true);
    store.get.mockImplementation(get);
    await refreshData(changing([3]), { store });
    expect(store.values.has(first)).toBe(false);
  });
});

describe('clock skew', () => {
  it('accepts a manifest a few minutes ahead of the reader clock, but not further', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store, now: () => 1_000_000 + 4 * 60_000 });
    expect(await new SnapshotCache(store, 'list', numbers, 0, () => 1_000_000).reload()).toBe(true);
    await refreshData(listSource(), { store, now: () => 1_000_000 + 6 * 60_000 });
    expect(await new SnapshotCache(store, 'list', numbers, 0, () => 1_000_000).reload()).toBe(false);
  });
});
