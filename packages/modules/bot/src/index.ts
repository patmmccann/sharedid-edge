import { defineModule, type EdgeModule, type ModuleContext, type ModuleResult, type TrafficReport } from '@sharedid-edge/core';

/** The module's settings, from `SID_MODULE_CONFIG.bot`. */
export interface BotSettings {
  /**
   * Flag a request whose user agent claims to be a browser but which lacks headers that browser always sends
   * (`Accept-Language`, and the `Sec-Fetch-*` headers for browsers that send them) as `botKind: 'likely'`. A
   * heuristic, so off by default.
   */
  readonly missingHeaders: boolean;
  /** The name of the cookie that marks the site's own staff (`internal: true`); undefined for none. */
  readonly internalCookie: string | undefined;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const SETTINGS = ['missingHeaders', 'internalCookie'];
const SECRETS = ['internalToken'];

/**
 * Reads the module's `SID_MODULE_CONFIG` entry. Throws on an unknown key or a wrong type, so a typo can't silently turn
 * a signal off; the worker then reports the module as an `error`.
 */
export function botSettings(config: Readonly<Record<string, unknown>>): BotSettings {
  for (const key of Object.keys(config)) {
    if (!SETTINGS.includes(key)) throw new TypeError(`bot: unknown setting "${key}"`);
  }
  const { missingHeaders, internalCookie } = config;
  if (missingHeaders !== undefined && typeof missingHeaders !== 'boolean') throw new TypeError('bot: "missingHeaders" must be true or false');
  if (internalCookie !== undefined && (typeof internalCookie !== 'string' || !COOKIE_NAME.test(internalCookie))) {
    throw new TypeError('bot: "internalCookie" must be a cookie name');
  }
  return { missingHeaders: missingHeaders ?? false, internalCookie };
}

/** Reads the module's `SID_MODULE_SECRETS` entry: an optional `internalToken`. Never echoes a value. */
function internalToken(secrets: Readonly<Record<string, string>>): string | undefined {
  for (const key of Object.keys(secrets)) {
    if (!SECRETS.includes(key)) throw new TypeError('bot: unknown secret');
  }
  const token = secrets['internalToken'];
  if (token !== undefined && token.length < 16) throw new TypeError('bot: "internalToken" must be at least 16 characters');
  return token;
}

/**
 * Whether the user agent is a browser version that sends the `Sec-Fetch-*` fetch metadata headers on every request to
 * a secure origin: Chromium 80 and later (Chrome, Edge, Opera, Samsung Internet), Firefox 90 and later, and Safari 17
 * and later. Anything else, including iOS browsers other than Safari, isn't expected to send them.
 */
export function sendsFetchMetadata(userAgent: string): boolean {
  const chromium = /\bChrome\/(\d+)\./.exec(userAgent);
  if (chromium?.[1] !== undefined) return Number(chromium[1]) >= 80;
  const firefox = /\bFirefox\/(\d+)\./.exec(userAgent);
  if (firefox?.[1] !== undefined) return !/\bFxiOS\//.test(userAgent) && Number(firefox[1]) >= 90;
  const safari = /\bVersion\/(\d+)(?:\.\d+)*(?: Mobile\/\w+)? Safari\//.exec(userAgent);
  if (safari?.[1] !== undefined) return !/\b(?:CriOS|FxiOS|EdgiOS|Android)\b/.test(userAgent) && Number(safari[1]) >= 17;
  return false;
}

/** Browsers send fetch metadata only to secure origins: https, or the loopback host. */
function secureOrigin(url: URL): boolean {
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Whether a request from a "browser" (a user agent starting `Mozilla/5.0 (`) lacks headers that browser sends: an
 * empty or missing `Accept-Language`, which every browser sends, or, from a browser version that sends them
 * ({@link sendsFetchMetadata}) to a secure origin, none of `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`.
 * Clients that don't claim to be a browser aren't judged here.
 */
export function missingBrowserHeaders(headers: Headers, url: URL): boolean {
  const userAgent = headers.get('User-Agent') ?? '';
  if (!userAgent.startsWith('Mozilla/5.0 (')) return false;
  if ((headers.get('Accept-Language') ?? '').trim() === '') return true;
  const fetchMetadata = ['Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest'].some(name => headers.has(name));
  return !fetchMetadata && secureOrigin(url) && sendsFetchMetadata(userAgent);
}

/** Compares without stopping at the first difference, so timing doesn't reveal how much of the token matched. */
function sameToken(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  // Past the end, charCodeAt gives NaN, which bitwise operators read as 0.
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function run({ request, url, cookies, config, secrets }: ModuleContext): ModuleResult | undefined {
  const settings = botSettings(config);
  const token = internalToken(secrets);
  const marker = settings.internalCookie === undefined ? undefined : cookies.get(settings.internalCookie);
  const internal = marker !== undefined && marker !== '' && (token === undefined || sameToken(marker, token));
  const likely = settings.missingHeaders && missingBrowserHeaders(request.headers, url);
  const traffic: TrafficReport = {
    ...(likely ? { bot: true, botKind: 'likely' } : {}),
    ...(internal ? { internal: true } : {})
  };
  return Object.keys(traffic).length === 0 ? undefined : { traffic };
}

/**
 * The `bot` module: reports to the shared traffic signal (`ortb2.device.ext.traffic`), which core merges with other
 * modules' reports and the platform's own verdict (Cloudflare Bot Management). It adds:
 *
 * - with `"missingHeaders": true`, `bot: true, botKind: 'likely'` for a "browser" missing headers browsers send;
 * - with `"internalCookie": "<name>"`, `internal: true` when the request carries that cookie (with
 *   `SID_MODULE_SECRETS.bot.internalToken`, only when its value is the token).
 *
 * The signal describes the traffic, not the person, so it's sent whatever the consent signals say. Nothing is stored
 * or logged. Declared crawlers (user agent lists) are the `ua` module's job; the platform's verdict is merged by core,
 * not here. It runs only when listed in `SID_MODULES`, on `/v1` and `/sync`.
 */
export const botModule: EdgeModule = defineModule({
  name: 'bot',
  // Also on /sync: its report is a traffic verdict, not payload, so there it counts towards SID_SKIP_BOTS, and a
  // likely bot doesn't get an ID from Prebid.js's pixelUrl call that it wouldn't get from /v1.
  routes: ['v1', 'sync'],
  run
});
