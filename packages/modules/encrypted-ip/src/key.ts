/** Recipients' X25519 public keys (Google's, Prebid Server hosts'), and the base64url these values use. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url (RFC 4648 section 5). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET.charAt((n >> (18 - 6 * c)) & 63);
  }
  return out;
}

/** Decodes unpadded base64url, or returns undefined for anything else (padding, `+`, `/`, a stray character). */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const char of value) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so each key has one encoding.
  return (buffer & ((1 << bits) - 1)) === 0 ? bytes : undefined;
}

/** A recipient's public key: its key ID, if it has one, and the X25519 public key, base64url (32 bytes). */
export interface IpKey {
  readonly kid?: string;
  readonly x: string;
}

/** Where Google publishes the key, as a JWKS (RFC 8037) with one active X25519 key. */
export const GOOGLE_IP_KEY_URL = 'https://www.gstatic.com/real-ip/ip_enc_key.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jwk(value: unknown): IpKey | undefined {
  if (!isRecord(value) || value['kty'] !== 'OKP' || value['crv'] !== 'X25519') return undefined;
  // A private key here is a mistake that could leak it: refuse the whole value rather than skip the key.
  if ('d' in value) throw new TypeError('The key must be a public key; it has a private part ("d")');
  const { x, kid } = value;
  if (typeof x !== 'string' || fromBase64url(x)?.byteLength !== 32) return undefined;
  // As the payload carries it: printable ASCII without spaces, at most 256 characters.
  if (kid !== undefined && (typeof kid !== 'string' || !/^[!-~]{1,256}$/.test(kid))) return undefined;
  return kid === undefined ? { x } : { kid, x };
}

/**
 * A recipient's current key, from its JWKS (`{ "keys": [...] }`: the first X25519 key, which Google's single-key set
 * and a rotating Prebid Server host's list both put first) or a single JWK
 * (`{ "kty": "OKP", "crv": "X25519", "kid": ..., "x": ... }`). Throws a `TypeError` on anything else: no X25519 key, an
 * `x` that isn't 32 bytes of base64url, or a private key.
 */
export function parseIpKey(value: unknown): IpKey {
  const keys: readonly unknown[] = isRecord(value) && Array.isArray(value['keys']) ? value['keys'] : [value];
  for (const entry of keys) {
    const key = jwk(entry);
    if (key !== undefined) return key;
  }
  throw new TypeError('No X25519 public key (kty "OKP", crv "X25519", a 32-byte base64url "x")');
}
