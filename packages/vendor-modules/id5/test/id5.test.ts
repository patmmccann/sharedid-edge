import { createHandler, resolveConfig, type ConsentContext, type ForwardFetch, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheCookieValue,
  existingId5Reply,
  id5Module,
  id5ModuleConfig,
  id5RequestBody,
  isRoutableIp,
  isWebKit27,
  parseId5Reply,
  readCache,
  ID5_MAX_AGE_SECONDS,
  ID5_REFRESH_SECONDS,
  type Id5Cache
} from '../src/index.js';
import { parseIp } from '@sharedid-edge/core';

// Partner 173 is ID5's test partner. Every request goes to the stub below; nothing leaves the test.
const PARTNER = 173;
const COOKIE = 'sid_id5_173';
const SHAREDID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const NOW = new Date('2026-11-24T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
/** A routable address that isn't anyone's documentation range (the conformance suite uses it too). */
const PUBLIC_IP = '203.0.114.7';
const PUBLIC_IPV6 = '2a00:1450:4001:80b::200e';
const UA = 'Mozilla/5.0 (id5 test)';
const ID5_EID = { source: 'id5-sync.com', uids: [{ id: 'ID5*stub-universal-id', atype: 1, ext: { linkType: 2 } }] };
const TRUELINK_EID = { source: 'true-link-id5-sync.com', uids: [{ id: 'TL*stub', atype: 1 }] };

/** A stub ID5 server: records each request's URL and JSON body and answers with `answer`. */
function id5Stub(answer: (body: Record<string, unknown>) => Response | Promise<Response> = () => Response.json({
  ids: { id5id: { eid: ID5_EID }, trueLinkId: { eid: TRUELINK_EID } },
  signature: 'sig-1',
  cache_control: { max_age_sec: 7200 }
})): { readonly bodies: Record<string, unknown>[]; readonly urls: string[]; readonly send: ForwardFetch } {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  return {
    bodies,
    urls,
    send: async request => {
      urls.push(request.url);
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      return answer(body);
    }
  };
}

function handler(send: ForwardFetch | null, settings: Record<string, unknown> = {}, env: Record<string, string> = {}): ReturnType<typeof createHandler> {
  return createHandler({
    config: resolveConfig({
      SID_MODULES: 'id5',
      SID_MODULE_TIMEOUT_MS: '1000',
      SID_MODULE_CONFIG: JSON.stringify({ id5: { partner: PARTNER, ...settings } }),
      ...env
    }),
    modules: [id5Module],
    now: () => NOW,
    mintId: () => SHAREDID,
    ...(send === null ? {} : { forwardFetch: send })
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://www.example.com${path}`, { headers: { 'User-Agent': UA, ...headers } });
}

const call = (h: ReturnType<typeof createHandler>, path = '/_sid/v1', headers: Record<string, string> = {}, platform: PlatformInfo = { clientIp: PUBLIC_IP }): Promise<Response> =>
  h(get(path, headers), platform);

/** The response's `Set-Cookie` for `name`: its value and attributes (lower-case names). */
function cookie(response: Response, name: string): { readonly value: string; readonly attributes: Map<string, string> } | undefined {
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';').map(part => part.trim());
    const index = pair.indexOf('=');
    if (pair.slice(0, index) !== name) continue;
    return {
      value: pair.slice(index + 1),
      attributes: new Map(attributes.map(attribute => {
        const at = attribute.indexOf('=');
        return at < 0 ? [attribute.toLowerCase(), ''] : [attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1)];
      }))
    };
  }
  return undefined;
}

const cacheOf = (response: Response): Id5Cache | undefined => {
  const value = cookie(response, COOKIE)?.value;
  return value === undefined || value === '' ? undefined : readCache(value, NOW_S);
};

/**
 * A minimal TCF v2 TC string: a core segment with purpose consents, special features and vendor consents, and a publisher
 * TC segment consenting to Purposes 1 and 2 (so the SharedID itself may be stored).
 */
