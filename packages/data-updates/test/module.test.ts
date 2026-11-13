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
});
