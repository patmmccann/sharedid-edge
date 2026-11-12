// Plumbing every platform adapter needs around the handler, kept here so a fix (to what errors log, say) reaches
// every adapter at once instead of one copy of it.
import { ConfigError } from './config.js';
import { parseIp } from './ip.js';

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
  const trimmed = value.trim();
  if (/^(1|true|yes|on)$/i.test(trimmed)) return true;
  if (/^(0|false|no|off)$/i.test(trimmed)) return false;
  return fallback;
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

/**
 * The IP address in a `CloudFront-Viewer-Address` value, which is `ip:port`: `192.0.2.1:46532`, and for IPv6
 * either `[2001:db8::1]:46532` or `2001:db8::1:46532` (CloudFront always appends the port, so the part after the last
 * colon is dropped). Returns undefined for anything else, including an address that isn't a valid IP (`parseIp`).
 */
export function parseViewerAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  let address: string;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return undefined;
    address = trimmed.slice(1, end);
  } else {
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0 || !/^\d{1,5}$/.test(trimmed.slice(colon + 1))) return undefined;
    address = trimmed.slice(0, colon);
  }
  return parseIp(address) === undefined ? undefined : address;
}

/**
 * Every setting an adapter reads from per-request storage (Akamai's Property Manager variables, Fastly's config store):
 * core's `SID_*` settings (the names in `SETTINGS`) and `SID_PUBLIC_ORIGIN`. Listed here rather than taken from
 * `SETTINGS`, whose descriptions would add about 1 KB to a bundle; a unit test keeps the two in step.
 */
export const SETTING_NAMES: readonly string[] = [
  'SID_BASE_PATH', 'SID_COOKIE_NAME', 'SID_COOKIE_DOMAIN', 'SID_MAX_AGE_DAYS', 'SID_CREATE', 'SID_RECOVERY_COOKIE',
  'SID_OPTOUT_COOKIE', 'SID_VENDOR_ID', 'SID_ALLOWED_ORIGINS', 'SID_SYNC_CACHE_SECONDS', 'SID_MODULES', 'SID_SYNC_MODULES',
  'SID_MODULE_CONFIG', 'SID_MODULE_SECRETS', 'SID_MODULE_TIMEOUT_MS', 'SID_SKIP_BOTS', 'SID_HOSTS', 'SID_SKIP_BOTS_SCORE',
  'SID_PUBLIC_ORIGIN'
];

/**
 * For platforms that hand the settings over with each request rather than at start-up (Akamai's Property Manager
 * variables, Fastly's config store): returns a function that gives the handler for the settings `env`, built with
 * `build`. The last one is kept, keyed by the values of `SETTING_NAMES`, and rebuilt only when they change, so a
 * request costs a handler build only after the settings change.
 */
export function cachedByEnv<H>(build: (env: Readonly<Record<string, string | undefined>>) => H): (env: Readonly<Record<string, string | undefined>>) => H {
  let cached: { readonly key: string; readonly handler: H } | undefined;
  return env => {
    const key = JSON.stringify(SETTING_NAMES.map(name => env[name] ?? null));
    if (cached?.key !== key) cached = { key, handler: build(env) };
    return cached.handler;
  };
}

/**
 * `request` with its URL on `publicOrigin` (`SID_PUBLIC_ORIGIN`): the same path and query, method, headers and body.
 * Returns `request` itself when `publicOrigin` is undefined. Only the origin changes, which decides `Secure` and picks
 * the site's settings with `SID_HOSTS`.
 */
export async function withPublicOrigin(request: Request, publicOrigin: string | undefined): Promise<Request> {
  if (publicOrigin === undefined) return request;
  const url = new URL(request.url);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(`${url.pathname}${url.search}`, publicOrigin), {
    method: request.method,
    headers: request.headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {})
  });
}
