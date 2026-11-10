import { locationInfo, type LocationSource, type PlatformInfo } from '@sharedid-edge/core';

/** The parts of a Workers request that platform info comes from. */
export interface CloudflareRequestLike {
  readonly headers: Headers;
  readonly cf?: (LocationSource & { readonly isEUCountry?: unknown }) | undefined;
}

/**
 * What Cloudflare knows about the request: the connecting IP (`CF-Connecting-IP`, set by Cloudflare and not
 * spoofable through it) and the location fields of `request.cf`, checked by core's `locationInfo`.
 */
export function platformInfo(request: CloudflareRequestLike): PlatformInfo {
  const cf = request.cf;
  const clientIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  const isEU = cf?.isEUCountry === '1' ? true : cf === undefined ? undefined : false;
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...(cf === undefined ? {} : locationInfo(cf)),
    ...(isEU === undefined ? {} : { isEU })
  };
}
