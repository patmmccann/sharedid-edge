import { exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { utcOffsetMinutes } from '@sharedid-edge/module-geo';
import { builtInModules as modules } from '@sharedid-edge/modules';
import { botManagementJa4, botManagementTraffic, platformInfo } from '../src/platform.js';
import { createWorker } from '../src/worker.js';

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
  it('reads every location field of request.cf, with coordinates as numbers', () => {
    // As request.cf has it, with fields the adapter doesn't read.
    const cf: Readonly<Record<string, unknown>> = {
      country: 'US', continent: 'NA', region: 'Texas', regionCode: 'TX', city: 'Austin', postalCode: '78701',
      metroCode: '635', latitude: '30.27130', longitude: '-97.74260', timezone: 'America/Chicago', colo: 'DFW', asn: 395747
    };
    expect(platformInfo({ headers: new Headers({ 'CF-Connecting-IP': '203.0.113.7' }), cf })).toEqual({
      clientIp: '203.0.113.7', country: 'US', region: 'TX', city: 'Austin', postalCode: '78701', metroCode: '635',
      latitude: 30.2713, longitude: -97.7426, timezone: 'America/Chicago', continent: 'NA', isEU: false
    });
  });
  it('ignores Tor and unknown countries, empty values and invalid coordinates', () => {
    expect(platformInfo({ headers: new Headers(), cf: { country: 'T1', city: '', latitude: 'NaN', longitude: '1' } })).toEqual({ isEU: false });
    expect(platformInfo({ headers: new Headers(), cf: { country: 'XX', regionCode: '', postalCode: ' ', timezone: '' } })).toEqual({ isEU: false });
  });
});

