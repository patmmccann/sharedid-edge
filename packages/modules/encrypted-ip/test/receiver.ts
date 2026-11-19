/**
 * Test helpers, and a receiver for the module's payloads written independently of `src/hpke.ts`: it uses Web Crypto's
 * own HKDF (`deriveBits` with `HKDF`, Extract and Expand in one) where the module builds them from HMAC, so a round
 * trip checks one against the other, as Google's decryption would.
 */

export const hex = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array((value.match(/../g) ?? []).map(byte => parseInt(byte, 16)));
export const toHex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** An X25519 private key from its 32 raw bytes, as PKCS #8 (RFC 8410's fixed prefix). */
export async function privateKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...hex('302e020100300506032b656e04220420'), ...raw]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const join = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flatMap(part => [...part]));
const KEM = join(utf8('KEM'), hex('0020'));
const SUITE = join(utf8('HPKE'), hex('0020'), hex('0001'), hex('0002'));

/** HKDF-SHA256 (RFC 5869): Expand(Extract(salt, ikm), info, length), in Web Crypto. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** HKDF-Extract alone is HMAC-SHA256(salt, ikm), with HashLen zero bytes for an empty salt. */
async function extract(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', salt.byteLength === 0 ? new Uint8Array(32) : salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

const labeledIkm = (suite: Uint8Array, label: string, ikm: Uint8Array): Uint8Array<ArrayBuffer> => join(utf8('HPKE-v1'), suite, utf8(label), ikm);
const labeledInfo = (suite: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array<ArrayBuffer> =>
  join(new Uint8Array([length >> 8, length & 0xff]), utf8('HPKE-v1'), suite, utf8(label), info);

/** Opens an HPKE base-mode payload (`enc` || ciphertext) with empty info and AAD, as Google does. */
export async function open(payload: Uint8Array<ArrayBuffer>, recipientPrivate: CryptoKey, recipientPublic: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const enc = payload.slice(0, 32);
  const ephemeral = await crypto.subtle.importKey('raw', enc, { name: 'X25519' }, true, []);
  const dh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: ephemeral }, recipientPrivate, 256));
  const empty = new Uint8Array(0);
  const sharedSecret = await hkdf(empty, labeledIkm(KEM, 'eae_prk', dh), labeledInfo(KEM, 'shared_secret', join(enc, recipientPublic), 32), 32);
  const context = join(new Uint8Array([0]), await extract(empty, labeledIkm(SUITE, 'psk_id_hash', empty)), await extract(empty, labeledIkm(SUITE, 'info_hash', empty)));
  const ikm = labeledIkm(SUITE, 'secret', empty);
  const key = await hkdf(sharedSecret, ikm, labeledInfo(SUITE, 'key', context, 32), 32);
  const nonce = await hkdf(sharedSecret, ikm, labeledInfo(SUITE, 'base_nonce', context, 12), 12);
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: empty }, aes, payload.slice(32)));
}

/** A recipient key pair for round trips: the private key, and the public key as raw bytes and as Google's JWK. */
export async function recipient(kid = 'test'): Promise<{ readonly privateKey: CryptoKey; readonly publicKey: Uint8Array<ArrayBuffer>; readonly jwk: { kty: string; crv: string; kid: string; x: string } }> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (exported.x === undefined) throw new Error('no x');
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), jwk: { kty: 'OKP', crv: 'X25519', kid, x: exported.x } };
}
