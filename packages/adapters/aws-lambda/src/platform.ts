import { EU_COUNTRY_CODES, locationWithEU, parseViewerAddress, type PlatformInfo } from '@sharedid-edge/core';
import type { LambdaEventV2 } from './event.js';

/** The 27 EU member states, from core: the meaning of Cloudflare's `request.cf.isEUCountry`. */
export { EU_COUNTRY_CODES };

/** Parses `CloudFront-Viewer-Address` (`ip:port`); from core, where the Node.js server uses it too. */
export { parseViewerAddress };

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
