// Trusted-upstream mode: an endpoint that a publisher's CDN passes `/_sid/*` to (a sales house's, serving many
// publishers), authenticated by a shared secret header. Only then are the CDN's forwarded headers (the visitor's IP,
// location and the site's hostname) trusted; the platform's own (CF-Connecting-IP, request.cf, CloudFront-Viewer-*)
// describe the publisher's CDN, not the visitor, and are ignored. Adapters opt in (see `settingsFromEnv`'s
// `trustedUpstream`) and wrap their handler in `withTrustedUpstream`, so bundles that don't use it don't carry it.
import { copyRequest, isHeaderName, parseHeaderMap, parseViewerAddress } from './adapter.js';
import { ConfigError, str } from './config.js';
import { text, type SharedIdEdgeHandler } from './handler.js';
import { HOSTNAME } from './hosts.js';
import { parseIp } from './ip.js';
import { LOCATION_FIELDS, locationWithEU, type LocationField, type LocationHeaders, type LocationSource } from './location.js';
import type { PlatformInfo } from './types.js';

type Env = Readonly<Record<string, unknown>>;

/** Where a trusted proxy or upstream puts the visitor's client IP and location. */
export interface ForwardedHeaders {
  /**
   * The request header (lower case) with the client IP: an IP address; `x-forwarded-for`'s first entry; or
   * `cloudfront-viewer-address`'s `ip:port`. Undefined: no client IP from the headers.
   */
  readonly clientIp?: string | undefined;
  /** The request headers (lower case) with the location, by field. */
  readonly location: LocationHeaders;
}

/** Trusted-upstream mode's settings, from `trustedUpstreamFromEnv`. */
export interface TrustedUpstream {
  /** The request header (lower case) the upstream sends the shared secret in. */
  readonly authHeader: string;
  /** The accepted secrets: any one authenticates a request. Never logged or returned. */
  readonly secrets: readonly string[];
  /** The request header (lower case) with the site's hostname, which becomes the request URL's host. */
  readonly hostHeader: string;
  /** Where the upstream puts the visitor's client IP and location. */
  readonly forwarded: ForwardedHeaders;
}

/** `SID_UPSTREAM_AUTH_HEADER`'s default. */
export const DEFAULT_UPSTREAM_AUTH_HEADER = 'x-sid-upstream-auth';
/** `SID_UPSTREAM_HOST_HEADER`'s default. */
export const DEFAULT_UPSTREAM_HOST_HEADER = 'x-forwarded-host';

/** A secret: at least 32 characters a header can carry unchanged (hex, base64 or base64url, say). */
const SECRET = /^[A-Za-z0-9._~+/=-]{32,256}$/;

/**
 * The client IP in a forwarded header `name`: `x-forwarded-for`'s first entry, `cloudfront-viewer-address`'s `ip:port`
 * (IPv6 too, with the port after the last colon), or any other header's whole value. Undefined unless it's a valid IP.
 */
export function clientIpFromHeader(name: string, value: string | null | undefined): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'cloudfront-viewer-address') return parseViewerAddress(value ?? undefined);
  const address = (lower === 'x-forwarded-for' ? value?.split(',')[0] : value)?.trim() ?? '';
  return parseIp(address) === undefined ? undefined : address;
}

/**
 * Re-decodes a header value read as Latin-1 (one character per byte, as Node.js and other runtimes read header bytes)
 * as UTF-8, which proxies send city names in. Returns it unchanged when it's plain ASCII, has characters past Latin-1,
 * or isn't valid UTF-8.
 */
