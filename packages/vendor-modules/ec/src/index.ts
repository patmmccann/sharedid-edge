import { defineModule, EU_COUNTRY_CODES, type ConsentContext, type EdgeModule, type ModuleContext, type ModuleCookie, type ModuleResult, type PlatformInfo } from '@sharedid-edge/core';
import { parseIp, type ParsedIp } from '@sharedid-edge/module-ip';

/**
 * IAB Tech Lab Trusted Server Edge Cookies (EC): `ts-ec`, a first-party identifier of the form
 * `{HMAC-SHA256(passphrase, normalized client IP) as 64 lowercase hex}.{6 random alphanumerics}`.
 *
 * Unlike the SharedID, **the prefix is derived from the client's IP address**: everyone behind the same IPv4 address,
 * or the same IPv6 /64, gets the same 64-hex prefix. That's how Trusted Server defines EC, and it's why this module is
 * an explicit opt-in. See https://iabtechlab.github.io/trusted-server/guide/edge-cookies.html.
 */
export const EC_COOKIE = 'ts-ec';
/** One year, as Trusted Server sets it. */
export const EC_MAX_AGE_SECONDS = 31_536_000;
/** Trusted Server requires a passphrase of at least 32 bytes. */
export const MIN_PASSPHRASE_BYTES = 32;

const EC_ID = /^[0-9a-f]{64}\.[A-Za-z0-9]{6}$/;
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Whether a value has the EC format. Like Trusted Server, only the format is checked, not the HMAC. */
export function isValidEcId(value: string | undefined): value is string {
  return value !== undefined && EC_ID.test(value);
}

/**
 * The HMAC input for an address, as Trusted Server normalizes it: IPv4 in dotted decimal; IPv6 as its first four
 * hextets (the /64), zero-padded lowercase hex with no separators, e.g. `2001:db8:85a3::1` gives `20010db885a30000`.
 * An IPv4-mapped address (`::ffff:192.0.2.1`), which `parseIp` returns as IPv4, gives its IPv4 address, so a dual-stack
 * client gets the same prefix either way. Trusted Server would give every mapped address `0000000000000000`.
 */
export function normalizeIp(ip: ParsedIp): string {
  if (ip.version === 4) return ip.octets.join('.');
  return ip.hextets.slice(0, 4).map(h => h.toString(16).padStart(4, '0')).join('');
}

/** The 64-hex prefix: HMAC-SHA256 of the normalized address, keyed with the passphrase. */
export async function ecPrefix(passphrase: string, normalizedIp: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(passphrase), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(normalizedIp)));
  return [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Six characters drawn uniformly from `A-Za-z0-9`. */
export function randomSuffix(): string {
  let out = '';
  while (out.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 is the largest multiple of 62 below 256: rejecting the rest keeps the draw uniform.
      if (byte < 248 && out.length < 6) out += ALPHANUMERIC.charAt(byte % 62);
    }
  }
  return out;
}

/**
 * The countries where GDPR applies for this module, as Trusted Server lists them (`GDPR_COUNTRIES` in
 * `crates/trusted-server-core/src/geo.rs`, at 06e51be): the 27 EU member states, the rest of the EEA (Iceland,
 * Liechtenstein, Norway) and the United Kingdom (UK GDPR). Wider than core's `EU_COUNTRY_CODES`, which matches
 * Cloudflare's `isEUCountry` and stays as it is. Turkey and Switzerland aren't in it, as in Trusted Server.
 */
export const EC_GDPR_COUNTRIES: ReadonlySet<string> = new Set([...EU_COUNTRY_CODES, 'GB', 'IS', 'LI', 'NO']);

/**
 * Whether GDPR applies for this module: `gdpr=1` or `gdpr=0` as sent; otherwise a country in `EC_GDPR_COUNTRIES` or
 * the platform's EU flag; otherwise unknown. Used in place of core's `gdprApplies`, which only knows the EU.
 */
export function ecGdprApplies(url: URL, platform: Pick<PlatformInfo, 'country' | 'isEU'>): boolean | undefined {
  const param = url.searchParams.get('gdpr');
  if (param === '1') return true;
  if (param === '0') return false;
  if (platform.country !== undefined && EC_GDPR_COUNTRIES.has(platform.country)) return true;
  return platform.isEU;
}

