import type { SharedIdEdgeConfig } from './config.js';
import { gdprFromLocation } from './location.js';
import { decodeTcf, type TcfConsents } from './tcf.js';
import type { PlatformInfo } from './types.js';

/** The consent signals on a request. */
export interface ConsentContext {
  /**
   * Whether GDPR applies: from the `gdpr` query parameter, else the platform's location (a country in
   * `GDPR_COUNTRY_CODES`, or the EU flag), else unknown.
   */
  readonly gdprApplies: boolean | undefined;
  /** The TC string, from the `gdpr_consent` query parameter or the CMP's `euconsent-v2` cookie. */
  readonly tcString: string | undefined;
  /** The decoded TC string; undefined when there is none or it isn't valid. */
  readonly tcf: TcfConsents | undefined;
  /** The `us_privacy` (USP) string, if sent. */
  readonly usPrivacy: string | undefined;
  /** The GPP string and section IDs, if sent. */
  readonly gppString: string | undefined;
  readonly gppSid: readonly number[] | undefined;
  /** Global Privacy Control (`Sec-GPC: 1`). */
  readonly gpc: boolean;
  /** The request is subject to COPPA (`coppa=1`, as in OpenRTB `regs.coppa`). */
  readonly coppa: boolean;
}

export const TCF_COOKIE = 'euconsent-v2';

export function readConsent(url: URL, headers: Headers, cookies: ReadonlyMap<string, string>, platform: PlatformInfo): ConsentContext {
  const gdprParam = url.searchParams.get('gdpr');
  const gdprApplies = gdprParam === '1' ? true : gdprParam === '0' ? false : gdprFromLocation(platform);
  const tcString = nonEmpty(url.searchParams.get('gdpr_consent')) ?? nonEmpty(cookies.get(TCF_COOKIE));
  const gppSid = nonEmpty(url.searchParams.get('gpp_sid'))
    ?.split(',')
    .filter(value => /^\d+$/.test(value.trim()))
    .map(value => Number(value));
  return {
    gdprApplies,
    tcString,
    tcf: tcString === undefined ? undefined : decodeTcf(tcString),
    usPrivacy: nonEmpty(url.searchParams.get('us_privacy')),
    gppString: nonEmpty(url.searchParams.get('gpp')),
    gppSid,
    gpc: headers.get('Sec-GPC')?.trim() === '1',
    coppa: url.searchParams.get('coppa') === '1'
  };
}

export type StorageDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Purposes 2 to 10: at least one must have consent or legitimate interest, or the ID has no use. */
const USE_PURPOSES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Whether the SharedID cookie may be set or refreshed. Opt-out is checked separately, before this. Storage is denied:
 *
 * - with Global Privacy Control (`Sec-GPC: 1`), or for a request subject to COPPA (`coppa=1`);
 * - when there is a TC string, unless it is valid, consents to Purpose 1, and has consent or legitimate interest for at
 *   least one of Purposes 2 to 10:
 *   - by default (publisher mode), in the publisher TC segment: SharedID is the publisher's own ID;
 *   - with `vendorId` configured (vendor mode), in the core segment's purposes, and the vendor itself has consent;
 * - when GDPR applies and there is no TC string.
 */
export function storageDecision(config: Pick<SharedIdEdgeConfig, 'vendorId'>, consent: ConsentContext): StorageDecision {
  if (consent.gpc) return { allowed: false, reason: 'gpc' };
  if (consent.coppa) return { allowed: false, reason: 'coppa' };
  if (consent.tcString !== undefined) {
    const tcf = consent.tcf;
    if (tcf === undefined) return { allowed: false, reason: 'tcf: invalid TC string' };
    if (config.vendorId !== undefined) {
      if (!tcf.vendorConsent(config.vendorId)) return { allowed: false, reason: `tcf: no consent for vendor ${String(config.vendorId)}` };
      return purposeDecision(tcf.purposeConsents, tcf.purposeLegitimateInterests, 'vendor');
    }
    if (tcf.publisherPurposeConsents === undefined || tcf.publisherPurposeLegitimateInterests === undefined) {
      return { allowed: false, reason: 'tcf: no publisher TC segment' };
    }
    return purposeDecision(tcf.publisherPurposeConsents, tcf.publisherPurposeLegitimateInterests, 'publisher');
  }
  if (consent.gdprApplies === true) return { allowed: false, reason: 'tcf: GDPR applies and there is no TC string' };
  return { allowed: true };
}

/** Why precise location data is left out; see `preciseLocationDenial`. */
export type PreciseLocationDenial = 'gpc' | 'coppa' | 'us-privacy' | 'tcf: no TC string' | 'tcf: invalid TC string' | 'tcf: no opt-in to precise geolocation';

/**
 * Why data that locates the user precisely (a full IP address, coordinates, a postal code) must be left out, or
 * undefined if it may be sent. It's left out:
 *
 * - with Global Privacy Control, for a request subject to COPPA, or with a `us_privacy` string that opts out of sale;
 * - when there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data),
 *   whatever `gdpr` says, or when GDPR applies and there is no TC string.
 *
 * Modules send such data in full or not at all: truncating or rounding it isn't a substitute.
 */
export function preciseLocationDenial(consent: ConsentContext): PreciseLocationDenial | undefined {
  if (consent.gpc) return 'gpc';
  if (consent.coppa) return 'coppa';
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  if (consent.tcString !== undefined) {
    if (consent.tcf === undefined) return 'tcf: invalid TC string';
    if (!consent.tcf.specialFeatureOptIns.has(1)) return 'tcf: no opt-in to precise geolocation';
    return undefined;
  }
  if (consent.gdprApplies === true) return 'tcf: no TC string';
  return undefined;
}

function purposeDecision(consents: ReadonlySet<number>, legitimateInterests: ReadonlySet<number>, kind: 'publisher' | 'vendor'): StorageDecision {
  if (!consents.has(1)) return { allowed: false, reason: `tcf: no ${kind} consent for purpose 1` };
  if (!USE_PURPOSES.some(p => consents.has(p) || legitimateInterests.has(p))) {
    return { allowed: false, reason: `tcf: no ${kind} consent or legitimate interest for any of purposes 2-10` };
  }
  return { allowed: true };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === '' ? undefined : value.trim();
}
