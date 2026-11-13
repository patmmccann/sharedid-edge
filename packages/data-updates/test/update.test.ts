import { describe, expect, it } from 'vitest';
import { readSnapshot, refreshData, runUpdates, SnapshotCache, updateSecrets, type UpdateSource } from '../src/index.js';
import { listSource, MemoryStore, numbers } from './helpers.js';

describe('scheduled publication', () => {
  it('disables cached ETags when transformation options change', async () => {
    const source = listSource();
    const store = new MemoryStore();
    await refreshData({ ...source, variant: 'v1' }, { store });
    expect(await refreshData({ ...source, variant: 'v2', download: context => {
      expect(context.previous).toBeUndefined();
      return source.download(context);
    } }, { store })).toMatchObject({ status: 'unchanged' });
  });
  it('publishes data before the manifest and skips data writes on hash equality and HTTP 304', async () => {
    const store = new MemoryStore();
    const source = listSource();
    const options = { store, now: () => 1000 };
    expect(await refreshData(source, options)).toEqual({ name: 'list', status: 'updated' });
    expect(store.put.mock.calls.map(call => call[0])).toEqual([expect.stringMatching(/^list\/[a-f0-9]{64}\.json$/), 'list/current.json']);
    const first = await readSnapshot(store, 'list', numbers);
    expect(first).toMatchObject({ data: [1, 2], checkedAt: 1000 });
    store.put.mockClear();
    expect(await refreshData(source, { store, now: () => 2000 })).toMatchObject({ status: 'unchanged' });
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put.mock.calls[0]?.[0]).toBe('list/current.json');
    const notModified: UpdateSource<readonly number[]> = {
      ...source, download: context => {
        expect(context.previous).toMatchObject({ etag: 'first', url: 'https://data.example/list' });
        return Promise.resolve(undefined);
      }
    };
    expect(await refreshData(notModified, { store, now: () => 3000 })).toMatchObject({ status: 'unchanged' });
    expect(await readSnapshot(store, 'list', numbers, first)).toMatchObject({ data: [1, 2], checkedAt: 3000 });
  });

  it.each(['download', 'decode', 'validate', 'blob', 'manifest'] as const)('retains the last published copy after a %s failure and reports no secret', async stage => {
    const store = new MemoryStore();
    const source = listSource();
    await refreshData(source, { store, now: () => 1000 });
    const previous = store.values.get('list/current.json');
    const failure = (): never => { throw new Error('private licence key and URL'); };
    const next: UpdateSource<readonly number[]> = {
      ...source,
      download: stage === 'download' ? () => failure() : () => Promise.resolve({ bytes: new TextEncoder().encode('[3]') }),
      decode: stage === 'decode' ? failure : source.decode,
      validate: stage === 'validate' ? failure : source.validate
    };
    if (stage === 'blob' || stage === 'manifest') store.put.mockImplementation((key, value) => {
      if ((stage === 'manifest') === key.endsWith('/current.json')) failure();
      store.values.set(key, value);
      return Promise.resolve();
    });
    const report = await refreshData(next, { store, secrets: { list: { licenseKey: 'secret' } }, now: () => 2000 });
    expect(report).toEqual({ name: 'list', status: 'failed' });
    expect(store.values.get('list/current.json')).toBe(previous);
    expect(await readSnapshot(store, 'list', numbers)).toMatchObject({ data: [1, 2], checkedAt: 1000 });
  });

  it('rejects a 304 on first boot and times out an unresponsive source', async () => {
    const store = new MemoryStore();
    const source = listSource();
    expect(await refreshData({ ...source, download: () => Promise.resolve(undefined) }, { store })).toMatchObject({ status: 'failed' });
    expect(await refreshData({ ...source, download: () => new Promise(() => undefined) }, { store, timeoutMs: 5 })).toMatchObject({ status: 'failed' });
    expect(await refreshData({ ...source, decode: () => new Promise(() => undefined) }, { store, timeoutMs: 5 })).toMatchObject({ status: 'failed' });
    expect(store.put).not.toHaveBeenCalled();
  });

  it('rejects data whose JSON representation would fail the reader validator before publishing it', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store });
    const previous = store.values.get('list/current.json');
    const source: UpdateSource<Uint8Array> = {
      ...listSource(), decode: bytes => bytes,
      validate: value => {
        if (!(value instanceof Uint8Array)) throw new TypeError('Expected bytes');
        return value;
      }
    };
    expect(await refreshData(source, { store })).toMatchObject({ status: 'failed' });
    expect(store.values.get('list/current.json')).toBe(previous);
  });

  it('rejects traversal and duplicate jobs before downloading, while independent failures do not block other sources', async () => {
    const source = listSource();
    const store = new MemoryStore();
    await expect(refreshData({ ...source, name: '../secret' }, { store })).rejects.toThrow('source name');
    await expect(runUpdates([source, source], { store })).rejects.toThrow('Duplicate');
    expect(source.download).not.toHaveBeenCalled();
    const reports = await runUpdates([{ ...source, download: () => Promise.reject(new Error()) }, { ...source, name: 'other' }], { store });
    expect(reports.map(report => report.status)).toEqual(['failed', 'updated']);
  });
});

