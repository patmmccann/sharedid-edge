// The core browser tests in real Safari, driven through safaridriver (WebDriver): Playwright's WebKit isn't Safari, so
// these run the same page, Prebid.js bundle and consent scenarios as tests/prebid-sharedid.spec.ts in the browser
// SharedID Edge exists for. macOS only. See e2e/AGENTS.md ("Real Safari") for how to run them.
//
// Locally, the page is http://e2e.sharedid.test:4310, served by server.ts, which this file starts: map the hostname
// in /etc/hosts (`127.0.0.1 e2e.sharedid.test`), since Safari can't use the Playwright proxy trick. With E2E_BASE_URL
// (and E2E_COOKIE_DOMAIN), it runs against a live deployment instead, with no local server.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { Builder, type IWebDriverOptionsCookie as Cookie, type WebDriver } from 'selenium-webdriver';

const PORT = 4310;
const live = process.env['E2E_BASE_URL'];
const BASE = live ?? `http://e2e.sharedid.test:${String(PORT)}`;
const COOKIE_DOMAIN = live === undefined ? 'sharedid.test' : process.env['E2E_COOKIE_DOMAIN'];
const DAY = 86_400;
const UUID = /^[0-9a-f-]{36}$/;

let server: ChildProcess | undefined;
let driver: WebDriver;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls `read` until `ok` holds for its value, for up to `timeout` ms, and returns the last value. */
async function poll<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await sleep(100);
    value = await read();
  }
  return value;
}

