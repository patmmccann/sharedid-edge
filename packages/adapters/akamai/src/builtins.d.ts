// Types for the EdgeWorkers built-in modules the bundle imports, as far as it uses them. The runtime provides them;
// the bundle leaves them as imports (scripts/bundle.mjs). https://techdocs.akamai.com/edgeworkers/docs/built-in-modules

/** https://techdocs.akamai.com/edgeworkers/docs/create-response */
declare module 'create-response' {
  /**
   * The value `responseProvider` resolves to. Header values are a string or an array of strings, one per header line.
   * A string body is limited to 16 KB; a stream of bytes has no limit.
   */
  export function createResponse(
    status: number,
    headers: Readonly<Record<string, string | readonly string[]>>,
    body: string | ReadableStream<Uint8Array>
  ): object;
}

/** https://techdocs.akamai.com/edgeworkers/docs/streams */
declare module 'streams' {
  export const ReadableStream: typeof globalThis.ReadableStream;
}

/** https://techdocs.akamai.com/edgeworkers/docs/encoding */
declare module 'encoding' {
  export const TextEncoder: typeof globalThis.TextEncoder;
  export const TextDecoder: typeof globalThis.TextDecoder;
  export function atob(data: string): string;
  export function btoa(data: string): string;
}

/** https://techdocs.akamai.com/edgeworkers/docs/crypto */
declare module 'crypto' {
  export const crypto: {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    readonly subtle: SubtleCrypto;
  };
}

/** https://techdocs.akamai.com/edgeworkers/docs/log */
declare module 'log' {
  export const logger: {
    log(...data: unknown[]): void;
    debug(...data: unknown[]): void;
    info(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
  };
}
