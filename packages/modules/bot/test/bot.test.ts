import { createHandler, resolveConfig, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { botModule, botSettings, missingBrowserHeaders, sendsFetchMetadata } from '../src/index.js';

const MINTED = '11111111-2222-4333-8444-555555555555';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const OLD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1';
const BROWSER_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
const TOKEN = 'staff-token-0123456789';

describe('botSettings', () => {
  it('defaults to nothing on', () => {
    expect(botSettings({})).toEqual({ missingHeaders: false, internalCookie: undefined });
  });
  it('reads both settings', () => {
    expect(botSettings({ missingHeaders: true, internalCookie: 'its_me' })).toEqual({ missingHeaders: true, internalCookie: 'its_me' });
  });
  it.each([
    [{ missingheaders: true }],
    [{ missingHeaders: 'yes' }],
    [{ internalCookie: 'bad name' }],
    [{ internalCookie: '' }],
    [{ internalCookie: 1 }]
  ])('rejects %j', config => {
    expect(() => botSettings(config)).toThrow(TypeError);
  });
});

describe('sendsFetchMetadata', () => {
  it.each([
    [CHROME, true],
    [FIREFOX, true],
    [SAFARI, true],
    [IOS_SAFARI, true],
    [OLD_SAFARI, false],
    [IOS_CHROME, false],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36', false],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:78.0) Gecko/20100101 Firefox/78.0', false],
    ['curl/8.5.0', false]
  ])('%s: %s', (userAgent, expected) => {
    expect(sendsFetchMetadata(userAgent)).toBe(expected);
  });
});

describe('missingBrowserHeaders', () => {
  const https = new URL('https://www.example.com/_sid/v1');
  const check = (headers: Record<string, string>, url: URL = https): boolean => missingBrowserHeaders(new Headers(headers), url);

  it('passes a browser with its usual headers', () => {
    expect(check({ 'User-Agent': CHROME, ...BROWSER_HEADERS })).toBe(false);
  });
  it('flags a browser without Accept-Language, or with an empty one', () => {
    expect(check({ 'User-Agent': CHROME, 'Sec-Fetch-Mode': 'cors' })).toBe(true);
    expect(check({ 'User-Agent': OLD_SAFARI, 'Accept-Language': ' ' })).toBe(true);
  });
  it('flags a fetch-metadata browser without any Sec-Fetch header, over https', () => {
    expect(check({ 'User-Agent': CHROME, 'Accept-Language': 'en' })).toBe(true);
    expect(check({ 'User-Agent': SAFARI, 'Accept-Language': 'en' })).toBe(true);
    expect(check({ 'User-Agent': FIREFOX, 'Accept-Language': 'en', 'Sec-Fetch-Site': 'same-origin' })).toBe(false);
  });
  it("doesn't expect Sec-Fetch headers from older browsers, or over plain http", () => {
    expect(check({ 'User-Agent': OLD_SAFARI, 'Accept-Language': 'en' })).toBe(false);
    expect(check({ 'User-Agent': IOS_CHROME, 'Accept-Language': 'en' })).toBe(false);
    expect(check({ 'User-Agent': CHROME, 'Accept-Language': 'en' }, new URL('http://www.example.com/_sid/v1'))).toBe(false);
    expect(check({ 'User-Agent': CHROME, 'Accept-Language': 'en' }, new URL('http://localhost:8787/_sid/v1'))).toBe(true);
  });
  it("doesn't judge clients that don't claim to be a browser", () => {
    expect(check({})).toBe(false);
    expect(check({ 'User-Agent': 'curl/8.5.0' })).toBe(false);
    expect(check({ 'User-Agent': 'Mozilla/5.0' })).toBe(false);
  });
});

function handler(moduleConfig: Record<string, unknown>, env: Record<string, string> = {}): ReturnType<typeof createHandler> {
  return createHandler({
    config: resolveConfig({ SID_MODULES: 'bot', SID_MODULE_CONFIG: JSON.stringify({ bot: moduleConfig }), ...env }),
    modules: [botModule],
    mintId: () => MINTED
  });
}

async function v1(h: ReturnType<typeof createHandler>, headers: Record<string, string>, query = '', platform: PlatformInfo = {}): Promise<{ response: Response; body: PayloadV1 }> {
  const response = await h(new Request(`https://www.example.com/_sid/v1${query}`, { headers }), platform);
  return { response, body: await response.json() as PayloadV1 };
}