/**
 * Whether the EC may be returned as an EID, once `ecDecision` allows it, following Trusted Server's
 * `gate_eids_by_consent`: with a TC string, only with consent for Purposes 1 and 4 (core segment); without one, only
 * when GDPR doesn't apply. The cookie itself needs Purpose 1 only.
 */
export function ecEidAllowed(consent: ConsentContext): boolean {
  if (consent.tcString !== undefined) return consent.tcf?.purposeConsents.has(1) === true && consent.tcf.purposeConsents.has(4);
  return consent.gdprApplies !== true;
}

export type EcDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; /** Whether an existing `ts-ec` should be deleted. */ readonly withdraw: boolean };

/**
 * Whether an EC may be created or used, following Trusted Server's rules on the signals this worker has:
 *
 * - opt-out, GPC, COPPA or a `us_privacy` opt-out of sale withdraws (deletes an existing EC);
 * - a TC string without consent for Purpose 1 (core segment) withdraws; an undecodable one fails closed without deleting;
 * - GDPR without a TC string fails closed without deleting.
 *
 * `consent.gdprApplies` should be the module's own (`ecGdprApplies`), as `run` passes it.
 */
export function ecDecision(consent: ConsentContext, optedOut: boolean): EcDecision {
  if (optedOut) return { allowed: false, reason: 'opt-out', withdraw: true };
  if (consent.gpc) return { allowed: false, reason: 'gpc', withdraw: true };
  if (consent.coppa) return { allowed: false, reason: 'coppa', withdraw: true };
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return { allowed: false, reason: 'us-privacy', withdraw: true };
  if (consent.tcString !== undefined) {
    if (consent.tcf === undefined) return { allowed: false, reason: 'tcf: invalid TC string', withdraw: false };
    if (!consent.tcf.purposeConsents.has(1)) return { allowed: false, reason: 'tcf: no consent for purpose 1', withdraw: true };
    return { allowed: true };
  }
  if (consent.gdprApplies === true) return { allowed: false, reason: 'tcf: no TC string', withdraw: false };
  return { allowed: true };
}

/** Settings from `SID_MODULE_CONFIG.ec`. */
export interface EcModuleConfig {
  /** The publisher's domain, e.g. `example.com`: the cookie gets `Domain=.example.com`, as Trusted Server sets it. */
  readonly domain: string | undefined;
}

export function ecModuleConfig(config: Readonly<Record<string, unknown>>): EcModuleConfig {
  const domain = config['domain'];
  if (domain === undefined) return { domain: undefined };
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) throw new TypeError('ec: "domain" must be a domain like example.com');
  return { domain };
}

/**
 * Passphrases refused as placeholders, compared ignoring ASCII case: Trusted Server's `PASSPHRASE_PLACEHOLDERS`
 * (`crates/trusted-server-core/src/settings.rs`, at 06e51be), then this project's own examples, which deployers might
 * copy as they are (the Fastly adapter's local `fastly.toml`, and the adapters' READMEs).
 */
export const EC_PASSPHRASE_PLACEHOLDERS: readonly string[] = Object.freeze([
  'secret-key',
  'secret_key',
  'trusted-server',
  'trusted-server-placeholder-secret',
  'replace-with-random-ec-passphrase',
  'a-local-passphrase-of-at-least-32-characters',
  '<openssl rand -hex 32>',
  '<your passphrase>'
]);

/** Whether a passphrase is one of `EC_PASSPHRASE_PLACEHOLDERS`, ignoring ASCII case, as Trusted Server compares. */
export function isPlaceholderPassphrase(passphrase: string): boolean {
  const lower = passphrase.replace(/[A-Z]/g, c => c.toLowerCase());
  return EC_PASSPHRASE_PLACEHOLDERS.includes(lower);
}

/**
 * The passphrase from `SID_MODULE_SECRETS.ec`; throws (an `error` status) if it's missing, too short or a placeholder.
 * The messages name the setting, never the value.
 */
