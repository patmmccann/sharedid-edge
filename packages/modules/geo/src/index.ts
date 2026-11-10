import { defineModule, preciseLocationDenial, type EdgeModule, type ModuleContext, type ModuleResult, type PlatformInfo } from '@sharedid-edge/core';
import { alpha3 } from './countries.js';

export { ALPHA_3, alpha3 } from './countries.js';

/** OpenRTB 2.6 `device.geo`, as this module fills it. */
export interface DeviceGeo {
  /** Location type: 2, IP address (the CDN geolocates the connecting address). */
  readonly type: 2;
  /** ISO 3166-1 alpha-3. */
  readonly country?: string;
  /** ISO 3166-2 subdivision code, without the country prefix. */
  readonly region?: string;
  /** Nielsen DMA code. */
  readonly metro?: string;
  /** Offset from UTC in minutes, at the time of the request. */
  readonly utcoffset?: number;
  /** Precise: city name. */
  readonly city?: string;
  /** Precise: postal code. */
  readonly zip?: string;
  /** Precise: latitude. */
  readonly lat?: number;
  /** Precise: longitude. */
  readonly lon?: number;
}

/** `precise` (the default) sends precise fields when consent allows; `coarse` never does. */
export type GeoPrecision = 'precise' | 'coarse';

/**
 * Reads the module's `SID_MODULE_CONFIG` entry. Throws on an unknown key or a `precision` other than `precise` or
 * `coarse`, so a typo can't silently send precise data; the worker then reports the module as an `error`.
 */
export function geoPrecision(config: Readonly<Record<string, unknown>>): GeoPrecision {
  for (const key of Object.keys(config)) {
    if (key !== 'precision') throw new TypeError(`geo: unknown setting "${key}"`);
  }
  const precision = config['precision'];
  if (precision === undefined || precision === 'precise') return 'precise';
  if (precision === 'coarse') return 'coarse';
  throw new TypeError('geo: "precision" must be "precise" or "coarse"');
}

const REGION = /^(?:[A-Za-z]{2}-)?([A-Za-z0-9]{1,3})$/;

/** The subdivision part of an ISO 3166-2 code, upper case: `US-TX` and `tx` both give `TX`. */
export function regionCode(region: string): string | undefined {
  return REGION.exec(region.trim())?.[1]?.toUpperCase();
}

// Formatters are slow to create, so they're kept per time zone. Only valid zones get here, but the cache is still
// bounded, since names are matched case-insensitively.
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATS = 500;
const OFFSET = /^GMT(?:([+\-−])(\d{1,2})(?::(\d{2}))?)?$/;

/**
 * The offset from UTC of an IANA time zone at a given time, in minutes (east positive, so `America/New_York` is -300
 * in winter and -240 in summer). Undefined if the runtime doesn't know the zone.
 */
export function utcOffsetMinutes(timeZone: string, at: Date): number | undefined {
  let format = offsetFormats.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    } catch {
      return undefined;
    }
    if (offsetFormats.size >= MAX_FORMATS) offsetFormats.clear();
    offsetFormats.set(timeZone, format);
  }
  const name = format.formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? '';
  const match = OFFSET.exec(name);
  if (match === null) return undefined;
  const [, sign, hours, minutes] = match;
  if (sign === undefined || hours === undefined) return 0;
  const offset = Number(hours) * 60 + Number(minutes ?? '0');
  return sign === '+' ? offset : -offset;
}

/**
 * Maps platform location data to `device.geo`. Coarse fields are always included when known; precise ones (`city`,
 * `zip`, `lat`, `lon`) only with `precise`, and then in full. Undefined when there's nothing to send.
 */
export function deviceGeo(platform: PlatformInfo, options: { readonly precise: boolean; readonly at: Date }): DeviceGeo | undefined {
  const country = platform.country === undefined ? undefined : alpha3(platform.country);
  const region = platform.region === undefined ? undefined : regionCode(platform.region);
  const utcoffset = platform.timezone === undefined ? undefined : utcOffsetMinutes(platform.timezone, options.at);
  const precise: PlatformInfo = options.precise ? platform : {};
  const { city, postalCode, latitude, longitude } = precise;
  const geo: DeviceGeo = {
    type: 2,
    ...(country === undefined ? {} : { country }),
    ...(region === undefined ? {} : { region }),
    ...(platform.metroCode === undefined ? {} : { metro: platform.metroCode }),
    ...(utcoffset === undefined ? {} : { utcoffset }),
    ...(city === undefined ? {} : { city }),
    ...(postalCode === undefined ? {} : { zip: postalCode }),
    ...(latitude === undefined || longitude === undefined ? {} : { lat: latitude, lon: longitude })
  };
  return Object.keys(geo).length > 1 ? geo : undefined;
}

function run({ platform, consent, config }: ModuleContext): ModuleResult | undefined {
  const precise = geoPrecision(config) === 'precise' && preciseLocationDenial(consent) === undefined;
  const geo = deviceGeo(platform, { precise, at: new Date() });
  return geo === undefined ? undefined : { ortb2: { device: { geo } } };
}

/**
 * The `geo` module: the CDN's location data as the `/v1` payload's `ortb2.device.geo` (OpenRTB 2.6). Coarse fields
 * (country, region, metro, UTC offset) are always sent; precise ones (city, postal code, coordinates) are sent in full
 * or not at all, under core's `preciseLocationDenial` rules, and never with `{"precision":"coarse"}`. It runs only
 * when listed in `SID_MODULES`. The location is echoed back to the same browser; it isn't stored or logged.
 */
export const geoModule: EdgeModule = defineModule({ name: 'geo', run });
