import { MAX_UA_LENGTH } from './parse.js';

/**
 * A crawler User-Agent pattern list from a scheduled snapshot: regular expression sources, matched case-insensitively
 * against the User-Agent, as [isbot](https://github.com/omrilotan/isbot) publishes them in `src/patterns.json`.
 */
export interface CrawlerList {
  readonly patterns: readonly string[];
}

/** Fewer patterns than this isn't a crawler list (isbot's had 206 when this was written): a bad download. */
export const MIN_CRAWLER_PATTERNS = 50;
/** More than this isn't one either, and would make every request's match slower. */
export const MAX_CRAWLER_PATTERNS = 10_000;
/** The longest pattern accepted (isbot's longest was 68 characters). */
export const MAX_CRAWLER_PATTERN_LENGTH = 1024;

/**
 * Crawlers any usable list recognizes. A list that misses one would turn declared-bot detection off for it, so it's
 * refused. Kept to long-lived, self-identifying crawlers.
 */
const KNOWN_CRAWLERS: readonly string[] = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'
];

/**
 * Browsers no usable list may match. A list that matches one would mark real visitors as bots (and, with
 * `SID_SKIP_BOTS`, deny them a SharedID), so it's refused.
 */
const BROWSERS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0'
];

/** Compiled lists, by the validated list object: shared reference data only, never visitor data. */
const compiled = new WeakMap<CrawlerList, RegExp>();

/** One case-insensitive expression for the whole list, as isbot builds its own; throws when a pattern doesn't compile. */
function compile(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join('|'), 'i');
}

/**
 * Checks a crawler list and returns it, throwing a `TypeError` on anything unusable, so a bad download never replaces
 * a good list: not `{ patterns: [...] }` with only strings; fewer than {@link MIN_CRAWLER_PATTERNS} or more than
 * {@link MAX_CRAWLER_PATTERNS} patterns; an empty, overlong or duplicate pattern; a pattern that doesn't compile as a
 * regular expression, or matches the empty string (it would match every User-Agent); a list that matches a current
 * browser, or misses a well-known crawler. It also compiles the list, kept for {@link crawlerMatcher}, so a background
 * reload, not a request, pays for it.
 */
export function parseCrawlerList(value: unknown): CrawlerList {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Not a crawler list');
  // Checked to be a non-array object just above.
  const { patterns, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new TypeError('Unknown crawler list field');
  if (!Array.isArray(patterns)) throw new TypeError('Not a crawler list');
  const list: readonly unknown[] = patterns;
  if (list.length < MIN_CRAWLER_PATTERNS) throw new TypeError('Too few crawler patterns');
  if (list.length > MAX_CRAWLER_PATTERNS) throw new TypeError('Too many crawler patterns');
  const seen = new Set<string>();
  for (const pattern of list) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_CRAWLER_PATTERN_LENGTH) throw new TypeError('Invalid crawler pattern');
    if (seen.has(pattern)) throw new TypeError('Duplicate crawler pattern');
    seen.add(pattern);
    let expression: RegExp;
    try { expression = new RegExp(pattern, 'i'); } catch { throw new TypeError('Crawler pattern does not compile'); }
    if (expression.test('')) throw new TypeError('Crawler pattern matches every User-Agent');
  }
  const result: CrawlerList = { patterns: [...seen] };
  const expression = compile(result.patterns);
  if (BROWSERS.some(browser => expression.test(browser))) throw new TypeError('Crawler list matches a browser');
  if (!KNOWN_CRAWLERS.every(crawler => expression.test(crawler))) throw new TypeError('Crawler list misses a known crawler');
  compiled.set(result, expression);
  return result;
}

/**
 * The bot test for a crawler list: whether the first {@link MAX_UA_LENGTH} characters of a User-Agent match it. Uses
 * the expression {@link parseCrawlerList} compiled for a validated list; compiles any other list once (throwing when
 * it doesn't compile).
 */
export function crawlerMatcher(list: CrawlerList): (userAgent: string) => boolean {
  let expression = compiled.get(list);
  if (expression === undefined) {
    expression = compile(list.patterns);
    compiled.set(list, expression);
  }
  const pattern = expression;
  return userAgent => userAgent !== '' && pattern.test(userAgent.slice(0, MAX_UA_LENGTH));
}
