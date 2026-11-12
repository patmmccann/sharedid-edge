import { isDeepStrictEqual } from 'node:util';
import type { Case } from './cases.js';

interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: ReadonlyMap<string, string>;
}

function parseSetCookie(header: string): SetCookie {
  const [pair = '', ...attrs] = header.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  const attributes = new Map<string, string>();
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    attributes.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? '' : attr.slice(i + 1));
  }
  return { name: eq < 0 ? pair : pair.slice(0, eq), value: eq < 0 ? '' : pair.slice(eq + 1), attributes };
}

/** Rewrites a case's request headers for a target; see `RunningTarget.requestHeaders`. */
export type HeaderAdapter = (headers: Readonly<Record<string, string>>) => Record<string, string>;

/**
 * Whether the spec requires `Secure` on cookies for requests the implementation sees at `origin`: always over https,
 * and over plain http unless the host is local (`localhost`, an IP address, or a name under a suffix reserved for local
 * use, ignoring a trailing dot). Written from the spec rather than imported from core, so the suite checks core too.
 */
function expectsSecure(origin: URL): boolean {
  if (origin.protocol === 'https:') return true;
  const host = origin.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return !['localhost', 'test', 'local', 'internal', 'example', 'invalid'].includes(host.slice(host.lastIndexOf('.') + 1));
}

/**
 * The origin the implementation sees for a case's request, given the origin it builds request URLs from: in
 * trusted-upstream mode (the file's SID_UPSTREAM_SECRETS), a request with one of the secrets in the auth header has
 * the forwarded host header's hostname instead (spec/SPEC.md, "Trusted upstream"). It decides whether cookies must be
 * `Secure`.
 */
export function caseOrigin(origin: string, config: Readonly<Record<string, string>>, headers: Readonly<Record<string, string>>): string {
  const secretsText = config['SID_UPSTREAM_SECRETS'];
  if (secretsText === undefined || secretsText.trim() === '') return origin;
  const header = (name: string): string | undefined => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const secrets: unknown = JSON.parse(secretsText);
  const auth = header(config['SID_UPSTREAM_AUTH_HEADER'] ?? 'x-sid-upstream-auth');
  const host = header(config['SID_UPSTREAM_HOST_HEADER'] ?? 'x-forwarded-host');
  if (!Array.isArray(secrets) || auth === undefined || !secrets.includes(auth) || host === undefined) return origin;
  const url = new URL(origin);
  url.hostname = host.split(':')[0] ?? host;
  url.port = '';
  return url.origin;
}

/**
 * Sends a case's request to `baseUrl` and returns the failures (empty when it passes). `unavailable` lists payload
 * paths (`ortb2.device.geo.metro`) the target's platform has no data for (see `RunningTarget.unavailable`): they're
 * removed from the expected JSON, and checked to be absent instead, so a platform can't pass by making them up.
 * `publicOrigin` is the origin the implementation builds request URLs from, when it isn't `baseUrl` (a target given
 * SID_PUBLIC_ORIGIN); it decides whether cookies must be `Secure`.
 */
