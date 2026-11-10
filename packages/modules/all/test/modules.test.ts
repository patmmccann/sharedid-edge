import { ModuleRegistry } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { uaModuleWithBowser } from '@sharedid-edge/module-ua/bowser';
import { builtInModules } from '../src/index.js';

describe('builtInModules', () => {
  it('lists every project module once, in the documented order', () => {
    expect(builtInModules.map(m => m.name)).toEqual(['ip', 'ec', 'geo', 'reflect', 'ua']);
  });

  it('registers cleanly: valid names and purposes, no duplicates', () => {
    expect(new ModuleRegistry(builtInModules).names()).toEqual(['ip', 'ec', 'geo', 'reflect', 'ua']);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(builtInModules)).toBe(true);
  });
});

describe('ua in the built-in list', () => {
  it('is the variant with Bowser, so the parser setting can choose it', () => {
    expect(builtInModules.find(m => m.name === 'ua')).toBe(uaModuleWithBowser);
  });
});
