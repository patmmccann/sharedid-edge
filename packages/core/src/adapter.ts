// Plumbing every platform adapter needs around the handler, kept here so a fix (to what errors log, say) reaches
// every adapter at once instead of one copy of it.
import { ConfigError } from './config.js';

/** A response's headers for a platform that keeps one value per header name. */
export interface SplitHeaders {
  /** Every header but `Set-Cookie`, by lowercase name. */
  readonly headers: Record<string, string>;
  /** Each `Set-Cookie` on its own: joining them would break the cookies. */
  readonly cookies: string[];
}

/** Splits a response's headers into the `Set-Cookie` values, each kept separate, and every other header. */
export function splitHeaders(headers: Headers): SplitHeaders {
  const rest: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') rest[name] = value;
  });
  return { headers: rest, cookies: headers.getSetCookie() };
}

/** Logs that a request failed, naming only the error's type: its message may contain request data. */
export function logRequestFailure(error: unknown): void {
  console.error('sharedid-edge: request failed', error instanceof Error ? error.name : 'unknown error');
}

/**
 * Builds a handler with `build`, or, when the configuration is invalid (`build` throws a `ConfigError`), logs why
 * (the message names the setting, not request data) and returns `misconfigured()`: a handler that answers every
 * request with a 500 rather than one that sets wrong cookies. Other errors are thrown.
 */
export function handlerOrMisconfigured<H>(build: () => H, misconfigured: () => H): H {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`sharedid-edge: ${error.message}`);
    return misconfigured();
  }
}
