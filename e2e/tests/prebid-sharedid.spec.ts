import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface SyncRequest {
  readonly path: string;
  readonly cookie: string;
}

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

async function syncLog(page: Page): Promise<SyncRequest[]> {
  return (await page.request.get('/__sync-log')).json() as Promise<SyncRequest[]>;
}

async function cookie(context: BrowserContext, name: string): Promise<{ value: string; expires: number; httpOnly: boolean } | undefined> {
  return (await context.cookies()).find(c => c.name === name);
}

test.beforeEach(async ({ page }) => {
  await page.request.get('/__reset');
});

test('unmodified Prebid.js sharedIdSystem with pixelUrl gets a long-lived server-set SharedID', async ({ page, context }) => {
  // First visit: Prebid.js mints an id and sends it to pixelUrl before writing its own cookie.
  await visit(page);
  const [firstSync] = await syncLog(page);
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
  await page.request.get('/__reset');
  await visit(page);
  const [secondSync] = await syncLog(page);
  expect(secondSync?.cookie).toContain(`_pubcid=${String(first)}`);
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
  expect(await pubcidInPrebid(page)).toBe(first);
});

test('a capped or cleared script cookie is restored from the server-only copy', async ({ page, context }) => {
  await visit(page);
  const first = (await cookie(context, '_pubcid'))?.value;
  expect(first).toBeDefined();

  // Simulate Safari capping or clearing the script-readable cookie, while the HttpOnly copy survives.
  await context.clearCookies({ name: '_pubcid' });
  await page.request.get('/__reset');

  // Prebid.js mints a new id, writes it, and sends it to pixelUrl; the endpoint restores the original from the
  // recovery copy, and Prebid.js reads the cookie back after the pixel loads.
  await visit(page);
  const [sync] = await syncLog(page);
  expect(sync?.path).not.toContain(String(first));
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
  await expect.poll(() => pubcidInPrebid(page)).toBe(first);
});

test('an opted-out user gets no id cookies from the endpoint', async ({ page, context }) => {
  const optout = await page.request.get('/_sid/optout');
  expect(optout.status()).toBe(204);
  expect((await cookie(context, '_pubcid_optout'))?.value).toBe('1');
  await page.request.get('/__reset');
  await page.goto('/');
  await page.waitForTimeout(1_500);
  // Prebid.js also checks _pubcid_optout, so it neither writes the id nor calls pixelUrl.
  expect(await cookie(context, '_pubcid')).toBeUndefined();
  expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
});
