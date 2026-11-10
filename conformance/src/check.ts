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

/** Sends a case's request to `baseUrl` and returns the failures (empty when it passes). */
export async function runCase(baseUrl: string, testCase: Case): Promise<string[]> {
  const { request, expect } = testCase;
  const method = request.method ?? 'GET';
  const response = await fetch(new URL(request.path, baseUrl), { method, headers: request.headers ?? {}, redirect: 'manual' });
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
  if (expect.json !== undefined || expect.jsonIncludes !== undefined) {
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
  }

  const cookies = response.headers.getSetCookie().map(parseSetCookie);
  const secure = new URL(baseUrl).protocol === 'https:';
  for (const cookie of cookies) {
    // Every cookie is Secure over https, and not over plain http (local development).
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
    if (want.sameSite !== undefined && got.attributes.get('samesite') !== want.sameSite) failures.push(`cookie ${want.name}: SameSite ${String(got.attributes.get('samesite'))}, expected ${want.sameSite}`);
    if (want.path !== undefined && got.attributes.get('path') !== want.path) failures.push(`cookie ${want.name}: Path ${String(got.attributes.get('path'))}, expected ${want.path}`);
    if (want.domain !== undefined && (got.attributes.get('domain') ?? '') !== want.domain) failures.push(`cookie ${want.name}: Domain ${String(got.attributes.get('domain'))}, expected ${JSON.stringify(want.domain)}`);
    if (want.httpOnly !== undefined && got.attributes.has('httponly') !== want.httpOnly) failures.push(`cookie ${want.name}: HttpOnly should be ${String(want.httpOnly)}`);
    if (want.maxAge !== undefined && want.maxAge > 0 && !got.attributes.has('expires')) failures.push(`cookie ${want.name}: missing Expires`);
  }
  if (expect.onlyListedCookies === true) {
    const listed = new Set((expect.cookies ?? []).map(c => c.name));
    const extra = cookies.filter(c => !listed.has(c.name)).map(c => c.name);
    if (extra.length > 0) failures.push(`unexpected cookies: ${extra.join(', ')}`);
  }
  return failures;
}

/** Whether `actual` contains `expected`: objects match on `expected`'s keys, recursively; anything else exactly. */
function includes(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && includes(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
