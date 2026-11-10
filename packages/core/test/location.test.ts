import { describe, expect, it } from 'vitest';
import { locationInfo, preciseLocationDenial, type ConsentContext, type TcfConsents } from '../src/index.js';

describe('locationInfo', () => {
  it('keeps every valid field, parsing coordinates as numbers', () => {
    expect(locationInfo({
      country: 'US',
      regionCode: 'TX',
      city: 'Austin',
      postalCode: '78701',
      metroCode: '635',
      latitude: '30.27130',
      longitude: '-97.74260',
      timezone: 'America/Chicago',
      continent: 'NA'
    })).toEqual({
      country: 'US',
      region: 'TX',
      city: 'Austin',
      postalCode: '78701',
      metroCode: '635',
      latitude: 30.2713,
      longitude: -97.7426,
      timezone: 'America/Chicago',
      continent: 'NA'
    });
  });
  it('trims, upper-cases codes, and accepts numeric coordinates and prefixed regions', () => {
    expect(locationInfo({ country: ' gb ', regionCode: 'gb-eng', latitude: 51.5, longitude: 0, continent: 'eu', timezone: 'Etc/GMT+5' }))
      .toEqual({ country: 'GB', region: 'GB-ENG', latitude: 51.5, longitude: 0, continent: 'EU', timezone: 'Etc/GMT+5' });
  });
  it('ignores Tor (T1), unknown (XX) and malformed countries', () => {
    for (const country of ['T1', 'XX', 'xx', 'USA', 'U', '', '  ', 1]) expect(locationInfo({ country })).toEqual({});
  });
  it('ignores empty, non-finite and out-of-range coordinates, and needs both', () => {
    for (const [latitude, longitude] of [['', ''], ['north', '10'], ['NaN', '1'], ['Infinity', '1'], ['91', '0'], ['0', '-180.5'], [Number.NaN, 1]]) {
      expect(locationInfo({ latitude, longitude })).toEqual({});
    }
    expect(locationInfo({ latitude: '45' })).toEqual({});
    expect(locationInfo({ latitude: '-90', longitude: '180' })).toEqual({ latitude: -90, longitude: 180 });
  });
  it('ignores empty or malformed text fields', () => {
    expect(locationInfo({ city: '', postalCode: ' ', metroCode: 'abc', regionCode: 'Texas', timezone: '../etc', continent: 'XX' })).toEqual({});
    expect(locationInfo({ city: 'x'.repeat(129) })).toEqual({});
    expect(locationInfo({ city: 42, postalCode: null, timezone: {} })).toEqual({});
  });
});

describe('preciseLocationDenial', () => {
  const tcf = (specialFeatures: readonly number[]): TcfConsents => ({
    version: 2,
    specialFeatureOptIns: new Set(specialFeatures),
    purposeConsents: new Set(),
    purposeLegitimateInterests: new Set(),
    vendorConsent: () => false,
    publisherPurposeConsents: undefined,
    publisherPurposeLegitimateInterests: undefined
  });
  const consent = (overrides: Partial<ConsentContext> = {}): ConsentContext => ({
    gdprApplies: undefined,
    tcString: undefined,
    tcf: undefined,
    usPrivacy: undefined,
    gppString: undefined,
    gppSid: undefined,
    gpc: false,
    coppa: false,
    ...overrides
  });

  it('allows precise data without restrictions, or with opt-in to Special Feature 1', () => {
    expect(preciseLocationDenial(consent())).toBeUndefined();
    expect(preciseLocationDenial(consent({ gdprApplies: false, usPrivacy: '1YNN' }))).toBeUndefined();
    expect(preciseLocationDenial(consent({ gdprApplies: true, tcString: 'x', tcf: tcf([1]) }))).toBeUndefined();
  });
  it('denies it with GPC, COPPA or a US privacy opt-out', () => {
    expect(preciseLocationDenial(consent({ gpc: true }))).toBe('gpc');
    expect(preciseLocationDenial(consent({ coppa: true }))).toBe('coppa');
    expect(preciseLocationDenial(consent({ usPrivacy: '1nyn' }))).toBe('us-privacy');
  });
  it('denies it without opt-in to Special Feature 1, for an invalid TC string, or under GDPR without one', () => {
    expect(preciseLocationDenial(consent({ tcString: 'x', tcf: tcf([2]) }))).toBe('tcf: no opt-in to precise geolocation');
    expect(preciseLocationDenial(consent({ tcString: 'x' }))).toBe('tcf: invalid TC string');
    expect(preciseLocationDenial(consent({ gdprApplies: true }))).toBe('tcf: no TC string');
  });
});
