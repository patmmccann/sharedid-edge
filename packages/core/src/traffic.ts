/**
 * How sure a bot verdict is, strongest first: `verified` (a known good bot the platform has verified, such as a
 * search crawler), `declared` (a crawler that says what it is in its user agent), `likely` (a heuristic or a score).
 */
export type BotKind = 'verified' | 'declared' | 'likely';

/**
 * The kind of proxy or network the request comes through: a data centre or hosting address, a VPN, a residential
 * proxy, a Tor exit, or a relay that carries people's traffic (iCloud Private Relay and similar privacy relays, or a
 * verified corporate proxy). A relay never implies a bot.
 */
export type ProxyKind = 'datacenter' | 'vpn' | 'residential' | 'tor' | 'relay';

/**
 * What one source (a module, or the platform) reports about the traffic. Every field is optional; a source reports
 * only what it knows. A `botKind` implies `bot: true`.
 */
export interface TrafficReport {
  /** Whether the request comes from a bot. */
  readonly bot?: boolean;
  /** How sure the bot verdict is. */
  readonly botKind?: BotKind;
  /** The kind of proxy or network the request comes through. */
  readonly proxy?: ProxyKind;
  /** Human-likelihood, 1 (almost certainly a bot) to 99 (almost certainly human): Cloudflare's scale. */
  readonly score?: number;
  /** The visitor marked themselves as the site's own staff (an internal-traffic cookie). */
  readonly internal?: boolean;
}

/** The merged traffic signal the worker returns as `ortb2.device.ext.traffic`. */
export interface TrafficSignal extends TrafficReport {
  /** The sources that contributed, in order: `platform` first, then module names in `SID_MODULES` order. */
  readonly sources: readonly string[];
}

/** One source's report, before merging. */
export interface TrafficEntry {
  readonly source: string;
  readonly report: TrafficReport;
}

/** Bot kinds, strongest claim first. */
export const BOT_KINDS: readonly BotKind[] = Object.freeze(['verified', 'declared', 'likely']);

/**
 * Proxy kinds, most specific first. `tor` and `residential` name the exit itself; `relay` is a named service
 * carrying people's traffic; `vpn` a VPN service; `datacenter` only says the address is a hosting address, which
 * VPNs and relays also use. When sources disagree, the most specific wins: an IP database that sees iCloud Private
 * Relay as a data centre doesn't override a source that knows it's a relay.
 */
