import type { IncomingMessage } from 'node:http';
import { EU_COUNTRY_CODES, locationInfo, type PlatformInfo } from '@sharedid-edge/core';
import { utf8 } from '@sharedid-edge/node';

/**
 * The location fields a load balancer custom request header can carry, with the variable that fills each:
 * `country` ← `{client_region}` (`US`), `region` ← `{client_region_subdivision}` (`USCA`), `city` ← `{client_city}`,
 * `latLong` ← `{client_city_lat_long}` (`37.386051,-122.083851`).
 */
export type LocationField = 'country' | 'region' | 'city' | 'latLong';

export const LOCATION_FIELDS: readonly LocationField[] = ['country', 'region', 'city', 'latLong'];

/** Request header names, by location field, that the load balancer's backend service adds. */
export type LocationHeaders = Readonly<Partial<Record<LocationField, string>>>;

export interface PlatformOptions {
  /**
   * `true` (the default): the function is reached only through the external Application Load Balancer (ingress
   * "internal and Cloud Load Balancing"), so its `X-Forwarded-For` entries and custom request headers are
   * trustworthy. `false`: nothing is trusted, and there's no client IP or location.
   */
  readonly behindLoadBalancer?: boolean;
  /**
   * How many `X-Forwarded-For` entries your infrastructure appends after the client's address. The external
   * Application Load Balancer appends `<client>,<load balancer>`, so the client is the second-to-last entry: 1, the
   * default. Earlier entries come from the visitor and are never used.
   */
  readonly trustedHops?: number;
  /**
   * A custom request header with the client's address (`{client_ip_address}`), used instead of `X-Forwarded-For`
   * when set.
   */
  readonly clientIpHeader?: string;
  /** Custom request headers with the visitor's location, by field. Without them there's no location. */
  readonly locationHeaders?: LocationHeaders;
}

const ADDRESS = /^[0-9A-Fa-f:.]+$/;

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const value = (Array.isArray(raw) ? raw.join(',') : raw)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function address(value: string | undefined): string | undefined {
  return value !== undefined && ADDRESS.test(value) ? value : undefined;
}

/**
 * The client IP: the `clientIpHeader` header when one is configured, else the `X-Forwarded-For` entry just before the
 * `trustedHops` entries your infrastructure appended. Undefined when there aren't enough entries or it isn't an IP.
 */
export function clientIp(req: IncomingMessage, options: PlatformOptions = {}): string | undefined {
  if (options.clientIpHeader !== undefined) return address(header(req, options.clientIpHeader));
  const entries = (header(req, 'x-forwarded-for') ?? '').split(',').map(entry => entry.trim());
  const index = entries.length - 1 - (options.trustedHops ?? 1);
  return index < 0 ? undefined : address(entries[index]);
}

/**
 * `{client_region_subdivision}` is the country and the subdivision run together (`USCA`, `CAON`); core expects the
 * ISO 3166-2 subdivision code with or without its `US-` prefix.
 */
function subdivision(value: string | undefined, country: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  return country !== undefined && upper.length > 2 && upper.startsWith(country.toUpperCase()) && upper[2] !== '-' ? upper.slice(2) : upper;
}

/**
 * What the platform knows about the request. Behind the load balancer: the client IP from `X-Forwarded-For` (or
 * `clientIpHeader`), and the location from the custom request headers `locationHeaders` names, checked by core's
 * `locationInfo` like every adapter's, with `isEU` from the country. The load balancer overwrites headers of the same
 * name a visitor sends.
 */
export function platformInfo(req: IncomingMessage, options: PlatformOptions = {}): PlatformInfo {
  if (options.behindLoadBalancer === false) return {};
  const ip = clientIp(req, options);
  const named = (field: LocationField): string | undefined => {
    const name = options.locationHeaders?.[field];
    return name === undefined ? undefined : header(req, name);
  };
  const country = named('country');
  const city = named('city');
  const [latitude, longitude] = (named('latLong') ?? '').split(',').map(part => part.trim());
  const location = locationInfo({
    country,
    regionCode: subdivision(named('region'), country),
    // Node.js reads header bytes as Latin-1; the load balancer sends city names as UTF-8.
    city: city === undefined ? undefined : utf8(city),
    latitude,
    longitude
  });
  return {
    ...(ip === undefined ? {} : { clientIp: ip }),
    ...location,
    ...(location.country === undefined ? {} : { isEU: EU_COUNTRY_CODES.has(location.country) })
  };
}
