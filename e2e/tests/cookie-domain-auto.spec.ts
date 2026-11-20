import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';

// SID_COOKIE_DOMAIN=auto with Prebid.js's pixelCookieDomain (11.53.0 and later), and the settings beside it. Each case is
// a site of its own on the local server (server.ts), so these run only there, not against a live deployment:
//
// - auto.sharedid.test: SID_COOKIE_DOMAIN=auto. Prebid.js writes _pubcid on sharedid.test, a parent of the page's host.
// - fixed.sharedid.test: SID_COOKIE_DOMAIN=fixed.sharedid.test, which isn't where Prebid.js writes _pubcid, so the test
//   can tell the fixed domain from cookie_domain.
// - hostonly.sharedid.test: SID_COOKIE_DOMAIN=host-only.
// - www.pub-a.test and www.pub-b.test: an upstream operator's endpoint (sid.upstream.test, trusted-upstream mode,
//   SID_COOKIE_DOMAIN=auto), reached through the publisher's CDN, which server.ts also plays.
test.skip(process.env['E2E_BASE_URL'] !== undefined, 'needs the local server\'s sites');

/** Loads the page on `origin` and waits for Prebid.js's pixelUrl request to complete. */
async function visit(page: Page, origin: string, query = ''): Promise<Response> {
  const sync = page.waitForResponse(response => new URL(response.url()).pathname === '/_sid/sync', { timeout: 15_000 });
  await page.goto(`${origin}/${query}`);
  const response = await sync;
  expect(response.status()).toBe(200);
  return response;
}

/** The `cookie_domain` Prebid.js sent with the sync, or null. */
function cookieDomainParam(response: Response): string | null {
  return new URL(response.url()).searchParams.get('cookie_domain');
}

/** The `Domain` of the sync's `Set-Cookie` for `name` (undefined for host-only), from the response the browser got. */
async function setCookieDomain(response: Response, name: string): Promise<string | undefined> {
  const line = (await response.headerValues('set-cookie')).find(value => value.startsWith(`${name}=`));
  expect(line, `Set-Cookie ${name}`).toBeDefined();
  return /;\s*Domain=([^;]+)/i.exec(line ?? '')?.[1];
}

/** The domain of each `name` cookie the browser holds. */
async function cookieDomains(context: BrowserContext, name: string): Promise<string[]> {
  return (await context.cookies()).filter(c => c.name === name).map(c => c.domain);
}

test.describe('SID_COOKIE_DOMAIN=auto', () => {
  test('with pixelCookieDomain, the cookies go on the domain Prebid.js reports: a parent of the page\'s host', async ({ page, context }) => {
    const sync = await visit(page, 'http://auto.sharedid.test', '?pixelCookieDomain=1');
    expect(cookieDomainParam(sync)).toBe('sharedid.test');
    expect(await sync.headerValue('x-sharedid-cookie-domain')).toBe('sharedid.test');
    expect(await setCookieDomain(sync, '_pubcid')).toBe('sharedid.test');
    expect(await setCookieDomain(sync, '_pubcid_sv')).toBe('sharedid.test');
    // One _pubcid, Prebid.js's and the endpoint's on the same domain.
    await page.reload();
    expect(await cookieDomains(context, '_pubcid')).toEqual(['.sharedid.test']);
    expect(await cookieDomains(context, '_pubcid_sv')).toEqual(['.sharedid.test']);
  });

  test('without pixelCookieDomain, there is no cookie_domain and the cookies are host-only', async ({ page }) => {
    const sync = await visit(page, 'http://auto.sharedid.test');
    expect(cookieDomainParam(sync)).toBeNull();
    expect(await sync.headerValue('x-sharedid-cookie-domain')).toBe('host-only: no cookie_domain');
    expect(await setCookieDomain(sync, '_pubcid')).toBeUndefined();
    expect(await setCookieDomain(sync, '_pubcid_sv')).toBeUndefined();
  });
});

test.describe('a fixed SID_COOKIE_DOMAIN ignores cookie_domain', () => {
  test('a fixed domain wins', async ({ page }) => {
    const sync = await visit(page, 'http://fixed.sharedid.test', '?pixelCookieDomain=1');
    expect(cookieDomainParam(sync)).toBe('sharedid.test');
    expect(await sync.headerValue('x-sharedid-cookie-domain')).toBeNull();
    expect(await setCookieDomain(sync, '_pubcid')).toBe('fixed.sharedid.test');
    expect(await setCookieDomain(sync, '_pubcid_sv')).toBe('fixed.sharedid.test');
  });

  test('host-only wins', async ({ page }) => {
    const sync = await visit(page, 'http://hostonly.sharedid.test', '?pixelCookieDomain=1');
    expect(cookieDomainParam(sync)).toBe('sharedid.test');
    expect(await sync.headerValue('x-sharedid-cookie-domain')).toBeNull();
    expect(await setCookieDomain(sync, '_pubcid')).toBeUndefined();
  });
});

test.describe('auto at an upstream operator\'s endpoint (trusted upstream)', () => {
  test('each publisher\'s cookies go on its own domain, checked against its site, not the endpoint', async ({ page, context }) => {
    for (const [site, domain] of [['www.pub-a.test', 'pub-a.test'], ['www.pub-b.test', 'pub-b.test']] as const) {
      const sync = await visit(page, `http://${site}`, '?pixelCookieDomain=1');
      expect(cookieDomainParam(sync)).toBe(domain);
      expect(await sync.headerValue('x-sharedid-cookie-domain')).toBe(domain);
      expect(await setCookieDomain(sync, '_pubcid')).toBe(domain);
      expect(await setCookieDomain(sync, '_pubcid_sv')).toBe(domain);
    }
    expect((await cookieDomains(context, '_pubcid')).sort()).toEqual(['.pub-a.test', '.pub-b.test']);
  });
});