export async function runCase(
  baseUrl: string,
  testCase: Case,
  adaptHeaders: HeaderAdapter = headers => ({ ...headers }),
  unavailable: readonly string[] = [],
  publicOrigin?: string
): Promise<string[]> {
  const { request } = testCase;
  const expect = withoutUnavailable(testCase.expect, unavailable);
  const method = request.method ?? 'GET';
  const response = await fetch(new URL(request.path, baseUrl), { method, headers: adaptHeaders(request.headers ?? {}), redirect: 'manual' });
  const failures: string[] = [];
  const body = new Uint8Array(await response.arrayBuffer());

  if (response.status !== expect.status) failures.push(`status ${String(response.status)}, expected ${String(expect.status)}`);
  for (const [name, value] of Object.entries(expect.headers ?? {})) {
    const actual = response.headers.get(name);
    if (actual !== value) failures.push(`header ${name}: ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`);
  }
  for (const name of expect.absentHeaders ?? []) {
    if (response.headers.has(name)) failures.push(`header ${name} should be absent, was ${JSON.stringify(response.headers.get(name))}`);
  }
  if (expect.bodyLength !== undefined && method !== 'HEAD' && body.byteLength !== expect.bodyLength) {
    failures.push(`body is ${String(body.byteLength)} bytes, expected ${String(expect.bodyLength)}`);
  }
  if (expect.json !== undefined || expect.jsonIncludes !== undefined || expect.jsonAbsent !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      failures.push('body is not JSON');
    }
    if (json !== undefined && expect.json !== undefined && !isDeepStrictEqual(json, expect.json)) {
      failures.push(`json ${JSON.stringify(json)}, expected ${JSON.stringify(expect.json)}`);
    }
    if (json !== undefined && expect.jsonIncludes !== undefined && !includes(json, expect.jsonIncludes)) {
      failures.push(`json ${JSON.stringify(json)} doesn't include ${JSON.stringify(expect.jsonIncludes)}`);
    }
    for (const path of json === undefined ? [] : expect.jsonAbsent ?? []) {
      if (hasPath(json, path.split('.'))) failures.push(`json ${JSON.stringify(json)} should not have ${path}`);
    }
  }

  const cookies = response.headers.getSetCookie().map(parseSetCookie);
  const secure = expectsSecure(new URL(publicOrigin ?? baseUrl));
  for (const cookie of cookies) {
    // Every cookie is Secure, except over plain http in local development (see expectsSecure).
    if (cookie.attributes.has('secure') !== secure) failures.push(`cookie ${cookie.name}: Secure should be ${String(secure)}`);
  }
  if (expect.noCookies === true && cookies.length > 0) failures.push(`expected no cookies, got ${cookies.map(c => c.name).join(', ')}`);
  // Each expected cookie consumes one Set-Cookie, so a name can be listed twice (e.g. with and without Domain).
  const unmatched = [...cookies];
  for (const want of expect.cookies ?? []) {
    const index = unmatched.findIndex(c => c.name === want.name && (want.domain === undefined || (c.attributes.get('domain') ?? '') === want.domain));
    const got = index < 0 ? unmatched.find(c => c.name === want.name) : unmatched.splice(index, 1)[0];
    if (got === undefined) {
      failures.push(`cookie ${want.name}${want.domain === undefined ? '' : ` (Domain ${JSON.stringify(want.domain)})`} was not set`);
      continue;
    }
    if (want.value !== undefined && got.value !== want.value) failures.push(`cookie ${want.name}: value ${JSON.stringify(got.value)}, expected ${JSON.stringify(want.value)}`);
    if (want.valuePattern !== undefined && !new RegExp(want.valuePattern).test(got.value)) failures.push(`cookie ${want.name}: value ${JSON.stringify(got.value)} doesn't match /${want.valuePattern}/`);
    if (want.maxAge !== undefined && got.attributes.get('max-age') !== String(want.maxAge)) failures.push(`cookie ${want.name}: Max-Age ${String(got.attributes.get('max-age'))}, expected ${String(want.maxAge)}`);
    // SameSite's value is case-insensitive (ASP.NET Core writes `samesite=lax`).
    if (want.sameSite !== undefined && got.attributes.get('samesite')?.toLowerCase() !== want.sameSite.toLowerCase()) failures.push(`cookie ${want.name}: SameSite ${String(got.attributes.get('samesite'))}, expected ${want.sameSite}`);
    if (want.path !== undefined && got.attributes.get('path') !== want.path) failures.push(`cookie ${want.name}: Path ${String(got.attributes.get('path'))}, expected ${want.path}`);
    if (want.domain !== undefined && (got.attributes.get('domain') ?? '') !== want.domain) failures.push(`cookie ${want.name}: Domain ${String(got.attributes.get('domain'))}, expected ${JSON.stringify(want.domain)}`);
    if (want.httpOnly !== undefined && got.attributes.has('httponly') !== want.httpOnly) failures.push(`cookie ${want.name}: HttpOnly should be ${String(want.httpOnly)}`);
    if (want.maxAge !== undefined && want.maxAge > 0 && !got.attributes.has('expires')) failures.push(`cookie ${want.name}: missing Expires`);
  }
  if (expect.onlyListedCookies === true) {
    // Every Set-Cookie must be one of the listed cookies, so a name appears only as many times as it's listed (a
    // duplicate's deletion next to the cookie, say, has to be listed to be allowed).
    // Each listed cookie consumed one Set-Cookie above; whatever is left wasn't listed.
    if (unmatched.length > 0) failures.push(`unexpected cookies: ${unmatched.map(c => `${c.name}${c.attributes.has('domain') ? ` (Domain ${String(c.attributes.get('domain'))})` : ' (host-only)'}`).join(', ')}`);
  }
  return failures;
}

/** Whether `actual` contains `expected`: objects match on `expected`'s keys, recursively; anything else exactly. */
/** The expectations with the `unavailable` paths moved from `json` and `jsonIncludes` to `jsonAbsent`. */
function withoutUnavailable(expect: Case['expect'], unavailable: readonly string[]): Case['expect'] {
  if (unavailable.length === 0 || (expect.json === undefined && expect.jsonIncludes === undefined)) return expect;
  const paths = unavailable.map(path => path.split('.'));
  return {
    ...expect,
    ...(expect.json === undefined ? {} : { json: paths.reduce(withoutPath, expect.json) }),
    ...(expect.jsonIncludes === undefined ? {} : { jsonIncludes: paths.reduce(withoutPath, expect.jsonIncludes) }),
    jsonAbsent: [...expect.jsonAbsent ?? [], ...unavailable]
  };
}

/** A copy of `value` without the nested object key at `path`. */
function withoutPath(value: unknown, path: readonly string[]): unknown {
  const [key, ...rest] = path;
  if (key === undefined || !isPlainObject(value) || !Object.hasOwn(value, key)) return value;
  const copy: Record<string, unknown> = { ...value };
  if (rest.length === 0) Reflect.deleteProperty(copy, key);
  else copy[key] = withoutPath(value[key], rest);
  return copy;
}

function includes(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && includes(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

/** Whether `value` has the nested object keys in `path`. */
function hasPath(value: unknown, path: readonly string[]): boolean {
  const [key, ...rest] = path;
  if (key === undefined) return true;
  return isPlainObject(value) && Object.hasOwn(value, key) && hasPath(value[key], rest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
