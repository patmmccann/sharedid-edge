import { locationWithEU, type PlatformInfo } from '@sharedid-edge/core';
import type { EdgeWorkerRequest } from './edgeworkers.js';

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

/**
 * What the platform knows about the request: the client IP EdgeWorkers reports (`request.clientIp`) and EdgeScape's
 * location (`request.userLocation`), both set by Akamai, checked by core's `locationInfo` like every adapter's, with
 * `isEU` from the country. Nothing comes from request headers.
 */
export function platformInfo(request: Pick<EdgeWorkerRequest, 'clientIp' | 'userLocation'>): PlatformInfo {
  const clientIp = request.clientIp?.trim() ?? '';
  const where = request.userLocation;
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
  return {
    ...(clientIp !== '' && ADDRESS.test(clientIp) ? { clientIp } : {}),
    ...location
  };
}
