import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { list as isbotList } from 'isbot';
import { describe, expect, it } from 'vitest';
import { bowserParser } from '../src/bowser.js';
import { botParser, crawlerMatcher, createUaModule, MIN_CRAWLER_PATTERNS, parseCrawlerList, type CrawlerList, type CrawlerSnapshot, type UaCrawlerOptions } from '../src/index.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 86_400_000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
/** Recognized only by the test list below, not by isbot. */
const EXAMPLE_CRAWLER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Zqxwidget/2.0';
/** Recognized by isbot, not by the test list below. */
const CURL = 'curl/8.4.0';

/** A list that recognizes the well-known crawlers, `Zqxwidget`, and nothing isbot alone would. */
function testPatterns(): string[] {
  const filler = Array.from({ length: MIN_CRAWLER_PATTERNS }, (_value, index) => `^filler-agent-${String(index)}/`);
  return ['googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'baiduspider', 'facebookexternalhit', 'ahrefsbot', 'zqxwidget/', ...filler];
}

describe('crawler lists', () => {
  it('accepts isbot\'s own compiled-in list', () => {
    expect(parseCrawlerList({ patterns: isbotList }).patterns).toEqual(isbotList);
  });

  it('accepts a list that recognizes the well-known crawlers and no browser, and compiles it', () => {
    const list = parseCrawlerList({ patterns: testPatterns() });
    const isBot = crawlerMatcher(list);
    expect([GOOGLEBOT, EXAMPLE_CRAWLER].map(isBot)).toEqual([true, true]);
    expect([CHROME, CURL, ''].map(isBot)).toEqual([false, false, false]);
  });

  it.each([
    ['not an object', ['googlebot']],
    ['no patterns', {}],
    ['another field', { patterns: testPatterns(), extra: 1 }],
    ['an empty list', { patterns: [] }],
    ['too few patterns', { patterns: testPatterns().slice(0, 10) }],
    ['too many patterns', { patterns: Array.from({ length: 10_001 }, (_value, index) => `x${String(index)}`) }],
    ['a pattern that is not a string', { patterns: [...testPatterns(), 1] }],
    ['an empty pattern', { patterns: [...testPatterns(), ''] }],
    ['an overlong pattern', { patterns: [...testPatterns(), 'x'.repeat(1025)] }],
    ['a duplicate pattern', { patterns: [...testPatterns(), 'googlebot'] }],
    ['a pattern that does not compile', { patterns: [...testPatterns(), 'bot('] }],
    ['a pattern that matches everything', { patterns: [...testPatterns(), '.*'] }],
    ['a pattern that matches a browser', { patterns: [...testPatterns(), 'chrome/'] }],
    ['a pattern that matches Safari', { patterns: [...testPatterns(), 'safari'] }],
    ['no pattern for Googlebot', { patterns: testPatterns().filter(pattern => pattern !== 'googlebot') }]
  ])('refuses %s', (_name, value) => {
    expect(() => parseCrawlerList(value)).toThrow(TypeError);
  });

  it('compiles an unvalidated list once, and throws for one that does not compile', () => {
    const isBot = crawlerMatcher({ patterns: ['zqxwidget/'] });
    expect(isBot(EXAMPLE_CRAWLER)).toBe(true);
    expect(() => crawlerMatcher({ patterns: ['bot('] })).toThrow();
  });

  it('lets the parsers use a given bot test in place of isbot', () => {
    const isBot = crawlerMatcher(parseCrawlerList({ patterns: testPatterns() }));
    expect(botParser(EXAMPLE_CRAWLER).bot).toBe(false);
    expect(botParser(EXAMPLE_CRAWLER, isBot).bot).toBe(true);
    expect(botParser(CURL, isBot).bot).toBe(false);
    expect(bowserParser(EXAMPLE_CRAWLER, isBot).bot).toBe(true);
    expect(bowserParser(CHROME, isBot).bot).toBe(false);
  });
});

describe('the ua module with scheduled crawler lists', () => {
  const data: CrawlerList = parseCrawlerList({ patterns: testPatterns() });
  const fresh: CrawlerSnapshot = () => ({ data, checkedAt: NOW - 1000 });
  const crawlers = (snapshot: CrawlerSnapshot, rest: Partial<UaCrawlerOptions> = {}): UaCrawlerOptions => ({ snapshot, maxAgeMs: 2 * DAY, now: () => NOW, ...rest });
  async function payload(options: UaCrawlerOptions | undefined, userAgent: string, parser?: 'bowser'): Promise<PayloadV1> {
    const module = createUaModule({ bowser: bowserParser, ...(options === undefined ? {} : { crawlers: options }) });
    const env = { SID_MODULES: 'ua', ...(parser === undefined ? {} : { SID_MODULE_CONFIG: JSON.stringify({ ua: { parser } }) }) };
    const response = await createHandler({ config: resolveConfig(env), modules: [module] })(new Request('https://www.example.com/_sid/v1', { headers: { 'User-Agent': userAgent } }), {});
    return await response.json() as PayloadV1;
  }
  const bot = (body: PayloadV1): boolean => JSON.stringify(body.ortb2 ?? {}).includes('"botKind":"declared"');

  it('uses a fresh snapshot instead of the compiled-in list, without stale', async () => {
    const found = await payload(crawlers(fresh), EXAMPLE_CRAWLER);
    expect(bot(found)).toBe(true);
    expect(found.ext.modules['ua']).toEqual({ ms: expect.any(Number) as number, status: 'ok' });
    // isbot recognizes curl; this list doesn't.
    expect(bot(await payload(crawlers(fresh), CURL))).toBe(false);
    expect(bot(await payload(crawlers(fresh), GOOGLEBOT))).toBe(true);
  });

  it('uses the snapshot with the Bowser parser too', async () => {
    expect(bot(await payload(crawlers(fresh), EXAMPLE_CRAWLER, 'bowser'))).toBe(true);
    expect(bot(await payload(crawlers(fresh), CHROME, 'bowser'))).toBe(false);
  });

  it('falls back to the compiled-in list, reported stale, without a snapshot', async () => {
    const body = await payload(crawlers(() => undefined), CURL);
    expect(bot(body)).toBe(true);
    expect(body.ext.modules['ua']).toEqual({ ms: expect.any(Number) as number, status: 'ok', stale: true });
    expect(bot(await payload(crawlers(() => undefined), EXAMPLE_CRAWLER))).toBe(false);
  });

  it('reports stale with no output when there is nothing else to return', async () => {
    const response = await createHandler({ config: resolveConfig({ SID_MODULES: 'ua' }), modules: [createUaModule({ crawlers: crawlers(() => undefined) })] })(
      new Request('https://www.example.com/_sid/v1'), {});
    const body = await response.json() as PayloadV1;
    expect(body.ext.modules['ua']).toEqual({ ms: expect.any(Number) as number, status: 'empty', stale: true });
  });

  it('keeps using an old snapshot past its maximum age, reported stale', async () => {
    const body = await payload(crawlers(() => ({ data, checkedAt: NOW - 3 * DAY })), EXAMPLE_CRAWLER);
    expect(bot(body)).toBe(true);
    expect(body.ext.modules['ua']?.stale).toBe(true);
  });

  it('falls back to the compiled-in list, reported stale, past the expiry', async () => {
    const body = await payload(crawlers(() => ({ data, checkedAt: NOW - 10 * DAY }), { expireAfterMs: 7 * DAY }), EXAMPLE_CRAWLER);
    expect(bot(body)).toBe(false);
    expect(body.ext.modules['ua']?.stale).toBe(true);
    expect(bot(await payload(crawlers(() => ({ data, checkedAt: NOW - 10 * DAY }), { expireAfterMs: 7 * DAY }), CURL))).toBe(true);
  });

  it('accepts clock skew, and falls back for a snapshot too far ahead of the clock', async () => {
    const skewed = await payload(crawlers(() => ({ data, checkedAt: NOW + 60_000 })), EXAMPLE_CRAWLER);
    expect(bot(skewed)).toBe(true);
    expect(skewed.ext.modules['ua']?.stale).toBeUndefined();
    const ahead = await payload(crawlers(() => ({ data, checkedAt: NOW + DAY })), EXAMPLE_CRAWLER);
    expect(bot(ahead)).toBe(false);
    expect(ahead.ext.modules['ua']?.stale).toBe(true);
  });

  it('falls back to the compiled-in list, reported stale, for data that does not compile', async () => {
    const body = await payload(crawlers(() => ({ data: { patterns: ['bot('] }, checkedAt: NOW })), CURL);
    expect(bot(body)).toBe(true);
    expect(body.ext.modules['ua']).toMatchObject({ status: 'ok', stale: true });
  });

  it('is unchanged without the option: the compiled-in list, never stale', async () => {
    const body = await payload(undefined, CURL);
    expect(bot(body)).toBe(true);
    expect(body.ext.modules['ua']?.stale).toBeUndefined();
  });

  it.each([
    ['a negative maximum age', { maxAgeMs: -1 }],
    ['an infinite maximum age', { maxAgeMs: Number.POSITIVE_INFINITY }],
    ['an expiry before the maximum age', { maxAgeMs: DAY, expireAfterMs: DAY - 1 }]
  ])('refuses %s', (_name, ages) => {
    expect(() => createUaModule({ crawlers: { snapshot: fresh, ...ages } })).toThrow(/maximum age/);
  });
});
