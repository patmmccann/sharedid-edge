import { expect, test as base, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';

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
 * The deployment's SID_COOKIE_DOMAIN (E2E_COOKIE_DOMAIN, `sharedid.dev` live), or undefined for host-only cookies, as on
 * the local server at 127.0.0.1. Prebid.js writes _pubcid on the highest domain it can, and the endpoint must match.
 */
const COOKIE_DOMAIN = process.env['E2E_COOKIE_DOMAIN'];

/** Where a test's own cookie goes: on the cookie domain, as a script on the site would write it, or host-only. */
function cookieScope(baseURL: string | undefined): { domain: string; path: string } | { url: string } {
  return COOKIE_DOMAIN === undefined ? { url: String(baseURL) } : { domain: `.${COOKIE_DOMAIN}`, path: '/' };
}

/**
 * Loads the page and waits for Prebid.js's pixelUrl request to SharedID Edge to complete.
 *
 * Not `pbjs.getUserIdsAsync()`: with `extend: true` and `pixelUrl`, sharedIdSystem's extendId callback ignores the
 * completion callback the User ID module passes it, so on every visit after the first the promise never resolves.
 * That is a Prebid.js issue, independent of this endpoint.
 */
async function visit(page: Page): Promise<Response> {
  const sync = page.waitForResponse(response => new URL(response.url()).pathname === '/_sid/sync', { timeout: 15_000 });
  await page.goto('/');
  const response = await sync;
  expect(response.status()).toBe(200);
  return response;
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

test('Prebid.js and the endpoint keep one _pubcid, on the same domain', async ({ page, context, baseURL }) => {
  await visit(page);
  await page.reload();
  await page.waitForTimeout(500);
  const all = await context.cookies();
  const ids = all.filter(c => c.name === '_pubcid');
  // Two _pubcid cookies mean SID_COOKIE_DOMAIN doesn't match where Prebid.js writes it: each side reads its own.
  expect(ids.map(c => c.domain)).toHaveLength(1);
  const expected = COOKIE_DOMAIN === undefined ? new URL(String(baseURL)).hostname : `.${COOKIE_DOMAIN}`;
  expect(ids[0]?.domain).toBe(expected);
  expect(all.find(c => c.name === '_pubcid_sv')?.domain).toBe(expected);
  await expect.poll(() => pubcidInPrebid(page)).toBe(ids[0]?.value);
});

test('works under GDPR with the page\'s static TC string: publisher and purpose consent for 1-10', async ({ page, context }) => {
  await visit(page);
  // Prebid.js got GDPR scope and the TC string from the page's static consent data (site/public/index.html), so consent is in play.
  await expect.poll(() => page.evaluate(() => (window as unknown as { pbjs: { getConsentMetadata(): { gdpr?: { gdprApplies?: boolean; consentStringSize?: number } } } }).pbjs.getConsentMetadata().gdpr))
    .toMatchObject({ gdprApplies: true });
  const cookies = await context.cookies();
  // SharedID Edge reads the TC string from euconsent-v2 (sharedIdSystem doesn't send it to pixelUrl), and sets both ID cookies.
  expect(cookies.find(c => c.name === 'euconsent-v2')?.value).toMatch(/^CQ/);
  expect(cookies.find(c => c.name === '_pubcid')?.value).toMatch(/^[0-9a-f-]{36}$/);
  expect(cookies.find(c => c.name === '_pubcid_sv')?.httpOnly).toBe(true);
});

test('a capped or cleared script cookie is restored from the server-only copy', async ({ page, context, sid }) => {
  await visit(page);
  const first = (await cookie(context, '_pubcid'))?.value;
  expect(first).toBeDefined();

  // Simulate Safari capping or clearing the script-readable cookie, while the HttpOnly copy survives.
  await context.clearCookies({ name: '_pubcid' });
  sid.reset();

  // Prebid.js mints a new id, writes it, and sends it to pixelUrl; the endpoint restores the original from the
  // recovery copy.
  const response = await visit(page);
  const [sync] = await sid.requests();
  expect(sync?.path).not.toContain(String(first));
  expect((await response.headerValues('set-cookie')).some(c => c.startsWith(`_pubcid=${String(first)};`))).toBe(true);
  // Prebid.js 11.48.0 then writes its new id again from script once the pixel loads (fixed by prebid/Prebid.js#16136),
  // which can overwrite the restored one, depending on timing. When the pinned prebid.js has the fix, check the browser
  // too: the _pubcid cookie and pbjs.getUserIds().pubcid are the original id.
});

test('Prebid.js\'s own pixel call, with no /v1 fetch, refreshes a reflected cookie', async ({ page, context, sid, baseURL }) => {
  // A script-written uid1 that would expire in a day, as Safari caps script cookies.
  const soon = Math.round(Date.now() / 1000) + DAY;
  await context.addCookies([{ name: 'uid1', value: 'AbC%2Fx+y/z==.v1', ...cookieScope(baseURL), expires: soon }]);
  await visit(page);

  const log = await sid.requests();
  expect(log.map(r => new URL(r.path, 'http://x').pathname)).toEqual(['/_sid/sync']);
  expect(log[0]?.cookie).toContain('uid1=AbC%2Fx+y/z==.v1');
  const uid1 = await cookie(context, 'uid1');
  expect(uid1?.value).toBe('AbC%2Fx+y/z==.v1');
  expect((uid1?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(360 * DAY);
});

test('Prebid.js\'s pixel call restores a deleted cookie from the keeper', async ({ page, context, sid, baseURL }) => {
  await context.addCookies([{ name: '_ga', value: 'GA1.1.1234567890.1700000000', ...cookieScope(baseURL), expires: Math.round(Date.now() / 1000) + DAY }]);
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
