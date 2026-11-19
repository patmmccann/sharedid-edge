import { describe, expect, it } from 'vitest';
import { createHandler, defineModule, resolveConfig, type ModuleResult, type PayloadV1 } from '../src/index.js';

const VALUE = 'a'.repeat(32) + '-_' + 'B'.repeat(42); // 76 characters of base64url
const OTHER = 'c'.repeat(79);

async function payloadWith(results: readonly unknown[]): Promise<PayloadV1> {
  // Modules written in JavaScript can return anything; the cast stands in for one.
  const modules = results.map((result, index) => defineModule({ name: `m${String(index)}`, run: () => result as ModuleResult }));
  const handler = createHandler({ modules, config: resolveConfig({ SID_MODULES: modules.map(module => module.name).join(',') }) });
  return await (await handler(new Request('https://example.com/_sid/v1'))).json() as PayloadV1;
}

describe('the eip payload field', () => {
  it('returns a module\'s values per recipient, outside ortb2, and reports it ok', async () => {
    const eip = { google: { value: VALUE, kid: 'ypXWcw' }, pbs: { 'pbs.example.com': { value: OTHER, kid: '2026-11', stale: true }, 'pbs.example.org:8443': { value: VALUE } } };
    const payload = await payloadWith([{ eip }]);
    expect(payload.eip).toEqual(eip);
    expect(payload.ortb2).toBeUndefined();
    expect(payload.ext.modules['m0']).toMatchObject({ status: 'ok' });
  });

  it('is absent when no module returns a value', async () => {
    const payload = await payloadWith([{ ortb2: { site: { id: '1' } } }, undefined, { eip: {} }, { eip: { pbs: {} } }]);
    expect(payload).not.toHaveProperty('eip');
    expect(payload.ext.modules['m2']).toMatchObject({ status: 'empty' });
  });

  it('lets a later module replace an earlier one\'s value for the same recipient only', async () => {
    const payload = await payloadWith([
      { eip: { google: { value: VALUE }, pbs: { a: { value: VALUE }, b: { value: VALUE } } } },
      { eip: { pbs: { b: { value: OTHER } } } }
    ]);
    expect(payload.eip).toEqual({ google: { value: VALUE }, pbs: { a: { value: VALUE }, b: { value: OTHER } } });
  });

  it.each([
    ['a value too short', { google: { value: 'a'.repeat(66) } }],
    ['a value too long', { google: { value: 'a'.repeat(125) } }],
    ['standard base64', { google: { value: `${'a'.repeat(74)}+/` } }],
    ['a value that isn\'t a string', { google: { value: 76 } }],
    ['a kid with a space', { google: { value: VALUE, kid: 'a b' } }],
    ['stale: false', { google: { value: VALUE, stale: false } }],
    ['another entry field', { google: { value: VALUE, ip: '192.0.2.1' } }],
    ['another recipient', { bidder: { value: VALUE } }],
    ['an upper-case host', { pbs: { 'PBS.example.com': { value: VALUE } } }],
    ['a host with a path', { pbs: { 'pbs.example.com/openrtb2': { value: VALUE } } }],
    ['pbs not an object', { pbs: [] }],
    ['not an object', 'x']
  ])('makes the module an error, with none of its output, for %s', async (_name, eip) => {
    const payload = await payloadWith([{ eip, ortb2: { site: { id: '1' } } }]);
    expect(payload).not.toHaveProperty('eip');
    expect(payload.ortb2).toBeUndefined();
    expect(payload.ext.modules['m0']).toEqual({ ms: expect.any(Number) as number, status: 'error' });
  });

  it('is ignored on /sync', async () => {
    const module = defineModule({ name: 'g', routes: ['v1', 'sync'], run: () => ({ eip: { google: { value: VALUE } } }) });
    const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'g' }) });
    const sync = await handler(new Request('https://example.com/_sid/sync'));
    expect(sync.headers.get('Content-Type')).toBe('image/gif');
    expect(sync.headers.get('X-SharedID-Modules')).toBe('g=ok');
  });
});
