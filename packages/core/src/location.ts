import type { PlatformInfo } from './types.js';

/**
 * Location fields as Cloudflare reports them, in `request.cf` or its visitor location headers: strings (latitude and
 * longitude may be numbers), any of them missing. Values are `unknown` because they come from outside: every one is
 * checked before it's used.
 */
export interface LocationSource {
  readonly country?: unknown;
  readonly regionCode?: unknown;
  readonly city?: unknown;
  readonly postalCode?: unknown;
  readonly metroCode?: unknown;
  readonly latitude?: unknown;
  readonly longitude?: unknown;
  readonly timezone?: unknown;
  readonly continent?: unknown;
}

/** A location field, named as in `LocationSource`. */
export type LocationField = keyof LocationSource;

/** Every location field, in the order adapters' `SID_LOCATION_HEADERS` settings list them. */
export const LOCATION_FIELDS: readonly LocationField[] = [
  'country', 'regionCode', 'city', 'postalCode', 'metroCode', 'latitude', 'longitude', 'timezone', 'continent'
];

/** Request header names (lower case), by location field, that a trusted proxy sets with the visitor's location. */
export type LocationHeaders = Readonly<Partial<Record<LocationField, string>>>;

/** The location fields of `PlatformInfo`. */
export type PlatformLocation = Pick<PlatformInfo, 'country' | 'region' | 'city' | 'postalCode' | 'metroCode' | 'latitude' | 'longitude' | 'timezone' | 'continent'>;

const COUNTRY = /^[A-Z]{2}$/;
/** ISO 3166-2: a subdivision code of 1 to 3 letters or digits, optionally after the country code. */
const REGION = /^(?:[A-Z]{2}-)?[A-Z0-9]{1,3}$/;
const METRO = /^\d{1,5}$/;
const TIMEZONE = /^[A-Za-z0-9_+-]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){0,2}$/;
const CONTINENTS: ReadonlySet<string> = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);
const MAX_TEXT = 128;

/**
 * Checks location data from a platform and returns the valid fields. Empty and malformed values are left out, as are
 * the country codes `XX` (unknown) and `T1` (Tor), and coordinates that aren't finite or are out of range.
 */
export function locationInfo(source: LocationSource): PlatformLocation {
  const country = text(source.country)?.toUpperCase();
  const region = text(source.regionCode)?.toUpperCase();
  const continent = text(source.continent)?.toUpperCase();
  const city = text(source.city);
  const postalCode = text(source.postalCode);
  const metroCode = text(source.metroCode);
  const timezone = text(source.timezone);
  const latitude = coordinate(source.latitude, 90);
  const longitude = coordinate(source.longitude, 180);
  // A position needs both coordinates.
  const position = latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };
  return {
    ...(country !== undefined && COUNTRY.test(country) && country !== 'XX' && country !== 'T1' ? { country } : {}),
    ...(region !== undefined && REGION.test(region) ? { region } : {}),
    ...(city === undefined ? {} : { city }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(metroCode !== undefined && METRO.test(metroCode) ? { metroCode } : {}),
    ...position,
    ...(timezone !== undefined && TIMEZONE.test(timezone) ? { timezone } : {}),
    ...(continent !== undefined && CONTINENTS.has(continent) ? { continent } : {})
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > MAX_TEXT ? undefined : trimmed;
}

function coordinate(value: unknown, limit: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

/**
 * The 27 EU member states (ISO 3166-1 alpha-2), for adapters whose platform reports a country but no EU flag. The
 * same set Cloudflare's `request.cf.isEUCountry` covers, so every adapter agrees: EU membership, not the wider EEA
 * (Iceland, Liechtenstein, Norway), the UK or Turkey. Whether GDPR applies uses `GDPR_COUNTRY_CODES`, which adds
 * those. Update it if EU membership changes.
 */
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'
]);

/**
 * The countries where GDPR (or a law SharedID Edge treats as GDPR) applies, by ISO 3166-1 alpha-2 code: the 27 EU
 * member states (`EU_COUNTRY_CODES`), the rest of the EEA (Iceland, Liechtenstein, Norway), the United Kingdom (UK
 * GDPR) and Turkey (KVKK, treated as GDPR). Not Switzerland. Wider than EU membership, which `isEU` keeps meaning:
 * core decides whether GDPR applies from a country in this list, or the platform's EU flag (`gdprFromLocation`).
 */
export const GDPR_COUNTRY_CODES: ReadonlySet<string> = new Set([...EU_COUNTRY_CODES, 'GB', 'IS', 'LI', 'NO', 'TR']);

/**
 * Whether GDPR applies from the visitor's location alone: true for a country in `GDPR_COUNTRY_CODES` or when the
 * platform says the request is from the EU; otherwise the platform's EU flag (false, or undefined when unknown).
 * An explicit `gdpr` parameter takes precedence; `readConsent` applies it.
 */
export function gdprFromLocation(platform: Pick<PlatformInfo, 'country' | 'isEU'>): boolean | undefined {
  // One expression: the Cloudflare Snippet build is within bytes of its 32 KB limit.
  return GDPR_COUNTRY_CODES.has(platform.country ?? '') || platform.isEU;
}

/**
 * `locationInfo`, plus `isEU` from the country with `EU_COUNTRY_CODES`, for adapters whose platform reports a country
 * but no EU flag. No country, no `isEU`.
 */
export function locationWithEU(source: LocationSource): PlatformLocation & Pick<PlatformInfo, 'isEU'> {
  const location = locationInfo(source);
  return location.country === undefined ? location : { ...location, isEU: EU_COUNTRY_CODES.has(location.country) };
}
