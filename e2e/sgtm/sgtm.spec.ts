// SharedID Edge beside server-side Google Tag Manager, on Google's real tagging server image (README.md). It checks
// what docs/sgtm.md and templates/sgtm/README.md say: the SharedID variable template's choices, through the echo
// client (gtm/container.json), and how SharedID Edge's cookies and consent sit beside the GA4 client's server-managed
// FPID and the Conversion Linker's FPGCLAW. Where Google's documentation is silent (docs/sgtm.md, "Not confirmed"), the
// tests record what they see as annotations ("observed") instead of asserting it.
import { expect, test as base, type BrowserContext, type Page, type Response } from '@playwright/test';

/** The echo client's path (container.ts, ECHO_PATH). */
const ECHO = '/metrics/sid-echo';
const COOKIE_DOMAIN = process.env['E2E_COOKIE_DOMAIN'] ?? 'sharedid.test';
const VALID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';

/** Cookies SharedID Edge sets (with reflect for uid1 and clickid), and those sGTM's GA4 client and Conversion Linker set. */
const SHAREDID_COOKIES = ['_pubcid', '_pubcid_sv', '_pubcid_optout', 'uid1', '_sid_keep', '_sid_gclid'];
const GOOGLE_COOKIE = /^(FP|_ga|_gcl_)/;

interface SetCookies {
  /** The names of the cookies each side's responses set (or deleted), as far as the browser exposed the responses. */
  sid: Set<string>;
  sgtm: Set<string>;
  sgtmResponses: number;
}

/** Records which cookies the responses from /_sid/* and from /metrics/* set. */
const test = base.extend<{ setCookies: SetCookies }>({
  setCookies: async ({ page }, use) => {
    const seen: SetCookies = { sid: new Set(), sgtm: new Set(), sgtmResponses: 0 };
    const pending: Promise<void>[] = [];
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      const side = path.startsWith('/_sid/') ? seen.sid : path.startsWith('/metrics/') && path !== ECHO ? seen.sgtm : undefined;
      if (side === undefined) return;
      if (side === seen.sgtm) seen.sgtmResponses++;
      pending.push(response.headerValues('set-cookie').then(values => {
        for (const value of values) side.add(value.split('=')[0]?.trim() ?? '');
      }, () => undefined));
    });
    await use(seen);
    await Promise.all(pending);
  }
});

function observe(description: string): void {
  test.info().annotations.push({ type: 'observed', description });
  console.log(`observed: ${description}`);
}

/** Loads the test page and waits for Prebid.js's pixelUrl call to SharedID Edge. */
async function visit(page: Page, path = '/'): Promise<Response> {
  const sync = page.waitForResponse(response => new URL(response.url()).pathname === '/_sid/sync', { timeout: 20_000 });
  await page.goto(path);
  const response = await sync;
  expect(response.status()).toBe(200);
  return response;
}

/** Loads the test page and waits for the Google tag's first request to the tagging server's GA4 client. */
async function visitWithGa4(page: Page, path = '/'): Promise<void> {
  const collect = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/g/collect'), { timeout: 30_000 });
  await visit(page, path);
  await collect;
}

/** What the SharedID variable returns for this browser's cookies and headers, through the echo client. */
async function echo(page: Page): Promise<string | null> {
  const response = await page.goto(ECHO);
  expect(response?.status()).toBe(200);
  const body: unknown = await response?.json();
  const sharedid = typeof body === 'object' && body !== null && 'sharedid' in body ? body.sharedid : undefined;
  if (typeof sharedid !== 'string' && sharedid !== null) throw new Error(`${ECHO} answered ${JSON.stringify(body)}, not {"sharedid":<string or null>}`);
  return sharedid;
}

async function cookie(context: BrowserContext, name: string): Promise<{ value: string; domain: string; expires: number; httpOnly: boolean } | undefined> {
  return (await context.cookies()).find(c => c.name === name);
}

function scope(): { domain: string; path: string } {
  return { domain: `.${COOKIE_DOMAIN}`, path: '/' };
}

test.beforeAll(async ({ browser }) => {
  // The tagging server answers the echo only once it has loaded the published container (README.md). Through the
  // browser, which resolves the site's hostname to the stack (playwright.sgtm.config.ts).
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...(baseURL === undefined ? {} : { baseURL }) });
  const response = await (await context.newPage()).goto(ECHO).catch(() => null);
  const type = response?.headers()['content-type'] ?? '';
  await context.close();
  if (!type.includes('application/json')) {
    throw new Error(`${ECHO} doesn't answer JSON: start the stack (docker compose up) and run sgtm/wait.sh first (sgtm/README.md).`);
  }
});

