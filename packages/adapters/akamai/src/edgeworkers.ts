/**
 * EdgeScape's location for the request, as EdgeWorkers exposes it in `request.userLocation`. Every field is a string
 * (or missing); the adapter checks each one with core's `locationInfo`. Only the fields the adapter reads are listed;
 * EdgeWorkers' own object has more (`areaCodes`, `fips`, `networkType`, `bandwidth`) and stays assignable.
 * https://techdocs.akamai.com/edgeworkers/docs/user-location-object
 */
export interface EdgeWorkerUserLocation {
  /** ISO 3166-1 alpha-2, like `US`. */
  readonly country?: string | undefined;
  /** ISO 3166-2 subdivision code without the country, like `MA`. */
  readonly region?: string | undefined;
  /** Like `CAMBRIDGE`. */
  readonly city?: string | undefined;
  /** One code, or several: `+` separates codes and ranges, and `-` joins the ends of a range (`02114+02134-02138`). */
  readonly zipCode?: string | undefined;
  /** The US Designated Market Area (Nielsen DMA) code, like `506`. */
  readonly dma?: string | undefined;
  readonly latitude?: string | undefined;
  readonly longitude?: string | undefined;
  readonly timezone?: string | undefined;
  /** A two-letter continent code, like `NA`. */
  readonly continent?: string | undefined;
}

/**
 * The parts of the request object EdgeWorkers passes to `responseProvider` that the adapter reads. Defined here,
 * structurally, so the package needs no EdgeWorkers types; the platform's object is assignable.
 * https://techdocs.akamai.com/edgeworkers/docs/request-object
 */
export interface EdgeWorkerRequest {
  readonly method: string;
  /** `http` or `https`: the scheme the visitor used. */
  readonly scheme: string;
  /** The visitor's `Host` header. */
  readonly host: string;
  /** The path and query string, as sent: `/_sid/sync?id=pubcid%3A…`. */
  readonly url: string;
  /** The visitor's IP address, IPv4 or IPv6. */
  readonly clientIp?: string | undefined;
  readonly userLocation?: EdgeWorkerUserLocation | undefined;
  /** Every request header, by lowercase name; each value is an array with one string per header line. */
  getHeaders(): Readonly<Record<string, readonly string[] | undefined>>;
  /** A Property Manager user-defined variable (`PMUSER_*`), or undefined when it doesn't exist. */
  getVariable(name: string): string | undefined;
}

/** What the adapter answers, for `createResponse(status, headers, body)`. */
export interface EdgeWorkerResult {
  readonly status: number;
  /** Lowercase header names. Each value is an array with one string per header line: every `Set-Cookie` is its own. */
  readonly headers: Readonly<Record<string, readonly string[]>>;
  /** The body's bytes; empty for HEAD and for responses without a body. */
  readonly body: Uint8Array;
}
