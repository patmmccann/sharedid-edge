import { GOOGLE_IP_KEY_URL, importIpKey, parseIpKey, type FetchedIpKey } from '@sharedid-edge/module-encrypted-ip';
import { bytes, checkNotModified, get, requireOk } from './download.js';
import { sourceName } from './snapshot.js';
import type { UpdateSource } from './update.js';

export { GOOGLE_IP_KEY_URL, type FetchedIpKey } from '@sharedid-edge/module-encrypted-ip';

/** A key file is about 100 bytes; anything much larger isn't one. */
const MAX_KEY_BYTES = 16 * 1024;

/** `Cache-Control`'s `max-age`, in seconds, or undefined without one (`no-store` and `no-cache` count as 0). */
export function cacheMaxAge(header: string | null): number | undefined {
  if (header === null) return undefined;
  const directives = header.toLowerCase().split(',').map(part => part.trim());
  if (directives.includes('no-store') || directives.includes('no-cache')) return 0;
  const maxAge = directives.map(part => /^max-age\s*=\s*"?(\d{1,10})"?$/.exec(part)?.[1]).find(value => value !== undefined);
  return maxAge === undefined ? undefined : Number(maxAge);
}

/**
 * Validates a stored key snapshot, `{ kid, x, maxAgeSeconds? }`: an X25519 public key, as a recipient's key file holds
 * it, and the file's `Cache-Control` `max-age` when it had one. It also starts importing the key into Web Crypto, so the
 * module's first request after a load or reload finds it ready (the snapshot cache validates outside module execution).
 */
export function validateIpKey(value: unknown): FetchedIpKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid key snapshot');
  // Checked to be a non-array object just above.
  const { kid, x, maxAgeSeconds } = value as Record<string, unknown>;
  const key = parseIpKey({ keys: [{ kty: 'OKP', crv: 'X25519', kid, x }] });
  if (maxAgeSeconds !== undefined && (typeof maxAgeSeconds !== 'number' || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0)) throw new TypeError('Invalid key snapshot max-age');
  importIpKey(key).catch(() => undefined); // A failed import is retried on use, where it's reported.
  return maxAgeSeconds === undefined ? key : { ...key, maxAgeSeconds };
}

/**
 * A source for a key file at a public HTTPS URL: no credentials and no visitor data. Publishes the file's one key, and
 * its `Cache-Control` `max-age`, which decides when the module reports the key due for a refresh. The download hands
 * `decode` both, as JSON (`{ "maxAgeSeconds": …, "file": "<the key file>" }`), since `decode` sees only bytes.
 */
function ipKeySource(name: string, url: string): UpdateSource<FetchedIpKey> {
  return {
    name: sourceName(name),
    // A new URL is a new key: an ETag from the old one mustn't skip the download.
    variant: JSON.stringify({ version: 2, url }),
    validate: validateIpKey,
    async download(context) {
      const response = await get(url, context);
      if (response.status === 304) { checkNotModified(url, context); return undefined; }
      await requireOk(response, 'Download failed');
      const etag = response.headers.get('ETag');
      const maxAgeSeconds = cacheMaxAge(response.headers.get('Cache-Control'));
      const file = new TextDecoder('utf-8', { fatal: true }).decode(await bytes(response, MAX_KEY_BYTES));
      const envelope = JSON.stringify({ ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }), file });
      return { bytes: new TextEncoder().encode(envelope), url, ...(etag === null ? {} : { etag }) };
    },
    decode(envelope) {
      const value: unknown = JSON.parse(new TextDecoder().decode(envelope));
      if (typeof value !== 'object' || value === null || !('file' in value) || typeof value.file !== 'string') throw new TypeError('Invalid key download');
      const key = parseIpKey(JSON.parse(value.file));
      const maxAgeSeconds = 'maxAgeSeconds' in value && typeof value.maxAgeSeconds === 'number' ? value.maxAgeSeconds : undefined;
      return maxAgeSeconds === undefined ? key : { ...key, maxAgeSeconds };
    }
  };
}

/**
 * Google Publisher Tag's publisher-provided IP key, from `https://www.gstatic.com/real-ip/ip_enc_key.json`, as source
 * `google-ip-key` (or the name given). Run it at least as often as the file's `Cache-Control` asks (`max-age=3000`,
 * 50 minutes, when this was written): the module reports the key stale past that, and stops using it 24 hours after
 * the last successful check.
 */
export function googleIpKeySource(name = 'google-ip-key'): UpdateSource<FetchedIpKey> {
  return ipKeySource(name, GOOGLE_IP_KEY_URL);
}

/**
 * A Prebid Server host's key for encrypted client IPs (experimental: prebid/prebid-server#5106), from the key file its
 * operator publishes (`https:` only, no user name or password), with exactly one key as Google's has. Give each host
 * its own source `name`. The same freshness rules as Google's apply.
 */
export function pbsIpKeySource(options: { readonly name: string; readonly url: string }): UpdateSource<FetchedIpKey> {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new TypeError('A Prebid Server key URL must be https, without credentials');
  return ipKeySource(options.name, url.href);
}
