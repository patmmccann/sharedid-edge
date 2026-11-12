import { locationWithEU, type PlatformInfo } from '@sharedid-edge/core';
import type { EdgeWorkerRequest } from './edgeworkers.js';

/**
 * The Property Manager variable the property rule sets to the visitor's connecting address, `{{builtin.AK_CLIENT_REAL_IP}}`
 * ("request headers are ignored"). The client IP comes from it when it's set.
 */
export const CLIENT_IP_VARIABLE = 'PMUSER_SID_CLIENT_IP';

const ADDRESS = /^[0-9A-Fa-f:.]+$/;
const ZIP_RANGE = /^[0-9]+-[0-9]+$/;

/**
 * The postal code in EdgeScape's `zipCode`, when it names one area. EdgeScape gives every code the address may be in:
 * several separated by `+`, and ranges as `first-last` (`02114+02134-02138`), which aren't one postal code, so they
 * give none. A single code is kept (`02138`, or a Canadian forward sortation area like `M5V`).
 */
export function postalCodeFromZip(zipCode: string | undefined): string | undefined {
  const value = zipCode?.trim() ?? '';
  if (value === '' || value.includes('+') || ZIP_RANGE.test(value)) return undefined;
  return value;
}

function address(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed !== '' && ADDRESS.test(trimmed) ? trimmed : undefined;
}

function sent(headers: Readonly<Record<string, readonly string[] | undefined>>, name: string): boolean {
  return (headers[name] ?? []).some(value => value.trim() !== '');
}

/**
 * What the platform knows about the request, from what Akamai sets and the visitor can't:
 *
 * - The client IP from `PMUSER_SID_CLIENT_IP`, which the property rule sets to `AK_CLIENT_REAL_IP`. Without it,
 *   `request.clientIp`, but only when the request carries no `X-Forwarded-For` or `Akamai-Client-IP` header: Akamai
 *   lets those override its client IP (`AK_CLIENT_IP`), and doesn't document whether `clientIp` follows them.
 * - EdgeScape's location (`request.userLocation`), only when the request carries no `X-Forwarded-For` header: Akamai
 *   documents that the location then describes the header's address, which the visitor chooses. Without a location
 *   the country, and so `isEU`, is unknown, rather than one the visitor picked.
 *
 * The location is checked by core's `locationInfo` like every adapter's, with `isEU` from the country.
 */
export function platformInfo(request: Pick<EdgeWorkerRequest, 'clientIp' | 'userLocation' | 'getHeaders' | 'getVariable'>): PlatformInfo {
  const headers = request.getHeaders();
  const forwarded = sent(headers, 'x-forwarded-for');
  const clientIp = address(request.getVariable(CLIENT_IP_VARIABLE))
    ?? (forwarded || sent(headers, 'akamai-client-ip') ? undefined : address(request.clientIp));
  const where = forwarded ? undefined : request.userLocation;
  const location = where === undefined ? {} : locationWithEU({
    country: where.country,
    regionCode: where.region,
    city: where.city,
    postalCode: postalCodeFromZip(where.zipCode),
    metroCode: where.dma,
    latitude: where.latitude,
    longitude: where.longitude,
    timezone: where.timezone,
    continent: where.continent
  });
  return { ...(clientIp === undefined ? {} : { clientIp }), ...location };
}
