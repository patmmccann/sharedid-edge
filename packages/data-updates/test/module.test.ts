import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type ModuleResult, type PayloadV1 } from '@sharedid-edge/core';
import { snapshotModule, type Snapshot } from '../src/index.js';

describe('in-memory snapshot modules', () => {
  it('reports missing, fresh, stale and expired data, recompiling only when the hash changes', async () => {
    let now = 1000;
    let snapshot: Snapshot<number> | undefined;
    const compile = vi.fn((value: number) => (): ModuleResult => ({ ortb2: { value } }));
    const module = snapshotModule({ definition: { name: 'list' }, snapshot: () => snapshot, create: compile, maxAgeMs: 100, expireAfterMs: 200, now: () => now });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'list' }) });
    const payload = async (): Promise<PayloadV1> => await (await handler(new Request('https://example.com/_sid/v1'))).json() as PayloadV1;
    expect((await payload()).ext.modules['list']).toMatchObject({ status: 'empty', stale: true });
    snapshot = { data: 1, hash: 'first', checkedAt: now };
    expect(await payload()).toMatchObject({ ortb2: { value: 1 }, ext: { modules: { list: { status: 'ok' } } } });
    now += 101;
    expect(await payload()).toMatchObject({ ortb2: { value: 1 }, ext: { modules: { list: { status: 'ok', stale: true } } } });
    expect(compile).toHaveBeenCalledTimes(1);
    now += 100;
    expect((await payload()).ortb2).toBeUndefined();
    snapshot = { data: 2, hash: 'second', checkedAt: now };
    expect(await payload()).toMatchObject({ ortb2: { value: 2 }, ext: { modules: { list: { status: 'ok' } } } });
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('keeps consent checks ahead of data execution', async () => {
    const compile = vi.fn(() => (): ModuleResult => ({ ortb2: { leaked: true } }));
    const module = snapshotModule({ definition: { name: 'list', purposes: [1] }, snapshot: () => ({ data: 1, hash: 'a', checkedAt: 1000 }), create: compile, maxAgeMs: 100, now: () => 1000 });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'list' }) });
    const response = await handler(new Request('https://example.com/_sid/v1?gdpr=1'));
    expect(await response.json()).toMatchObject({ ext: { modules: { list: { status: 'skipped' } } } });
    expect(compile).not.toHaveBeenCalled();
  });

  function setup(compile: (value: number) => () => ModuleResult, now = 1000): { set: (snapshot: Snapshot<number>) => void; payload: () => Promise<PayloadV1> } {
    let snapshot: Snapshot<number> | undefined;
    const module = snapshotModule({ definition: { name: 'list' }, snapshot: () => snapshot, create: compile, maxAgeMs: 100, expireAfterMs: 200, now: () => now });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'list' }) });
    return {
      set: next => { snapshot = next; },
      payload: async () => await (await handler(new Request('https://example.com/_sid/v1'))).json() as PayloadV1
    };
  }

  it('keeps serving the last good lookup, reported stale, when a new snapshot fails to compile, without retrying it per request', async () => {
    const compile = vi.fn((value: number) => {
      if (value === 2) throw new TypeError('unusable');
      return (): ModuleResult => ({ ortb2: { value } });
    });
    const { set, payload } = setup(compile);
    set({ data: 1, hash: 'first', checkedAt: 1000 });
    expect(await payload()).toMatchObject({ ortb2: { value: 1 }, ext: { modules: { list: { status: 'ok' } } } });
    set({ data: 2, hash: 'second', checkedAt: 1000 });
    for (let request = 0; request < 3; request++) {
      expect(await payload()).toMatchObject({ ortb2: { value: 1 }, ext: { modules: { list: { status: 'ok', stale: true } } } });
    }
    expect(compile).toHaveBeenCalledTimes(2);
    set({ data: 3, hash: 'third', checkedAt: 1000 });
    expect(await payload()).toMatchObject({ ortb2: { value: 3 }, ext: { modules: { list: { status: 'ok' } } } });
    expect((await payload()).ext.modules['list']?.stale).toBeUndefined();
  });

  it('reports an error, once compiled, when the only snapshot fails to compile', async () => {
    const compile = vi.fn((): () => ModuleResult => { throw new TypeError('unusable'); });
    const { set, payload } = setup(compile);
    set({ data: 1, hash: 'first', checkedAt: 1000 });
    expect((await payload()).ext.modules['list']).toMatchObject({ status: 'error' });
    expect((await payload()).ext.modules['list']).toMatchObject({ status: 'error' });
    expect(compile).toHaveBeenCalledOnce();
  });

  it('treats a checkedAt slightly ahead of this host as fresh (clock skew), but not far ahead', async () => {
    const compile = vi.fn((value: number) => (): ModuleResult => ({ ortb2: { value } }));
    const { set, payload } = setup(compile);
    set({ data: 1, hash: 'first', checkedAt: 1000 + 4 * 60_000 });
    expect(await payload()).toMatchObject({ ortb2: { value: 1 }, ext: { modules: { list: { status: 'ok' } } } });
    expect((await payload()).ext.modules['list']?.stale).toBeUndefined();
    const far = setup(compile);
    far.set({ data: 1, hash: 'first', checkedAt: 1000 + 6 * 60_000 });
    expect(await far.payload()).toMatchObject({ ext: { modules: { list: { status: 'empty', stale: true } } } });
  });
});
