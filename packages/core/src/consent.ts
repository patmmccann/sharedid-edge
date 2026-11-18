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
  /** The decoded TC string; undefined when there is none, it isn't valid, or the build leaves the decoder out (NO_TCF). */
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

/**
 * NO_TCF: `globalThis.__SID_NO_TCF__`, set to `true` with esbuild's `define` by builds that leave the TCF decoder out
 * (`--no-tcf` in the Cloudflare Snippet's build and in `scripts/bundle-adapter.mjs`), so `decodeTcf` compiles away.
 * There a TC string is never decoded: it denies storage and precise location as an unreadable one does, with its own
 * reason (`TCF_NOT_DECODED`), whatever `gdpr` says. Every default build keeps the decoder; unset everywhere else.
 */
interface TcfFlag {
  readonly __SID_NO_TCF__?: boolean;
}

/** The reason a TC string denies storage and precise location in a build without the TCF decoder (NO_TCF). */
const TCF_NOT_DECODED = 'tcf: TC string not decoded (build without TCF)';

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
    // Read from globalThis in place: `define` replaces only the expression `globalThis.__SID_NO_TCF__`.
    tcf: tcString === undefined || (globalThis as TcfFlag).__SID_NO_TCF__ === true ? undefined : decodeTcf(tcString),
    usPrivacy: nonEmpty(url.searchParams.get('us_privacy')),
    gppString: nonEmpty(url.searchParams.get('gpp')),
    gppSid,
    gpc: headers.get('Sec-GPC')?.trim() === '1',
    coppa: url.searchParams.get('coppa') === '1'
  };
}

export type StorageDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * What a consent provider (a module's `consent` hook, see `EdgeModule`) found on a request: the visitor `granted`
 * storage, or `denied` it, with the reason `X-SharedID-Status` gives. A provider that found nothing it can read returns
 * undefined (unknown), and the decision is as without it.
 */
export type ConsentSignal = { readonly consent: 'granted' } | { readonly consent: 'denied'; readonly reason: string };

/** Purposes 2 to 10: at least one must have consent or legitimate interest, or the ID has no use. */
const USE_PURPOSES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Whether the SharedID cookie may be set or refreshed, given the consent providers' `signal` (see `consentSignal`).
 * Opt-out is checked separately, before this. In order:
 *
 * 1. Denied with Global Privacy Control (`Sec-GPC: 1`), or for a request subject to COPPA (`coppa=1`).
 * 2. Denied when the providers' signal denies it, whether or not GDPR applies or there's a TC string.
 * 3. With a TC string, denied unless it is valid, consents to Purpose 1, and has consent or legitimate interest for at
 *    least one of Purposes 2 to 10, and allowed otherwise:
 *    - by default (publisher mode), in the publisher TC segment: SharedID is the publisher's own ID;
 *    - with `vendorId` configured (vendor mode), in the core segment's purposes, and the vendor itself has consent.
 * 4. Allowed when the providers' signal grants it.
 * 5. Denied when GDPR applies.
 * 6. Otherwise allowed.
 *
 * So a provider can add a denial, or lift the denial for want of a TC string under GDPR, and nothing else: never a TC
 * string's, GPC's, COPPA's or the opt-out's.
 */
export function storageDecisionWith(config: Pick<SharedIdEdgeConfig, 'vendorId'>, consent: ConsentContext, signal?: ConsentSignal): StorageDecision {
  if (signal === undefined || consent.gpc || consent.coppa) return storageDecision(config, consent);
  if (signal.consent === 'denied') return { allowed: false, reason: signal.reason };
  return consent.tcString === undefined ? { allowed: true } : storageDecision(config, consent);
}

/**
 * Whether the SharedID cookie may be set or refreshed, without consent providers: {@link storageDecisionWith}'s steps 1,
 * 3, 5 and 6. Builds without consent hooks call it directly (see the handler), so they don't carry the rest.
 */
export function storageDecision(config: Pick<SharedIdEdgeConfig, 'vendorId'>, consent: ConsentContext): StorageDecision {
  if (consent.gpc) return { allowed: false, reason: 'gpc' };
  if (consent.coppa) return { allowed: false, reason: 'coppa' };
  if (consent.tcString !== undefined) {
    const tcf = consent.tcf;
    if (tcf === undefined) return { allowed: false, reason: (globalThis as TcfFlag).__SID_NO_TCF__ === true ? TCF_NOT_DECODED : 'tcf: invalid TC string' };
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
export type PreciseLocationDenial = 'gpc' | 'coppa' | 'us-privacy' | 'tcf: no TC string' | 'tcf: invalid TC string' | 'tcf: TC string not decoded (build without TCF)' | 'tcf: no opt-in to precise geolocation';

/**
 * Why data that locates the user precisely (a full IP address, coordinates, a postal code) must be left out, or
 * undefined if it may be sent. It's left out:
 *
 * - with Global Privacy Control, for a request subject to COPPA, or with a `us_privacy` string that opts out of sale;
 * - when there is a TC string that is invalid, isn't decoded (a build without the TCF decoder, NO_TCF) or doesn't opt
 *   in to Special Feature 1 (use precise geolocation data), whatever `gdpr` says, or when GDPR applies and there is no
 *   TC string.
 *
 * Modules send such data in full or not at all: truncating or rounding it isn't a substitute.
 */
export function preciseLocationDenial(consent: ConsentContext): PreciseLocationDenial | undefined {
  if (consent.gpc) return 'gpc';
  if (consent.coppa) return 'coppa';
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  if (consent.tcString !== undefined) {
    if (consent.tcf === undefined) return (globalThis as TcfFlag).__SID_NO_TCF__ === true ? TCF_NOT_DECODED : 'tcf: invalid TC string';
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
