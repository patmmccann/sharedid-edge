import { EU_COUNTRY_CODES, locationWithEU, type PlatformInfo } from '@sharedid-edge/core';
import type { LambdaEventV2 } from './event.js';

/** The 27 EU member states, from core: the meaning of Cloudflare's `request.cf.isEUCountry`. */
export { EU_COUNTRY_CODES };

/** Whether CloudFront sits in front of the function and sets the `CloudFront-Viewer-*` headers. */
export interface PlatformOptions {
  /**
   * `true` (the default): the client IP and location come from CloudFront's `CloudFront-Viewer-Address` and
   * geolocation headers (`CloudFront-Viewer-Country`, `-Country-Region`, `-City`, `-Postal-Code`, `-Metro-Code`,
   * `-Latitude`, `-Longitude`, `-Time-Zone`), and `sourceIp` (CloudFront's own
   * address) is ignored. `false`: nothing is in front of the function, so those headers are ignored (anyone could
   * send them) and the client IP is `requestContext.http.sourceIp`; there is no location.
   */
  readonly behindCloudFront?: boolean;
}

const ADDRESS = /^[0-9A-Fa-f:.]+$/;

/**
 * The IP address in a `CloudFront-Viewer-Address` value, which is `ip:port`: `192.0.2.1:46532`, and for IPv6
 * either `[2001:db8::1]:46532` or `2001:db8::1:46532` (CloudFront always appends the port, so the last field is
 * dropped). Returns undefined for anything else.
 */
export function parseViewerAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  let address: string;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return undefined;
    address = trimmed.slice(1, end);
  } else {
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0 || !/^\d{1,5}$/.test(trimmed.slice(colon + 1))) return undefined;
    address = trimmed.slice(0, colon);
  }
  return address !== '' && ADDRESS.test(address) ? address : undefined;
}

function header(event: LambdaEventV2, name: string): string | undefined {
  const value = event.headers?.[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * What the platform knows about the request. Behind CloudFront: the viewer's address and location from the
 * `CloudFront-Viewer-*` headers, which CloudFront sets itself (a visitor's own copies are replaced). They're only
 * trustworthy when the function URL accepts requests from CloudFront alone (origin access control).
 */
export function platformInfo(event: LambdaEventV2, options: PlatformOptions = {}): PlatformInfo {
  if (options.behindCloudFront === false) {
    const sourceIp = event.requestContext.http.sourceIp;
    return sourceIp === undefined || sourceIp === '' ? {} : { clientIp: sourceIp };
  }
  const clientIp = parseViewerAddress(header(event, 'cloudfront-viewer-address'));
  // CloudFront's geolocation headers, checked by core's locationInfo like every adapter's, with isEU from the country.
  // CloudFront has no continent header.
  const location = locationWithEU({
    country: header(event, 'cloudfront-viewer-country'),
    regionCode: header(event, 'cloudfront-viewer-country-region'),
    city: header(event, 'cloudfront-viewer-city'),
    postalCode: header(event, 'cloudfront-viewer-postal-code'),
    metroCode: header(event, 'cloudfront-viewer-metro-code'),
    latitude: header(event, 'cloudfront-viewer-latitude'),
    longitude: header(event, 'cloudfront-viewer-longitude'),
    timezone: header(event, 'cloudfront-viewer-time-zone')
  });
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...location
  };
}