test.describe('the SharedID variable template', () => {
  test('returns the _pubcid that SharedID Edge set from /_sid/sync', async ({ page, context }) => {
    await visit(page);
    const id = (await cookie(context, '_pubcid'))?.value;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const recovery = await cookie(context, '_pubcid_sv');
    expect(recovery?.value).toBe(id);
    expect(recovery?.httpOnly).toBe(true);
    expect(await echo(page)).toBe(id);
  });

  test('prefers the HttpOnly recovery copy when the script cookie is cleared or re-minted', async ({ page, context }) => {
    await visit(page);
    const id = (await cookie(context, '_pubcid'))?.value;
    expect(id).toBeDefined();

    // Safari cleared the script-written cookie; the server-set HttpOnly copy survives.
    await context.clearCookies({ name: '_pubcid' });
    expect(await echo(page)).toBe(id);

    // The page re-minted a new ID before SharedID Edge's next call: the variable already returns the one kept.
    await context.addCookies([{ name: '_pubcid', value: OTHER, ...scope() }]);
    expect(await echo(page)).toBe(id);

    // And SharedID Edge restores it on its next call.
    await visit(page);
    expect((await cookie(context, '_pubcid'))?.value).toBe(id);
    expect(await echo(page)).toBe(id);
  });

  test('returns no invalid value', async ({ page, context }) => {
    // No page visit: the cookies are what the browser sends, untouched by Prebid.js or SharedID Edge.
    await context.addCookies([{ name: '_pubcid', value: '-not-an-id', ...scope() }]);
    expect(await echo(page)).toBeNull();

    // An invalid recovery copy (percent-encoded, read undecoded) doesn't count; the valid _pubcid does.
    await context.addCookies([{ name: '_pubcid', value: VALID, ...scope() }, { name: '_pubcid_sv', value: '%41', ...scope() }]);
    expect(await echo(page)).toBe(VALID);
  });

  test('returns no ID for a request with Sec-GPC: 1, and SharedID Edge then deletes the cookies', async ({ page, context }) => {
    await visit(page);
    expect(await echo(page)).toMatch(/^[0-9a-f-]{36}$/);

    await context.setExtraHTTPHeaders({ 'Sec-GPC': '1' });
    // The browser still sends _pubcid: the template's own GPC check returns nothing.
    expect(await echo(page)).toBeNull();
    expect(await cookie(context, '_pubcid')).toBeDefined();

    // SharedID Edge's next call deletes the ID cookies (docs/consent.md).
    const sync = await visit(page);
    expect(sync.headers()['x-sharedid-status']).toBe('denied: gpc');
    expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
    expect(await echo(page)).toBeNull();
  });

  test('returns no ID after opt-out', async ({ page, context }) => {
    await visit(page);
    // From the page, as a site's opt-out link would call it (a navigation to a 204 doesn't complete).
    expect(await page.evaluate(() => fetch('/_sid/optout', { credentials: 'include' }).then(r => r.status))).toBe(204);
    expect((await cookie(context, '_pubcid_optout'))?.value).toBe('1');
    expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
    expect(await echo(page)).toBeNull();

    // With the opt-out cookie, an ID cookie the browser still sends isn't returned either.
    await context.addCookies([{ name: '_pubcid', value: VALID, ...scope() }, { name: '_pubcid_sv', value: VALID, ...scope() }]);
    expect(await echo(page)).toBeNull();
  });
});