function tc(purposes: readonly number[], vendors: readonly number[], specialFeatures: readonly number[] = []): string {
  const bits: number[] = [];
  const push = (value: number, length: number): void => { for (let bit = length - 1; bit >= 0; bit--) bits.push((value >> bit) & 1); };
  push(2, 6);
  while (bits.length < 140) bits.push(0);
  for (let f = 1; f <= 12; f++) bits.push(specialFeatures.includes(f) ? 1 : 0);
  for (let p = 1; p <= 24; p++) bits.push(purposes.includes(p) ? 1 : 0);
  for (let p = 1; p <= 24; p++) bits.push(0);
  while (bits.length < 213) bits.push(0);
  const max = Math.max(0, ...vendors);
  push(max, 16);
  bits.push(0);
  for (let v = 1; v <= max; v++) bits.push(vendors.includes(v) ? 1 : 0);
  push(0, 16);
  bits.push(0);
  push(0, 12);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encode = (segment: readonly number[]): string => {
    const padded = [...segment];
    while (padded.length % 6 !== 0) padded.push(0);
    let out = '';
    for (let i = 0; i < padded.length; i += 6) out += alphabet[padded.slice(i, i + 6).reduce((n, b) => n * 2 + b, 0)] ?? '';
    return out;
  };
  const core = encode(bits);
  bits.length = 0;
  push(3, 3);
  for (let p = 1; p <= 24; p++) bits.push(p <= 2 ? 1 : 0);
  for (let p = 1; p <= 24; p++) bits.push(0);
  push(0, 6);
  return `${core}.${encode(bits)}`;
}

