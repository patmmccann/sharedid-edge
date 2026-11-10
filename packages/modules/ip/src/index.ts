import {
  defineModule,
  preciseLocationDenial,
  type ConsentContext,
  type EdgeModule,
  type ModuleContext,
  type ModuleResult,
  type PreciseLocationDenial
} from '@sharedid-edge/core';
import { formatIpv4, formatIpv6, parseIp, type ParsedIp } from './ip.js';

export { formatIpv4, formatIpv6, parseIp, type ParsedIp } from './ip.js';

/** Why the address is left out, or undefined to send it. */
export type OmissionReason = PreciseLocationDenial;

/**
 * Whether to leave the address out. A truncated address is worse than none (it looks like a real one but places the
 * user in the wrong network), so the module sends the full address or nothing. It's left out:
 *
 * - with Global Privacy Control, for a request subject to COPPA, or with a `us_privacy` string that opts out of sale;
 * - when there is a TC string without opt-in to Special Feature 1 (precise geolocation data), or GDPR applies and
 *   there is no TC string.
 *
 * These are core's `preciseLocationDenial` rules, shared with the `geo` module's precise fields.
 */
export function omissionReason(consent: ConsentContext): OmissionReason | undefined {
  return preciseLocationDenial(consent);
}

/** The OpenRTB `device` field for an address: `ip` for IPv4 (including IPv4-mapped IPv6), `ipv6` otherwise. */
export function deviceFields(ip: ParsedIp): { readonly ip: string } | { readonly ipv6: string } {
  return ip.version === 4 ? { ip: formatIpv4(ip.octets) } : { ipv6: formatIpv6(ip.hextets) };
}

function run({ platform, consent }: ModuleContext): ModuleResult | undefined {
  if (omissionReason(consent) !== undefined) return undefined;
  const ip = platform.clientIp === undefined ? undefined : parseIp(platform.clientIp);
  return ip === undefined ? undefined : { ortb2: { device: deviceFields(ip) } };
}

/**
 * The `ip` module: adds the connecting client's full IP address to the `/v1` payload's `ortb2.device`, so the page can
 * pass the user's real address to the auction instead of a proxy's or a server's, or nothing when consent signals rule
 * it out. It runs only when listed in `SID_MODULES`. The address is echoed back to the same browser; it isn't stored
 * or logged.
 */
export const ipModule: EdgeModule = defineModule({ name: 'ip', run });
