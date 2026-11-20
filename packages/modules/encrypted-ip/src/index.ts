import {
  defineModule,
  preciseLocationDenial,
  type EdgeModule,
  type EncryptedIp,
  type EncryptedIpValue,
  type ModuleContext,
  type ModuleResult
} from '@sharedid-edge/core';
import { formatIpv4, formatIpv6, parseIp } from '@sharedid-edge/module-ip';
import { importRecipient, seal, type RecipientKey } from './hpke.js';
import { base64url, fromBase64url, parseIpKey, type IpKey } from './key.js';

export { base64url, fromBase64url, GOOGLE_IP_KEY_URL, parseIpKey, type IpKey } from './key.js';

/** The module's name, in `SID_MODULES` and `SID_MODULE_CONFIG`. */
export const ENCRYPTED_IP_MODULE = 'encrypted-ip';

/**
 * How long a copy of a recipient's key may be used after it was fetched. Google keeps rotated private keys, so a value
 * encrypted with a key fetched within the last 24 hours still decrypts, and it promises nothing beyond that; Prebid
 * Server's proposal follows it. Older, the recipient gets no value.
 */
export const IP_KEY_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/**
 * When a key is due for a refresh if its file didn't say (no `Cache-Control` `max-age`): an hour. Past its refresh
 * time, a key still encrypts and its values are marked `stale`, so a broken updater shows long before values stop.
 */
export const IP_KEY_DEFAULT_REFRESH_SECONDS = 3600;

/** A `max-age` is held to 1 minute to 24 hours: a key is never due sooner, and never fresh past its 24 hours. */
export const IP_KEY_MIN_REFRESH_SECONDS = 60;

/** A key time up to this far ahead of the worker's clock counts as now: normal clock skew between hosts. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** A Prebid Server host's name, as the payload keys it: a lower-case host name, optionally with a port. */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** A key as fetched: the key, and the `Cache-Control` `max-age` its file came with, if any (seconds). */
export interface FetchedIpKey extends IpKey {
  readonly maxAgeSeconds?: number;
}

/** A `max-age` held to {@link IP_KEY_MIN_REFRESH_SECONDS} to 24 hours, or undefined when there's none. */
export function refreshSeconds(maxAge: number | undefined): number | undefined {
  if (maxAge === undefined || !Number.isFinite(maxAge)) return undefined;
  return Math.min(Math.max(Math.floor(maxAge), IP_KEY_MIN_REFRESH_SECONDS), IP_KEY_MAX_AGE_MS / 1000);
}

/** One recipient's settings: its key, if the settings provide it, when that copy was fetched (epoch ms) and its max-age. */
export interface RecipientSettings {
  readonly key: IpKey | undefined;
  readonly keyFetched: number | undefined;
  readonly keyMaxAge: number | undefined;
}

