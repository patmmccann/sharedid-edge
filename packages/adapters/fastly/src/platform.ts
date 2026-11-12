import { locationWithEU, parseIp, type PlatformInfo } from '@sharedid-edge/core';
import type { FastlyClientInfo, FastlyGeolocation } from './fastly.js';

/** Placeholders Fastly's geolocation data uses for "unknown" in text fields. */
const UNKNOWN: ReadonlySet<string> = new Set(['', '?', '**', '--']);

function known(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return UNKNOWN.has(trimmed) ? undefined : trimmed;
}

/** The metro (DMA) code as digits; Fastly's `0` means there is none. */
function metro(value: number | null | undefined): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? String(value) : undefined;
}

/** The coordinates, unless they're missing or exactly 0,0, which geolocation databases use for "unknown". */
function position(geo: FastlyGeolocation): { readonly latitude?: number; readonly longitude?: number } {
  const { latitude, longitude } = geo;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || (latitude === 0 && longitude === 0)) return {};
  return { latitude, longitude };
}

/**
 * What the platform knows about the request, from what Fastly sets and the visitor can't:
 *
 * - The client IP from `event.client.address`, the connection's address (IPv4 or IPv6). Never from a request header:
 *   `Fastly-Client-IP` and `X-Forwarded-For` are both whatever the visitor sends to a Compute service.
 * - The location from `event.client.geo`, Fastly's geolocation of that address. Fastly's placeholders for unknown
 *   values (`?`, a `0` metro code, coordinates of 0,0) are dropped, and postal codes are upper-cased (Fastly gives
 *   alphanumeric ones in lowercase). Fastly has no IANA time zone, so there's none.
 *
 * The location is checked by core's `locationInfo` like every adapter's, with `isEU` from the country.
 */
export function platformInfo(client: FastlyClientInfo): PlatformInfo {
  const address = client.address.trim();
  const clientIp = parseIp(address) === undefined ? undefined : address;
  const geo = client.geo;
  const location = geo === null ? {} : locationWithEU({
    country: known(geo.country_code),
    regionCode: known(geo.region),
    city: known(geo.city),
    postalCode: known(geo.postal_code)?.toUpperCase(),
    metroCode: metro(geo.metro_code),
    ...position(geo),
    continent: known(geo.continent)
  });
  return { ...(clientIp === undefined ? {} : { clientIp }), ...location };
}