export const PROXY_KINDS: readonly ProxyKind[] = Object.freeze(['tor', 'residential', 'relay', 'vpn', 'datacenter']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBotKind(value: unknown): value is BotKind {
  return BOT_KINDS.some(kind => kind === value);
}

function isProxyKind(value: unknown): value is ProxyKind {
  return PROXY_KINDS.some(kind => kind === value);
}

/**
 * Checks a traffic report from a module or a platform and returns its known fields. Other keys (such as `sources`,
 * which core sets itself) are ignored. A `botKind` without `bot` gives `bot: true`.
 *
 * @throws TypeError on a field with the wrong type or value, or `bot: false` with a `botKind`.
 */
export function trafficReport(value: unknown): TrafficReport {
  if (!isRecord(value)) throw new TypeError('traffic: must be an object');
  const { bot, botKind, proxy, score, internal } = value;
  if (bot !== undefined && typeof bot !== 'boolean') throw new TypeError('traffic: "bot" must be a boolean');
  if (botKind !== undefined && !isBotKind(botKind)) throw new TypeError('traffic: "botKind" must be verified, declared or likely');
  if (botKind !== undefined && bot === false) throw new TypeError('traffic: "botKind" needs "bot" to be true');
  if (proxy !== undefined && !isProxyKind(proxy)) throw new TypeError('traffic: "proxy" must be datacenter, vpn, residential, tor or relay');
  if (score !== undefined && (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 99)) {
    throw new TypeError('traffic: "score" must be a whole number from 1 to 99');
  }
  if (internal !== undefined && typeof internal !== 'boolean') throw new TypeError('traffic: "internal" must be a boolean');
  return {
    ...(botKind !== undefined ? { bot: true } : bot === undefined ? {} : { bot }),
    ...(botKind === undefined ? {} : { botKind }),
    ...(proxy === undefined ? {} : { proxy }),
    ...(score === undefined ? {} : { score }),
    ...(internal === undefined ? {} : { internal })
  };
}

function isEmpty(report: TrafficReport): boolean {
  return report.bot === undefined && report.botKind === undefined && report.proxy === undefined && report.score === undefined && report.internal === undefined;
}

/** `true` if any says so, else `false` if any says so, else undefined. */
function anyTrue(values: readonly (boolean | undefined)[]): boolean | undefined {
  if (values.includes(true)) return true;
  return values.includes(false) ? false : undefined;
}

/** The value earliest in `order` among `values`, or undefined. */
function first<T>(order: readonly T[], values: readonly (T | undefined)[]): T | undefined {
  return order.find(item => values.includes(item));
}

/**
 * Merges traffic reports, most cautious first:
 *
 * - `bot` is true if any report says so (`false` only if some report says `false` and none says `true`);
 * - `botKind` keeps the strongest claim: `verified`, then `declared`, then `likely`;
 * - `proxy` keeps the most specific value, in {@link PROXY_KINDS} order: `tor`, `residential`, `relay`, `vpn`,
 *   `datacenter`. A proxy never sets `bot`;
 * - `score` keeps the minimum (the most bot-like);
 * - `internal` is true if any report says so;
 * - `sources` lists the sources that reported anything, in order, once each.
 *
 * Merging is idempotent and order only affects `sources`, so the same report counted twice changes nothing.
 * Undefined when no source reported anything.
 */
export function mergeTraffic(entries: readonly TrafficEntry[]): TrafficSignal | undefined {
  const reports = entries.filter(entry => !isEmpty(entry.report));
  if (reports.length === 0) return undefined;
  const all = reports.map(entry => entry.report);
  const bot = anyTrue(all.map(r => r.bot));
  const botKind = first(BOT_KINDS, all.map(r => r.botKind));
  const proxy = first(PROXY_KINDS, all.map(r => r.proxy));
  const scores = all.flatMap(r => (r.score === undefined ? [] : [r.score]));
  const internal = anyTrue(all.map(r => r.internal));
  const sources: string[] = [];
  for (const { source } of reports) if (!sources.includes(source)) sources.push(source);
  return {
    ...(bot === undefined ? {} : { bot }),
    ...(botKind === undefined ? {} : { botKind }),
    ...(proxy === undefined ? {} : { proxy }),
    ...(scores.length === 0 ? {} : { score: Math.min(...scores) }),
    ...(internal === undefined ? {} : { internal }),
    sources
  };
}

/** The `SID_SKIP_BOTS` and `SID_SKIP_BOTS_SCORE` settings. */
export interface SkipBotsSettings {
  readonly skipBots: BotKind | undefined;
  readonly skipBotsScore: number | undefined;
}

/**
 * Whether `SID_SKIP_BOTS` rules out the SharedID for this traffic:
 *
 * - with `skipBots`, when the signal says `bot` and its `botKind` is that kind or a stronger one (`verified` skips
 *   verified bots only; `declared` verified and declared ones; `likely` every bot). A bot without a `botKind` counts
 *   as `likely`;
 * - with `skipBotsScore`, when the signal's `score` is at or below it.
 *
 * `internal` and `proxy` never skip.
 */
export function skipsBot(settings: SkipBotsSettings, signal: TrafficSignal | undefined): boolean {
  if (signal === undefined) return false;
  const { skipBots, skipBotsScore } = settings;
  if (skipBots !== undefined && signal.bot === true && BOT_KINDS.indexOf(signal.botKind ?? 'likely') <= BOT_KINDS.indexOf(skipBots)) return true;
  return skipBotsScore !== undefined && signal.score !== undefined && signal.score <= skipBotsScore;
}