export function utf8Header(value: string): string {
  const bytes = Array.from(value, c => c.charCodeAt(0));
  // Only Latin-1 code units, some of them past ASCII, can be re-read as UTF-8 bytes.
  if (bytes.every(b => b < 0x80) || bytes.some(b => b > 0xff)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

/**
 * What a trusted proxy or upstream says about the visitor, from its forwarded headers: the client IP (see
 * `clientIpFromHeader`) and the location, checked by `locationWithEU`, so the country also sets `isEU`. Only for
 * headers the proxy sets itself, on requests that can only come through it.
 */
export function forwardedPlatformInfo(headers: Headers, forwarded: ForwardedHeaders): PlatformInfo {
  const clientIp = forwarded.clientIp === undefined ? undefined : clientIpFromHeader(forwarded.clientIp, headers.get(forwarded.clientIp));
  const source: Partial<Record<LocationField, string>> = {};
  for (const field of LOCATION_FIELDS) {
    const name = forwarded.location[field];
    const value = name === undefined ? null : headers.get(name);
    if (value !== null) source[field] = field === 'city' ? utf8Header(value) : value;
  }
  const location: LocationSource = source;
  return { ...(clientIp === undefined ? {} : { clientIp }), ...locationWithEU(location) };
}

/** A header-name setting, lower case, or `fallback` when it's unset. */
function headerSetting(env: Env, name: string, fallback: string): string;
function headerSetting(env: Env, name: string, fallback?: undefined): string | undefined;
function headerSetting(env: Env, name: string, fallback?: string): string | undefined {
  const value = str(env, name);
  if (value === undefined) return fallback;
  if (!isHeaderName(value)) throw new ConfigError(`${name} must be a header name, not "${value}"`);
  return value.toLowerCase();
}

function parseLocationHeaders(value: string | undefined): LocationHeaders {
  return parseHeaderMap(value, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"x-sid-country"}');
}

/** The prefix of trusted upstream's own settings: `SID_UPSTREAM_SECRETS`, `SID_UPSTREAM_AUTH_HEADER`, `SID_UPSTREAM_HOST_HEADER`. */
const UPSTREAM_PREFIX = 'SID_UPSTREAM_';

/**
 * Trusted upstream's settings belong to the deployment: the forwarded host that picks a site in `SID_HOSTS` is read only
 * once a request is authenticated. Throws a `ConfigError` naming the host and setting when an entry of `SID_HOSTS` has
 * one (`SID_UPSTREAM_*`, `SID_CLIENT_IP_HEADER`, `SID_LOCATION_HEADERS`). `SID_HOSTS` that isn't a JSON object is left
 * to `settingsFromEnv` to refuse.
 */
function refusePerHost(env: Env): void {
  let hosts: unknown;
  try {
    hosts = JSON.parse(str(env, 'SID_HOSTS') ?? '{}');
  } catch {
    return;
  }
  if (typeof hosts !== 'object' || hosts === null) return;
  const entries: [string, unknown][] = Object.entries(hosts);
  for (const [host, settings] of entries) {
    if (typeof settings !== 'object' || settings === null) continue;
    for (const key of Object.keys(settings)) {
      if (key.startsWith(UPSTREAM_PREFIX) || key === 'SID_CLIENT_IP_HEADER' || key === 'SID_LOCATION_HEADERS') {
        throw new ConfigError(`SID_HOSTS["${host}"]: ${key} can't be set per host`);
      }
    }
  }
}

/**
 * For adapters without trusted-upstream mode: throws a `ConfigError` naming the setting when `SID_UPSTREAM_SECRETS`,
 * `SID_UPSTREAM_AUTH_HEADER` or `SID_UPSTREAM_HOST_HEADER` is set, so the platform refuses them rather than ignore
 * them (and run without the authentication they ask for). Never shows a value. Returns `env`, for
 * `settingsFromEnv(refuseTrustedUpstream(env), options)`.
 */
export function refuseTrustedUpstream<E extends Env>(env: E): E {
  refusePerHost(env);
  for (const name of Object.keys(env)) {
    if (name.startsWith(UPSTREAM_PREFIX) && str(env, name) !== undefined) {
      throw new ConfigError(`${name}: trusted-upstream mode isn't available on this platform (the Cloudflare Worker, AWS Lambda, Fastly Compute and the Node.js server have it)`);
    }
  }
  return env;
}

/** Options for {@link trustedUpstreamFromEnv}. */
export interface TrustedUpstreamOptions {
  /**
   * The adapter also reads `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` from a proxy it trusts without a secret (the
   * Node.js server's `SID_TRUST_PROXY`), so they may be set without `SID_UPSTREAM_SECRETS`.
   */
  readonly trustProxy?: boolean;
}

/**
 * Trusted-upstream mode from the environment: on when `SID_UPSTREAM_SECRETS` is set, with `SID_UPSTREAM_AUTH_HEADER`,
 * `SID_UPSTREAM_HOST_HEADER`, `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` (which must name the `country` header:
 * it decides whether GDPR applies). Undefined when it's off.
 *
 * @throws ConfigError for an invalid setting, for one that needs `SID_UPSTREAM_SECRETS` without it, and for an invalid
 * secret (without its value).
 */
export function trustedUpstreamFromEnv(env: Env, options: TrustedUpstreamOptions = {}): TrustedUpstream | undefined {
  refusePerHost(env);
  const secretsText = str(env, 'SID_UPSTREAM_SECRETS');
  const authHeader = headerSetting(env, 'SID_UPSTREAM_AUTH_HEADER', DEFAULT_UPSTREAM_AUTH_HEADER);
  const hostHeader = headerSetting(env, 'SID_UPSTREAM_HOST_HEADER', DEFAULT_UPSTREAM_HOST_HEADER);
  const clientIp = headerSetting(env, 'SID_CLIENT_IP_HEADER');
  const locationText = str(env, 'SID_LOCATION_HEADERS');
  if (secretsText === undefined) {
    // Without the secret, nothing reads these: say so rather than run as if they weren't there.
    for (const name of ['SID_UPSTREAM_AUTH_HEADER', 'SID_UPSTREAM_HOST_HEADER']) {
      if (str(env, name) !== undefined) throw new ConfigError(`${name} needs SID_UPSTREAM_SECRETS`);
    }
    if (options.trustProxy !== true) {
      for (const name of ['SID_CLIENT_IP_HEADER', 'SID_LOCATION_HEADERS']) {
        if (str(env, name) !== undefined) throw new ConfigError(`${name} is read only from an authenticated upstream: it needs SID_UPSTREAM_SECRETS`);
      }
    }
    return undefined;
  }
  const location = parseLocationHeaders(locationText);
  if (location.country === undefined) {
    throw new ConfigError('SID_LOCATION_HEADERS must name the country header with SID_UPSTREAM_SECRETS, like {"country":"x-sid-country"}: the country decides whether GDPR applies');
  }
  const headers: [setting: string, name: string | undefined][] = [
    ['SID_UPSTREAM_AUTH_HEADER', authHeader],
    ['SID_UPSTREAM_HOST_HEADER', hostHeader],
    ['SID_CLIENT_IP_HEADER', clientIp],
    ...Object.values(location).map((name): [string, string] => ['SID_LOCATION_HEADERS', name])
  ];
  const seen = new Set<string>();
  for (const [setting, name] of headers) {
    if (name === undefined) continue;
    // A header the endpoint's own platform sets (CF-Connecting-IP, CloudFront-Viewer-*, True-Client-IP) would describe
    // the publisher's CDN, not the visitor; X-Forwarded-For is a list proxies append to.
    if (!name.startsWith('x-') || name === 'x-forwarded-for') {
      throw new ConfigError(`${setting}: with SID_UPSTREAM_SECRETS, name a header starting with x- that the publisher's CDN sets, not "${name}"`);
    }
    if (seen.has(name)) throw new ConfigError(`${setting}: "${name}" is used twice; the upstream's headers must all differ`);
    seen.add(name);
  }
  // Frozen like the module secrets: the handler keeps it for every request.
  return Object.freeze({ authHeader, secrets: parseSecrets(secretsText), hostHeader, forwarded: Object.freeze({ clientIp, location: Object.freeze(location) }) });
}

/** `SID_UPSTREAM_SECRETS`: a JSON array of secrets. Errors never include a value. */
function parseSecrets(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigError('SID_UPSTREAM_SECRETS must be a JSON array of secrets, like ["<openssl rand -hex 32>"]');
  const list: readonly unknown[] = parsed;
  const secrets: string[] = [];
  for (const [index, secret] of list.entries()) {
    if (typeof secret !== 'string' || !SECRET.test(secret)) {
      throw new ConfigError(`SID_UPSTREAM_SECRETS: secret ${String(index + 1)} must be 32 to 256 letters, digits or -._~+/= (openssl rand -hex 32 makes one)`);
    }
    secrets.push(secret);
  }
  return Object.freeze(secrets);
}

/** Whether `given` equals `secret`, in time that depends on the secret's length only, not on where they differ. */
function sameBytes(given: Uint8Array, secret: Uint8Array): boolean {
  let difference = given.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) difference |= (given[i] ?? 0) ^ (secret[i] ?? 0);
  return difference === 0;
}

/**
 * The site's hostname from the forwarded host header: one hostname, with an optional port (dropped), lower case,
 * without a trailing dot. Undefined when it's anything else, including a list: a proxy that appended to a header the
 * visitor sent would put the visitor's first.
 */
export function parseForwardedHost(value: string): string | undefined {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value.trim());
  const host = match?.[1]?.toLowerCase().replace(/\.$/, '');
  const port = Number(match?.[2] ?? 0);
  return host !== undefined && HOSTNAME.test(host) && port <= 65_535 ? host : undefined;
}

