import { createHandler, resolveConfig, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { botModule, claimedBrowser, ja4Contradicts, ja4Stack } from '../src/index.js';

const MINTED = '11111111-2222-4333-8444-555555555555';
const EXISTING = 'c29cb2ae-769d-42f6-891a-f53cadee823d';

// Fingerprints from FoxIO's public JA4+ mapping (ja4plus-mapping.csv), and one made up that's in no table.
const JA4 = {
  chrome: 't13d1516h2_8daaf6152771_02713d6af862',
  chromeNoSni: 't13i1516h2_8daaf6152771_b0da82dd1658',
  chromeQuic: 'q13d0312h3_55b375c5d22e_06cda9e17597',
  firefox: 't13d1715h2_5b57614c22b0_7121afd63204',
  safari: 't13d2014h2_a09f3c656075_14788d8d241b',
  python: 't13d181000_85036bcba153_d41ae481755e',
  pythonH1: 't13d4312h1_c7886603b240_b26ce05bbdd6',
  go: 't13d190900_9dc949149365_97f8aa674fd9',
  goH2: 't13d1412h2_e33ad33b3d25_6b314db333b6',
  unknown: 't13d1516h2_0123456789ab_02713d6af862'
};

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0';
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1';
const IOS_FIREFOX = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15';
const IOS_IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]';
// An iPad browser asking for the desktop site sends a Mac user agent, over Apple's TLS stack.
const IPAD_DESKTOP_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/605.1.15';
const OLD_ANDROID = 'Mozilla/5.0 (Linux; U; Android 4.4.2; en-us) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('ja4Stack', () => {
  it.each([
    [JA4.chrome, 'chromium'],
    [JA4.chromeNoSni, 'chromium'],
    [JA4.firefox, 'firefox'],
    [JA4.safari, 'safari'],
    [JA4.python, 'python'],
    [JA4.pythonH1, 'python'],
    [JA4.go, 'go'],
    [JA4.goH2, 'go'],
    [JA4.unknown, undefined],
    [JA4.chromeQuic, undefined],
    ['q13d0312h3_8daaf6152771_06cda9e17597', undefined]
  ])('%s: %s', (ja4, expected) => {
    expect(ja4Stack(ja4)).toBe(expected);
  });
});

describe('claimedBrowser', () => {
  it.each([
    [CHROME, 'chromium'],
    [EDGE, 'chromium'],
    [ANDROID_WEBVIEW, 'chromium'],
    [FIREFOX, 'firefox'],
    [LINUX_FIREFOX, 'firefox'],
    [ANDROID_FIREFOX, 'firefox'],
    [SAFARI, 'safari'],
    [IOS_SAFARI, undefined],
    [IOS_CHROME, undefined],
    [IOS_FIREFOX, undefined],
    [IOS_IN_APP, undefined],
    [OLD_ANDROID, undefined],
    [GOOGLEBOT, undefined],
    ['curl/8.5.0', undefined],
    ['python-requests/2.32.3', undefined],
    ['', undefined]
  ])('%s: %s', (userAgent, expected) => {
    expect(claimedBrowser(userAgent)).toBe(expected);
  });
});

describe('ja4Contradicts', () => {
  it.each([
    [CHROME, JA4.python],
    [CHROME, JA4.pythonH1],
    [CHROME, JA4.go],
    [CHROME, JA4.firefox],
    [CHROME, JA4.safari],
    [EDGE, JA4.goH2],
    [ANDROID_WEBVIEW, JA4.firefox],
    [FIREFOX, JA4.chrome],
    [LINUX_FIREFOX, JA4.safari],
    [FIREFOX, JA4.python],
    [SAFARI, JA4.chrome],
    [SAFARI, JA4.go]
  ])('%s over %s: a contradiction', (userAgent, ja4) => {
    expect(ja4Contradicts(userAgent, ja4)).toBe(true);
  });
  it.each([
    ['Chrome over Chromium', CHROME, JA4.chrome],
    ['Chrome without SNI', CHROME, JA4.chromeNoSni],
    ['Edge over Chromium', EDGE, JA4.chrome],
    ['Android WebView over Chromium', ANDROID_WEBVIEW, JA4.chrome],
    ['Firefox', FIREFOX, JA4.firefox],
    ['Firefox on Android', ANDROID_FIREFOX, JA4.firefox],
    ['Safari', SAFARI, JA4.safari],
    ['Safari on iOS', IOS_SAFARI, JA4.safari],
    ['Chrome on iOS, over Apple\'s stack', IOS_CHROME, JA4.safari],
    ['Firefox on iOS, over Apple\'s stack', IOS_FIREFOX, JA4.safari],
    ['an in-app browser on iOS', IOS_IN_APP, JA4.safari],
    ['an iOS user agent over any stack', IOS_CHROME, JA4.python],
    ['an iPad asking for the desktop site', IPAD_DESKTOP_CHROME, JA4.safari],
    ['a Mac Firefox user agent over Apple\'s stack (an iPad asking for the desktop site)', FIREFOX, JA4.safari],
    ['HTTP/3, whose cipher hash every browser shares', FIREFOX, JA4.chromeQuic],
    ['an unknown fingerprint', CHROME, JA4.unknown],
    ['a client that claims no browser', 'python-requests/2.32.3', JA4.python],
    ['a declared crawler', GOOGLEBOT, JA4.go]
  ])('no decision: %s', (_name, userAgent, ja4) => {
    expect(ja4Contradicts(userAgent, ja4)).toBe(false);
  });
});

