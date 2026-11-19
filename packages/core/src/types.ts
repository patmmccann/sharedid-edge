import type { TrafficReport } from './traffic.js';

/**
 * What the platform adapter knows about the request that isn't in the `Request` itself:
 * the connecting IP and the CDN's location data. Every field is optional; a platform that
 * doesn't know a value leaves it out.
 */
export interface PlatformInfo {
  /** The connecting client's IP address (for example `CF-Connecting-IP` on Cloudflare). */
  readonly clientIp?: string;
  /** ISO 3166-1 alpha-2 country code, upper case. Never `XX` (unknown) or `T1` (Tor). */
  readonly country?: string;
  /** ISO 3166-2 subdivision code, with or without the country prefix (`TX` or `US-TX`). */
  readonly region?: string;
  /** Whether the request comes from a country where GDPR applies, if the platform can tell. */
  readonly isEU?: boolean;
  /** City name. */
  readonly city?: string;
  /** Postal code. */
  readonly postalCode?: string;
  /** Metro code: the Nielsen DMA code (US only), digits. */
  readonly metroCode?: string;
  /** Latitude in degrees, -90 to 90. */
  readonly latitude?: number;
  /** Longitude in degrees, -180 to 180. */
  readonly longitude?: number;
  /** IANA time zone name, e.g. `America/Chicago`. */
  readonly timezone?: string;
  /** Continent code: `AF`, `AN`, `AS`, `EU`, `NA`, `OC` or `SA`. */
  readonly continent?: string;
  /**
   * The platform's own verdict on the traffic (on Cloudflare, Bot Management's score, verified bot flag and corporate
   * proxy flag). Core merges it into the traffic signal as source `platform`.
   */
  readonly traffic?: TrafficReport;
}

/** An OpenRTB extended identifier, in the `user.ext.eids` format. */
export interface Eid {
  readonly source: string;
  readonly uids: readonly { readonly id: string; readonly atype: number; readonly ext?: Readonly<Record<string, unknown>> }[];
}

/** The JSON body of `GET {basePath}/v1`. */
export interface PayloadV1 {
  readonly v: 1;
  /** The SharedID, when one is set and storage is allowed. */
  readonly sharedid?: string;
  readonly eids: readonly Eid[];
  /** An OpenRTB 2.x fragment for the auction's first-party data, merged from the modules' output. */
  readonly ortb2?: Readonly<Record<string, unknown>>;
  /**
   * The client's IP address encrypted for each configured recipient (Google Publisher Tag, Prebid Server hosts), kept
   * out of `ortb2` so that the page passes each value to its recipient alone rather than to every bidder.
   */
  readonly eip?: EncryptedIp;
  readonly ext: {
    /** Per module: how long it took, and whether it was skipped or failed. */
    readonly modules: Readonly<Record<string, ModuleReport>>;
  };
}

/** One recipient's encrypted IP address: HPKE to its public key, as unpadded base64url of 67 to 124 characters. */
export interface EncryptedIpValue {
  readonly value: string;
  /** The `kid` of the recipient's key it was encrypted to, when the key has one. */
  readonly kid?: string;
  /** The key is older than its maximum age (or ahead of the clock); the value may still decrypt. */
  readonly stale?: true;
}

/**
 * The `eip` payload field: `google` for Google Publisher Tag's `googletag.setConfig({ ipAddress })`, and
 * `pbs` keyed by each Prebid Server host's name (host, or host:port, lower case).
 */
export interface EncryptedIp {
  readonly google?: EncryptedIpValue;
  readonly pbs?: Readonly<Record<string, EncryptedIpValue>>;
}

export interface ModuleReport {
  readonly ms: number;
  readonly status: 'ok' | 'empty' | 'skipped' | 'error' | 'timeout';
  /** Scheduled reference data is missing or old; usable last-good output may still contribute. */
  readonly stale?: true;
  /** Why the module was skipped, for example missing consent. */
  readonly reason?: string;
}