/**
 * Wraps `handler` for trusted-upstream mode; returns it unchanged when `upstream` is undefined. A request without one
 * of the secrets in the auth header gets a `403` and no cookies. An authenticated one is passed on with the platform
 * information from the forwarded headers instead of the platform's (which describe the publisher's CDN), the forwarded
 * host as its URL's host (a `400` when that header isn't one hostname; its own host when the header is missing), and
 * without the auth header, so no module can see the secret.
 */
export function withTrustedUpstream(handler: SharedIdEdgeHandler, upstream: TrustedUpstream | undefined): SharedIdEdgeHandler {
  if (upstream === undefined) return handler;
  const encoder = new TextEncoder();
  const secrets = upstream.secrets.map(secret => encoder.encode(secret));
  return async (request: Request): Promise<Response> => {
    // Repeated auth headers come joined (`a, b`), which matches no secret: secrets have no commas or spaces.
    const given = encoder.encode(request.headers.get(upstream.authHeader) ?? '');
    // Every secret is compared, so the time doesn't say which one matched.
    let authenticated = false;
    for (const secret of secrets) authenticated = sameBytes(given, secret) || authenticated;
    if (!authenticated) return text(403, 'Forbidden');

    const url = new URL(request.url);
    const forwardedHost = request.headers.get(upstream.hostHeader);
    if (forwardedHost !== null) {
      const host = parseForwardedHost(forwardedHost);
      if (host === undefined) return text(400, 'Bad request');
      url.hostname = host;
      url.port = '';
    }
    const headers = new Headers(request.headers);
    headers.delete(upstream.authHeader);
    return handler(await copyRequest(request, url, headers), forwardedPlatformInfo(request.headers, upstream.forwarded));
  };
}
