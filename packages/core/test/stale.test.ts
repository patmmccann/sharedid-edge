import { describe, expect, it } from 'vitest';
import { createHandler, defineModule, resolveConfig, type ModuleResult, type PayloadV1 } from '../src/index.js';

describe('scheduled-data status', () => {
  it.each([false, true])('reports stale with output=%s without changing core cookies or routes', async output => {
    const module = defineModule({ name: 'data', routes: ['v1', 'sync'], run: () => ({ stale: true, ...(output ? { ortb2: { value: 1 } } : {}) }) });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'data' }) });
    const response = await handler(new Request('https://example.com/_sid/v1'));
    const payload = await response.json() as PayloadV1;
    expect(payload.ext.modules['data']).toMatchObject({ status: output ? 'ok' : 'empty', stale: true });
    expect(payload.ortb2).toEqual(output ? { value: 1 } : undefined);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    const sync = await handler(new Request('https://example.com/_sid/sync'));
    expect(sync.status).toBe(200);
    expect(sync.headers.get('Content-Type')).toBe('image/gif');
    expect(sync.headers.get('X-SharedID-Modules')).toBe(output ? 'data=ok' : 'data=empty');
  });

  it('rejects invalid stale flags and preserves failure precedence', async () => {
    const invalid = { stale: 'secret', ortb2: { invalid: true } } as unknown as ModuleResult;
    const modules = [
      defineModule({ name: 'invalid', run: () => invalid }),
      defineModule({ name: 'bad-cookie', run: () => ({ stale: true, cookies: [{ name: '_pubcid', value: 'x', maxAgeSeconds: 1, httpOnly: false }] }) }),
      defineModule({ name: 'failed', run: () => { throw new Error('private'); } }),
      defineModule({ name: 'slow', run: () => new Promise<ModuleResult>(() => undefined) })
    ];
    const handler = createHandler({ modules, config: resolveConfig({ SID_MODULES: modules.map(module => module.name).join(','), SID_MODULE_TIMEOUT_MS: '5' }) });
    const payload = await (await handler(new Request('https://example.com/_sid/v1'))).json() as PayloadV1;
    expect(payload.ortb2).toBeUndefined();
    expect(payload.ext.modules).toMatchObject({ invalid: { status: 'error' }, 'bad-cookie': { status: 'error' }, failed: { status: 'error' }, slow: { status: 'timeout' } });
  });
});
