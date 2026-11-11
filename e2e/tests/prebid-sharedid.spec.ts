import { expect, test as base, type BrowserContext, type Page, type Request } from '@playwright/test';

/** A request the page sent to SharedID Edge: its path and query, and the cookies the browser sent with it. */
interface SidRequest {
  readonly path: string;
  readonly cookie: string;
}

interface SidLog {
  /** The page's requests to /_sid/* so far, in order. */
  requests(): Promise<SidRequest[]>;
  reset(): void;
}

/**
 * Records the page's requests to /_sid/* from the browser's side, so the tests run the same against the local server
 * and a live deployment. Requests made with `page.request` (outside the page) aren't recorded.
 */
const test = base.extend<{ sid: SidLog }>({
  sid: async ({ page }, use) => {
    const seen: Request[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/_sid/')) seen.push(request);
    });
    await use({
      requests: () => Promise.all(seen.map(async request => {
        const url = new URL(request.url());
        return { path: url.pathname + url.search, cookie: (await request.allHeaders())['cookie'] ?? '' };
      })),
      reset: () => { seen.length = 0; }
    });
  }
});

interface Pbjs {
  getUserIds(): { pubcid?: string };
}

const DAY = 86_400;

/**
 * Loads the page and waits for Prebid.js's pixelUrl request to SharedID Edge to complete.
 *
 * Not `pbjs.getUserIdsAsync()`: with `extend: true` and `pixelUrl`, sharedIdSystem's extendId callback ignores the
 * completion callback the User ID module passes it, so on every visit after the first the promise never resolves.
 * That is a Prebid.js issue, independent of this endpoint.
 */
async function visit(page: Page): Promise<void> {
  const sync = page.waitForResponse(response => new URL(response.url()).pathname === '/_sid/sync', { timeout: 15_000 });
  await page.goto('/');
  expect((await sync).status()).toBe(200);
}

async function pubcidInPrebid(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as unknown as { pbjs: Pbjs }).pbjs.getUserIds().pubcid);
}

async function cookie(context: BrowserContext, name: string): Promise<{ value: string; expires: number; httpOnly: boolean } | undefined> {
  return (await context.cookies()).find(c => c.name === name);
}

test('unmodified Prebid.js sharedIdSystem with pixelUrl gets a long-lived server-set SharedID', async ({ page, context, sid }) => {
  // First visit: Prebid.js mints an id and sends it to pixelUrl before writing its own cookie.
  await visit(page);
  const [firstSync] = await sid.requests();
  expect(firstSync?.path).toMatch(/^\/_sid\/sync\?id=pubcid(%253A|%3A|:)/);
  const first = decodeURIComponent(decodeURIComponent(firstSync?.path ?? '')).split('pubcid:')[1];
  expect(first).toMatch(/^[0-9a-f-]{36}$/);

  const idCookie = await cookie(context, '_pubcid');
  expect(idCookie?.value).toBe(first);
  expect(idCookie?.httpOnly).toBe(false);
  expect((idCookie?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(360 * DAY);
  // Only the server can set the HttpOnly copy, so this shows the endpoint set the cookies.
  const recovery = await cookie(context, '_pubcid_sv');
  expect(recovery?.value).toBe(first);
  expect(recovery?.httpOnly).toBe(true);
  await expect.poll(() => pubcidInPrebid(page)).toBe(first);

  // Second visit: the same id, now sent to the endpoint as a cookie, and kept.
  sid.reset();
  await visit(page);
  const [secondSync] = await sid.requests();
  expect(secondSync?.cookie).toContain(`_pubcid=${String(first)}`);
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
  expect(await pubcidInPrebid(page)).toBe(first);
});

test('a capped or cleared script cookie is restored from the server-only copy', async ({ page, context, sid }) => {
  await visit(page);
  const first = (await cookie(context, '_pubcid'))?.value;
  expect(first).toBeDefined();

  // Simulate Safari capping or clearing the script-readable cookie, while the HttpOnly copy survives.
  await context.clearCookies({ name: '_pubcid' });
  sid.reset();

  // Prebid.js mints a new id, writes it, and sends it to pixelUrl; the endpoint restores the original from the
  // recovery copy, and Prebid.js reads the cookie back after the pixel loads.
  await visit(page);
  const [sync] = await sid.requests();
  expect(sync?.path).not.toContain(String(first));
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
  await expect.poll(() => pubcidInPrebid(page)).toBe(first);
});

test('Prebid.js\'s own pixel call, with no /v1 fetch, refreshes a reflected cookie', async ({ page, context, sid, baseURL }) => {
  // A script-written uid1 that would expire in a day, as Safari caps script cookies.
  const soon = Math.round(Date.now() / 1000) + DAY;
  await context.addCookies([{ name: 'uid1', value: 'AbC%2Fx+y/z==.v1', url: String(baseURL), expires: soon }]);
  await visit(page);

  const log = await sid.requests();
  expect(log.map(r => new URL(r.path, 'http://x').pathname)).toEqual(['/_sid/sync']);
  expect(log[0]?.cookie).toContain('uid1=AbC%2Fx+y/z==.v1');
  const uid1 = await cookie(context, 'uid1');
  expect(uid1?.value).toBe('AbC%2Fx+y/z==.v1');
  expect((uid1?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(360 * DAY);
});

test('Prebid.js\'s pixel call restores a deleted cookie from the keeper', async ({ page, context, sid, baseURL }) => {
  await context.addCookies([{ name: '_ga', value: 'GA1.1.1234567890.1700000000', url: String(baseURL), expires: Math.round(Date.now() / 1000) + DAY }]);
  await visit(page);
  expect((await cookie(context, '_sid_keep'))?.httpOnly).toBe(true);

  // Simulate Safari deleting the script-written _ga; the HttpOnly keeper survives.
  await context.clearCookies({ name: '_ga' });
  sid.reset();
  await visit(page);
  const [sync] = await sid.requests();
  expect(sync?.cookie).not.toContain('_ga=');
  expect((await cookie(context, '_ga'))?.value).toBe('GA1.1.1234567890.1700000000');
});

test('an opted-out user gets no id cookies from the endpoint', async ({ page, context }) => {
  const optout = await page.request.get('/_sid/optout');
  expect(optout.status()).toBe(204);
  expect((await cookie(context, '_pubcid_optout'))?.value).toBe('1');
  await page.goto('/');
  await page.waitForTimeout(1_500);
  // Prebid.js also checks _pubcid_optout, so it neither writes the id nor calls pixelUrl.
  expect(await cookie(context, '_pubcid')).toBeUndefined();
  expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
});
