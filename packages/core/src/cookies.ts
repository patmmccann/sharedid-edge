/** Cookies from a request's `Cookie` header. The first value wins when a name repeats, as browsers send the most specific first. */
export function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
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