function handler(moduleConfig: Record<string, unknown>, env: Record<string, string> = {}): ReturnType<typeof createHandler> {
  return createHandler({
    config: resolveConfig({ SID_MODULES: 'bot', SID_MODULE_CONFIG: JSON.stringify({ bot: moduleConfig }), ...env }),
    modules: [botModule],
    mintId: () => MINTED
  });
}

const HEADERS = { 'User-Agent': CHROME, 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
const ON = { ja4Mismatch: true };
const LIKELY = { device: { ext: { traffic: { bot: true, botKind: 'likely', sources: ['bot'] } } } };

async function v1(h: ReturnType<typeof createHandler>, headers: Record<string, string>, platform: PlatformInfo = {}): Promise<{ response: Response; body: PayloadV1 }> {
  const response = await h(new Request('https://www.example.com/_sid/v1', { headers }), platform);
  return { response, body: await response.json() as PayloadV1 };
}

describe('ja4Mismatch', () => {
  it('reports a likely bot when the platform\'s JA4 contradicts the user agent, without returning the fingerprint', async () => {
    const { response, body } = await v1(handler(ON), HEADERS, { ja4: JA4.python });
    expect(body.ortb2).toEqual(LIKELY);
    expect(body.ext.modules['bot']?.status).toBe('ok');
    expect(body.sharedid).toBe(MINTED);
    expect(JSON.stringify(body) + JSON.stringify([...response.headers])).not.toContain('85036bcba153');
  });

  it('reports nothing when they agree, without a JA4, or with the setting off', async () => {
    expect((await v1(handler(ON), HEADERS, { ja4: JA4.chrome })).body.ortb2).toBeUndefined();
    expect((await v1(handler(ON), HEADERS)).body.ortb2).toBeUndefined();
    expect((await v1(handler({}), HEADERS, { ja4: JA4.python })).body.ortb2).toBeUndefined();
    expect((await v1(handler({ missingHeaders: true }), HEADERS, { ja4: JA4.python })).body.ortb2).toBeUndefined();
  });

  it('never reads a JA4 from the request headers', async () => {
    const { body } = await v1(handler(ON), { ...HEADERS, 'CloudFront-Viewer-JA4-Fingerprint': JA4.python, 'X-JA4': JA4.python });
    expect(body.ortb2).toBeUndefined();
    expect(body.sharedid).toBe(MINTED);
  });

  it('with SID_SKIP_BOTS=likely, skips minting with skipped: bot, and an existing ID is neither set nor deleted', async () => {
    const h = handler(ON, { SID_SKIP_BOTS: 'likely' });
    const fresh = await v1(h, HEADERS, { ja4: JA4.go });
    expect(fresh.response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(fresh.response.headers.get('X-SharedID-Source')).toBeNull();
    expect(fresh.response.headers.getSetCookie()).toEqual([]);
    expect(fresh.body.sharedid).toBeUndefined();
    expect(fresh.body.eids).toEqual([]);
    const existing = await v1(h, { ...HEADERS, Cookie: `_pubcid=${EXISTING}` }, { ja4: JA4.go });
    expect(existing.response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(existing.response.headers.getSetCookie()).toEqual([]);
    const human = await v1(h, HEADERS, { ja4: JA4.chrome });
    expect(human.body.sharedid).toBe(MINTED);
    expect(human.response.headers.get('X-SharedID-Status')).toBeNull();
  });

  it('on /sync too', async () => {
    const h = handler(ON, { SID_SKIP_BOTS: 'likely' });
    const sync = await h(new Request('https://www.example.com/_sid/sync', { headers: HEADERS }), { ja4: JA4.firefox });
    expect(sync.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(sync.headers.get('X-SharedID-Modules')).toBe('bot=ok');
    expect(sync.headers.getSetCookie()).toEqual([]);
  });

  it('consent still decides first and deletes the ID, and the signal is still reported', async () => {
    const h = handler(ON, { SID_SKIP_BOTS: 'likely' });
    const { response, body } = await v1(h, { ...HEADERS, 'Sec-GPC': '1', Cookie: `_pubcid=${EXISTING}` }, { ja4: JA4.python });
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: gpc');
    expect(body.ortb2).toEqual(LIKELY);
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith('_pubcid=;'))).toBe(true);
  });
});
