import { describe, expect, it } from 'vitest';
import { ConfigError, defineModule } from '@sharedid-edge/core';
import { loadModulePackages } from '../src/index.js';
describe('loadModulePackages (SID_MODULE_PACKAGES)', () => {
  const ec = defineModule({ name: 'ec', run: () => undefined });
  const load = (exports: Record<string, unknown>) => (specifier: string): Promise<unknown> =>
    specifier === '@sharedid-edge/module-ec' ? Promise.resolve(exports) : Promise.reject(new Error('not installed'));

  it('loads <package>#<export> entries, in order, and nothing when unset', async () => {
    expect(await loadModulePackages(undefined, load({}))).toEqual([]);
    expect(await loadModulePackages(' @sharedid-edge/module-ec#ecModule , ', load({ ecModule: ec }))).toEqual([ec]);
  });

  it('refuses a malformed entry, a package it can\'t load, and an export that isn\'t a module', async () => {
    await expect(loadModulePackages('@sharedid-edge/module-ec', load({ ecModule: ec }))).rejects.toThrow(ConfigError);
    await expect(loadModulePackages('@sharedid-edge/module-nope#x', load({}))).rejects.toThrow(/can't load @sharedid-edge\/module-nope/);
    await expect(loadModulePackages('@sharedid-edge/module-ec#ecModule', load({ ecModule: { name: 'ec' } }))).rejects.toThrow(/no module export "ecModule"/);
  });

  it('loads the real ec package', async () => {
    const [module] = await loadModulePackages('@sharedid-edge/module-ec#ecModule');
    expect(module?.name).toBe('ec');
  });
});