/** ID5 (131) has consent, with Purposes 1 and 2 and precise geolocation (Special Feature 1); the publisher, Purposes 1 and 2. */
const TC_ID5 = tc([1, 2], [131], [1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fetching the ID5 ID', () => {
  it('asks ID5 once and returns the EIDs in ids, caching them with the signature in an HttpOnly cookie per partner', async () => {
    const stub = id5Stub();
    const response = await call(handler(stub.send));
    const body = await response.json() as PayloadV1;
    expect(body.eids).toEqual([{ source: 'pubcid.org', uids: [{ id: SHAREDID, atype: 1 }] }, ID5_EID, TRUELINK_EID]);
    expect(body.ext.modules['id5']?.status).toBe('ok');
    expect(stub.urls).toEqual(['https://id5-sync.com/gs/v2/173.json']);
    const set = cookie(response, COOKIE);
    expect(set?.attributes.has('httponly')).toBe(true);
    expect(set?.attributes.get('max-age')).toBe(String(ID5_MAX_AGE_SECONDS));
    expect(cacheOf(response)).toEqual({ t: NOW_S, r: NOW_S + 7200, e: [ID5_EID, TRUELINK_EID], s: 'sig-1' });
  });

  it('sends the partner, client IP, user agent, SharedID as puid, domain and consent strings, and never a signature it has none of', async () => {
    const stub = id5Stub();
    await call(handler(stub.send, { provider: 'example-operator' }), '/_sid/v1?us_privacy=1YNN&gpp=DBABMA~CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA&gpp_sid=2', {}, { clientIp: PUBLIC_IP });
    expect(stub.bodies[0]).toEqual({
      partner: 173,
      origin: 'sharedid-edge',
      v: '0.1.0',
      ts: NOW.toISOString(),
      gdpr: 0,
      us_privacy: '1YNN',
      gpp_string: 'DBABMA~CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA',
      gpp_sid: '2',
      provider: 'example-operator',
      domain: 'www.example.com',
      ua: UA,
      ip: PUBLIC_IP,
      puid: SHAREDID
    });
  });

  it('returns the legacy universal_uid as an id5-sync.com EID with its linkType', async () => {
    const stub = id5Stub(() => Response.json({ universal_uid: 'ID5*legacy', ext: { linkType: 1 }, signature: 'sig-2' }));
    const body = await (await call(handler(stub.send))).json() as PayloadV1;
    expect(body.eids[1]).toEqual({ source: 'id5-sync.com', uids: [{ id: 'ID5*legacy', atype: 1, ext: { linkType: 1 } }] });
  });

  it('uses a fresh cache without asking ID5', async () => {
    const stub = id5Stub();
    const cached = cacheCookieValue({ t: NOW_S - 60, r: NOW_S + 3600, e: [ID5_EID], s: 'sig-0' });
    const response = await call(handler(stub.send), '/_sid/v1', { Cookie: `${COOKIE}=${cached}` });
    expect(((await response.json()) as PayloadV1).eids[1]).toEqual(ID5_EID);
    expect(stub.bodies).toHaveLength(0);
    expect(cookie(response, COOKIE)).toBeUndefined();
  });

  it('refreshes a cache past its refresh time, sending the signature back', async () => {
    const stub = id5Stub();
    const cached = cacheCookieValue({ t: NOW_S - ID5_REFRESH_SECONDS - 1, r: NOW_S - 1, e: [ID5_EID], s: 'sig-0' });
    const response = await call(handler(stub.send), '/_sid/v1', { Cookie: `${COOKIE}=${cached}` });
    expect(stub.bodies[0]?.['s']).toBe('sig-0');
    expect(cacheOf(response)?.s).toBe('sig-1');
  });

  it('sends the signature as signature to /ga/v1', async () => {
    const stub = id5Stub();
    const cached = cacheCookieValue({ t: NOW_S - 9 * 3600, r: NOW_S - 1, e: [ID5_EID], s: 'sig-0' });
    await call(handler(stub.send, { endpoint: 'https://api.id5-sync.com/ga/v1' }), '/_sid/v1', { Cookie: `${COOKIE}=${cached}` });
    expect(stub.urls).toEqual(['https://api.id5-sync.com/ga/v1']);
    expect(stub.bodies[0]?.['signature']).toBe('sig-0');
    expect(stub.bodies[0]).not.toHaveProperty('s');
  });

  it('ignores a cache more than 30 days old, or one the browser changed', async () => {
    const stub = id5Stub();
    const old = cacheCookieValue({ t: NOW_S - ID5_MAX_AGE_SECONDS, r: NOW_S + 3600, e: [ID5_EID], s: 'old' });
    await call(handler(stub.send), '/_sid/v1', { Cookie: `${COOKIE}=${old}` });
    expect(stub.bodies[0]).not.toHaveProperty('s');
    await call(handler(stub.send), '/_sid/v1', { Cookie: `${COOKIE}=not-base64!` });
    expect(stub.bodies).toHaveLength(2);
  });

  it('refreshes the cache from /sync, where only its cookie is used', async () => {
    const stub = id5Stub();
    const response = await call(handler(stub.send), '/_sid/sync');
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(stub.bodies).toHaveLength(1);
    expect(cacheOf(response)?.e).toEqual([ID5_EID, TRUELINK_EID]);
  });

  it('runs under GDPR with ID5\'s vendor consent, Purposes 1 and 2 and precise geolocation, and sends the TC string', async () => {
    const stub = id5Stub();
    const body = await (await call(handler(stub.send), `/_sid/v1?gdpr=1&gdpr_consent=${TC_ID5}`)).json() as PayloadV1;
    expect(body.eids).toContainEqual(ID5_EID);
    expect(stub.bodies[0]).toMatchObject({ gdpr: 1, gdpr_consent: TC_ID5 });
  });

  it('uses an ID5 answer already in the id5id cookie, without asking ID5', async () => {
    const stub = id5Stub();
    const reply = encodeURIComponent(JSON.stringify({ universal_uid: 'ID5*from-cookie', signature: 'x' }));
    const body = await (await call(handler(stub.send), '/_sid/v1', { Cookie: `id5id=${reply}` })).json() as PayloadV1;
    expect(body.eids[1]).toEqual({ source: 'id5-sync.com', uids: [{ id: 'ID5*from-cookie', atype: 1 }] });
    expect(stub.bodies).toHaveLength(0);
    // Turned off with "".
    await call(handler(stub.send, { readCookie: '' }), '/_sid/v1', { Cookie: `id5id=${reply}` });
    expect(stub.bodies).toHaveLength(1);
  });
});

