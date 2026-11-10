import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { platformInfo } from '../src/platform.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';

function fetchWorker(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://www.example.com${path}`, { headers }));
}

describe('Cloudflare worker', () => {
  describe.each([
    ['IPv4', '203.0.113.7'],
    ['IPv6', '2001:db8::7']
  ])('%s client', (_label, ip) => {
    it('adopts the id Prebid.js sends and sets the server cookies', async () => {
      const response = await fetchWorker(`/_sid/sync?id=pubcid%253A${UUID}`, { 'CF-Connecting-IP': ip });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/gif');
      const cookies = response.headers.getSetCookie();
      expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID}; Max-Age=31536000; Expires=.+; Path=/; SameSite=Lax; Secure$`));
      expect(cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*; Secure; HttpOnly$`));
    });

    it('keeps an existing id', async () => {
      const response = await fetchWorker('/_sid/sync?id=pubcid:other-id', { 'CF-Connecting-IP': ip, Cookie: `_pubcid=${UUID}` });
      expect(response.headers.getSetCookie()[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
    });
  });

  it('returns the JSON payload', async () => {
    const response = await fetchWorker('/_sid/v1', { Cookie: `_pubcid=${UUID}` });
    expect(await response.json()).toEqual({ v: 1, sharedid: UUID, eids: [{ source: 'pubcid.org', uids: [{ id: UUID, atype: 1 }] }], ext: { modules: {} } });
  });

  it('never answers other paths, so nothing is forwarded to the origin', async () => {
    expect((await fetchWorker('/index.html')).status).toBe(404);
  });
});

describe('platformInfo', () => {
  it('reads the connecting IP and request.cf location', () => {
    expect(platformInfo({
      headers: new Headers({ 'CF-Connecting-IP': '2001:db8::1' }),
      cf: { country: 'DE', regionCode: 'BE', isEUCountry: '1' }
    })).toEqual({ clientIp: '2001:db8::1', country: 'DE', region: 'BE', isEU: true });
  });
  it('treats a missing isEUCountry as outside the EU, and missing cf as unknown', () => {
    expect(platformInfo({ headers: new Headers(), cf: { country: 'US' } })).toEqual({ country: 'US', isEU: false });
    expect(platformInfo({ headers: new Headers() })).toEqual({});
  });
});
