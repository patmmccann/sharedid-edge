import type { PlatformInfo } from '@sharedid-edge/core';
import type { LambdaEventV2 } from './event.js';

/**
 * The 27 EU member states (ISO 3166-1 alpha-2), for `PlatformInfo.isEU`. The same set Cloudflare's
 * `request.cf.isEUCountry` covers, so the two adapters agree: EU membership, not the wider EEA (Iceland,
 * Liechtenstein, Norway) or the UK. Pages there should send `gdpr=1` explicitly.
 */
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'
]);

/** Whether CloudFront sits in front of the function and sets the `CloudFront-Viewer-*` headers. */
export interface PlatformOptions {
  /**
   * `true` (the default): the client IP and location come from CloudFront's `CloudFront-Viewer-Address`,
   * `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region` headers, and `sourceIp` (CloudFront's own
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
  const countryHeader = header(event, 'cloudfront-viewer-country')?.toUpperCase();
  const country = countryHeader !== undefined && /^[A-Z]{2}$/.test(countryHeader) ? countryHeader : undefined;
  const regionHeader = header(event, 'cloudfront-viewer-country-region')?.toUpperCase();
  const region = regionHeader !== undefined && /^[A-Z0-9]{1,3}$/.test(regionHeader) ? regionHeader : undefined;
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...(country === undefined ? {} : { country, isEU: EU_COUNTRY_CODES.has(country) }),
    ...(region === undefined ? {} : { region })
  };
}
