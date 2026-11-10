import { headerValue as header, locationWithEU, type PlatformInfo } from '@sharedid-edge/core';

/** Whether Vercel's proxy sits in front of the handler and sets the client IP and `x-vercel-ip-*` headers. */
export interface PlatformOptions {
  /**
   * `true` (the default): the handler runs on Vercel, whose proxy sets `x-real-ip`, `x-forwarded-for` and the
   * `x-vercel-ip-*` geolocation headers itself, overwriting any a visitor sends. `false`: nothing trustworthy is in
   * front (for example `next start` on your own server), so those headers are ignored, since anyone could send them,
   * and there's no client IP or location.
   */
  readonly behindVercel?: boolean;
}

const ADDRESS = /^[0-9A-Fa-f:.]+$/;

/**
 * The client IP Vercel's proxy reports: `x-real-ip`, else the first `x-forwarded-for` entry. Vercel overwrites both
 * with the connecting client's address (it doesn't forward an `X-Forwarded-For` the visitor sends), so on Vercel
 * they hold one address. Returns undefined when neither is an IP address.
 */
export function clientIp(headers: Headers): string | undefined {
  for (const value of [header(headers, 'x-real-ip'), header(headers, 'x-forwarded-for')?.split(',')[0]?.trim()]) {
    if (value !== undefined && value !== '' && ADDRESS.test(value)) return value;
  }
  return undefined;
}

/** `x-vercel-ip-city` is percent-encoded (RFC 3986) when it has non-ASCII characters, like `S%C3%A3o%20Paulo`. */
function decodeCity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: leave it out rather than guess.
    return undefined;
  }
}

/**
 * What the platform knows about the request. On Vercel: the client IP from `x-real-ip` (or `x-forwarded-for`), and
 * the location from the `x-vercel-ip-*` geolocation headers, which Vercel's proxy computes from the connecting IP.
 * Location is checked by core's `locationInfo`, like every adapter's, and `isEU` derived from the country.
 */
export function platformInfo(headers: Headers, options: PlatformOptions = {}): PlatformInfo {
  if (options.behindVercel === false) return {};
  const ip = clientIp(headers);
  return {
    ...(ip === undefined ? {} : { clientIp: ip }),
    ...locationWithEU({
    country: header(headers, 'x-vercel-ip-country'),
    regionCode: header(headers, 'x-vercel-ip-country-region'),
    city: decodeCity(header(headers, 'x-vercel-ip-city')),
    postalCode: header(headers, 'x-vercel-ip-postal-code'),
    latitude: header(headers, 'x-vercel-ip-latitude'),
    longitude: header(headers, 'x-vercel-ip-longitude'),
    timezone: header(headers, 'x-vercel-ip-timezone'),
    continent: header(headers, 'x-vercel-ip-continent')
    })
  };
}