describe('ID5\'s opt-out', () => {
  it.each([
    ['universal_uid "0"', { universal_uid: '0', signature: 'sig-x' }],
    ['privacy.id5_consent false', { universal_uid: 'ID5*x', privacy: { id5_consent: false } }]
  ])('keeps no ID after %s, and doesn\'t ask again before the refresh', async (_name, answer) => {
    const stub = id5Stub(() => Response.json(answer));
    const cached = cacheCookieValue({ t: NOW_S - 9 * 3600, r: NOW_S - 1, e: [ID5_EID], s: 'sig-0' });
    const h = handler(stub.send);
    const response = await call(h, '/_sid/v1', { Cookie: `${COOKIE}=${cached}` });
    expect(((await response.json()) as PayloadV1).eids).toHaveLength(1);
    const marker = cookie(response, COOKIE)?.value ?? '';
    expect(readCache(marker, NOW_S)).toEqual({ t: NOW_S, r: NOW_S + ID5_REFRESH_SECONDS, o: 1 });
    await call(h, '/_sid/v1', { Cookie: `${COOKIE}=${marker}` });
    expect(stub.bodies).toHaveLength(1);
  });

  it('treats an id5id cookie holding 0 as ID5\'s opt-out: no request, and the cache is deleted', async () => {
    const stub = id5Stub();
    const cached = cacheCookieValue({ t: NOW_S, r: NOW_S + 3600, e: [ID5_EID] });
    const response = await call(handler(stub.send), '/_sid/v1', { Cookie: `id5id=0; ${COOKIE}=${cached}` });
    expect(stub.bodies).toHaveLength(0);
    expect(cookie(response, COOKIE)?.attributes.get('max-age')).toBe('0');
  });
});

describe('no request at all', () => {
  const cached = cacheCookieValue({ t: NOW_S, r: NOW_S + 3600, e: [ID5_EID], s: 'sig-0' });

  it.each([
    ['the SharedID opt-out', '/_sid/v1', { Cookie: `_pubcid_optout=1; ${COOKIE}=${cached}` }],
    ['GPC', '/_sid/v1', { 'Sec-GPC': '1', Cookie: `${COOKIE}=${cached}` }],
    ['COPPA', '/_sid/v1?coppa=1', { Cookie: `${COOKIE}=${cached}` }],
    ['a us_privacy opt-out of sale', '/_sid/v1?us_privacy=1YYN', { Cookie: `${COOKIE}=${cached}` }],
    // US National v2 (section 7) with SaleOptOut=1, as in conformance/cases/module-gpp.json.
    ['a GPP US opt-out, without the gpp module', '/_sid/v1?gpp=DBABLA~CVQaAAAAAABA.QA&gpp_sid=7', { Cookie: `${COOKIE}=${cached}` }],
    ['GDPR without a TC string', '/_sid/v1?gdpr=1', { Cookie: `${COOKIE}=${cached}` }],
    ['GDPR without ID5\'s vendor consent', `/_sid/v1?gdpr=1&gdpr_consent=${tc([1, 2], [130], [1])}`, { Cookie: `${COOKIE}=${cached}` }],
    ['GDPR without Purpose 1 for vendors', `/_sid/v1?gdpr=1&gdpr_consent=${tc([2], [131], [1])}`, { Cookie: `${COOKIE}=${cached}` }],
    ['GDPR without any of Purposes 2 to 10', `/_sid/v1?gdpr=1&gdpr_consent=${tc([1], [131], [1])}`, { Cookie: `${COOKIE}=${cached}` }],
    // Outside GDPR, a TC string still has to give ID5 consent, as the SharedID's own TC string check applies whatever gdpr says.
    ["a TC string without ID5's vendor consent, outside GDPR", `/_sid/v1?gdpr=0&gdpr_consent=${tc([1, 2], [130], [1])}`, { Cookie: `${COOKIE}=${cached}` }]
  ])('on %s, and the cache is deleted', async (_name, path, headers) => {
    const stub = id5Stub();
    const response = await call(handler(stub.send), path, headers);
    expect(stub.bodies).toHaveLength(0);
    const body = path.startsWith('/_sid/v1') ? await response.json() as PayloadV1 : undefined;
    expect(body?.eids.some(eid => eid.source === 'id5-sync.com')).toBe(false);
    expect(cookie(response, COOKIE)?.attributes.get('max-age')).toBe('0');
  });

  it.each([
    ['a private address', '10.1.2.3'],
    ['a loopback address', '127.0.0.1'],
    ['a shared (CGNAT) address', '100.64.1.1'],
    ['a documentation address', '192.0.2.10'],
    ['a link-local IPv6 address', 'fe80::1'],
    ['a unique local IPv6 address', 'fd00::1'],
    ['a documentation IPv6 address', '2001:db8::1']
  ])('from %s, which is never sent', async (_name, clientIp) => {
    const stub = id5Stub();
    const body = await (await call(handler(stub.send), '/_sid/v1', {}, { clientIp })).json() as PayloadV1;
    expect(stub.bodies).toHaveLength(0);
    expect(body.eids).toHaveLength(1);
  });

  it('without a client IP or user agent, or when consent rules out a full IP address', async () => {
    const stub = id5Stub();
    const h = handler(stub.send);
    await call(h, '/_sid/v1', {}, {});
    await h(new Request('https://www.example.com/_sid/v1'), { clientIp: PUBLIC_IP });
    // ID5's consent, but no opt-in to precise geolocation (Special Feature 1).
    await call(h, `/_sid/v1?gdpr=1&gdpr_consent=${tc([1, 2], [131])}`);
    expect(stub.bodies).toHaveLength(0);
  });

  it('deletes the cache at /optout', async () => {
    const response = await handler(id5Stub().send)(get('/_sid/optout', { Cookie: `${COOKIE}=${cached}` }));
    expect(cookie(response, COOKIE)?.attributes.get('max-age')).toBe('0');
  });
});