/** The module's parsed settings (`SID_MODULE_CONFIG["encrypted-ip"]`): the recipients it encrypts for. */
export interface EncryptedIpSettings {
  readonly google: RecipientSettings | undefined;
  /** By Prebid Server host name. */
  readonly pbs: Readonly<Record<string, RecipientSettings>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RECIPIENT_SETTINGS = new Set(['key', 'keyFetched', 'keyMaxAge']);

function recipientSettings(value: unknown, where: string): RecipientSettings {
  if (!isRecord(value)) throw new TypeError(`encrypted-ip: ${where} must be an object`);
  for (const name of Object.keys(value)) {
    if (!RECIPIENT_SETTINGS.has(name)) throw new TypeError(`encrypted-ip: ${where} has an unknown setting "${name}"`);
  }
  let key: IpKey | undefined;
  try { key = value['key'] === undefined ? undefined : parseIpKey(value['key']); }
  catch (error) { throw new TypeError(`encrypted-ip: ${where}.key: ${error instanceof Error ? error.message : 'invalid'}`, { cause: error }); }
  const fetched = value['keyFetched'];
  const maxAge = value['keyMaxAge'];
  if (maxAge !== undefined && (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0)) {
    throw new TypeError(`encrypted-ip: ${where}.keyMaxAge must be a whole number of seconds`);
  }
  if (fetched === undefined) {
    if (maxAge !== undefined) throw new TypeError(`encrypted-ip: ${where}.keyMaxAge needs ${where}.keyFetched`);
    return { key, keyFetched: undefined, keyMaxAge: undefined };
  }
  if (key === undefined) throw new TypeError(`encrypted-ip: ${where}.keyFetched needs ${where}.key`);
  // An explicit offset or Z: a date-time without one is local time, which differs between hosts.
  const time = typeof fetched === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(fetched) ? Date.parse(fetched) : NaN;
  if (!Number.isFinite(time)) throw new TypeError(`encrypted-ip: ${where}.keyFetched must be an ISO 8601 date and time with a time zone`);
  return { key, keyFetched: time, keyMaxAge: maxAge };
}

/**
 * Parses the module's settings: `google` and `pbs` (an object keyed by Prebid Server host name), each recipient
 * `{ key?, keyFetched?, keyMaxAge? }`: `key` is the recipient's key file (exactly one key), `keyFetched` an ISO 8601
 * date and time with a time zone, `keyMaxAge` the file's `Cache-Control` `max-age` in seconds. A recipient is on when
 * it's listed, even as `{}` (its key then comes from a scheduled snapshot). Throws a `TypeError` naming the setting on
 * anything else, including no recipient at all, so a typo makes the module an `error` rather than quietly change what
 * it does. Pure: usable when a build validates settings.
 */
export function encryptedIpSettings(config: Readonly<Record<string, unknown>>): EncryptedIpSettings {
  if ((globalThis as { __SID_PREVALIDATED__?: boolean }).__SID_PREVALIDATED__ === true) return config as unknown as EncryptedIpSettings;
  for (const name of Object.keys(config)) {
    if (name !== 'google' && name !== 'pbs') throw new TypeError(`encrypted-ip: unknown setting "${name}"`);
  }
  const google = config['google'] === undefined ? undefined : recipientSettings(config['google'], 'google');
  const hosts = config['pbs'] ?? {};
  if (!isRecord(hosts)) throw new TypeError('encrypted-ip: "pbs" must be an object keyed by Prebid Server host name');
  const pbs: Record<string, RecipientSettings> = {};
  for (const [host, entry] of Object.entries(hosts)) {
    if (!HOST.test(host)) throw new TypeError('encrypted-ip: "pbs" keys must be lower-case host names, optionally with a port');
    Object.defineProperty(pbs, host, { value: recipientSettings(entry, `pbs["${host}"]`), enumerable: true });
  }
  if (google === undefined && Object.keys(pbs).length === 0) throw new TypeError('encrypted-ip: no recipient; set "google" or "pbs"');
  return { google, pbs };
}

/** The bare address to encrypt: IPv4 dotted (IPv4-mapped IPv6 too) or RFC 5952 IPv6, no port, brackets or prefix. */
function plaintextAddress(clientIp: string | undefined): string | undefined {
  const ip = clientIp === undefined ? undefined : parseIp(clientIp);
  if (ip === undefined) return undefined;
  return ip.version === 4 ? formatIpv4(ip.octets) : formatIpv6(ip.hextets);
}

/**
 * Whether the encrypted address must be left out, for every recipient: the `ip` module's rules (core's
 * `preciseLocationDenial`: GPC, COPPA, a US privacy opt-out, a TC string without Special Feature 1, GDPR without a TC
 * string), and also every storage denial that isn't TCF's own: the opt-out cookie, and a consent provider's refusal
 * (`cmp`, `gpp`). Under TCF, Special Feature 1 decides, as it does for the plain address.
 */
export function encryptedIpDenied(context: Pick<ModuleContext, 'consent' | 'storage'>): boolean {
  const { storage } = context;
  return preciseLocationDenial(context.consent) !== undefined || (!storage.allowed && !storage.reason.startsWith('tcf: '));
}

/** Imported keys, by `x`: public key material only, never visitor data. A key that fails to import isn't kept. */
const imported = new Map<string, Promise<RecipientKey>>();
const MAX_IMPORTED = 16;

/** A recipient's key as a Web Crypto key, imported once and kept, by its public key, for every later message. */
function recipientKey(key: Pick<IpKey, 'x'>): Promise<RecipientKey> {
  const cached = imported.get(key.x);
  if (cached !== undefined) return cached;
  const raw = fromBase64url(key.x);
  const pending = raw === undefined ? Promise.reject(new TypeError('Invalid key')) : importRecipient(raw);
  if (imported.size >= MAX_IMPORTED) {
    const oldest = imported.keys().next();
    if (oldest.done !== true) imported.delete(oldest.value);
  }
  imported.set(key.x, pending);
  pending.catch(() => { imported.delete(key.x); });
  return pending;
}

/**
 * Imports a recipient's key into Web Crypto ahead of its first use, and keeps it for every later message. Call it when
 * a key is loaded or reloaded, outside module execution: `@sharedid-edge/data-updates`'s `validateIpKey` does, so a
 * scheduled key is ready before a request needs it. A key from settings is imported on its first use. Rejects for a
 * key that can't be imported.
 */
export async function importIpKey(key: Pick<IpKey, 'x'>): Promise<void> {
  await recipientKey(key);
}

/**
 * Encrypts an address to a recipient's key: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * AES-256-GCM, empty info and AAD, a fresh ephemeral key per call; `enc` then the ciphertext and tag, as unpadded
 * base64url. The same for Google and for Prebid Server hosts.
 */
export async function encryptIp(address: string, key: Pick<IpKey, 'x'>): Promise<string> {
  return base64url(await seal(await recipientKey(key), new TextEncoder().encode(address)));
}

/** A recipient's key from scheduled data: the shape of `SnapshotCache.current` from `@sharedid-edge/data-updates`. */
export type KeySnapshot = () => { readonly data: FetchedIpKey; readonly checkedAt: number } | undefined;

/** Options for {@link createEncryptedIpModule}. */
export interface EncryptedIpModuleOptions {
  /**
   * Keys from scheduled snapshots, for recipients whose settings leave `key` out: `google`, and Prebid Server hosts by
   * name. A recipient is still on only when the settings list it.
   */
  readonly keys?: { readonly google?: KeySnapshot; readonly pbs?: Readonly<Record<string, KeySnapshot>> };
  /** The clock, for the keys' age; `Date.now` by default. */
  readonly now?: () => number;
}

/** A recipient's key for this request: undefined when there's none or it's over 24 hours old; stale past its refresh. */
interface Resolved {
  readonly key: IpKey | undefined;
  readonly stale: boolean;
}

/**
 * Whether a key fetched at `fetchedAt` (with the file's `max-age`) may still be used, and whether it's past its
 * refresh time: over 24 hours old, no; past its `max-age` (an hour without one), stale; more than 5 minutes ahead of
 * the clock, stale. Without a fetch time (a key setting without `keyFetched`), always fresh.
 */
export function keyAge(fetchedAt: number | undefined, maxAgeSeconds: number | undefined, now: number): { readonly usable: boolean; readonly stale: boolean } {
  if (fetchedAt === undefined) return { usable: true, stale: false };
  const age = now - fetchedAt;
  if (age > IP_KEY_MAX_AGE_MS) return { usable: false, stale: true };
  const refresh = (refreshSeconds(maxAgeSeconds) ?? IP_KEY_DEFAULT_REFRESH_SECONDS) * 1000;
  return { usable: true, stale: age > refresh || age < -CLOCK_SKEW_MS };
}

/**
 * The `encrypted-ip` module, with keys from settings and, optionally, scheduled snapshots. Each recipient listed in the
 * settings gets a value, unless it has no key or its key was fetched over 24 hours ago; a key past its refresh time
 * (the file's `max-age`, or an hour) still encrypts, and that value is marked `stale`. Any of these makes the module
 * report `stale`.
 */
export function createEncryptedIpModule(options: EncryptedIpModuleOptions = {}): EdgeModule {
  const now = options.now ?? Date.now;
  function resolve(settings: RecipientSettings, snapshot: KeySnapshot | undefined, where: string, time: number): Resolved {
    if (settings.key !== undefined && snapshot !== undefined) throw new TypeError(`encrypted-ip: ${where} has a key in its settings and a scheduled one`);
    const current = settings.key === undefined ? snapshot?.() : { data: { ...settings.key, ...(settings.keyMaxAge === undefined ? {} : { maxAgeSeconds: settings.keyMaxAge }) }, checkedAt: settings.keyFetched };
    if (current === undefined) return { key: undefined, stale: true };
    const { usable, stale } = keyAge(current.checkedAt, current.data.maxAgeSeconds, time);
    return { key: usable ? { kid: current.data.kid, x: current.data.x } : undefined, stale };
  }
  async function value({ key, stale }: Resolved, address: string): Promise<EncryptedIpValue | undefined> {
    if (key === undefined) return undefined;
    return { value: await encryptIp(address, key), kid: key.kid, ...(stale ? { stale: true } : {}) };
  }
  return defineModule({
    name: ENCRYPTED_IP_MODULE,
    async run(context: ModuleContext): Promise<ModuleResult | undefined> {
      const settings = encryptedIpSettings(context.config);
      const time = now();
      const google = settings.google === undefined ? undefined : resolve(settings.google, options.keys?.google, 'google', time);
      const hosts = Object.entries(settings.pbs).map(([host, entry]): [string, Resolved] => [host, resolve(entry, options.keys?.pbs?.[host], `pbs["${host}"]`, time)]);
      const stale = google?.stale === true || hosts.some(([, resolved]) => resolved.stale);
      const address = encryptedIpDenied(context) ? undefined : plaintextAddress(context.platform.clientIp);
      const flag = stale ? { stale: true } : {};
      if (address === undefined) return stale ? flag : undefined;
      const [googleValue, pbsValues] = await Promise.all([
        google === undefined ? undefined : value(google, address),
        Promise.all(hosts.map(async ([host, resolved]) => [host, await value(resolved, address)] as const))
      ]);
      const entries = pbsValues.filter((entry): entry is readonly [string, EncryptedIpValue] => entry[1] !== undefined);
      const eip: EncryptedIp = {
        ...(googleValue === undefined ? {} : { google: googleValue }),
        ...(entries.length === 0 ? {} : { pbs: Object.fromEntries(entries) })
      };
      return googleValue === undefined && entries.length === 0 ? (stale ? flag : undefined) : { eip, ...flag };
    }
  });
}

/**
 * The `encrypted-ip` module: the client's IP address encrypted to each configured recipient's public key, in the
 * payload's `eip`: `google`, for Google Publisher Tag's `googletag.setConfig({ ipAddress })`, and `pbs`, by Prebid
 * Server host, for Prebid Server's proposed (experimental) `device.ext.prebid.eip`. Keys come from settings here; use
 * {@link createEncryptedIpModule} for keys from scheduled snapshots. Opt-in at build time, and runs only when listed in
 * `SID_MODULES`. Nothing about the address is stored or logged, and no ID is derived from it.
 */
export const encryptedIpModule: EdgeModule = createEncryptedIpModule();