describe('private snapshot loading', () => {
  it('coalesces loads, reads no unchanged data blob, and preserves the previous copy on corrupt or missing data', async () => {
    let now = 1000;
    const store = new MemoryStore();
    const source = listSource();
    await refreshData(source, { store, now: () => now });
    const cache = new SnapshotCache(store, 'list', numbers, 100, () => now);
    const pending = cache.reload();
    expect(cache.reload()).toBe(pending);
    expect(await pending).toBe(true);
    expect(cache.current?.data).toEqual([1, 2]);
    store.get.mockClear();
    expect(await cache.reload()).toBe(true);
    expect(store.get).not.toHaveBeenCalled();
    now += 101;
    await refreshData(source, { store, now: () => now });
    store.get.mockClear();
    expect(await cache.reload()).toBe(true);
    expect(store.get.mock.calls).toEqual([['list/current.json']]);
    const previous = cache.current;
    now += 101;
    await refreshData({ ...source, download: () => Promise.resolve({ bytes: new TextEncoder().encode('[3]') }) }, { store, now: () => now });
    const key = [...store.values.keys()].filter(key => key !== 'list/current.json').at(-1);
    if (key === undefined) throw new Error('Missing test snapshot');
    store.values.set(key, 'corrupt');
    expect(await cache.reload()).toBe(false);
    expect(cache.current).toBe(previous);
    now += 101;
    store.values.delete('list/current.json');
    expect(await cache.reload()).toBe(false);
    expect(cache.current).toBe(previous);
  });

  it('rejects unsupported manifest/data versions, wrong hashes and future dates', async () => {
    const store = new MemoryStore();
    await refreshData(listSource(), { store, now: () => 1000 + 10 * 60_000 }); // Beyond the clock-skew tolerance.
    const cache = new SnapshotCache(store, 'list', numbers, 0, () => 1000);
    expect(await cache.reload()).toBe(false);
    expect(cache.current).toBeUndefined();
    store.values.set('list/current.json', JSON.stringify({ version: 999, source: 'list', checkedAt: 0, hash: 'a'.repeat(64) }));
    expect(await cache.reload()).toBe(false);
  });

  it('accepts only per-module string secrets without exposing values in validation errors', () => {
    expect(updateSecrets('{"maxmind":{"accountId":"123","licenseKey":"private"}}')).toEqual({ maxmind: { accountId: '123', licenseKey: 'private' } });
    expect(() => updateSecrets('{"maxmind":{"licenseKey":123}}')).toThrow('SID_MODULE_SECRETS');
    expect(() => updateSecrets('[]')).toThrow('SID_MODULE_SECRETS');
    expect(() => updateSecrets('private-malformed-secret')).toThrow('Invalid SID_MODULE_SECRETS');
  });
});