const ALL = { missingHeaders: true, internalCookie: 'its_me' };

describe('the bot module', () => {
  it('reports nothing for a normal visitor', async () => {
    const { body } = await v1(handler(ALL), { 'User-Agent': CHROME, ...BROWSER_HEADERS });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['bot']?.status).toBe('empty');
    expect(body.sharedid).toBe(MINTED);
  });

  it('reports a likely bot', async () => {
    const { body } = await v1(handler(ALL), { 'User-Agent': CHROME });
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { bot: true, botKind: 'likely', sources: ['bot'] } } } });
    expect(body.ext.modules['bot']?.status).toBe('ok');
  });

  it('reports nothing for missing headers unless missingHeaders is on', async () => {
    const { body } = await v1(handler({ internalCookie: 'its_me' }), { 'User-Agent': CHROME });
    expect(body.ortb2).toBeUndefined();
  });

  it('marks internal traffic with the configured cookie', async () => {
    const { body } = await v1(handler(ALL), { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: 'its_me=1' });
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { internal: true, sources: ['bot'] } } } });
  });

  it('ignores an empty internal cookie', async () => {
    const { body } = await v1(handler(ALL), { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: 'its_me=' });
    expect(body.ortb2).toBeUndefined();
  });

  it('with an internalToken secret, accepts only that value', async () => {
    const env = { SID_MODULE_SECRETS: JSON.stringify({ bot: { internalToken: TOKEN } }) };
    const h = handler(ALL, env);
    expect((await v1(h, { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: 'its_me=1' })).body.ortb2).toBeUndefined();
    expect((await v1(h, { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: `its_me=${TOKEN}x` })).body.ortb2).toBeUndefined();
    const { body } = await v1(h, { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: `its_me=${TOKEN}` });
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { internal: true, sources: ['bot'] } } } });
  });

  it('is an error with a bad setting or secret, without echoing the secret', async () => {
    expect((await v1(handler({ missingHeader: true }), {})).body.ext.modules['bot']?.status).toBe('error');
    const short = handler(ALL, { SID_MODULE_SECRETS: JSON.stringify({ bot: { internalToken: 'short' } }) });
    const { response, body } = await v1(short, {});
    expect(body.ext.modules['bot']?.status).toBe('error');
    expect(JSON.stringify(body) + JSON.stringify([...response.headers])).not.toContain('short');
  });

  it('merges with the platform verdict: the strongest bot kind and both sources', async () => {
    const { body } = await v1(handler(ALL), { 'User-Agent': CHROME, Cookie: 'its_me=1' }, '', { traffic: { bot: true, botKind: 'verified', score: 1 } });
    expect(body.ortb2).toEqual({
      device: { ext: { traffic: { bot: true, botKind: 'verified', score: 1, internal: true, sources: ['platform', 'bot'] } } }
    });
  });

  it.each([
    ['Global Privacy Control', { 'Sec-GPC': '1' }, ''],
    ['COPPA', {}, '?coppa=1'],
    ['GDPR without a TC string', {}, '?gdpr=1'],
    ['opt-out', { Cookie: '_pubcid_optout=1' }, '']
  ])('still reports the signal with %s', async (_name, headers: Record<string, string>, query) => {
    const { response, body } = await v1(handler(ALL), { 'User-Agent': CHROME, ...headers }, query);
    expect(response.headers.get('X-SharedID-Status')).toMatch(/^denied: /);
    expect(body.sharedid).toBeUndefined();
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { bot: true, botKind: 'likely', sources: ['bot'] } } } });
  });

  it('with SID_SKIP_BOTS=likely, a likely bot gets no SharedID, and keeps an existing one', async () => {
    const h = handler(ALL, { SID_SKIP_BOTS: 'likely' });
    const { response, body } = await v1(h, { 'User-Agent': CHROME, Cookie: '_pubcid=c29cb2ae-769d-42f6-891a-f53cadee823d' });
    expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(body.sharedid).toBeUndefined();
    const human = await v1(h, { 'User-Agent': CHROME, ...BROWSER_HEADERS, Cookie: 'its_me=1' });
    expect(human.body.sharedid).toBe(MINTED);
  });
});
