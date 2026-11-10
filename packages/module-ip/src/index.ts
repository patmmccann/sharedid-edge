import { defineModule, type ConsentContext, type EdgeModule, type ModuleContext, type ModuleResult } from '@sharedid-edge/core';
import { formatIpv4, formatIpv6, parseIp, truncateIpv4, truncateIpv6, type ParsedIp } from './ip.js';

export { formatIpv4, formatIpv6, parseIp, truncateIpv4, truncateIpv6, type ParsedIp } from './ip.js';

/** Settings for the `ip` module, from its entry in `SID_MODULE_CONFIG`. */
export interface IpModuleConfig {
  /** Always send the truncated address, whatever the consent signals. Default false. */
  readonly truncate: boolean;
}

/** Why the address is truncated, or undefined to send it in full. */
export type TruncationReason = 'configured' | 'gpc' | 'us-privacy' | 'tcf: no TC string' | 'tcf: invalid TC string' | 'tcf: no opt-in to precise geolocation';

/** Reads the module's settings; throws on a setting of the wrong type, which the module runner reports as an error. */
export function ipModuleConfig(config: Readonly<Record<string, unknown>>): IpModuleConfig {
  const truncate = config['truncate'] ?? false;
  if (typeof truncate !== 'boolean') throw new TypeError('ip: "truncate" must be true or false');
  return { truncate };
}

/**
 * Whether to truncate the address, as Prebid Server masks IP addresses:
 *
 * - with Global Privacy Control, or a `us_privacy` string that opts out of sale;
 * - when there is a TC string without opt-in to Special Feature 1 (precise geolocation data), or GDPR applies and
 *   there is no TC string.
 */
export function truncationReason(config: IpModuleConfig, consent: ConsentContext): TruncationReason | undefined {
  if (config.truncate) return 'configured';
  if (consent.gpc) return 'gpc';
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  if (consent.tcString !== undefined) {
    if (consent.tcf === undefined) return 'tcf: invalid TC string';
    if (!consent.tcf.specialFeatureOptIns.has(1)) return 'tcf: no opt-in to precise geolocation';
    return undefined;
  }
  if (consent.gdprApplies === true) return 'tcf: no TC string';
  return undefined;
}

/** The OpenRTB `device` fields for an address: `ip` for IPv4 (including IPv4-mapped IPv6), `ipv6` otherwise. */
export function deviceFields(ip: ParsedIp, truncate: boolean): { readonly ip: string } | { readonly ipv6: string } {
  if (ip.version === 4) return { ip: formatIpv4(truncate ? truncateIpv4(ip.octets) : ip.octets) };
  return { ipv6: formatIpv6(truncate ? truncateIpv6(ip.hextets) : ip.hextets) };
}

function run({ platform, consent, config }: ModuleContext): ModuleResult | undefined {
  const settings = ipModuleConfig(config);
  const ip = platform.clientIp === undefined ? undefined : parseIp(platform.clientIp);
  if (ip === undefined) return undefined;
  return { ortb2: { device: deviceFields(ip, truncationReason(settings, consent) !== undefined) } };
}

/**
 * The `ip` module: adds the connecting client's IP address to the `/v1` payload's `ortb2.device`, so the page can pass
 * the user's real address to the auction instead of a proxy's or a server's. It runs only when listed in
 * `SID_MODULES`. The address is echoed back to the same browser; it isn't stored or logged.
 */
export const ipModule: EdgeModule = defineModule({ name: 'ip', run });
