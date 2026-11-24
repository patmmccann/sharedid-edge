import { defineModule, preciseLocationDenial, type ConsentContext, type EdgeModule, type Eid, type ModuleContext, type ModuleCookie, type ModuleResult, type PlatformInfo } from '@sharedid-edge/core';
import { gppSignal } from '@sharedid-edge/module-gpp';
import { formatIpv4, formatIpv6, parseIp, type ParsedIp } from '@sharedid-edge/module-ip';

/**
 * The ID5 ID, fetched server-to-server: the worker asks ID5's API for the visitor's ID5 ID, with the deployment's own
 * ID5 partner number, the client IP, the user agent, the SharedID (as ID5's partner user ID, `puid`) and the consent
 * strings, and returns the EIDs ID5 answers with in `/v1`. The result and ID5's `signature` are cached in an `HttpOnly`
 * first-party cookie per partner, refreshed after 8 hours and dropped after 30 days. Written from ID5's public
 * documentation (its server-to-server API, its Prebid Server module) and Prebid.js's `id5IdSystem`; not by ID5.
 */

/** ID5's IAB Global Vendor List ID. */
export const ID5_GVLID = 131;
/** The hosts the module may send requests to: ID5's web fetch endpoint and its API host. */
export const ID5_HOSTS: readonly string[] = Object.freeze(['id5-sync.com', 'api.id5-sync.com']);
/** The default endpoint, Prebid.js's `/gs/v2` fetch URL; `{partner}` is replaced with the partner number. */
export const ID5_DEFAULT_ENDPOINT = 'https://id5-sync.com/gs/v2/{partner}.json';
/** The EID source of the legacy `universal_uid` answer, as Prebid.js's ID5 module gives it. */
export const ID5_EID_SOURCE = 'id5-sync.com';
/** The `origin` and `v` sent to ID5, naming this integration and its version (ID5 refuses a fetch without a version). */
export const ID5_ORIGIN = 'sharedid-edge';
export const ID5_VERSION = '0.1.0';
/** How long a cached answer is used before it's refreshed: 8 hours, as ID5's server-to-server documentation says. */
export const ID5_REFRESH_SECONDS: number = 8 * 3600;
/** The shortest refresh ID5's `cache_control.max_age_sec` can ask for: 15 minutes. */
export const ID5_MIN_REFRESH_SECONDS: number = 15 * 60;
/** How long a cached answer is kept without a refresh: 30 days, as ID5's documentation says. Also the cookie's lifetime. */
export const ID5_MAX_AGE_SECONDS: number = 30 * 86_400;
/** After ID5 answers with an error or something unusable, how long until the module asks again: an hour. */
export const ID5_RETRY_SECONDS = 3600;
/** The default time limit for the request to ID5, in milliseconds. */
export const ID5_DEFAULT_TIMEOUT_MS = 300;
/** The longest cache cookie value written; a larger answer is cached without its EIDs (see `cacheCookieValue`). */
export const ID5_MAX_COOKIE_VALUE = 3072;
/** The largest answer from ID5 that's read, in characters. */
const MAX_REPLY_LENGTH = 65_536;
const MAX_EIDS = 4;
const MAX_UIDS = 2;
/** Purposes 2 to 10: at least one needs consent or legitimate interest for ID5 (core segment), as in vendor mode. */
const USE_PURPOSES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10];

const SETTINGS = new Set(['partner', 'provider', 'endpoint', 'timeoutMs', 'domain', 'readCookie']);
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const PRINTABLE = /^[\x20-\x7E]+$/;
const SOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/;
const SIGNATURE = /^[\x21-\x7E]{1,1024}$/;
const UID = /^[\x21-\x7E]{1,512}$/;

