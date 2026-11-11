/** Cookies from a request's `Cookie` header. The first value wins when a name repeats, as browsers send the most specific first. */
export function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const [name, value] of cookiePairs(header)) {
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * Every value the `Cookie` header has for `name`, in header order. A browser sends several when cookies of the same
 * name were set with different `Domain` or `Path` attributes (a host-only one and a `Domain=.example.com` one, say),
 * listing longer paths first and, for the same path, older cookies first. The header doesn't say which is which.
 */
export function cookieValues(header: string | null, name: string): string[] {
  return cookiePairs(header).filter(([n]) => n === name).map(([, value]) => value);
}

function cookiePairs(header: string | null): [string, string][] {
  if (header === null) return [];
  const pairs: [string, string][] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name !== '') pairs.push([name, value]);
  }
  return pairs;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly domain: string | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: 'Lax' | 'Strict' | 'None';
}

/**
 * A `Set-Cookie` header value. `Max-Age` 0 deletes the cookie; `Expires` is added too, for clients that ignore
 * `Max-Age`.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions, now: Date): string {
  const expires = new Date(now.getTime() + options.maxAgeSeconds * 1000);
  const parts = [
    `${name}=${value}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
    `Expires=${options.maxAgeSeconds === 0 ? new Date(0).toUTCString() : expires.toUTCString()}`,
    'Path=/'
  ];
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  if (options.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}
