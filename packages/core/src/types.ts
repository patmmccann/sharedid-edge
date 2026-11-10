/**
 * What the platform adapter knows about the request that isn't in the `Request` itself:
 * the connecting IP and the CDN's location data. Every field is optional; a platform that
 * doesn't know a value leaves it out.
 */
export interface PlatformInfo {
  /** The connecting client's IP address (for example `CF-Connecting-IP` on Cloudflare). */
  readonly clientIp?: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly country?: string;
  /** Region or subdivision code within the country. */
  readonly region?: string;
  /** Whether the request comes from a country where GDPR applies, if the platform can tell. */
  readonly isEU?: boolean;
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
  readonly ext: {
    /** Per module: how long it took, and whether it was skipped or failed. */
    readonly modules: Readonly<Record<string, ModuleReport>>;
  };
}

export interface ModuleReport {
  readonly ms: number;
  readonly status: 'ok' | 'empty' | 'skipped' | 'error' | 'timeout';
  /** Why the module was skipped, for example missing consent. */
  readonly reason?: string;
}