/** The module's settings, parsed by `id5ModuleConfig`. */
export interface Id5Settings {
  /** The deployment's ID5 partner number. */
  readonly partner: number;
  /** Who runs the integration, declared to ID5 as `provider` (an upstream operator or hosting company). */
  readonly provider: string | undefined;
  /** The endpoint, with the partner number filled in. */
  readonly endpoint: string;
  /** The field the previous answer's `signature` goes back in: `s` for `/gs/v2`, `signature` for `/ga/v1`. */
  readonly signatureField: 's' | 'signature';
  readonly timeoutMs: number;
  /** The cache cookie's domain (`auto`, or a domain); `SID_COOKIE_DOMAIN` when undefined. */
  readonly domain: string | undefined;
  /** A first-party cookie holding an ID5 answer to use before asking ID5 (`id5id` by default), or undefined for none. */
  readonly readCookie: string | undefined;
  /** The cache cookie's name: `sid_id5_<partner>`. */
  readonly cookieName: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The module's settings (its `SID_MODULE_CONFIG` entry), checked. Throws a `TypeError` naming the setting on anything
 * invalid, an unknown setting included (a typo shouldn't send data somewhere unexpected), so the module reports `error`.
 */
export function id5ModuleConfig(config: Readonly<Record<string, unknown>>): Id5Settings {
  for (const key of Object.keys(config)) if (!SETTINGS.has(key)) throw new TypeError(`id5: unknown setting "${key}"`);
  const { partner, provider, endpoint, timeoutMs, domain, readCookie } = config;
  if (typeof partner !== 'number' || !Number.isInteger(partner) || partner < 1 || partner > 2_147_483_647) {
    throw new TypeError('id5: "partner" must be your ID5 partner number');
  }
  if (provider !== undefined && (typeof provider !== 'string' || provider.trim() === '' || provider.length > 100 || !PRINTABLE.test(provider))) {
    throw new TypeError('id5: "provider" must be 1 to 100 printable ASCII characters');
  }
  if (endpoint !== undefined && typeof endpoint !== 'string') throw new TypeError('id5: "endpoint" must be a URL');
  const url = endpointUrl((endpoint ?? ID5_DEFAULT_ENDPOINT).replaceAll('{partner}', String(partner)));
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5000)) {
    throw new TypeError('id5: "timeoutMs" must be a whole number of milliseconds from 10 to 5000');
  }
  if (domain !== undefined && domain !== 'auto' && (typeof domain !== 'string' || !DOMAIN.test(domain))) {
    throw new TypeError('id5: "domain" must be a domain like example.com, or auto');
  }
  if (readCookie !== undefined && (typeof readCookie !== 'string' || (readCookie !== '' && !COOKIE_NAME.test(readCookie)))) {
    throw new TypeError('id5: "readCookie" must be a cookie name, or "" for none');
  }
  return {
    partner,
    provider: provider?.trim(),
    endpoint: url.href,
    signatureField: url.pathname.startsWith('/ga/') ? 'signature' : 's',
    timeoutMs: timeoutMs ?? ID5_DEFAULT_TIMEOUT_MS,
    domain,
    readCookie: readCookie === undefined ? 'id5id' : readCookie === '' ? undefined : readCookie,
    cookieName: `sid_id5_${String(partner)}`
  };
}

/** An endpoint: `https`, on the default port, without credentials or a fragment, on one of `ID5_HOSTS`. */
function endpointUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('id5: "endpoint" must be a URL');
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '' || !ID5_HOSTS.includes(url.hostname)) {
    throw new TypeError(`id5: "endpoint" must be an https URL on ${ID5_HOSTS.join(' or ')}`);
  }
  return url;
}

/** What ID5 answered: EIDs (with the signature and how soon to refresh), or ID5's own opt-out. */
export type Id5Reply =
  | { readonly kind: 'id'; readonly eids: readonly Eid[]; readonly signature: string | undefined; readonly refreshSeconds: number }
  | { readonly kind: 'optout' };

