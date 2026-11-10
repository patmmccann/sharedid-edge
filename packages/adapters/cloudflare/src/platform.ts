import { locationInfo, type LocationSource, type PlatformInfo, type TrafficReport } from '@sharedid-edge/core';

/** The parts of a Workers request that platform info comes from. */
export interface CloudflareRequestLike {
  readonly headers: Headers;
  readonly cf?: (LocationSource & { readonly isEUCountry?: unknown; readonly botManagement?: unknown }) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cloudflare Bot Management's verdict (`request.cf.botManagement`, an Enterprise add-on) as a traffic report:
 *
 * - `score` (1 to 99; 1 is almost certainly a bot) as `score`. Other values, including Bot Management's 0 for "not
 *   computed", are left out;
 * - `verifiedBot: true` (a known good bot, such as a search crawler) as `bot: true, botKind: 'verified'`;
 * - `corporateProxy: true` (a Cloudflare-verified proxy service carrying people's traffic) as `proxy: 'relay'`, which
 *   never makes the request a bot.
 *
 * Undefined when the object is absent (other plans) or says nothing: the platform adds nothing rather than guess.
 */
export function botManagementTraffic(botManagement: unknown): TrafficReport | undefined {
  if (!isRecord(botManagement)) return undefined;
  const { score, verifiedBot, corporateProxy } = botManagement;
  const report: TrafficReport = {
    ...(verifiedBot === true ? { bot: true, botKind: 'verified' } : {}),
    ...(corporateProxy === true ? { proxy: 'relay' } : {}),
    ...(typeof score === 'number' && Number.isInteger(score) && score >= 1 && score <= 99 ? { score } : {})
  };
  return Object.keys(report).length === 0 ? undefined : report;
}

/**
 * What Cloudflare knows about the request: the connecting IP (`CF-Connecting-IP`, set by Cloudflare and not
 * spoofable through it), the location fields of `request.cf`, checked by core's `locationInfo`, and Bot Management's
 * verdict, when the zone has it.
 */
export function platformInfo(request: CloudflareRequestLike): PlatformInfo {
  const cf = request.cf;
  const clientIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  const isEU = cf?.isEUCountry === '1' ? true : cf === undefined ? undefined : false;
  const traffic = botManagementTraffic(cf?.botManagement);
  return {
    ...(clientIp === undefined ? {} : { clientIp }),
    ...(cf === undefined ? {} : locationInfo(cf)),
    ...(isEU === undefined ? {} : { isEU }),
    ...(traffic === undefined ? {} : { traffic })
  };
}
