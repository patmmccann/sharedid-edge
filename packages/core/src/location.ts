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
