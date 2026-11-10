import { ModuleRegistry } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { builtInModules } from '../src/index.js';

describe('builtInModules', () => {
  it('lists every project module once, in the documented order', () => {
    expect(builtInModules.map(m => m.name)).toEqual(['ip', 'ec', 'geo', 'reflect']);
  });

  it('registers cleanly: valid names and purposes, no duplicates', () => {
    expect(new ModuleRegistry(builtInModules).names()).toEqual(['ip', 'ec', 'geo', 'reflect']);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(builtInModules)).toBe(true);
  });
});
