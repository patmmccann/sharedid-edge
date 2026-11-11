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

/** A request header's value, trimmed, or undefined when it's missing or blank. */
export function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `SID_PUBLIC_ORIGIN` as an adapter option: `{ publicOrigin }`, or nothing when it's unset or empty. */
export function booleanFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function publicOriginFromEnv(env: Readonly<Record<string, string | undefined>>): { readonly publicOrigin?: string } {
  const publicOrigin = env['SID_PUBLIC_ORIGIN'];
  return publicOrigin === undefined || publicOrigin === '' ? {} : { publicOrigin };
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Whether `value` is an HTTP header name (an RFC 9110 token). */
export function isHeaderName(value: string): boolean {
  return HEADER_NAME.test(value);
}

/**
 * Parses a setting that maps fields to request header names, such as `SID_LOCATION_HEADERS`: a JSON object whose keys
 * are among `fields` and whose values are header names, which come back lowercase. Unset or blank gives `{}`. Throws a
 * `ConfigError` naming `setting` (and showing `example`, a JSON object) for anything else, so a typo can't silently
 * turn the mapping off.
 */
export function parseHeaderMap<F extends string>(value: string | undefined, setting: string, fields: readonly F[], example: string): Partial<Record<F, string>> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${setting} must be a JSON object, like ${example}`);
  }
  const known: readonly string[] = fields;
  const headers: Partial<Record<F, string>> = {};
  for (const [field, name] of Object.entries(parsed)) {
    if (!known.includes(field)) throw new ConfigError(`${setting}: unknown field "${field}"; use ${fields.join(', ')}`);
    if (typeof name !== 'string' || !isHeaderName(name)) throw new ConfigError(`${setting}: the header for "${field}" must be a header name`);
    // Checked to be one of `fields` above.
    headers[field as F] = name.toLowerCase();
  }
  return headers;
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
