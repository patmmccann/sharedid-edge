import { parseCrawlerList, type CrawlerList } from '@sharedid-edge/module-ua';
import { bytes, checkNotModified, get, requireOk } from './download.js';
import { sourceName } from './snapshot.js';
import type { UpdateSource } from './update.js';

export type { CrawlerList } from '@sharedid-edge/module-ua';

/**
 * isbot's crawler pattern list (Unlicense), the list its releases compile in, on its main branch: a JSON array of
 * regular expression sources.
 */
export const ISBOT_PATTERNS_URL = 'https://raw.githubusercontent.com/omrilotan/isbot/main/src/patterns.json';

/** isbot's list is about 3 KB; anything this large isn't one. */
const MAX_LIST_BYTES = 1024 * 1024;

/**
 * Validates a stored crawler list snapshot, `{ patterns: [...] }`, with the `ua` module's rules (`parseCrawlerList`):
 * a plausible number of patterns, each compiling as a regular expression and none matching every User-Agent, matching
 * well-known crawlers and no current browser. It also compiles the list, so the reload, not a request, pays for it.
 */
export function validateCrawlerPatterns(value: unknown): CrawlerList {
  return parseCrawlerList(value);
}

/**
 * A source for a crawler User-Agent pattern list in isbot's format (a JSON array of regular expression sources, as
 * `src/patterns.json`), for the `ua` module's `crawlers` option: by default isbot's own list on its main branch
 * ({@link ISBOT_PATTERNS_URL}), as source `isbot-patterns`. `url` may point at a pinned release tag or your own copy
 * (`https:` only, without credentials). No credentials and no visitor data are sent.
 */
export function isbotPatternsSource(options: { readonly name?: string; readonly url?: string } = {}): UpdateSource<CrawlerList> {
  const url = new URL(options.url ?? ISBOT_PATTERNS_URL);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new TypeError('A crawler list URL must be https, without credentials');
  const href = url.href;
  return {
    name: sourceName(options.name ?? 'isbot-patterns'),
    // A new URL, or a change to the stored shape, mustn't let an old ETag skip the download.
    variant: JSON.stringify({ version: 1, url: href }),
    validate: validateCrawlerPatterns,
    async download(context) {
      const response = await get(href, context);
      if (response.status === 304) { checkNotModified(href, context); return undefined; }
      await requireOk(response, 'Download failed');
      const etag = response.headers.get('ETag');
      return { bytes: await bytes(response, MAX_LIST_BYTES), url: href, ...(etag === null ? {} : { etag }) };
    },
    decode(list) {
      const patterns: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(list));
      return parseCrawlerList({ patterns });
    }
  };
}