describe('IPv6', () => {
  it('sends a routable IPv6 address as ipv6, never as ip', async () => {
    const stub = id5Stub();
    await call(handler(stub.send), '/_sid/v1', {}, { clientIp: '2A00:1450:4001:080b:0000:0000:0000:200E' });
    expect(stub.bodies[0]?.['ipv6']).toBe(PUBLIC_IPV6);
    expect(stub.bodies[0]).not.toHaveProperty('ip');
  });

  it('sends an IPv4-mapped address as ip', async () => {
    const stub = id5Stub();
    await call(handler(stub.send), '/_sid/v1', {}, { clientIp: `::ffff:${PUBLIC_IP}` });
    expect(stub.bodies[0]?.['ip']).toBe(PUBLIC_IP);
    expect(stub.bodies[0]).not.toHaveProperty('ipv6');
  });
});

describe('time limits and failures', () => {
  it('gives up after timeoutMs and answers without the ID5 EID, or with the cached one', async () => {
    // The stub holds each request, as a runtime's fetch does while it waits, so nothing is collected before it aborts.
    const held: Request[] = [];
    const hang: ForwardFetch = request => new Promise((_resolve, reject) => {
      held.push(request);
      request.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
    });
    const h = handler(hang, { timeoutMs: 20 });
    const started = performance.now();
    const response = await call(h);
    const body = await response.json() as PayloadV1;
    expect(performance.now() - started).toBeLessThan(800);
    expect(body.eids).toHaveLength(1);
    expect(body.ext.modules['id5']?.status).toBe('empty');
    expect(cookie(response, COOKIE)).toBeUndefined();
    const due = cacheCookieValue({ t: NOW_S - 9 * 3600, r: NOW_S - 1, e: [ID5_EID] });
    expect(((await (await call(h, '/_sid/v1', { Cookie: `${COOKIE}=${due}` })).json()) as PayloadV1).eids[1]).toEqual(ID5_EID);
  });

  it('asks again in an hour after an error, keeping what is cached', async () => {
    const stub = id5Stub(() => new Response('Fetch of ID5 ID disabled', { status: 400 }));
    const due = cacheCookieValue({ t: NOW_S - 9 * 3600, r: NOW_S - 1, e: [ID5_EID], s: 'sig-0' });
    const response = await call(handler(stub.send), '/_sid/v1', { Cookie: `${COOKIE}=${due}` });
    expect(((await response.json()) as PayloadV1).eids[1]).toEqual(ID5_EID);
    expect(cacheOf(response)).toEqual({ t: NOW_S - 9 * 3600, r: NOW_S + 3600, e: [ID5_EID], s: 'sig-0' });
  });

  it('backs off for an hour after a successful status with malformed JSON, as after an error', async () => {
    const stub = id5Stub(() => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const response = await call(handler(stub.send));
    expect(cacheOf(response)).toEqual({ t: NOW_S, r: NOW_S + 3600 });
  });

  it('reports an invalid configuration as an error, and is a configuration error on an adapter that can\'t send requests', async () => {
    const body = await (await call(handler(id5Stub().send, { partner: 'abc' }))).json() as PayloadV1;
    expect(body.ext.modules['id5']?.status).toBe('error');
    expect(() => handler(null)).toThrow('sends requests to another host');
  });

  it('caches an answer too large for its cookie without the EIDs, so the next request asks again with the signature', async () => {
    const big = (n: number): { eid: { source: string; uids: { id: string; atype: number }[] } } => ({ eid: { source: `s${String(n)}.example`, uids: [{ id: 'x'.repeat(500), atype: 1 }, { id: 'y'.repeat(500), atype: 1 }] } });
    const stub = id5Stub(() => Response.json({ ids: { a: big(1), b: big(2), c: big(3), d: big(4) }, signature: 'sig-big' }));
    const response = await call(handler(stub.send));
    expect(((await response.json()) as PayloadV1).eids).toHaveLength(5);
    const value = cookie(response, COOKIE)?.value ?? '';
    expect(value.length).toBeLessThanOrEqual(3072);
    expect(readCache(value, NOW_S)).toEqual({ t: NOW_S, r: NOW_S, s: 'sig-big' });
  });
});

describe('building blocks', () => {
  it('checks the settings', () => {
    expect(id5ModuleConfig({ partner: 173 })).toEqual({
      partner: 173, provider: undefined, endpoint: 'https://id5-sync.com/gs/v2/173.json', signatureField: 's', timeoutMs: 300,
      domain: undefined, readCookie: 'id5id', browsers: 'all', cookieName: 'sid_id5_173'
    });
    expect(id5ModuleConfig({ partner: 173, endpoint: 'https://api.id5-sync.com/gs/v2' }).endpoint).toBe('https://api.id5-sync.com/gs/v2');
    for (const bad of [{}, { partner: 0 }, { partner: 1.5 }, { partner: 173, endpoint: 'https://evil.example/gs/v2' }, { partner: 173, endpoint: 'http://id5-sync.com/x' },
      { partner: 173, endpoint: 'https://id5-sync.com:8443/x' }, { partner: 173, timeoutMs: 5 }, { partner: 173, provider: '' }, { partner: 173, parnter: 1 }, { partner: 173, domain: 'not a domain' }, { partner: 173, browsers: 'safari' }]) {
      expect(() => id5ModuleConfig(bad)).toThrow(TypeError);
    }
  });

  it('leaves puid out without a SharedID', () => {
    const consent: ConsentContext = { gdprApplies: undefined, tcString: undefined, tcf: undefined, usPrivacy: undefined, gppString: undefined, gppSid: undefined, gpc: false, coppa: false };
    const body = id5RequestBody(id5ModuleConfig({ partner: 173 }), { address: { ipv6: PUBLIC_IPV6 }, ua: UA, domain: 'example.com', consent, sharedId: undefined, signature: undefined, now: NOW });
    expect(body).not.toHaveProperty('puid');
    expect(body).not.toHaveProperty('ip');
    expect(body['ipv6']).toBe(PUBLIC_IPV6);
  });

  it('parses ID5\'s answers defensively', () => {
    expect(parseId5Reply('nope')).toBeUndefined();
    expect(parseId5Reply({ ids: { x: { eid: { source: 'bad source', uids: [{ id: 'a' }] } } } })).toBeUndefined();
    expect(parseId5Reply({ universal_uid: 'ID5*a', cache_control: { max_age_sec: 1 } })).toMatchObject({ refreshSeconds: 900 });
    expect(parseId5Reply({ universal_uid: 'ID5*a', cache_control: { max_age_sec: 999_999 } })).toMatchObject({ refreshSeconds: ID5_REFRESH_SECONDS });
    expect(parseId5Reply({ ids: { a: { eid: { source: 'id5-sync.com', uids: [{ id: '0' }, { id: 'ok', atype: 9 }] } } } })).toBeUndefined();
    expect(existingId5Reply(JSON.stringify({ pbjs: { 173: { universal_uid: 'ID5*p' }, 99: { universal_uid: 'ID5*q' } } }), 173))
      .toMatchObject({ kind: 'id', eids: [{ uids: [{ id: 'ID5*p' }] }] });
    expect(existingId5Reply('plain-id', 173)).toBeUndefined();
  });

  it('knows which addresses are routable', () => {
    const routable = (text: string): boolean => isRoutableIp(parseIp(text) ?? expect.unreachable(text));
    for (const ip of [PUBLIC_IP, '8.8.8.8', PUBLIC_IPV6]) expect(routable(ip)).toBe(true);
    for (const ip of ['0.1.2.3', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '198.18.0.1', '203.0.113.5', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'ff02::1', '2001::1', '2002::1', '3fff::1']) {
      expect(routable(ip)).toBe(false);
    }
  });
});

const UA_IOS = (os: string, browser: string): string => `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;
const UA_MAC = (browser: string): string => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;

describe('browsers: "webkit27"', () => {
  it.each([
    // Safari on iOS reports a frozen OS version; its Version/ token is the browser's.
    ['iOS 27 Safari (frozen OS version)', UA_IOS('18_6', 'Version/27.0 Mobile/15E148 Safari/604.1'), true],
    ['iOS 27 Safari', UA_IOS('27_0', 'Version/27.0 Mobile/15E148 Safari/604.1'), true],
    ['iPadOS 27 Safari', 'Mozilla/5.0 (iPad; CPU OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1', true],
    ['iOS 27 Chrome', UA_IOS('27_0', 'CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1'), true],
    ['iOS 27 Firefox', UA_IOS('27_0_1', 'FxiOS/143.0 Mobile/15E148 Safari/605.1.15'), true],
    ['iOS 26 Safari', UA_IOS('18_6', 'Version/26.0 Mobile/15E148 Safari/604.1'), false],
    ['iOS 26 Chrome', UA_IOS('26_0', 'CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1'), false],
    ['iOS Chrome with a frozen OS version (unsure, so no)', UA_IOS('18_6', 'CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1'), false],
    ['macOS Safari 27', UA_MAC('Version/27.0 Safari/605.1.15'), true],
    ['macOS Safari 26', UA_MAC('Version/26.2 Safari/605.1.15'), false],
    ['an iPad asking for the desktop site (Safari 27)', UA_MAC('Version/27.0 Safari/605.1.15'), true],
    ['macOS Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', false],
    ['macOS Edge', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', false],
    ['macOS Firefox', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0', false],
    ['Android Chrome', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', false],
    ['an Android WebView with Version/', 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36', false],
    ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', false]
  ])('%s: %s', (_name, ua, expected) => {
    expect(isWebKit27(ua)).toBe(expected);
  });

  it('asks ID5 only for WebKit 27 or later, and still serves a cached answer to other browsers', async () => {
    const stub = id5Stub();
    const h = handler(stub.send, { browsers: 'webkit27' });
    const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
    const none = await call(h, '/_sid/v1', { 'User-Agent': android });
    expect(((await none.json()) as PayloadV1).eids).toHaveLength(1);
    expect(cookie(none, COOKIE)).toBeUndefined();
    const due = cacheCookieValue({ t: NOW_S - 9 * 3600, r: NOW_S - 1, e: [ID5_EID] });
    const cached = await call(h, '/_sid/v1', { 'User-Agent': android, Cookie: `${COOKIE}=${due}` });
    expect(((await cached.json()) as PayloadV1).eids[1]).toEqual(ID5_EID);
    expect(stub.bodies).toHaveLength(0);
    await call(h, '/_sid/v1', { 'User-Agent': UA_IOS('18_6', 'Version/27.0 Mobile/15E148 Safari/604.1') });
    expect(stub.bodies).toHaveLength(1);
  });

  it('still deletes the cache on a denial for other browsers', async () => {
    const due = cacheCookieValue({ t: NOW_S, r: NOW_S + 3600, e: [ID5_EID] });
    const response = await call(handler(id5Stub().send, { browsers: 'webkit27' }), '/_sid/v1', { 'Sec-GPC': '1', Cookie: `${COOKIE}=${due}` });
    expect(cookie(response, COOKIE)?.attributes.get('max-age')).toBe('0');
  });
});
