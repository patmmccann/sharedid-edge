import { EU_COUNTRY_CODES, ja4Value, locationWithEU, parseViewerAddress, type PlatformInfo } from '@sharedid-edge/core';
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
  /**
   * `true`: the origin request policy adds `CloudFront-Viewer-JA4-Fingerprint`, so CloudFront sets it from the
   * viewer's TLS connection, and it becomes `PlatformInfo.ja4`. `false` (the default): the header is ignored, since
   * a policy that doesn't add it (such as the managed `AllViewerExceptHostHeader`) may pass on a visitor's own copy.
   * Only behind CloudFront.
   */
  readonly viewerJa4?: boolean;
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
  const info = viewerInfo(parseViewerAddress(header(event, 'cloudfront-viewer-address')), name => header(event, name));
  const ja4 = options.viewerJa4 === true ? ja4Value(header(event, 'cloudfront-viewer-ja4-fingerprint')) : undefined;
  return ja4 === undefined ? info : { ...info, ja4 };
}

/**
 * `PlatformInfo` from the client IP CloudFront gives (`clientIp`; undefined when there's none) and its geolocation
 * headers (`CloudFront-Viewer-Country`, `-Country-Region`, `-City`, `-Postal-Code`, `-Metro-Code`, `-Latitude`,
 * `-Longitude`, `-Time-Zone`), read with `header` (a trimmed, non-blank value by lowercase name). The location is
 * checked by core's `locationInfo` like every adapter's, with `isEU` from the country; CloudFront has no continent
 * header. Shared by the regional function (function URL events) and Lambda@Edge (CloudFront events), whose headers
 * come in different shapes.
 */
export function viewerInfo(clientIp: string | undefined, header: (name: string) => string | undefined): PlatformInfo {
  const location = locationWithEU({
    country: header('cloudfront-viewer-country'),
    regionCode: header('cloudfront-viewer-country-region'),
    city: header('cloudfront-viewer-city'),
    postalCode: header('cloudfront-viewer-postal-code'),
    metroCode: header('cloudfront-viewer-metro-code'),
    latitude: header('cloudfront-viewer-latitude'),
    longitude: header('cloudfront-viewer-longitude'),
    timezone: header('cloudfront-viewer-time-zone')
  });
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...location
  };
}
