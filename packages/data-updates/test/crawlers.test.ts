import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveConfig, type PayloadV1 } from '@sharedid-edge/core';
import { createUaModule } from '@sharedid-edge/module-ua';
import { ISBOT_PATTERNS_URL, isbotPatternsSource, validateCrawlerPatterns } from '../src/crawlers.js';
import { refreshData, SnapshotCache } from '../src/index.js';
import { MemoryStore } from './helpers.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 3_600_000;
/** Recognized by the lists below, not by isbot's compiled-in one. */
const CUSTOM_CRAWLER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Zqxwidget/2.0';

/** A list in isbot's format: the well-known crawlers, `zqxwidget/` and filler, `count` patterns in all. */
function patterns(count = 80): string[] {
  const known = ['googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'baiduspider', 'facebookexternalhit', 'ahrefsbot', 'zqxwidget/'];
  return [...known, ...Array.from({ length: count - known.length }, (_value, index) => `^filler-agent-${String(index)}/`)].slice(0, count);
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function serve(body: string, init: ResponseInit = {}, etag = '"v1"'): ReturnType<typeof vi.fn<Fetch>> {
  return vi.fn<Fetch>(() => Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/plain', ETag: etag }, ...init })));
}

async function stored(store: MemoryStore, name = 'isbot-patterns'): Promise<readonly string[] | undefined> {
  const cache = new SnapshotCache(store, name, validateCrawlerPatterns, 0, () => NOW);
  await cache.reload();
  return cache.current?.data.patterns;
}

describe('the isbot crawler list source', () => {
  it('downloads isbot\'s pattern list without credentials and publishes it', async () => {
    const store = new MemoryStore();
    const fetch = serve(JSON.stringify(patterns()));
    expect(await refreshData(isbotPatternsSource(), { store, fetch, now: () => NOW, secrets: { 'isbot-patterns': { unused: 'secret-value' } } }))
      .toEqual({ name: 'isbot-patterns', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(ISBOT_PATTERNS_URL);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(await stored(store)).toEqual(patterns());
    expect([...store.values.values()].join('')).not.toContain('secret-value');
  });

  it('sends the stored ETag and only refreshes the manifest on 304', async () => {
    const store = new MemoryStore();
    await refreshData(isbotPatternsSource(), { store, fetch: serve(JSON.stringify(patterns())), now: () => NOW });
    const before = new Map(store.values);
    const fetch = vi.fn<Fetch>(() => Promise.resolve(new Response(null, { status: 304 })));
    expect(await refreshData(isbotPatternsSource(), { store, fetch, now: () => NOW + HOUR })).toEqual({ name: 'isbot-patterns', status: 'unchanged' });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('If-None-Match')).toBe('"v1"');
    const manifest = JSON.parse(store.values.get('isbot-patterns/current.json') ?? '{}') as { checkedAt?: number; hash?: string };
    expect(manifest.checkedAt).toBe(NOW + HOUR);
    expect(manifest.hash).toBe((JSON.parse(before.get('isbot-patterns/current.json') ?? '{}') as { hash?: string }).hash);
    // An identical list without a 304 doesn't write a new body either.
    expect(await refreshData(isbotPatternsSource(), { store, fetch: serve(JSON.stringify(patterns()), {}, '"v2"'), now: () => NOW + 2 * HOUR })).toEqual({ name: 'isbot-patterns', status: 'unchanged' });
  });

  it.each([
    ['an empty list', '[]'],
    ['a list that is too small', JSON.stringify(patterns(20))],
    ['a pattern that does not compile', JSON.stringify([...patterns(), 'bot('])],
    ['a pattern that matches every User-Agent', JSON.stringify([...patterns(), '.?'])],
    ['a pattern that matches browsers', JSON.stringify([...patterns(), 'mozilla'])],
    ['a list without Googlebot', JSON.stringify(patterns().filter(pattern => pattern !== 'googlebot'))],
    ['a list of non-strings', JSON.stringify(patterns().map((_pattern, index) => index))],
    ['an object instead of a list', JSON.stringify({ patterns: patterns() })],
    ['something that is not JSON', 'googlebot\nbingbot\n'],
    ['a body over 1 MiB', JSON.stringify([...patterns(), 'x'.repeat(1024 * 1024)])]
  ])('refuses %s and keeps the previous list', async (_name, body) => {
    const store = new MemoryStore();
    await refreshData(isbotPatternsSource(), { store, fetch: serve(JSON.stringify(patterns())), now: () => NOW });
    const before = new Map(store.values);
    expect(await refreshData(isbotPatternsSource(), { store, fetch: serve(body, {}, '"bad"'), now: () => NOW + HOUR })).toEqual({ name: 'isbot-patterns', status: 'failed' });
    expect(store.values).toEqual(before);
    expect(await stored(store)).toEqual(patterns());
  });

  it('fails a first run on an error status, publishing nothing', async () => {
    const store = new MemoryStore();
    expect(await refreshData(isbotPatternsSource(), { store, fetch: serve('Not found', { status: 404 }), now: () => NOW })).toEqual({ name: 'isbot-patterns', status: 'failed' });
    expect(store.values.size).toBe(0);
  });

  it('downloads from another https URL under another name', async () => {
    const store = new MemoryStore();
    const url = 'https://raw.githubusercontent.com/omrilotan/isbot/v5.2.3/src/patterns.json';
    const fetch = serve(JSON.stringify(patterns()));
    expect(await refreshData(isbotPatternsSource({ name: 'crawlers', url }), { store, fetch, now: () => NOW })).toEqual({ name: 'crawlers', status: 'updated' });
    expect(fetch.mock.calls[0]?.[0]).toBe(url);
    expect(await stored(store, 'crawlers')).toEqual(patterns());
  });

  it.each([
    ['plain http', 'http://lists.example.com/patterns.json'],
    ['credentials in the URL', 'https://user:pass@lists.example.com/patterns.json']
  ])('refuses a URL with %s', (_name, url) => {
    expect(() => isbotPatternsSource({ url })).toThrow(/https, without credentials/);
  });

  it('gives the ua module the published list, through the snapshot cache', async () => {
    const store = new MemoryStore();
    await refreshData(isbotPatternsSource(), { store, fetch: serve(JSON.stringify(patterns())), now: () => NOW });
    const cache = new SnapshotCache(store, 'isbot-patterns', validateCrawlerPatterns, 0, () => NOW);
    const ua = createUaModule({ crawlers: { snapshot: () => cache.current, maxAgeMs: 2 * 24 * HOUR, now: () => NOW } });
    const handler = createHandler({ config: resolveConfig({ SID_MODULES: 'ua' }), modules: [ua] });
    const request = (): Request => new Request('https://www.example.com/_sid/v1', { headers: { 'User-Agent': CUSTOM_CRAWLER } });

    // Before the first load: isbot's compiled-in list, which doesn't know this crawler, reported stale.
    const before = await (await handler(request(), {})).json() as PayloadV1;
    expect(JSON.stringify(before.ortb2 ?? {})).not.toContain('traffic');
    expect(before.ext.modules['ua']?.stale).toBe(true);

    expect(await cache.reload()).toBe(true);
    const after = await (await handler(request(), {})).json() as PayloadV1;
    expect(after.ortb2).toMatchObject({ device: { ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } } } });
    expect(after.ext.modules['ua']?.stale).toBeUndefined();
  });
});