/** One EID from ID5's `ids`, checked and copied; undefined when it isn't usable. */
function eidFrom(value: unknown): Eid | undefined {
  if (!isRecord(value) || typeof value['source'] !== 'string' || !SOURCE.test(value['source']) || !Array.isArray(value['uids'])) return undefined;
  const uids: Eid['uids'][number][] = [];
  for (const uid of value['uids'] as readonly unknown[]) {
    if (uids.length === MAX_UIDS) break;
    if (!isRecord(uid)) continue;
    const { id, atype, ext } = uid;
    if (typeof id !== 'string' || !UID.test(id) || id === '0') continue;
    if (atype !== undefined && (typeof atype !== 'number' || !Number.isInteger(atype) || atype < 1 || atype > 3)) continue;
    const extCopy = ext === undefined ? undefined : smallObject(ext);
    if (ext !== undefined && extCopy === undefined) continue;
    uids.push({ id, atype: atype ?? 1, ...(extCopy === undefined ? {} : { ext: extCopy }) });
  }
  return uids.length === 0 ? undefined : { source: value['source'].toLowerCase(), uids };
}

/** A copy of a plain JSON object of at most 512 characters, or undefined. */
function smallObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const text = JSON.stringify(value);
  if (text.length > 512) return undefined;
  const copy: unknown = JSON.parse(text);
  return isRecord(copy) ? copy : undefined;
}

/**
 * An answer from ID5 (the parsed JSON of a fetch reply, or of a cookie holding one), or undefined when it has nothing
 * usable. `universal_uid` `"0"` or `privacy.id5_consent: false` is ID5's opt-out. Complete EIDs come from `ids` (at
 * most four, two UIDs each); without them, the legacy `universal_uid` becomes an `id5-sync.com` EID with `atype` 1 and
 * `ext.linkType` when ID5 sends one, as Prebid.js's ID5 module does. `cache_control.max_age_sec` can shorten the
 * refresh, to no less than 15 minutes; it never lengthens it past 8 hours.
 */
export function parseId5Reply(value: unknown): Id5Reply | undefined {
  if (!isRecord(value)) return undefined;
  const universal = value['universal_uid'];
  const privacy = value['privacy'];
  if (universal === '0' || (isRecord(privacy) && privacy['id5_consent'] === false)) return { kind: 'optout' };
  const eids: Eid[] = [];
  const ids = value['ids'];
  if (isRecord(ids)) {
    for (const entry of Object.values(ids)) {
      if (eids.length === MAX_EIDS) break;
      const eid = isRecord(entry) ? eidFrom(entry['eid']) : undefined;
      if (eid !== undefined) eids.push(eid);
    }
  }
  if (eids.length === 0 && typeof universal === 'string' && UID.test(universal)) {
    const ext = value['ext'];
    const linkType = isRecord(ext) ? ext['linkType'] : undefined;
    const link = typeof linkType === 'number' && Number.isInteger(linkType) && linkType >= 0 && linkType < 100 ? { ext: { linkType } } : {};
    eids.push({ source: ID5_EID_SOURCE, uids: [{ id: universal, atype: 1, ...link }] });
  }
  if (eids.length === 0) return undefined;
  const signature = typeof value['signature'] === 'string' && SIGNATURE.test(value['signature']) ? value['signature'] : undefined;
  const cache = value['cache_control'];
  const maxAge = isRecord(cache) ? cache['max_age_sec'] : undefined;
  const refreshSeconds = typeof maxAge === 'number' && Number.isFinite(maxAge)
    ? Math.min(ID5_REFRESH_SECONDS, Math.max(ID5_MIN_REFRESH_SECONDS, Math.floor(maxAge)))
    : ID5_REFRESH_SECONDS;
  return { kind: 'id', eids, signature, refreshSeconds };
}

/**
 * A first-party cookie holding an ID5 answer (the `id5id` cookie Prebid.js's ID5 module wrote with cookie storage: the
 * fetch reply as JSON, maybe percent-encoded, maybe with each partner's reply under `pbjs`), or a bare `0` (ID5's
 * opt-out). Undefined when it has nothing usable for this partner.
 */
