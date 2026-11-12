/**
 * Fastly's geolocation of the client address, as Fastly Compute exposes it in `event.client.geo` (and
 * `getGeolocationForIpAddress` in `fastly:geolocation`). Only the fields the adapter reads are listed; Fastly's object
 * has more (`as_name`, `as_number`, `conn_type`, `proxy_type`, …) and stays assignable. Fields are `null`, or missing,
 * when Fastly has no value. https://js-compute-reference-docs.edgecompute.app/docs/fastly:geolocation/getGeolocationForIpAddress
 */
export interface FastlyGeolocation {
  /** ISO 3166-1 alpha-2, like `US`. */
  readonly country_code?: string | null | undefined;
  /** ISO 3166-2 subdivision code, like `TX`. */
  readonly region?: string | null | undefined;
  readonly city?: string | null | undefined;
  /** Partial in some countries (Canada's first 3 characters, the UK's outward code); lowercase when alphanumeric. */
  readonly postal_code?: string | null | undefined;
  /** The US Designated Market Area (Nielsen DMA) code, like `635`; `0` when there is none. */
  readonly metro_code?: number | null | undefined;
  readonly latitude?: number | null | undefined;
  readonly longitude?: number | null | undefined;
  /** A two-letter continent code, like `NA`. */
  readonly continent?: string | null | undefined;
}

/**
 * The parts of `event.client` (Fastly's `ClientInfo`) the adapter reads. Defined here, structurally, so the package
 * needs no Fastly types; the platform's object is assignable.
 * https://js-compute-reference-docs.edgecompute.app/docs/globals/FetchEvent/
 */
export interface FastlyClientInfo {
  /** The IPv4 or IPv6 address of the downstream client: the connection's, never a request header. */
  readonly address: string;
  /** Fastly's geolocation of `address`, or `null` when it has none. */
  readonly geo: FastlyGeolocation | null;
}

/** The parts of Fastly's `FetchEvent` the entry point uses. */
export interface FastlyFetchEvent {
  readonly request: Request;
  readonly client: FastlyClientInfo;
  respondWith(response: Response | PromiseLike<Response>): void;
}
