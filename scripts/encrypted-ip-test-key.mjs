// The encrypted-ip module's settings for this project's live demo (the Cloudflare and AWS /platform deployments and the
// Vercel project), from a test-only X25519 key pair. Not for deployers.
//
//   ENCRYPTED_IP_TEST_KEY=<private key> node scripts/encrypted-ip-test-key.mjs
//
// ENCRYPTED_IP_TEST_KEY is the private key, the 32 raw bytes as unpadded base64url (a JWK's "d"), held only as the
// repository secret of the same name. This prints the public part, which is all a deployment needs (keys are public;
// the module refuses a private part): its recipients, `{"pbs":{"<recipient>":{"key":{"keys":[…]}}}}`, for
// SID_MODULE_CONFIG["encrypted-ip"]. The recipient is a made-up Prebid Server host name: there's no server, the browser
// tests decrypt the values themselves with the private key. The kid is derived from the public key, so a new key pair
// gets a new kid. Make a key pair with:
//
//   node -e "crypto.subtle.generateKey({name:'X25519'},true,['deriveBits']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(j.d))"
//
// The private key is never printed, and an invalid one is reported without its value.

import { Buffer } from 'node:buffer';
import { webcrypto as crypto } from 'node:crypto';

/** The recipient name the deployments and e2e/tests/prebid-sharedid.spec.ts use. */
const RECIPIENT = 'eip-test.sharedid.dev';

/** RFC 8410's fixed PKCS #8 prefix for an X25519 private key, before its 32 raw bytes. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const secret = (process.env['ENCRYPTED_IP_TEST_KEY'] ?? '').trim();
const raw = Buffer.from(secret, 'base64url');
if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || raw.length !== 32) {
  console.error('ENCRYPTED_IP_TEST_KEY must be an X25519 private key: 32 bytes as unpadded base64url (43 characters).');
  process.exit(1);
}
const key = await crypto.subtle.importKey('pkcs8', Buffer.concat([PKCS8_PREFIX, raw]), { name: 'X25519' }, true, ['deriveBits']);
const { x } = await crypto.subtle.exportKey('jwk', key);
if (typeof x !== 'string') throw new Error('no public key');
const kid = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(x, 'base64url'))).toString('base64url').slice(0, 8);
process.stdout.write(`${JSON.stringify({ pbs: { [RECIPIENT]: { key: { keys: [{ kty: 'OKP', crv: 'X25519', kid, x }] } } } })}\n`);
