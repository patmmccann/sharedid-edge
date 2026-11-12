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
  getUserIdsAsync(): Promise<{ pubcid?: string }>;
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
/** Loads the page (with a consent scenario from site/public/tcf.js: ?consent=denied, say) and waits for the sync. */
async function visit(page: Page, path = '/'): Promise<Response> {
  const sync = page.waitForResponse(response => new URL(response.url()).pathname === '/_sid/sync', { timeout: 15_000 });
  await page.goto(path);
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

interface ConsentMeta {
  getConsentMetadata(): { gdpr?: { gdprApplies?: boolean } };
}

function gdprMeta(page: Page): Promise<{ gdprApplies?: boolean } | undefined> {
  return page.evaluate(() => (window as unknown as { pbjs: ConsentMeta }).pbjs.getConsentMetadata().gdpr);
}

test('without purpose 1 consent, neither Prebid.js nor the endpoint stores an id, and existing ones are deleted', async ({ page, context, sid }) => {
  // An earlier visit with consent leaves the ID cookies.
  await visit(page);
  expect(await cookie(context, '_pubcid')).toBeDefined();
  await context.clearCookies({ name: '_pubcid' });
  sid.reset();

  // The visitor withdraws purpose 1 consent (vendors and publisher): the denied scenario's TC string.
  await page.goto('/?consent=denied');
  await expect.poll(() => gdprMeta(page)).toMatchObject({ gdprApplies: true });
  await page.waitForTimeout(1_500);
  // tcfControl stops sharedIdSystem: it writes no id and doesn't call pixelUrl.
  expect(await cookie(context, '_pubcid')).toBeUndefined();
  expect((await sid.requests()).filter(r => r.path.startsWith('/_sid/sync'))).toEqual([]);

  // The endpoint reads the same TC string from euconsent-v2: it sets no id and deletes the recovery copy left from before.
  expect(await cookie(context, '_pubcid_sv')).toBeDefined();
  const response = await page.request.get('/_sid/sync');
  expect(response.status()).toBe(200);
  expect(response.headers()['x-sharedid-status']).toBe('denied: tcf: no publisher consent for purpose 1');
  expect(await cookie(context, '_pubcid')).toBeUndefined();
  expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
});

test('where GDPR doesn\'t apply (static consent data, no TC string), everything works', async ({ page, context }) => {
  await visit(page, '/?consent=notApplicable');
  await expect.poll(() => gdprMeta(page)).toMatchObject({ gdprApplies: false });
  expect(await cookie(context, 'euconsent-v2')).toBeUndefined();
  const id = (await cookie(context, '_pubcid'))?.value;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await cookie(context, '_pubcid_sv'))?.value).toBe(id);
  await expect.poll(() => pubcidInPrebid(page)).toBe(id);
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
  // ...and the browser keeps it: since Prebid.js 11.49.0 (prebid/Prebid.js#16136), sharedIdSystem no longer writes its own
  // new id from script after the pixel loads, which overwrote the restored one. Wait a moment so a late rewrite shows.
  await page.waitForTimeout(500);
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
  // Prebid.js reads the restored id from the cookie on the next page view. (On this one, sharedIdSystem reads storage
  // as soon as the pixel loads; WebKit on Linux may not show the pixel response's Set-Cookie to document.cookie yet,
  // so Prebid.js can keep its own new id in memory until the page is next loaded.)
  await visit(page);
  expect(await pubcidInPrebid(page)).toBe(first);
  expect((await cookie(context, '_pubcid'))?.value).toBe(first);
});

test('pbjs.getUserIdsAsync() resolves on a later visit with extend: true', async ({ page, context }) => {
  await visit(page);
  const first = (await cookie(context, '_pubcid'))?.value;
  // A later visit takes sharedIdSystem's extendId path, which calls pixelUrl again. In Prebid.js 11.48.0 and earlier its
  // callback never signalled completion, so getUserIdsAsync() never resolved (fixed by prebid/Prebid.js#16135).
  await visit(page);
  const ids = await page.evaluate(() => Promise.race([
    (window as unknown as { pbjs: Pbjs }).pbjs.getUserIdsAsync(),
    new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('getUserIdsAsync() did not resolve within 5 seconds')); }, 5_000))
  ]));
  expect(ids.pubcid).toBe(first);
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

// The reflect README's "Make uid1 sticky and server-set" walkthrough, with a stand-in vendor tag
// (site/public/vendor-uid1.js) writing uid1 from page script, and uid1 configured as the walkthrough does it.
const ONE_YEAR_ISH = 360 * DAY;

