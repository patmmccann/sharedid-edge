/**
 * The parts of the Azure Functions v4 `HttpRequest` the adapter reads. Defined here, structurally, so the package
 * needs no runtime dependency on `@azure/functions`; its `HttpRequest` is assignable (`src/functions.ts` checks).
 */
export interface AzureHttpRequest {
  readonly method: string;
  /** The full request URL, as the Functions host received it. */
  readonly url: string;
  readonly headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A response cookie, as the v4 `Cookie` type has it. The Functions host writes each as its own `Set-Cookie`. */
export interface AzureCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: Date;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Seconds; 0 deletes the cookie. */
  readonly maxAge?: number;
}

/** An Azure Functions v4 `HttpResponseInit`. */
export interface AzureHttpResponseInit {
  readonly status: number;
  /** Every header except `Set-Cookie`. */
  readonly headers: Readonly<Record<string, string>>;
  /** One entry per `Set-Cookie`: the Functions host keeps one value per header name, so cookies must go here. */
  readonly cookies: AzureCookie[];
  readonly body?: Uint8Array<ArrayBuffer>;
}