export function existingId5Reply(value: string, partner: number): Id5Reply | undefined {
  let text = value.trim();
  if (text === '0') return { kind: 'optout' };
  if (text.startsWith('%7B') || text.startsWith('%7b')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  if (!text.startsWith('{') || text.length > MAX_REPLY_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pbjs = isRecord(parsed) ? parsed['pbjs'] : undefined;
  return parseId5Reply(isRecord(pbjs) ? pbjs[String(partner)] : parsed);
}

/** What the cache cookie holds. Times are Unix seconds. */
export interface Id5Cache {
  /** When ID5 last gave an ID (or opted out), or, before any answer, when the module first asked. */
  readonly t: number;
  /** When to ask ID5 again. */
  readonly r: number;
  readonly e?: readonly Eid[];
  /** ID5's `signature`, sent back on the next request. */
  readonly s?: string;
  /** `1`: ID5 answered with its opt-out; no ID is kept. */
  readonly o?: 1;
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) return undefined;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** The cache cookie's value: base64url of the cache's JSON. */
export function cacheCookieValue(cache: Id5Cache): string {
  return toBase64Url(JSON.stringify(cache));
}

/**
 * The cache in a cookie, checked like an answer from ID5 (the browser can change it), or undefined when it isn't valid,
 * is from the future, or is more than 30 days old.
 */
export function readCache(value: string, now: number): Id5Cache | undefined {
  const text = fromBase64Url(value);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { t, r, e, s, o } = parsed;
  if (typeof t !== 'number' || typeof r !== 'number' || !Number.isInteger(t) || !Number.isInteger(r) || t > now + 60 || now - t >= ID5_MAX_AGE_SECONDS) return undefined;
  if (o === 1) return { t, r, o: 1 };
  if (s !== undefined && (typeof s !== 'string' || !SIGNATURE.test(s))) return undefined;
  const eids = Array.isArray(e) ? (e as readonly unknown[]).slice(0, MAX_EIDS).map(eidFrom).filter(eid => eid !== undefined) : [];
  return { t, r, ...(eids.length === 0 ? {} : { e: eids }), ...(s === undefined ? {} : { s }) };
}

/**
 * Why the module mustn't ask ID5 or keep an ID5 ID for this request, or undefined if it may. Where GDPR applies, core
 * has already checked ID5's TCF vendor consent and Purpose 1 (the module's `gvlid` and `purposes`). Here: the SharedID's
 * storage decision (opt-out, GPC, COPPA, a consent provider's denial, the TC string); a `us_privacy` opt-out of sale;
 * a US opt-out in the GPP string (the `gpp` module's rules, whether or not that module is in `SID_MODULES`); and, for any
 * TC string wherever the visitor is, ID5's vendor consent, consent for Purpose 1 and consent or legitimate interest for at
 * least one of Purposes 2 to 10 (the core segment, as in vendor mode).
 */
export function id5Denial(context: Pick<ModuleContext, 'storage' | 'consent'>): string | undefined {
  const { storage, consent } = context;
  if (!storage.allowed) return storage.reason;
  if (consent.usPrivacy?.charAt(2).toUpperCase() === 'Y') return 'us-privacy';
  const gpp = gppSignal(consent.gppString, consent.gppSid);
  if (gpp?.consent === 'denied') return `gpp: ${gpp.reason}`;
  const { tcf } = consent;
  if (tcf === undefined) return undefined;
  if (!tcf.vendorConsent(ID5_GVLID)) return `tcf: no consent for vendor ${String(ID5_GVLID)}`;
  if (!tcf.purposeConsents.has(1)) return 'tcf: no vendor consent for purpose 1';
  if (!USE_PURPOSES.some(p => tcf.purposeConsents.has(p) || tcf.purposeLegitimateInterests.has(p))) {
    return 'tcf: no vendor consent or legitimate interest for any of purposes 2-10';
  }
  return undefined;
}

/** Whether an address is routable on the public internet: never a private, loopback, link-local, shared, reserved or documentation one. */
export function isRoutableIp(ip: ParsedIp): boolean {
  if (ip.version === 4) {
    const [a = 0, b = 0, c = 0] = ip.octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  const [h0 = 0, h1 = 0] = ip.hextets;
  // Global unicast (2000::/3) only, without the documentation ranges, IETF protocol assignments (Teredo among them) and 6to4.
  if ((h0 & 0xe000) !== 0x2000) return false;
  if (h0 === 0x2001 && (h1 === 0x0db8 || h1 < 0x0200)) return false;
  if (h0 === 0x2002) return false;
  return !(h0 === 0x3fff && h1 < 0x1000);
}

/**
 * The client address to send to ID5: `{ ip }` for a routable IPv4 address, `{ ipv6 }` for a routable IPv6 one; undefined
 * when there's none, it isn't routable, or consent doesn't allow a full IP address (`preciseLocationDenial`). Without
 * one the module doesn't ask ID5 at all: ID5 would otherwise see the worker's address.
 */
export function clientAddress(platform: Pick<PlatformInfo, 'clientIp'>, consent: ConsentContext): { readonly ip: string } | { readonly ipv6: string } | undefined {
  if (platform.clientIp === undefined || preciseLocationDenial(consent) !== undefined) return undefined;
  const ip = parseIp(platform.clientIp);
  if (ip === undefined || !isRoutableIp(ip)) return undefined;
  return ip.version === 4 ? { ip: formatIpv4(ip.octets) } : { ipv6: formatIpv6(ip.hextets) };
}

/** What goes into a request to ID5 besides the settings. */
export interface Id5RequestInput {
  readonly address: { readonly ip: string } | { readonly ipv6: string };
  readonly ua: string;
  /** The site's host name, sent as `domain`. */
  readonly domain: string;
  readonly consent: ConsentContext;
  /** The SharedID, sent as `puid`, ID5's partner user ID. */
  readonly sharedId: string | undefined;
  /** The previous answer's `signature`. */
  readonly signature: string | undefined;
  readonly now: Date;
}

/**
 * The JSON body of the request to ID5: `partner`, `origin` and `v`, `ts`, the consent strings (`gdpr`, `gdpr_consent`,
 * `us_privacy`, `gpp_string`, `gpp_sid` comma-joined), `provider`, `domain`, `ua`, the client address as `ip` or `ipv6`,
 * `puid` (the SharedID) and the previous `signature` (as `s`, or `signature` for `/ga/v1`).
 */
export function id5RequestBody(settings: Id5Settings, input: Id5RequestInput): Record<string, unknown> {
  const { consent } = input;
  return {
    partner: settings.partner,
    origin: ID5_ORIGIN,
    v: ID5_VERSION,
    ts: input.now.toISOString(),
    gdpr: consent.gdprApplies === true ? 1 : 0,
    ...(consent.tcString === undefined ? {} : { gdpr_consent: consent.tcString }),
    ...(consent.usPrivacy === undefined ? {} : { us_privacy: consent.usPrivacy }),
    ...(consent.gppString === undefined ? {} : { gpp_string: consent.gppString }),
    ...(consent.gppSid === undefined || consent.gppSid.length === 0 ? {} : { gpp_sid: consent.gppSid.join(',') }),
    ...(settings.provider === undefined ? {} : { provider: settings.provider }),
    domain: input.domain,
    ua: input.ua,
    ...input.address,
    ...(input.sharedId === undefined ? {} : { puid: input.sharedId }),
    ...(input.signature === undefined ? {} : { [settings.signatureField]: input.signature })
  };
}

function cacheCookie(settings: Id5Settings, value: string, maxAgeSeconds: number): ModuleCookie {
  return {
    name: settings.cookieName,
    value,
    maxAgeSeconds,
    httpOnly: true,
    ...(settings.domain === undefined ? {} : { domain: settings.domain === 'auto' ? 'auto' : `.${settings.domain}` })
  };
}

/** The cookie that stores `cache`, for the rest of its 30 days. Too large with its EIDs, it keeps only the signature. */
function storeCache(settings: Id5Settings, cache: Id5Cache, now: number): ModuleCookie {
  let value = cacheCookieValue(cache);
  if (value.length > ID5_MAX_COOKIE_VALUE) {
    // Without the EIDs, the next request asks again (r = now), sending the signature back.
    value = cacheCookieValue({ t: cache.t, r: now, ...(cache.s === undefined ? {} : { s: cache.s }) });
  }
  return cacheCookie(settings, value, Math.max(1, cache.t + ID5_MAX_AGE_SECONDS - now));
}

const eidsOf = (cache: Id5Cache | undefined): ModuleResult | undefined => (cache?.e === undefined ? undefined : { eids: cache.e });

async function run(context: ModuleContext): Promise<ModuleResult | undefined> {
  const settings = id5ModuleConfig(context.config);
  const { cookies, consent } = context;
  const raw = cookies.get(settings.cookieName);
  const remove: ModuleResult | undefined = raw === undefined ? undefined : { cookies: [cacheCookie(settings, '', 0)] };
  // Opt-out, GPC, COPPA, denied consent, a US opt-out: no request to ID5, no ID, and the cache is deleted.
  if (id5Denial(context) !== undefined) return remove;

  // An ID5 answer the browser already has in a first-party cookie is used as it is.
  const existing = settings.readCookie === undefined ? undefined : cookies.get(settings.readCookie);
  const fromCookie = existing === undefined ? undefined : existingId5Reply(existing, settings.partner);
  if (fromCookie?.kind === 'optout') return remove;
  if (fromCookie !== undefined) return { eids: fromCookie.eids };

  const now = Math.floor(Date.now() / 1000);
  const cache = raw === undefined ? undefined : readCache(raw, now);
  if (cache?.o === 1 && now < cache.r) return undefined;
  if (cache !== undefined && now < cache.r) return eidsOf(cache);
  // Due a refresh: until it succeeds, the cached EIDs (under 30 days old) are still returned.
  const fallback = cache?.o === 1 ? undefined : cache;
  const { fetch } = context;
  const address = clientAddress(context.platform, consent);
  const ua = context.request.headers.get('User-Agent')?.trim() ?? '';
  if (fetch === undefined || address === undefined || ua === '' || ua.length > 1024 || !PRINTABLE.test(ua)) return eidsOf(fallback);

  const body = id5RequestBody(settings, {
    address,
    ua,
    domain: context.url.hostname,
    consent,
    sharedId: context.sharedId,
    signature: fallback?.s,
    now: new Date(now * 1000)
  });
  let reply: Id5Reply | undefined;
  try {
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify(body)),
      timeoutMs: settings.timeoutMs
    });
    const text = response.ok ? await response.text() : '';
    reply = text === '' || text.length > MAX_REPLY_LENGTH ? undefined : parseId5Reply(JSON.parse(text));
  } catch {
    // Timed out, or the network failed: answer from the cache and ask again on the next request. Nothing is reported.
    return eidsOf(fallback);
  }
  if (reply === undefined) {
    // ID5 answered with an error, or without anything usable: ask again in an hour, keeping what's cached.
    const retry: Id5Cache = { ...(fallback ?? { t: now }), r: now + ID5_RETRY_SECONDS };
    return { ...eidsOf(fallback), cookies: [storeCache(settings, retry, now)] };
  }
  if (reply.kind === 'optout') {
    // ID5's own opt-out: no ID is kept, and ID5 isn't asked again until the next refresh.
    return { cookies: [storeCache(settings, { t: now, r: now + ID5_REFRESH_SECONDS, o: 1 }, now)] };
  }
  const fresh: Id5Cache = { t: now, r: now + reply.refreshSeconds, e: reply.eids, ...(reply.signature === undefined ? {} : { s: reply.signature }) };
  return { eids: reply.eids, cookies: [storeCache(settings, fresh, now)] };
}

/**
 * The `id5` module: the ID5 ID, fetched from ID5 server-to-server. Off until listed in `SID_MODULES`, and needs the
 * deployment's ID5 partner number (`partner`). It acts for ID5 (`gvlid` 131, Purpose 1), sends requests only to
 * `ID5_HOSTS` through core, and caches the answer in the `HttpOnly` `sid_id5_<partner>` cookie.
 */
export const id5Module: EdgeModule = defineModule({
  name: 'id5',
  gvlid: ID5_GVLID,
  purposes: [1],
  // Also on /sync, so the cache is refreshed on page views (only its cookie is used there).
  routes: ['v1', 'sync'],
  fetching: { hosts: ID5_HOSTS },
  run,
  // An opt-out at /optout deletes the cache straight away; so does core when consent skips the module.
  optOutCookies: config => [cacheCookie(id5ModuleConfig(config), '', 0)]
});
