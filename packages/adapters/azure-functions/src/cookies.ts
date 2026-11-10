import type { AzureCookie } from './types.js';

/**
 * Characters the Functions host leaves alone in a cookie value. It writes `cookies[]` with ASP.NET Core's
 * `Response.Cookies.Append`, which percent-encodes the value (`Uri.EscapeDataString`): everything but the RFC 3986
 * unreserved characters is changed. (`enableHttpStream` serializes them with `encodeURIComponent`, which changes
 * these too.)
 */
const PRESERVED = /^[A-Za-z0-9\-._~]*$/;

/** Whether the Functions host sets `value` byte for byte. */
export function preservedByHost(value: string): boolean {
  return PRESERVED.test(value);
}

/**
 * Parses a `Set-Cookie` header from core into the v4 `Cookie` shape. Core writes `name=value` and the attributes
 * `Max-Age`, `Expires`, `Path`, `Domain`, `SameSite`, `Secure` and `HttpOnly`; anything else is ignored.
 */
export function parseSetCookie(header: string): AzureCookie {
  const [pair = '', ...attributes] = header.split(';').map(part => part.trim());
  const eq = pair.indexOf('=');
  let cookie: AzureCookie = { name: eq < 0 ? pair : pair.slice(0, eq), value: eq < 0 ? '' : pair.slice(eq + 1) };
  for (const attribute of attributes) {
    const i = attribute.indexOf('=');
    const key = (i < 0 ? attribute : attribute.slice(0, i)).toLowerCase();
    const value = i < 0 ? '' : attribute.slice(i + 1);
    switch (key) {
      case 'max-age':
        if (/^-?\d+$/.test(value)) cookie = { ...cookie, maxAge: Number(value) };
        break;
      case 'expires': {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) cookie = { ...cookie, expires: date };
        break;
      }
      case 'path':
        cookie = { ...cookie, path: value };
        break;
      case 'domain':
        cookie = { ...cookie, domain: value };
        break;
      case 'samesite': {
        const sameSite = value.toLowerCase();
        if (sameSite === 'lax') cookie = { ...cookie, sameSite: 'Lax' };
        else if (sameSite === 'strict') cookie = { ...cookie, sameSite: 'Strict' };
        else if (sameSite === 'none') cookie = { ...cookie, sameSite: 'None' };
        break;
      }
      case 'secure':
        cookie = { ...cookie, secure: true };
        break;
      case 'httponly':
        cookie = { ...cookie, httpOnly: true };
        break;
      default:
        break;
    }
  }
  return cookie;
}
