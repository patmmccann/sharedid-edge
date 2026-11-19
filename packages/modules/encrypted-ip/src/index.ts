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
import { seal } from './hpke.js';
import { base64url, fromBase64url, parseIpKey, type IpKey } from './key.js';

export { base64url, fromBase64url, GOOGLE_IP_KEY_URL, parseIpKey, type IpKey } from './key.js';

/** The module's name, in `SID_MODULES` and `SID_MODULE_CONFIG`. */
export const ENCRYPTED_IP_MODULE = 'encrypted-ip';

/**
 * How long a copy of a recipient's key is fresh. Google keeps rotated private keys, so a payload encrypted with a key
 * fetched within the last 24 hours still decrypts; the Prebid Server proposal keeps previous keys for a grace period
 * like it. Older, the module reports `stale` (and keeps encrypting with it).
 */
export const IP_KEY_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/** A key time up to this far ahead of the worker's clock counts as now: normal clock skew between hosts. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** A Prebid Server host's name, as the payload keys it: a lower-case host name, optionally with a port. */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** One recipient's settings: its key, if the settings provide it, and when that copy was fetched (epoch ms). */
export interface RecipientSettings {
  readonly key: IpKey | undefined;
  readonly keyFetched: number | undefined;
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

function recipientSettings(value: unknown, where: string): RecipientSettings {
  if (!isRecord(value)) throw new TypeError(`encrypted-ip: ${where} must be an object`);
  for (const name of Object.keys(value)) {
    if (name !== 'key' && name !== 'keyFetched') throw new TypeError(`encrypted-ip: ${where} has an unknown setting "${name}"`);
  }
  let key: IpKey | undefined;
  try { key = value['key'] === undefined ? undefined : parseIpKey(value['key']); }
  catch (error) { throw new TypeError(`encrypted-ip: ${where}.key: ${error instanceof Error ? error.message : 'invalid'}`, { cause: error }); }
  const fetched = value['keyFetched'];
  if (fetched === undefined) return { key, keyFetched: undefined };
  if (key === undefined) throw new TypeError(`encrypted-ip: ${where}.keyFetched needs ${where}.key`);
  // An explicit offset or Z: a date-time without one is local time, which differs between hosts.
  const time = typeof fetched === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(fetched) ? Date.parse(fetched) : NaN;
  if (!Number.isFinite(time)) throw new TypeError(`encrypted-ip: ${where}.keyFetched must be an ISO 8601 date and time with a time zone`);
  return { key, keyFetched: time };
}

/**
 * Parses the module's settings: `google` and `pbs` (an object keyed by Prebid Server host name), each recipient
 * `{ key?, keyFetched? }`, where `key` is the recipient's JWKS or its one JWK and `keyFetched` an ISO 8601 date and
 * time with a time zone. A recipient is on when it's listed, even as `{}` (its key then comes from a scheduled
 * snapshot). Throws a `TypeError` naming the setting on anything else, including no recipient at all, so a typo makes
 * the module an `error` rather than quietly change what it does. Pure: usable when a build validates settings.
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

/**
 * Encrypts an address to a recipient's key: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * AES-256-GCM, empty info and AAD, a fresh ephemeral key per call; `enc` then the ciphertext and tag, as unpadded
 * base64url. The same for Google and for Prebid Server hosts.
 */
export async function encryptIp(address: string, key: IpKey): Promise<string> {
  const publicKey = fromBase64url(key.x);
  if (publicKey === undefined) throw new TypeError('Invalid key');
  return base64url(await seal(publicKey, new TextEncoder().encode(address)));
}

/** A recipient's key from scheduled data: the shape of `SnapshotCache.current` from `@sharedid-edge/data-updates`. */
export type KeySnapshot = () => { readonly data: IpKey; readonly checkedAt: number } | undefined;

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

interface Resolved {
  readonly key: IpKey | undefined;
  readonly stale: boolean;
}

/**
 * The `encrypted-ip` module, with keys from settings and, optionally, scheduled snapshots. Each recipient listed in
 * the settings gets a value; one without a key gets none, and one whose key is over 24 hours old (or more than 5
 * minutes ahead) gets its value marked `stale`. Either makes the module report `stale`.
 */
export function createEncryptedIpModule(options: EncryptedIpModuleOptions = {}): EdgeModule {
  const now = options.now ?? Date.now;
  function resolve(settings: RecipientSettings, snapshot: KeySnapshot | undefined, where: string, time: number): Resolved {
    if (settings.key !== undefined && snapshot !== undefined) throw new TypeError(`encrypted-ip: ${where} has a key in its settings and a scheduled one`);
    const current = settings.key === undefined ? snapshot?.() : { data: settings.key, checkedAt: settings.keyFetched };
    if (current === undefined) return { key: undefined, stale: true };
    const age = current.checkedAt === undefined ? 0 : time - current.checkedAt;
    return { key: current.data, stale: age > IP_KEY_MAX_AGE_MS || age < -CLOCK_SKEW_MS };
  }
  async function value({ key, stale }: Resolved, address: string): Promise<EncryptedIpValue | undefined> {
    if (key === undefined) return undefined;
    const encrypted = await encryptIp(address, key);
    return { value: encrypted, ...(key.kid === undefined ? {} : { kid: key.kid }), ...(stale ? { stale: true } : {}) };
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
      const googleValue = google === undefined ? undefined : await value(google, address);
      const pbsValues = (await Promise.all(hosts.map(async ([host, resolved]) => [host, await value(resolved, address)] as const)))
        .filter((entry): entry is readonly [string, EncryptedIpValue] => entry[1] !== undefined);
      const eip: EncryptedIp = {
        ...(googleValue === undefined ? {} : { google: googleValue }),
        ...(pbsValues.length === 0 ? {} : { pbs: Object.fromEntries(pbsValues) })
      };
      return googleValue === undefined && pbsValues.length === 0 ? (stale ? flag : undefined) : { eip, ...flag };
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
