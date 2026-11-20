import { createHandler, resolveConfig, type ForwardFetch, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { locationHeaders, scriptCacheControl, tagGatewayModule, tagGatewaySettings } from '../src/index.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const HIT = '/metrics/g/collect?v=2&tid=G-12345&en=page_view';
const PLATFORM: PlatformInfo = { clientIp: '192.0.2.77', country: 'US', region: 'CA', city: 'Mountain View', latitude: 37.4, longitude: -122.1 };
// Publisher TC segment with consent to purposes 1 and 7, with and without opt-in to Special Feature 1; and to 1 only.
const TC_PRECISE = 'CAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAA.cEAAAAAAAA';
const TC_MEASURE = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.cEAAAAAAAA';
const TC_STORAGE_ONLY = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.cAAAAAAAAA';

/** A stand-in for Google's gateway: records what it gets; scripts are public for 15 minutes, hits echo nothing. CI never calls Google. */
function gateway(): { readonly sent: Request[]; readonly send: ForwardFetch } {
  const sent: Request[] = [];
  return {
    sent,
    send: request => {
      sent.push(request);
      const path = new URL(request.url).pathname;
      return Promise.resolve(path.endsWith('/') || path.endsWith('.js')
        ? new Response('/* tag */', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=900, s-maxage=900' } })
        : new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=60' } }));
    }
  };
}

function setup(settings: Record<string, unknown> = { tags: [{ id: 'G-12345', path: '/metrics' }] }): { readonly sent: Request[]; readonly serve: (path: string, headers?: Record<string, string>, init?: RequestInit, platform?: PlatformInfo) => Promise<Response> } {
  const { sent, send } = gateway();
  const handler = createHandler({
    config: resolveConfig({ SID_MODULES: 'tag-gateway', SID_MODULE_CONFIG: JSON.stringify({ 'tag-gateway': settings }) }),
    modules: [tagGatewayModule],
    forwardFetch: send
  });
  return { sent, serve: (path, headers = {}, init = {}, platform = PLATFORM) => handler(new Request(`https://www.example.com${path}`, { headers, ...init }), platform) };
}

describe('settings', () => {
  it('parses tags and the GPC policy', () => {
    expect(tagGatewaySettings({ tags: [{ id: 'GTM-ABCDEF', path: '/metrics' }, { id: 'G-1', path: '/m2' }], gpc: 'forward-anonymous' })).toEqual({
      tags: [{ id: 'GTM-ABCDEF', path: '/metrics' }, { id: 'G-1', path: '/m2' }],
      gpc: 'forward-anonymous'
    });
    expect(tagGatewaySettings({ tags: [{ id: 'AW-123456789', path: '/a/b' }] }).gpc).toBe('block');
  });

  it('throws on anything else', () => {
    const bad: Record<string, unknown>[] = [
      {},
      { tags: [] },
      { tags: [{ id: 'G-1', path: '/m' }], extra: 1 },
      { tags: [{ id: 'G-1', path: '/m' }], gpc: 'allow' },
      { tags: [{ id: 'not a tag', path: '/m' }] },
      { tags: [{ id: 'G-1.evil.example', path: '/m' }] },
      { tags: [{ id: 'G-1', path: 'm' }] },
      { tags: [{ id: 'G-1', path: '/m/' }] },
      { tags: [{ id: 'G-1', path: '/' }] },
      { tags: [{ id: 'G-1', path: '/m', host: 'x' }] },
      { tags: [{ id: 'G-1', path: '/m' }, { id: 'G-2', path: '/m/x' }] },
      { tags: Array.from({ length: 11 }, (_, i) => ({ id: `G-${String(i)}`, path: `/m${String(i)}` })) }
    ];
    for (const settings of bad) expect(() => tagGatewaySettings(settings), JSON.stringify(settings)).toThrow(TypeError);
  });
});

describe('forwarding', () => {
  it("sends a hit to the tag's gateway host with the path and query, Google's cookies, allowed headers, and the platform's IP and location", async () => {
    const { sent, serve } = setup();
    const response = await serve(HIT, {
      Cookie: `_ga=GA1.1.1.2; _pubcid=${UUID}; _pubcid_sv=${UUID}; _gcl_au=1.1.3.4; FPID=x; other=1`,
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://www.example.com/page',
      'Sec-CH-UA-Platform': '"macOS"',
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Host': 'elsewhere.example',
      'CF-Connecting-IP': '203.0.113.9',
      'CF-IPCountry': 'FR',
      'X-Real-IP': '203.0.113.9',
      Forwarded: 'for=203.0.113.9'
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-SharedID-Forwarding')).toBe('forwarded');
    expect(response.headers.getSetCookie()).toEqual([]);
    const request = sent[0];
    expect(request?.url).toBe(`https://g-12345.fps.goog${HIT}`);
    const headers = Object.fromEntries([...(request?.headers ?? new Headers())]);
    expect(headers).toEqual({
      cookie: '_ga=GA1.1.1.2; _gcl_au=1.1.3.4; FPID=x',
      'user-agent': 'Mozilla/5.0',
      referer: 'https://www.example.com/page',
      'sec-ch-ua-platform': '"macOS"',
      'x-forwarded-for': '192.0.2.77',
      'x-forwarded-country': 'US',
      'x-forwarded-countryregion': 'US-CA',
      'x-forwarded-geolocation': 'latlong=37.4,-122.1;city=Mountain View'
    });
  });

  it('sends an IPv6 address in full', async () => {
    const { sent, serve } = setup();
    await serve(HIT, {}, {}, { clientIp: '2001:db8::77' });
    expect(sent[0]?.headers.get('X-Forwarded-For')).toBe('2001:db8::77');
  });

  it('forwards a POST with its body', async () => {
    const { sent, serve } = setup();
    const response = await serve(HIT, { 'Content-Type': 'text/plain', 'Content-Length': '9' }, { method: 'POST', body: 'en=scroll' });
    expect(response.status).toBe(204);
    expect(sent[0]?.method).toBe('POST');
    expect(await sent[0]?.text()).toBe('en=scroll');
  });

  it('keeps the tag script in the browser cache only, and never caches hits', async () => {
    const { serve } = setup();
    for (const path of ['/metrics/?id=GTM-ABCDEF', '/metrics/gtm.js?id=GTM-ABCDEF']) {
      const response = await serve(path, { 'Sec-Fetch-Dest': 'script' });
      expect(response.headers.get('Cache-Control'), path).toBe('private, max-age=900');
      expect(await response.text()).toBe('/* tag */');
    }
    expect((await serve(HIT)).headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends a request under each tag to its own gateway', async () => {
    const { sent, serve } = setup({ tags: [{ id: 'G-12345', path: '/metrics' }, { id: 'GTM-ABCDEF', path: '/gtm' }] });
    await serve('/gtm/?id=GTM-ABCDEF');
    await serve(HIT);
    expect(sent.map(request => new URL(request.url).host)).toEqual(['gtm-abcdef.fps.goog', 'g-12345.fps.goog']);
  });

  it('keeps a crafted path on the gateway host', async () => {
    const { sent, serve } = setup();
    await serve('/metrics//elsewhere.example/x');
    await serve('/metrics/@elsewhere.example/x');
    for (const request of sent) expect(new URL(request.url).host).toBe('g-12345.fps.goog');
  });
});

describe('privacy', () => {
  it('sends nothing with the opt-out cookie, COPPA, GPC or GDPR without a TC string: 204 for a hit, an empty script for the tag', async () => {
    const cases: [string, Record<string, string>, string][] = [
      ['', { Cookie: '_pubcid_optout=1' }, 'opt-out'],
      ['&coppa=1', {}, 'coppa'],
      ['', { 'Sec-GPC': '1' }, 'gpc'],
      ['&gdpr=1', {}, 'tcf: GDPR applies and there is no TC string'],
      [`&gdpr=1&gdpr_consent=${TC_STORAGE_ONLY}`, {}, 'tcf: no publisher consent for purpose 7']
    ];
    for (const [query, headers, reason] of cases) {
      const { sent, serve } = setup();
      const hit = await serve(`${HIT}${query}`, headers);
      expect(hit.status, reason).toBe(204);
      expect(hit.headers.get('X-SharedID-Forwarding')).toBe(`blocked: ${reason}`);
      expect(hit.headers.get('Cache-Control')).toBe('no-store');
      const script = await serve(`/metrics/?id=G-12345${query}`, { ...headers, 'Sec-Fetch-Dest': 'script' });
      expect(script.status).toBe(200);
      expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
      expect(await script.text()).toBe('');
      expect(sent).toHaveLength(0);
    }
  });

  it('blocks an EU visitor without a TC string, and forwards with consent to purposes 1 and 7', async () => {
    const { sent, serve } = setup();
    expect((await serve(HIT, {}, {}, { ...PLATFORM, country: 'DE', region: 'BE' })).status).toBe(204);
    await serve(HIT, { Cookie: `euconsent-v2=${TC_PRECISE}` }, {}, { ...PLATFORM, country: 'DE', region: 'BE' });
    expect(sent[0]?.headers.get('X-Forwarded-For')).toBe('192.0.2.77');
    expect(sent[0]?.headers.get('X-Forwarded-CountryRegion')).toBe('DE-BE');
  });

  it('leaves out the client IP and precise location without opt-in to precise geolocation, or with a US privacy opt-out', async () => {
    for (const path of [`${HIT}&gdpr=1&gdpr_consent=${TC_MEASURE}`, `${HIT}&us_privacy=1YYN`]) {
      const { sent, serve } = setup();
      await serve(path);
      const headers = sent[0]?.headers;
      expect(headers?.get('X-Forwarded-For'), path).toBeNull();
      expect(headers?.get('X-Forwarded-Geolocation')).toBeNull();
      expect(headers?.get('X-Forwarded-CountryRegion')).toBe('US-CA');
    }
  });

  it('with "gpc": "forward-anonymous", forwards with GPC without any client IP or location', async () => {
    const { sent, serve } = setup({ tags: [{ id: 'G-12345', path: '/metrics' }], gpc: 'forward-anonymous' });
    const response = await serve(HIT, { 'Sec-GPC': '1', Cookie: '_ga=GA1.1.1.2' });
    expect(response.headers.get('X-SharedID-Forwarding')).toBe('anonymous');
    const headers = Object.fromEntries([...(sent[0]?.headers ?? new Headers())]);
    expect(headers).toEqual({ cookie: '_ga=GA1.1.1.2', 'sec-gpc': '1' });
    expect((await serve(`${HIT}&coppa=1`, { 'Sec-GPC': '1' })).status).toBe(204);
    expect(sent).toHaveLength(1);
  });

  it('reports on /v1 whether the visitor is forwarded, and reports error for invalid settings', async () => {
    const { serve } = setup();
    const report = async (headers: Record<string, string>): Promise<unknown> => ((await (await serve('/_sid/v1', headers)).json()) as PayloadV1).ext.modules['tag-gateway'];
    expect(await report({})).toMatchObject({ status: 'empty', forwards: true });
    expect(await report({ 'Sec-GPC': '1' })).toMatchObject({ status: 'empty', forwards: false });
    const broken = setup({ tags: 'G-1' });
    expect((await broken.serve(HIT)).status).toBe(404);
    expect((((await (await broken.serve('/_sid/v1')).json()) as PayloadV1).ext.modules['tag-gateway'])?.status).toBe('error');
  });
});

describe('locationHeaders', () => {
  it('sends the country and region always, and the IP and precise location only when allowed', () => {
    expect(locationHeaders(PLATFORM, false)).toEqual({ 'X-Forwarded-Country': 'US', 'X-Forwarded-CountryRegion': 'US-CA' });
    expect(locationHeaders({ ...PLATFORM, region: 'US-TX' }, false)['X-Forwarded-CountryRegion']).toBe('US-TX');
    expect(locationHeaders({ clientIp: '192.0.2.1' }, true)).toEqual({ 'X-Forwarded-For': '192.0.2.1' });
    expect(locationHeaders({ city: 'Zürich' }, true)).toEqual({});
    expect(locationHeaders({ city: 'A;B' }, true)).toEqual({});
    expect(locationHeaders({ latitude: 1, longitude: 2 }, true)).toEqual({ 'X-Forwarded-Geolocation': 'latlong=1,2' });
  });
});

describe('scriptCacheControl', () => {
  it('keeps the script private', () => {
    expect(scriptCacheControl('public, max-age=900, s-maxage=900')).toBe('private, max-age=900');
    expect(scriptCacheControl('max-age=900')).toBe('private, max-age=900');
    expect(scriptCacheControl('private, max-age=60')).toBe('private, max-age=60');
    expect(scriptCacheControl('no-store')).toBe('no-store');
    expect(scriptCacheControl(null)).toBe('no-store');
  });
});