export function ecPassphrase(secrets: Readonly<Record<string, string>>): string {
  const passphrase = secrets['passphrase'];
  if (passphrase === undefined || new TextEncoder().encode(passphrase).byteLength < MIN_PASSPHRASE_BYTES) {
    throw new TypeError('ec: SID_MODULE_SECRETS.ec.passphrase must be at least 32 bytes');
  }
  if (isPlaceholderPassphrase(passphrase)) {
    throw new TypeError('ec: SID_MODULE_SECRETS.ec.passphrase is a placeholder from the documentation; set a random one');
  }
  return passphrase;
}

/**
 * The EID `source` for an EC. OpenRTB's implementation guidance (7.12.2) makes an alt-ID's source the domain of the party
 * that defined it; IAB Tech Lab's Trusted Server defines the EC. Trusted Server's code names none (it sets `user.id` in
 * the requests it builds itself). Change it only with the README and the spec.
 */
export const EC_EID_SOURCE = 'ts.iabtechlab.com';

/**
 * The EC as an EID (`atype` 1, a cookie ID), both in the payload's `eids` and in `ortb2.user.ext.eids`, the fragment the
 * page merges into Prebid.js. Never as `ortb2.user.id`: in Prebid.js first-party data that would be every bidder's
 * exchange user ID.
 */
function ecOutput(id: string): Pick<ModuleResult, 'eids' | 'ortb2'> {
  const eid = { source: EC_EID_SOURCE, uids: [{ id, atype: 1 }] };
  return { eids: [eid], ortb2: { user: { ext: { eids: [eid] } } } };
}

function ecCookie(value: string, maxAgeSeconds: number, settings: EcModuleConfig): ModuleCookie {
  return { name: EC_COOKIE, value, maxAgeSeconds, httpOnly: true, ...(settings.domain === undefined ? {} : { domain: `.${settings.domain}` }) };
}

async function run({ url, platform, consent: coreConsent, cookies, optedOut, config, secrets }: ModuleContext): Promise<ModuleResult | undefined> {
  const settings = ecModuleConfig(config);
  const existing = cookies.get(EC_COOKIE);
  // Trusted Server's GDPR countries (EU, EEA and UK), not core's EU-only rule.
  const consent: ConsentContext = { ...coreConsent, gdprApplies: ecGdprApplies(url, platform) };
  const decision = ecDecision(consent, optedOut);
  if (!decision.allowed) {
    // Withdrawal needs no HMAC, so it doesn't depend on the passphrase: a missing or short secret must not keep an
    // existing ts-ec alive after GPC, COPPA, opt-out or withdrawn consent.
    return decision.withdraw && existing !== undefined ? { cookies: [ecCookie('', 0, settings)] } : undefined;
  }
  const passphrase = ecPassphrase(secrets);
  // The cookie needs Purpose 1; the EID, Purposes 1 and 4 (Trusted Server's gate_eids_by_consent).
  const eid = ecEidAllowed(consent);
  // An existing EC is used as is; like Trusted Server, it isn't refreshed.
  if (isValidEcId(existing)) return eid ? ecOutput(existing) : undefined;
  const ip = platform.clientIp === undefined ? undefined : parseIp(platform.clientIp);
  if (ip === undefined) return undefined;
  const id = `${await ecPrefix(passphrase, normalizeIp(ip))}.${randomSuffix()}`;
  return { ...(eid ? ecOutput(id) : {}), cookies: [ecCookie(id, EC_MAX_AGE_SECONDS, settings)] };
}

/**
 * The `ec` module: Trusted Server Edge Cookies. Off until listed in `SID_MODULES`, and needs a passphrase in
 * `SID_MODULE_SECRETS`. It sets the `HttpOnly` `ts-ec` cookie and returns the EC as an EID (`EC_EID_SOURCE`).
 */
export const ecModule: EdgeModule = defineModule({
  name: 'ec',
  // Also on /sync, so ts-ec is set on page views (as Trusted Server does), not only when the page calls /v1.
  routes: ['v1', 'sync'],
  run,
  // An opt-out at /optout deletes ts-ec straight away, not only on the next /v1 or /sync call.
  optOutCookies: config => [ecCookie('', 0, ecModuleConfig(config))]
});