describe('Bot Management', () => {
  // As request.cf has it on a zone with Bot Management (Enterprise), with fields the adapter doesn't read.
  const botManagement = { score: 1, verifiedBot: true, corporateProxy: false, staticResource: false, detectionIds: [], ja3Hash: 'x' };

  it('maps a verified bot, its score, and a corporate proxy to the platform traffic verdict', () => {
    expect(botManagementTraffic(botManagement)).toEqual({ bot: true, botKind: 'verified', score: 1 });
    expect(botManagementTraffic({ ...botManagement, score: 87, verifiedBot: false, corporateProxy: true })).toEqual({ proxy: 'relay', score: 87 });
    expect(platformInfo({ headers: new Headers(), cf: { country: 'US', botManagement } })).toEqual({
      country: 'US', isEU: false, traffic: { bot: true, botKind: 'verified', score: 1 }
    });
  });

  it('adds nothing when Bot Management is absent or says nothing', () => {
    expect(platformInfo({ headers: new Headers(), cf: { country: 'US' } })).toEqual({ country: 'US', isEU: false });
    // A zone without Bot Management's scoring: the flags are false and there is no score.
    expect(botManagementTraffic({ corporateProxy: false, verifiedBot: false, staticResource: false, detectionIds: {} })).toBeUndefined();
    expect(botManagementTraffic(undefined)).toBeUndefined();
    expect(botManagementTraffic('yes')).toBeUndefined();
  });

  it('ignores scores outside 1 to 99, including 0 (not computed)', () => {
    for (const score of [0, 100, 1.5, '5', Number.NaN]) {
      expect(botManagementTraffic({ score, verifiedBot: false, corporateProxy: false })).toBeUndefined();
    }
  });

  it('reads the JA4 fingerprint, only when it is one', () => {
    const ja4 = 't13d1516h2_8daaf6152771_02713d6af862';
    expect(botManagementJa4({ ...botManagement, ja4 })).toBe(ja4);
    expect(platformInfo({ headers: new Headers(), cf: { botManagement: { ...botManagement, ja4 } } })).toEqual({
      isEU: false, traffic: { bot: true, botKind: 'verified', score: 1 }, ja4
    });
    for (const value of [undefined, '', 'x', 42, '771,4865-4866,0-23,29-23,0']) {
      expect(botManagementJa4({ ...botManagement, ja4: value })).toBeUndefined();
    }
    expect(botManagementJa4(undefined)).toBeUndefined();
  });

  it("with the bot module's ja4Mismatch and SID_SKIP_BOTS=likely, skips minting for a Chrome user agent over Python's TLS", async () => {
    const fetchHandler = createWorker(modules).fetch;
    if (fetchHandler === undefined) throw new Error('no fetch handler');
    const env = { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'bot', SID_MODULE_CONFIG: '{"bot":{"ja4Mismatch":true}}', SID_SKIP_BOTS: 'likely' } as unknown as Env;
    const call = (request: Request): Promise<Response> => Promise.resolve(fetchHandler(request as Parameters<typeof fetchHandler>[0], env, {} as ExecutionContext));
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    const request = (ja4: string): Request => {
      // ja4 isn't in this version of the Workers types, so the object isn't a fresh literal in `cf`.
      const withJa4 = { ...botManagement, score: 50, verifiedBot: false, ja4 };
      return new Request('https://www.example.com/_sid/v1', { headers: { 'User-Agent': chrome, 'Accept-Language': 'en' }, cf: { botManagement: withJa4 } });
    };
    const bot = await call(request('t13d181000_85036bcba153_d41ae481755e'));
    expect(bot.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(bot.headers.getSetCookie()).toEqual([]);
    const human = await call(request('t13d1516h2_8daaf6152771_02713d6af862'));
    expect(human.headers.get('X-SharedID-Source')).toBe('minted');
  });

  it('returns the verdict as ortb2.device.ext.traffic from the Worker', async () => {
    const request = new Request('https://www.example.com/_sid/v1', { cf: { botManagement } });
    const body: unknown = await (await exports.default.fetch(request)).json();
    expect(body).toMatchObject({ ortb2: { device: { ext: { traffic: { bot: true, botKind: 'verified', score: 1, sources: ['platform'] } } } } });
  });
});

describe('geo module in workerd', () => {
  it('computes UTC offsets with the runtime time zone data', () => {
    expect(utcOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(-240);
    expect(utcOffsetMinutes('Asia/Kolkata', new Date('2026-07-15T12:00:00Z'))).toBe(330);
    expect(utcOffsetMinutes('Mars/Olympus_Mons', new Date())).toBeUndefined();
  });
  it('is built into the worker, and off until listed in SID_MODULES', async () => {
    expect(modules.map(m => m.name)).toContain('geo');
    expect(await (await fetchWorker('/_sid/v1')).json()).toMatchObject({ ext: { modules: {} } });
  });
});

describe('Cloudflare for SaaS custom hostname metadata', () => {
  const withMetadata = (hostMetadata: unknown, host = 'www.saas-customer.example'): Promise<Response> =>
    exports.default.fetch(new Request(`https://${host}/_sid/sync?id=pubcid%3A${UUID}`, { cf: { hostMetadata } }));

  it("applies a custom hostname's sharedid settings on top of the Worker's", async () => {
    const response = await withMetadata({ sharedid: { SID_COOKIE_DOMAIN: 'saas-customer.example', SID_COOKIE_NAME: 'msid' } });
    const cookie = response.headers.getSetCookie().find(c => c.startsWith('msid='));
    expect(cookie).toMatch(new RegExp(`^msid=${UUID};.*Domain=saas-customer\\.example;`));
  });

  it('uses the Worker settings without metadata, or with metadata for something else', async () => {
    for (const metadata of [undefined, { plan: 'gold' }]) {
      const response = await withMetadata(metadata);
      expect(response.headers.getSetCookie().find(c => c.startsWith('_pubcid='))).not.toMatch(/Domain=/);
    }
  });

  it("answers a host with invalid metadata with a 500, and sets nothing", async () => {
    const response = await withMetadata({ sharedid: { SID_COOKIE_DOMAIN: 'saas-customer.example', SID_MAX_AGE_DAYS: 'forever' } });
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('trusted upstream (an upstream operator behind publishers\' CDNs)', () => {
  const SECRET = 'f'.repeat(64);
  const worker = createWorker(modules);
  const env = {
    SID_COOKIE_DOMAIN: 'host-only',
    SID_MODULES: 'ip,geo',
    SID_UPSTREAM_SECRETS: JSON.stringify([SECRET]),
    SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
    SID_LOCATION_HEADERS: '{"country":"x-sid-country","regionCode":"x-sid-region"}',
    SID_HOSTS: JSON.stringify({ 'www.example.com': { SID_COOKIE_DOMAIN: 'example.com' } })
  } as unknown as Env;
  const call = (headers: Record<string, string>, path = '/_sid/v1'): Promise<Response> => {
    const fetchHandler = worker.fetch;
    if (fetchHandler === undefined) throw new Error('no fetch handler');
    // request.cf and CF-Connecting-IP describe the publisher's CDN here.
    const request = new Request(`https://sid.upstream.example${path}`, { headers: { 'CF-Connecting-IP': '198.51.100.1', ...headers }, cf: { country: 'DE', isEUCountry: '1' } });
    return Promise.resolve(fetchHandler(request as Parameters<typeof fetchHandler>[0], env, {} as ExecutionContext));
  };

  it('answers 403 without the secret, and sets nothing', async () => {
    for (const headers of [{}, { 'x-sid-upstream-auth': 'f'.repeat(63) }]) {
      const response = await call({ ...headers, 'x-forwarded-host': 'www.example.com', 'x-sid-country': 'US' }, `/_sid/sync?id=pubcid%3A${UUID}`);
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("uses the CDN's forwarded IP, location and host, not request.cf, with the secret", async () => {
    const auth = { 'x-sid-upstream-auth': SECRET, 'x-forwarded-host': 'www.example.com' };
    for (const ip of ['203.0.113.7', '2001:db8::7']) {
      const response = await call({ ...auth, 'x-sid-client-ip': ip, 'x-sid-country': 'US', 'x-sid-region': 'TX' });
      expect(await response.json()).toMatchObject({ ortb2: { device: { ...(ip.includes(':') ? { ipv6: ip } : { ip }), geo: { country: 'USA', region: 'TX' } } } });
    }
    const sync = await call({ ...auth, 'x-sid-country': 'US' }, `/_sid/sync?id=pubcid%3A${UUID}`);
    expect(sync.headers.getSetCookie().find(c => c.startsWith('_pubcid='))).toMatch(/Domain=example\.com;.*Secure/);
  });

  it('refuses SID_UPSTREAM_SECRETS without the country header', async () => {
    const fetchHandler = worker.fetch;
    if (fetchHandler === undefined) throw new Error('no fetch handler');
    const response = await fetchHandler(new Request('https://www.example.com/_sid/v1'), { ...env, SID_LOCATION_HEADERS: '' }, {} as ExecutionContext);
    expect(response.status).toBe(500);
  });
});

describe('rate limiting bindings (SID_RATE_LIMIT_CLIENT, SID_RATE_LIMIT_HOST)', () => {
  /** A stand-in for a Workers rate limiting binding: allows `limit` calls per key, recording the keys. */
  function fakeBinding(limit: number): { keys: string[]; limit: (options: { key: string }) => Promise<{ success: boolean }> } {
    const keys: string[] = [];
    return {
      keys,
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: keys.filter(k => k === key).length <= limit });
      }
    };
  }
  const call = (env: Record<string, unknown>, path: string, headers: Record<string, string> = {}): Promise<Response> => {
    const fetchHandler = createWorker(modules).fetch;
    if (fetchHandler === undefined) throw new Error('no fetch handler');
    const request = new Request(`https://www.example.com${path}`, { headers });
    return Promise.resolve(fetchHandler(request as Parameters<typeof fetchHandler>[0], { SID_COOKIE_DOMAIN: 'host-only', ...env } as unknown as Env, {} as ExecutionContext));
  };

  it('keys the client binding by IP (IPv6 by its /64) and the host binding by hostname, and answers 429 past either', async () => {
    const client = fakeBinding(1);
    const host = fakeBinding(3);
    const env = { SID_RATE_LIMIT_CLIENT: client, SID_RATE_LIMIT_HOST: host };
    expect((await call(env, '/_sid/sync', { 'CF-Connecting-IP': '203.0.113.7' })).status).toBe(200);
    expect((await call(env, '/_sid/v1', { 'CF-Connecting-IP': '2001:db8:0:1:aaaa::1' })).status).toBe(200);
    const refused = await call(env, '/_sid/v1', { 'CF-Connecting-IP': '2001:db8:0:1:bbbb::2' });
    expect(refused.status).toBe(429);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(client.keys).toEqual(['203.0.113.7', '2001:db8:0:1::/64', '2001:db8:0:1::/64']);
    // The host's limit of 3 is reached on the fourth request, whatever the client.
    expect((await call(env, '/_sid/v1', { 'CF-Connecting-IP': '198.51.100.9' })).status).toBe(429);
    expect(host.keys).toEqual(['www.example.com', 'www.example.com', 'www.example.com', 'www.example.com']);
  });


  it('in trusted-upstream mode, keys by the forwarded client IP and host, not the CDN\'s', async () => {
    const client = fakeBinding(10);
    const host = fakeBinding(10);
    const secret = 'f'.repeat(64);
    const env = {
      SID_UPSTREAM_SECRETS: JSON.stringify([secret]),
      SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
      SID_LOCATION_HEADERS: '{"country":"x-sid-country"}',
      SID_RATE_LIMIT_CLIENT: client,
      SID_RATE_LIMIT_HOST: host
    };
    const headers = { 'CF-Connecting-IP': '198.51.100.1', 'x-sid-upstream-auth': secret, 'x-forwarded-host': 'www.pub-a.example', 'x-sid-client-ip': '203.0.113.7', 'x-sid-country': 'US' };
    expect((await call(env, '/_sid/sync', headers)).status).toBe(200);
    // Without the secret: a 403 before anything is counted.
    expect((await call(env, '/_sid/sync', { ...headers, 'x-sid-upstream-auth': 'nope' })).status).toBe(403);
    expect(client.keys).toEqual(['203.0.113.7']);
    expect(host.keys).toEqual(['www.pub-a.example']);
  });
  it('never limits opt-out', async () => {
    const env = { SID_RATE_LIMIT_CLIENT: fakeBinding(0) };
    expect((await call(env, '/_sid/optout', { 'CF-Connecting-IP': '203.0.113.7' })).status).toBe(204);
    expect((await call(env, '/_sid/sync', { 'CF-Connecting-IP': '203.0.113.7' })).status).toBe(429);
  });

  it('counts a request without a client IP only per host', async () => {
    const client = fakeBinding(0);
    expect((await call({ SID_RATE_LIMIT_CLIENT: client }, '/_sid/sync')).status).toBe(200);
    expect(client.keys).toEqual([]);
  });

  it('refuses a variable in place of a binding with a 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call({ SID_RATE_LIMIT_HOST: '100' }, '/_sid/sync');
    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SID_RATE_LIMIT_HOST must be a rate limiting binding'));
    error.mockRestore();
  });
});
