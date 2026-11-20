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

/** A recipient's public key: its key ID and the X25519 public key, base64url (32 bytes). */
export interface IpKey {
  readonly kid: string;
  readonly x: string;
}

/** Where Google publishes its key file: a JWKS (RFC 8037) with exactly one key, the active one. */
export const GOOGLE_IP_KEY_URL = 'https://www.gstatic.com/real-ip/ip_enc_key.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A recipient's key from its key file, as Google publishes one: `{ "keys": [ { "kty": "OKP", "crv": "X25519",
 * "kid": …, "x": … } ] }`, with exactly one key, the active one. Recipients rotate by keeping their old private keys
 * for a while, not by listing several public keys, so a file with no key or more than one is refused rather than
 * guessed at. Throws a `TypeError` on anything else: not that shape, another key type, a missing or unprintable
 * `kid`, an `x` that isn't 32 bytes of unpadded base64url, or a private key (`d`).
 */
export function parseIpKey(value: unknown): IpKey {
  if (!isRecord(value) || !Array.isArray(value['keys'])) throw new TypeError('Not a key file: expected { "keys": [ … ] }');
  const keys: readonly unknown[] = value['keys'];
  if (keys.length !== 1) throw new TypeError(`A key file must hold exactly one key; it has ${String(keys.length)}`);
  const key = keys[0];
  if (!isRecord(key) || key['kty'] !== 'OKP' || key['crv'] !== 'X25519') throw new TypeError('The key must be X25519 (kty "OKP", crv "X25519")');
  // A private key here is a mistake that could leak it.
  if ('d' in key) throw new TypeError('The key must be a public key; it has a private part ("d")');
  const { x, kid } = key;
  if (typeof x !== 'string' || fromBase64url(x)?.byteLength !== 32) throw new TypeError('The "x" of the key must be 32 bytes of unpadded base64url');
  // As the payload carries it: printable ASCII without spaces, at most 256 characters.
  if (typeof kid !== 'string' || !/^[!-~]{1,256}$/.test(kid)) throw new TypeError('The key needs a "kid" of printable ASCII without spaces');
  return { kid, x };
}
