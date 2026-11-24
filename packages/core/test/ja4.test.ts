import { describe, expect, it } from 'vitest';
import { ja4Value } from '../src/index.js';

describe('ja4Value', () => {
  it.each([
    't13d1516h2_8daaf6152771_02713d6af862',
    'q13d0312h3_55b375c5d22e_06cda9e17597',
    't13i181000_85036bcba153_d41ae481755e',
    't12d8008h1_9cedc1f1428b_046e095b7c4a',
    'd00i000000_000000000000_000000000000'
  ])('accepts %s', value => {
    expect(ja4Value(value)).toBe(value);
  });
  it('trims whitespace', () => {
    expect(ja4Value(' t13d1715h2_5b57614c22b0_7121afd63204 ')).toBe('t13d1715h2_5b57614c22b0_7121afd63204');
  });
  it.each([
    [undefined],
    [null],
    [42],
    [''],
    ['x13d1516h2_8daaf6152771_02713d6af862'],
    ['t14d1516h2_8daaf6152771_02713d6af862'],
    ['t13x1516h2_8daaf6152771_02713d6af862'],
    ['t13d1516h2_8DAAF6152771_02713d6af862'],
    ['t13d1516h2_8daaf6152771'],
    ['t13d1516h2_8daaf6152771_02713d6af862_extra'],
    ['t13d1516h2_8daaf6152771_02713d6af86'],
    ['771,4865-4866,0-23,29-23,0']
  ])('rejects %j', value => {
    expect(ja4Value(value)).toBeUndefined();
  });
});
