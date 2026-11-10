import { ModuleRegistry } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { uaModuleWithBowser } from '@sharedid-edge/module-ua/bowser';
import { builtInModules as withBowser } from '../src/bowser.js';
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

describe('builtInModules with Bowser', () => {
  it('has the same modules in the same order, with Bowser in ua only', () => {
    expect(withBowser.map(m => m.name)).toEqual(builtInModules.map(m => m.name));
    expect(withBowser.find(m => m.name === 'ua')).toBe(uaModuleWithBowser);
    expect(builtInModules.find(m => m.name === 'ua')).not.toBe(uaModuleWithBowser);
    expect(withBowser.filter(m => m.name !== 'ua')).toEqual(builtInModules.filter(m => m.name !== 'ua'));
    expect(Object.isFrozen(withBowser)).toBe(true);
  });
});