test.describe('beside the GA4 client and Conversion Linker (docs/sgtm.md)', () => {
  test('with reflect keeping non-Google cookies only, neither side sets or overwrites the other\'s cookies', async ({ page, context, setCookies }) => {
    // A landing page with an ad click ID: the Conversion Linker's FPGCLAW and clickid's _sid_gclid.
    await visitWithGa4(page, '/?gclid=TeSt-gclid-1');
    // The vendor tag's uid1 reaches SharedID Edge on the next page view, which sets it from the server (reflect).
    await visitWithGa4(page);

    // The GA4 client in server-managed mode sets FPID (docs/sgtm.md, "The GA4 client's server-managed client ID").
    await expect.poll(async () => (await cookie(context, 'FPID'))?.value, { timeout: 15_000 }).toBeDefined();
    // The Conversion Linker writes FPGCLAW for a landing page with a gclid (docs/sgtm.md, from a third-party write-up).
    await expect.poll(async () => (await cookie(context, 'FPGCLAW'))?.value, { timeout: 15_000 }).toBeDefined();
    // clickid writes its own cookie, not Google's.
    expect((await cookie(context, '_sid_gclid'))?.value).toContain('TeSt-gclid-1');
    const before = {
      FPID: (await cookie(context, 'FPID'))?.value,
      FPGCLAW: (await cookie(context, 'FPGCLAW'))?.value,
      _pubcid: (await cookie(context, '_pubcid'))?.value,
      uid1: (await cookie(context, 'uid1'))?.value
    };
    expect([...setCookies.sid]).toContain('uid1');

    // More page views: every value stays as it was.
    await visitWithGa4(page);
    await visitWithGa4(page);
    await page.waitForTimeout(1_000);
    for (const [name, value] of Object.entries(before)) {
      expect((await cookie(context, name))?.value, name).toBe(value);
    }

    // SharedID Edge's responses set no Google cookie, and sGTM's none of SharedID Edge's (docs/sgtm.md's table).
    expect([...setCookies.sid].filter(name => GOOGLE_COOKIE.test(name))).toEqual([]);
    expect([...setCookies.sgtm].filter(name => SHAREDID_COOKIES.includes(name))).toEqual([]);

    // What Google's documentation doesn't say (docs/sgtm.md, "Not confirmed").
    const fpid = await cookie(context, 'FPID');
    const fpgclaw = await cookie(context, 'FPGCLAW');
    observe(`responses from /metrics/* seen by the browser: ${String(setCookies.sgtmResponses)}; cookies they set: ${[...setCookies.sgtm].sort().join(', ') || 'none seen'}`);
    observe(`FPID: HttpOnly ${String(fpid?.httpOnly)}, domain ${String(fpid?.domain)}, days left ${fpid === undefined ? '?' : String(Math.round((fpid.expires - Date.now() / 1000) / 86_400))}`);
    observe(`FPGCLAW: HttpOnly ${String(fpgclaw?.httpOnly)}, domain ${String(fpgclaw?.domain)}`);
    observe(`sGTM set _ga from the server (server-managed mode): ${String(setCookies.sgtm.has('_ga'))}`);
  });

  test('denied consent stops SharedID Edge, the variable and the Conversion Linker', async ({ page, context }) => {
    // One choice drives both (docs/sgtm.md, "Consent"): the denied TC string, and Consent Mode denied.
    const collect = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/g/collect'), { timeout: 30_000 }).catch(() => undefined);
    await page.goto('/?consent=denied&gclid=TeSt-gclid-denied');
    const sent = await collect;
    await page.waitForTimeout(3_000);

    expect(await cookie(context, '_pubcid')).toBeUndefined();
    expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
    expect(await cookie(context, '_sid_gclid')).toBeUndefined();
    expect(await echo(page)).toBeNull();
    // Google's tags adjust to Consent Mode; the Conversion Linker writes no FPGCLAW with ad_storage denied.
    expect(await cookie(context, 'FPGCLAW')).toBeUndefined();

    observe(`with Consent Mode denied, the Google tag sent to the GA4 client: ${String(sent !== undefined)}; FPID set: ${String(await cookie(context, 'FPID') !== undefined)}`);
  });

  test('with Sec-GPC: 1, SharedID Edge and the variable set and return nothing', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ 'Sec-GPC': '1' });
    await visitWithGa4(page, '/?gclid=TeSt-gclid-gpc');
    await page.waitForTimeout(2_000);

    expect(await cookie(context, '_pubcid_sv')).toBeUndefined();
    expect(await cookie(context, '_sid_gclid')).toBeUndefined();
    expect(await echo(page)).toBeNull();

    // docs/sgtm.md says sGTM reads Consent Mode, not GPC: record what Google's side does with GPC alone.
    observe(`with Sec-GPC: 1 and Consent Mode granted: FPID set: ${String(await cookie(context, 'FPID') !== undefined)}; FPGCLAW set: ${String(await cookie(context, 'FPGCLAW') !== undefined)}`);
  });
});