async function startServer(): Promise<ChildProcess> {
  const run = (args: string[]): ChildProcess => spawn(process.execPath, ['--experimental-strip-types', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  // The Prebid.js bundle the page loads (site/public/prebid/prebid.js), as Playwright's webServer command builds it.
  const bundle = run(['bundle-prebid.ts']);
  const code = await new Promise<number | null>(resolve => bundle.on('exit', resolve));
  assert.equal(code, 0, 'bundle-prebid.ts failed');
  const child = run(['server.ts']);
  const up = await poll(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${String(PORT)}/`)).ok;
    } catch {
      return false;
    }
  }, ok => ok, 15_000);
  assert.ok(up, 'server.ts did not start');
  return child;
}

/** The cookies the browser holds for the page, HttpOnly ones included. */
async function cookies(): Promise<Cookie[]> {
  return driver.manage().getCookies();
}

async function cookie(name: string): Promise<Cookie | undefined> {
  return (await cookies()).find(c => c.name === name);
}

/** Whether the page's request to /_sid/sync has completed (WebDriver has no network events; resource timing does). */
function syncs(): Promise<number> {
  return driver.executeScript<number>(
    "return performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/_sid/sync' && e.responseEnd > 0).length;"
  );
}

/** The id Prebid.js minted and sent to pixelUrl on this page view (`/_sid/sync?id=pubcid:<id>`), from resource timing. */
async function mintedId(): Promise<string | undefined> {
  const url = await driver.executeScript<string | null>(
    "const e = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/_sid/sync'); return e ? e.name : null;"
  );
  return url === null ? undefined : decodeURIComponent(decodeURIComponent(url)).split('pubcid:')[1];
}

/** Loads the page (with a consent scenario from site/public/tcf.js: ?consent=denied, say) and waits for the sync. */
async function visit(path = '/'): Promise<void> {
  await driver.get(new URL(path, BASE).href);
  assert.equal(await poll(syncs, n => n > 0, 15_000), 1, 'the page called /_sid/sync');
}

function pubcidInPrebid(): Promise<string | null> {
  return driver.executeScript<string | null>('return window.pbjs.getUserIds().pubcid || null;');
}

function gdprApplies(): Promise<boolean | null> {
  return driver.executeScript<boolean | null>(
    'const gdpr = window.pbjs && window.pbjs.getConsentMetadata && window.pbjs.getConsentMetadata().gdpr; return gdpr ? gdpr.gdprApplies : null;'
  );
}

function expirySeconds(c: Cookie | undefined): number {
  const expiry = c?.expiry;
  return expiry instanceof Date ? expiry.getTime() / 1000 : expiry ?? 0;
}

/** The domain a cookie Prebid.js and the endpoint share is on, as WebDriver reports it (with or without a leading dot). */
function domainOf(c: Cookie | undefined): string | undefined {
  return c?.domain?.replace(/^\./, '');
}

const expectedDomain = COOKIE_DOMAIN ?? new URL(BASE).hostname;

/**
 * Simulates Safari capping or clearing the script-readable _pubcid, while the HttpOnly copy survives: expires it from
 * script, on the cookie domain and host-only.
 */
async function clearScriptCookie(): Promise<void> {
  await driver.executeScript(
    `document.cookie = '_pubcid=; path=/; max-age=0; domain=${expectedDomain}'; document.cookie = '_pubcid=; path=/; max-age=0';`
  );
  assert.equal(await cookie('_pubcid'), undefined);
}

before(async () => {
  if (live === undefined) server = await startServer();
});

after(() => {
  server?.kill();
});

// A new Safari session per test. deleteAllCookies() isn't enough for a clean slate: in Safari it left the HttpOnly
// _pubcid_sv from one visit to the next, so the endpoint restored an earlier test's id.
beforeEach(async () => {
  driver = await new Builder().forBrowser('safari').build();
  const caps = await driver.getCapabilities();
  console.log(`Safari ${String(caps.get('browserVersion'))} on ${String(caps.get('platformName'))}, against ${BASE}`);
  await driver.get(new URL('/tcf.js', BASE).href);
  await driver.manage().deleteAllCookies();
  assert.deepEqual((await cookies()).map(c => c.name), []);
});

afterEach(async () => {
  await driver.quit();
});

test('a first visit gets a long-lived server-set _pubcid and its HttpOnly copy, one of each, on the cookie domain', async () => {
  await visit();
  const minted = await mintedId();
  assert.match(minted ?? '', UUID);
  // The id Prebid.js minted, not an earlier one the endpoint restored: the browser started with no ID cookies.
  const id = await poll(() => cookie('_pubcid'), c => c !== undefined);
  assert.equal(id?.value, minted);
  assert.equal(id?.httpOnly, false);
  assert.ok(expirySeconds(id) - Date.now() / 1000 > 360 * DAY, '_pubcid lasts about a year');
  // Only the server can set the HttpOnly copy, so this shows the endpoint set the cookies.
  const recovery = await poll(() => cookie('_pubcid_sv'), c => c !== undefined);
  assert.equal(recovery?.value, id?.value);
  assert.equal(recovery?.httpOnly, true);
  assert.equal(await poll(pubcidInPrebid, v => v === id?.value), id?.value);

  // A second page view keeps the same id, and there's still one _pubcid, on the domain the endpoint uses.
  await visit();
  await sleep(500);
  const all = await cookies();
  const ids = all.filter(c => c.name === '_pubcid');
  assert.equal(ids.length, 1, 'one _pubcid: SID_COOKIE_DOMAIN matches where Prebid.js writes it');
  assert.equal(ids[0]?.value, id?.value);
  assert.equal(domainOf(ids[0]), expectedDomain);
  assert.equal(domainOf(all.find(c => c.name === '_pubcid_sv')), expectedDomain);
  assert.equal(await pubcidInPrebid(), id?.value);
  // Prebid.js has GDPR scope from the page's static consent data, and SharedID Edge read the TC string from euconsent-v2.
  assert.equal(await poll(gdprApplies, v => v !== null), true);
  assert.match((await cookie('euconsent-v2'))?.value ?? '', /^CQ/);
});

test('a capped or cleared script cookie is restored from the server-only copy', async () => {
  await visit();
  const first = (await poll(() => cookie('_pubcid'), c => c !== undefined))?.value;
  assert.match(first ?? '', UUID);
  assert.equal((await poll(() => cookie('_pubcid_sv'), c => c !== undefined))?.value, first);

  await clearScriptCookie();

  // Prebid.js mints a new id and sends it to pixelUrl; the endpoint restores the original from the recovery copy, and
  // the browser keeps it.
  await visit();
  const minted = await mintedId();
  assert.match(minted ?? '', UUID);
  assert.notEqual(minted, first);
  assert.equal((await poll(() => cookie('_pubcid'), c => c?.value === first))?.value, first);
  await sleep(500);
  assert.equal((await cookie('_pubcid'))?.value, first);
  // Prebid.js reads the restored id on the next page view, which is what this checks, as the Playwright test does.
  // sharedIdSystem reads document.cookie in the pixel's load handler, and WebKit doesn't always show the pixel
  // response's Set-Cookie there yet (Playwright's WebKit on Linux, almost always; on Windows, rarely); then Prebid.js
  // keeps its own new id in memory for this page view. Real Safari hasn't shown it (none in 30 runs), but nothing
  // guarantees the ordering, so this page view isn't asserted.
  await visit();
  assert.equal(await poll(pubcidInPrebid, v => v === first), first);
  assert.equal((await cookie('_pubcid'))?.value, first);
});

test('without purpose 1 consent, neither Prebid.js nor the endpoint stores an id, and existing ones are deleted', async () => {
  // An earlier visit with consent leaves the ID cookies.
  await visit();
  await poll(() => cookie('_pubcid_sv'), c => c !== undefined);
  await clearScriptCookie();

  // The visitor withdraws purpose 1 consent: the denied scenario's TC string.
  await driver.get(new URL('/?consent=denied', BASE).href);
  assert.equal(await poll(gdprApplies, v => v !== null), true);
  await sleep(1_500);
  // tcfControl stops sharedIdSystem: it writes no id and doesn't call pixelUrl.
  assert.equal(await cookie('_pubcid'), undefined);
  assert.equal(await syncs(), 0);

  // The endpoint reads the same TC string from euconsent-v2: it sets no id and deletes the recovery copy left from before.
  assert.notEqual(await cookie('_pubcid_sv'), undefined);
  const status = await driver.executeAsyncScript<string>(
    "const done = arguments[arguments.length - 1]; fetch('/_sid/sync', { credentials: 'include' }).then(r => done(r.status + ' ' + r.headers.get('x-sharedid-status')), e => done(String(e)));"
  );
  assert.equal(status, '200 denied: tcf: no publisher consent for purpose 1');
  assert.equal(await cookie('_pubcid'), undefined);
  assert.equal(await cookie('_pubcid_sv'), undefined);
});

test('where GDPR doesn\'t apply (static consent data, no TC string), everything works', async () => {
  await visit('/?consent=notApplicable');
  assert.equal(await poll(gdprApplies, v => v !== null), false);
  assert.equal(await cookie('euconsent-v2'), undefined);
  const id = (await poll(() => cookie('_pubcid'), c => c !== undefined))?.value;
  assert.match(id ?? '', UUID);
  assert.equal((await poll(() => cookie('_pubcid_sv'), c => c !== undefined))?.value, id);
  assert.equal(await poll(pubcidInPrebid, v => v === id), id);
});
