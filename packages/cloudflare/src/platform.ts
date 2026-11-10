import type { PlatformInfo } from '@sharedid-edge/core';

/** The parts of a Workers request that platform info comes from. */
export interface CloudflareRequestLike {
  readonly headers: Headers;
  readonly cf?: Readonly<{ country?: unknown; regionCode?: unknown; isEUCountry?: unknown }> | undefined;
}

/**
 * What Cloudflare knows about the request: the connecting IP (`CF-Connecting-IP`, set by Cloudflare and not
 * spoofable through it) and the location fields of `request.cf`.
 */
export function platformInfo(request: CloudflareRequestLike): PlatformInfo {
  const cf = request.cf;
  const clientIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  const country = typeof cf?.country === 'string' && cf.country !== '' ? cf.country : undefined;
  const region = typeof cf?.regionCode === 'string' && cf.regionCode !== '' ? cf.regionCode : undefined;
  const isEU = cf?.isEUCountry === '1' ? true : cf === undefined ? undefined : false;
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...(country === undefined ? {} : { country }),
    ...(region === undefined ? {} : { region }),
    ...(isEU === undefined ? {} : { isEU })
  };
}
