import { headerValue as header, locationWithEU, type LocationSource, type PlatformInfo } from '@sharedid-edge/core';

/** The location fields a header can carry, named as in core's `LocationSource`. */
export type LocationField = keyof LocationSource;

export const LOCATION_FIELDS: readonly LocationField[] = [
  'country', 'regionCode', 'city', 'postalCode', 'metroCode', 'latitude', 'longitude', 'timezone', 'continent'
];

/** Request header names, by location field, that a Front Door rule set adds. */
export type LocationHeaders = Readonly<Partial<Record<LocationField, string>>>;

export interface PlatformOptions {
  /**
   * `true` (the default): Azure Front Door is in front, and the client IP is its `X-Azure-ClientIP` header.
   * `false`: nothing trustworthy is in front, so no header is trusted and there's no client IP or location.
   */
  readonly behindFrontDoor?: boolean;
  /**
   * Request headers a Front Door rule set adds with the visitor's location, by field, for example
   * `{ country: 'x-sid-country' }` with a rule that overwrites `x-sid-country` with `{geo_country}`. Front Door adds
   * no location headers of its own, so without this there's no location, and GDPR applies only with `gdpr=1`. Only
   * read behind Front Door, and only safe when the rule overwrites the header on every request.
   */
  readonly locationHeaders?: LocationHeaders;
}

const ADDRESS = /^[0-9A-Fa-f:.]+$/;

/**
 * The client IP Front Door reports in `X-Azure-ClientIP`, which it sets itself. Undefined when it's missing or isn't
 * an IP address.
 */
export function clientIp(headers: Headers): string | undefined {
  const value = header(headers, 'x-azure-clientip');
  return value !== undefined && ADDRESS.test(value) ? value : undefined;
}

/**
 * What the platform knows about the request. Behind Front Door: the client IP from `X-Azure-ClientIP`, and the
 * location from the headers `locationHeaders` names, checked by core's `locationInfo` like every adapter's, with
 * `isEU` from the country. Only trustworthy when the function app accepts traffic from your Front Door alone.
 */
export function platformInfo(headers: Headers, options: PlatformOptions = {}): PlatformInfo {
  if (options.behindFrontDoor === false) return {};
  const ip = clientIp(headers);
  const source: Partial<Record<LocationField, string | undefined>> = {};
  for (const field of LOCATION_FIELDS) {
    const name = options.locationHeaders?.[field];
    if (name !== undefined) source[field] = header(headers, name);
  }
  return {
    ...(ip === undefined ? {} : { clientIp: ip }),
    ...locationWithEU(source)
  };
}
