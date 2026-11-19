/**
 * HPKE (RFC 9180) base mode, single-shot seal, for one cipher suite: DHKEM(X25519, HKDF-SHA256) (0x0020),
 * HKDF-SHA256 (0x0001) and AES-256-GCM (0x0002), the suite Google Publisher Tag's publisher-provided IP uses. Web
 * Crypto only: X25519 `generateKey` and `deriveBits`, HMAC-SHA256 (HKDF's Extract and Expand are built from it, as
 * RFC 9180's `LabeledExtract` and `LabeledExpand` need them separately) and AES-GCM.
 */

type Bytes = Uint8Array<ArrayBuffer>;

/** An ephemeral X25519 key pair: the private key for `deriveBits`, and the raw 32-byte public key (`enc`). */
export interface EphemeralKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: Bytes;
}

const encoder = new TextEncoder();
const text = (value: string): Bytes => encoder.encode(value);

function concat(...parts: readonly Uint8Array[]): Bytes {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

/** I2OSP(value, 2): a 16-bit big-endian integer. */
const twoBytes = (value: number): Bytes => new Uint8Array([value >> 8, value & 0xff]);

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
/** Nk (AES-256-GCM's key), Nn (its nonce) and Nsecret (DHKEM(X25519)'s shared secret), in bytes. */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SECRET_BYTES = 32;
const KEM_SUITE = concat(text('KEM'), twoBytes(KEM_ID));
const HPKE_SUITE = concat(text('HPKE'), twoBytes(KEM_ID), twoBytes(KDF_ID), twoBytes(AEAD_ID));
const VERSION = text('HPKE-v1');
const EMPTY: Bytes = new Uint8Array(0);
/** HKDF-Extract with no salt uses HashLen zero bytes (RFC 5869), which HMAC treats exactly as an empty key. */
const ZERO_SALT: Bytes = new Uint8Array(32);
const X25519 = { name: 'X25519' } as const;

async function hmac(key: Bytes, message: Bytes): Promise<Bytes> {
  const imported = await crypto.subtle.importKey('raw', key.byteLength === 0 ? ZERO_SALT : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, message));
}

/** RFC 9180 `LabeledExtract(salt, label, ikm)`, with HKDF-SHA256's Extract. */
function labeledExtract(suite: Bytes, salt: Bytes, label: string, ikm: Bytes): Promise<Bytes> {
  return hmac(salt, concat(VERSION, suite, text(label), ikm));
}

/** RFC 9180 `LabeledExpand(prk, label, info, L)`, with HKDF-SHA256's Expand (L is at most 255 * 32 bytes). */
async function labeledExpand(suite: Bytes, prk: Bytes, label: string, info: Bytes, length: number): Promise<Bytes> {
  const labeledInfo = concat(twoBytes(length), VERSION, suite, text(label), info);
  const blocks: Bytes[] = [];
  let previous = EMPTY;
  for (let counter = 1; blocks.length * 32 < length; counter++) {
    previous = await hmac(prk, concat(previous, labeledInfo, new Uint8Array([counter])));
    blocks.push(previous);
  }
  return concat(...blocks).slice(0, length);
}

/** A fresh ephemeral X25519 key pair. */
export async function generateEphemeralKey(): Promise<EphemeralKey> {
  // The private key is never exported; a public key is always extractable.
  const pair = await crypto.subtle.generateKey(X25519, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

/** DHKEM(X25519, HKDF-SHA256)'s `Encap` with the given ephemeral key: the shared secret and `enc`. */
export async function encap(recipient: Bytes, ephemeral: EphemeralKey): Promise<{ readonly sharedSecret: Bytes; readonly enc: Bytes }> {
  if (recipient.byteLength !== 32) throw new TypeError('An X25519 public key is 32 bytes');
  const publicKey = await crypto.subtle.importKey('raw', recipient, X25519, true, []);
  const dh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, ephemeral.privateKey, 256));
  // RFC 9180 7.1.4: an all-zero X25519 output (a small-order public key) must abort.
  if (dh.every(byte => byte === 0)) throw new TypeError('Invalid X25519 public key');
  const enc = ephemeral.publicKey;
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh);
  return { sharedSecret: await labeledExpand(KEM_SUITE, prk, 'shared_secret', concat(enc, recipient), SECRET_BYTES), enc };
}

/** `key_schedule_context` for mode 0: the mode, then the hashes of the (empty) PSK ID and of `info`. */
async function scheduleContext(info: Bytes): Promise<Bytes> {
  const pskIdHash = await labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  return concat(new Uint8Array([0]), pskIdHash, await labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info));
}

/** The context for an empty `info` (Google's) is a constant, worked out once: it depends on nothing from a request. */
let emptyInfoContext: Promise<Bytes> | undefined;

/** The base-mode key schedule (`KeyScheduleS` with mode 0, no PSK): the AEAD key and base nonce. */
export async function keySchedule(sharedSecret: Bytes, info: Bytes): Promise<{ readonly key: Bytes; readonly baseNonce: Bytes }> {
  const context = info.byteLength === 0 ? await (emptyInfoContext ??= scheduleContext(EMPTY)) : await scheduleContext(info);
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  return {
    key: await labeledExpand(HPKE_SUITE, secret, 'key', context, KEY_BYTES),
    baseNonce: await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, NONCE_BYTES)
  };
}

export interface SealOptions {
  readonly info?: Bytes;
  readonly aad?: Bytes;
  /** Tests only: a fixed ephemeral key, to check against RFC 9180's test vectors. Otherwise a fresh one per call. */
  readonly ephemeral?: EphemeralKey;
}

/**
 * Single-shot HPKE base-mode seal to an X25519 public key (32 raw bytes): `enc` (32 bytes) followed by the AES-256-GCM
 * ciphertext and its 16-byte tag. The first message of a context uses the base nonce unchanged (sequence number 0).
 */
export async function seal(recipient: Bytes, plaintext: Bytes, options: SealOptions = {}): Promise<Bytes> {
  const { sharedSecret, enc } = await encap(recipient, options.ephemeral ?? await generateEphemeralKey());
  const { key, baseNonce } = await keySchedule(sharedSecret, options.info ?? EMPTY);
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: baseNonce, additionalData: options.aad ?? EMPTY }, aesKey, plaintext);
  return concat(enc, new Uint8Array(ciphertext));
}
