import { describe, expect, it } from 'vitest';
import { encap, keySchedule, seal, type EphemeralKey } from '../src/hpke.js';
import { hex, privateKey, toHex } from './receiver.js';

async function ephemeral(skEm: string, pkEm: string): Promise<EphemeralKey> {
  return { privateKey: await privateKey(hex(skEm)), publicKey: hex(pkEm) };
}

/**
 * RFC 9180's test vector for exactly this suite: mode 0 (base), KEM 0x0020 DHKEM(X25519, HKDF-SHA256), KDF 0x0001
 * HKDF-SHA256, AEAD 0x0002 AES-256-GCM, from the full vector set the RFC points to (test-vectors.json in
 * github.com/cfrg/draft-irtf-cfrg-hpke), and its first encryption (sequence number 0, the only one a single-shot seal
 * makes). Copied as published; don't regenerate it with this code.
 */
const SUITE_VECTOR = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  skEm: '179d4b53b6365c45b600c4163b61d95cbc2f4d9e36f1695558dce265ab8bab11',
  pkEm: '6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256',
  skRm: '497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d',
  pkRm: '430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c',
  enc: '6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256',
  sharedSecret: '3101c54c3a4f87439eaac080699ed9bbcc726ffe44e860c0424ccb7e3e2ead7b',
  key: 'f50b0609186798729ed0564b36ef2ef8044f1f9d05636874d1f46c819c7a669f',
  baseNonce: '151d9929e2449747889bc923',
  aad: '436f756e742d30',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  ct: 'e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a'
} as const;

/**
 * RFC 9180 Appendix A.1.1 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode): the KEM is the same as
 * this suite's, so its shared secret checks the KEM against the RFC's printed text as well.
 */
const A_1_1 = {
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc'
} as const;

describe('HPKE base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM', () => {
  it('matches RFC 9180\'s test vector for the suite: shared secret, key, base nonce and ciphertext', async () => {
    const v = SUITE_VECTOR;
    const { sharedSecret, enc } = await encap(hex(v.pkRm), await ephemeral(v.skEm, v.pkEm));
    expect(toHex(enc)).toBe(v.enc);
    expect(toHex(sharedSecret)).toBe(v.sharedSecret);
    const { key, baseNonce } = await keySchedule(sharedSecret, hex(v.info));
    expect(toHex(key)).toBe(v.key);
    expect(toHex(baseNonce)).toBe(v.baseNonce);
    const sealed = await seal(hex(v.pkRm), hex(v.pt), { info: hex(v.info), aad: hex(v.aad), ephemeral: await ephemeral(v.skEm, v.pkEm) });
    expect(toHex(sealed)).toBe(v.enc + v.ct);
  });

  it('matches RFC 9180 A.1.1\'s KEM shared secret', async () => {
    const { sharedSecret, enc } = await encap(hex(A_1_1.pkRm), await ephemeral(A_1_1.skEm, A_1_1.pkEm));
    expect(toHex(enc)).toBe(A_1_1.pkEm);
    expect(toHex(sharedSecret)).toBe(A_1_1.sharedSecret);
  });

  it('uses a fresh ephemeral key for every message', async () => {
    const recipient = hex(SUITE_VECTOR.pkRm);
    const [a, b] = await Promise.all([seal(recipient, hex('00')), seal(recipient, hex('00'))]);
    expect(a.byteLength).toBe(32 + 1 + 16);
    expect(toHex(a.slice(0, 32))).not.toBe(toHex(b.slice(0, 32)));
  });

  it('refuses a public key that isn\'t 32 bytes, and a small-order one', async () => {
    await expect(seal(hex('00'.repeat(31)), hex('00'))).rejects.toThrow();
    // The all-zero point has small order: the X25519 output is all zero, which RFC 9180 says must abort.
    await expect(seal(hex('00'.repeat(32)), hex('00'))).rejects.toThrow();
  });
});
