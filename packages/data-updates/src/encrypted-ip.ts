import { GOOGLE_IP_KEY_URL, parseIpKey, type IpKey } from '@sharedid-edge/module-encrypted-ip';
import { checkNotModified, downloaded, get } from './download.js';
import { sourceName } from './snapshot.js';
import type { UpdateSource } from './update.js';

export { GOOGLE_IP_KEY_URL, type IpKey } from '@sharedid-edge/module-encrypted-ip';

/** A key file is about 100 bytes per key; anything much larger isn't one. */
const MAX_KEY_BYTES = 16 * 1024;

/**
 * Validates a stored key snapshot: an X25519 public key (`kty` `OKP`, `crv` `X25519`, a 32-byte base64url `x`,
 * optionally its `kid`), as `{ kid?, x }`.
 */
export function validateIpKey(value: unknown): IpKey {
  return parseIpKey(typeof value === 'object' && value !== null && !('kty' in value) ? { ...value, kty: 'OKP', crv: 'X25519' } : value);
}

/** A source for a JWKS at a public HTTPS URL: no credentials and no visitor data; keeps its first X25519 key. */
function ipKeySource(name: string, url: string): UpdateSource<IpKey> {
  return {
    name: sourceName(name),
    // A new URL is a new key: an ETag from the old one mustn't skip the download.
    variant: JSON.stringify({ version: 1, url }),
    validate: validateIpKey,
    async download(context) {
      const response = await get(url, context);
      if (response.status === 304) { checkNotModified(url, context); return undefined; }
      return downloaded(response, url, MAX_KEY_BYTES);
    },
    decode(file) {
      return parseIpKey(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file)));
    }
  };
}

/**
 * Google Publisher Tag's publisher-provided IP key, from `https://www.gstatic.com/real-ip/ip_enc_key.json`, as source
 * `google-ip-key` (or the name given). Run it at least every 24 hours, and as often as the file's `Cache-Control`
 * asks (`max-age=3000`, 50 minutes, when this was written): Google keeps rotated private keys, so a key fetched within
 * the last 24 hours still decrypts.
 */
export function googleIpKeySource(name = 'google-ip-key'): UpdateSource<IpKey> {
  return ipKeySource(name, GOOGLE_IP_KEY_URL);
}

/**
 * A Prebid Server host's key for encrypted client IPs (experimental: prebid/prebid-server#5106), from the JWKS URL its
 * operator publishes (`https:` only, no user name or password), keeping the first X25519 key, the current one. Give
 * each host its own source `name`. Run it at least every 24 hours, or as the host's operator says.
 */
export function pbsIpKeySource(options: { readonly name: string; readonly url: string }): UpdateSource<IpKey> {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new TypeError('A Prebid Server key URL must be https, without credentials');
  return ipKeySource(options.name, url.href);
}