async function uid1Cookies(context: BrowserContext): Promise<{ value: string; domain: string; expires: number }[]> {
  return (await context.cookies()).filter(c => c.name === 'uid1');
}

test('a vendor-written uid1 becomes one server-set cookie with the vendor\'s value, kept for a year', async ({ page, context }) => {
  // The vendor tag writes uid1 with a 7-day lifetime; the next page view's pixel call carries it to the worker.
  await visit(page);
  const written = (await uid1Cookies(context))[0]?.value;
  expect(written).toMatch(/^v1\./);
  await visit(page);
  const uid1 = await uid1Cookies(context);
  expect(uid1.map(c => c.domain)).toEqual([COOKIE_DOMAIN === undefined ? new URL(String(page.url())).hostname : `.${COOKIE_DOMAIN}`]);
  expect(uid1[0]?.value).toBe(written);
  expect((uid1[0]?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(ONE_YEAR_ISH);
  expect((await cookie(context, '_sid_keep'))?.httpOnly).toBe(true);
});

test('a deleted uid1 comes back with the same value when the vendor tag runs after Prebid.js\'s pixel call', async ({ page, context, sid }) => {
  await visit(page, '/?vendor=late');
  await expect.poll(async () => (await uid1Cookies(context))[0]?.value, { timeout: 5_000 }).toMatch(/^v1\./);
  const original = (await uid1Cookies(context))[0]?.value;
  await visit(page, '/?vendor=late'); // reflected, and saved in the keeper

  // Safari's cap, or the visitor, deletes uid1; the HttpOnly keeper survives.
  await context.clearCookies({ name: 'uid1' });
  sid.reset();
  await visit(page, '/?vendor=late');
  expect((await sid.requests())[0]?.cookie).not.toContain('uid1=');
  expect((await uid1Cookies(context)).map(c => c.value)).toEqual([original]);
  // The vendor tag, running now, finds uid1 and keeps it.
  await page.waitForTimeout(2_000);
  expect((await uid1Cookies(context)).map(c => c.value)).toEqual([original]);
});

test('when the vendor tag runs before Prebid.js\'s pixel call, it re-mints a deleted uid1 before the worker can restore it', async ({ page, context, sid }) => {
  await visit(page);
  await visit(page);
  const original = (await uid1Cookies(context))[0]?.value;
  expect(original).toMatch(/^v1\./);

  await context.clearCookies({ name: 'uid1' });
  sid.reset();
  await visit(page);
  // The pixel call already carries the vendor's new uid1, and with the default prefer ("browser") the browser's value
  // wins: it's reflected, and the keeper saves it. "prefer": "backup", or calling /_sid/v1 before the vendor tag runs,
  // restores the original instead (see the README).
  const sent = (await sid.requests())[0]?.cookie ?? '';
  expect(sent).toMatch(/uid1=v1\./);
  expect(sent).not.toContain(`uid1=${String(original)}`);
  const now = (await uid1Cookies(context)).map(c => c.value);
  expect(now).toHaveLength(1);
  expect(now[0]).not.toBe(original);
});

// The clickid module: a landing page's click ID, from Prebid.js's pixel call's Referer, kept in a server-set cookie.
test('a landing page\'s gclid is kept in a server-set _sid_gclid for 90 days, readable by page script', async ({ page, context, sid }) => {
  const gclid = `e2e-${String(Date.now())}_Test.x`;
  await visit(page, `/?utm_source=e2e&gclid=${gclid}`);
  const log = await sid.requests();
  // No page code calls /_sid/v1: the click ID reached the worker through the pixel call alone.
  expect(log.map(r => new URL(r.path, 'http://x').pathname)).toEqual(['/_sid/sync']);
  const kept = await cookie(context, '_sid_gclid');
  expect(kept?.value).toMatch(new RegExp(`^[0-9]{10}\\.${gclid.replace('.', '\\.')}$`));
  expect(kept?.httpOnly).toBe(false);
  // Server-set: a script-written cookie would be capped at 7 days (or a day) in Safari.
  expect((kept?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(89 * DAY);
  const fromScript = await page.evaluate(() => document.cookie.split('; ').find(c => c.startsWith('_sid_gclid=')));
  expect(fromScript).toBe(`_sid_gclid=${String(kept?.value)}`);

  // A later page view without a click ID leaves it alone.
  await visit(page, '/');
  expect((await cookie(context, '_sid_gclid'))?.value).toBe(kept?.value);
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
