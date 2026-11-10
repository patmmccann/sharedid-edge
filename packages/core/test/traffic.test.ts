import { describe, expect, it } from 'vitest';
import {
  createHandler,
  defineModule,
  mergeTraffic,
  resolveConfig,
  skipsBot,
  trafficReport,
  type EdgeModule,
  type ModuleResult,
  type PayloadV1,
  type PlatformInfo,
  type TrafficReport,
  type TrafficSignal
} from '../src/index.js';
import { publisherTc, setCookies } from './helpers.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const MINTED = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-01-01T00:00:00Z');

function entry(source: string, report: TrafficReport): { source: string; report: TrafficReport } {
  return { source, report };
}

describe('trafficReport', () => {
  it('keeps the known fields and drops the rest, including sources', () => {
    expect(trafficReport({ bot: true, botKind: 'declared', proxy: 'vpn', score: 12, internal: false, sources: ['x'], other: 1 })).toEqual({
      bot: true,
      botKind: 'declared',
      proxy: 'vpn',
      score: 12,
      internal: false
    });
  });

  it('reads a botKind without bot as a bot', () => {
    expect(trafficReport({ botKind: 'likely' })).toEqual({ bot: true, botKind: 'likely' });
  });

  it('never makes a relay a bot', () => {
    expect(trafficReport({ proxy: 'relay' })).toEqual({ proxy: 'relay' });
  });

  it.each([
    ['not an object', 'bot'],
    ['an array', []],
    ['bot as a string', { bot: 'yes' }],
    ['an unknown botKind', { botKind: 'good' }],
    ['botKind with bot false', { bot: false, botKind: 'verified' }],
    ['an unknown proxy', { proxy: 'cdn' }],
    ['score 0', { score: 0 }],
    ['score 100', { score: 100 }],
    ['a fractional score', { score: 1.5 }],
    ['a string score', { score: '5' }],
    ['internal as a number', { internal: 1 }]
  ])('rejects %s', (_name, value) => {
    expect(() => trafficReport(value)).toThrow(TypeError);
  });
});

describe('mergeTraffic', () => {
  it('is undefined with no reports, or only empty ones', () => {
    expect(mergeTraffic([])).toBeUndefined();
    expect(mergeTraffic([entry('a', {}), entry('b', {})])).toBeUndefined();
  });

  it('bot: true if any report says so, false only if none does', () => {
    expect(mergeTraffic([entry('a', { bot: false }), entry('b', { bot: true })])?.bot).toBe(true);
    expect(mergeTraffic([entry('a', { bot: true }), entry('b', { bot: false })])?.bot).toBe(true);
    expect(mergeTraffic([entry('a', { bot: false }), entry('b', { score: 50 })])?.bot).toBe(false);
    expect(mergeTraffic([entry('a', { score: 50 })])).not.toHaveProperty('bot');
  });

  it('botKind keeps the strongest claim: verified, then declared, then likely', () => {
    const kind = (...kinds: ('verified' | 'declared' | 'likely')[]): string | undefined =>
      mergeTraffic(kinds.map((botKind, i) => entry(String(i), { bot: true, botKind })))?.botKind;
    expect(kind('likely', 'declared')).toBe('declared');
    expect(kind('declared', 'likely')).toBe('declared');
    expect(kind('likely', 'verified', 'declared')).toBe('verified');
    expect(kind('likely', 'likely')).toBe('likely');
  });

  it('proxy keeps the most specific: tor, residential, relay, vpn, datacenter', () => {
    const proxy = (...kinds: ('datacenter' | 'vpn' | 'residential' | 'tor' | 'relay')[]): string | undefined =>
      mergeTraffic(kinds.map((p, i) => entry(String(i), { proxy: p })))?.proxy;
    expect(proxy('datacenter', 'vpn')).toBe('vpn');
    expect(proxy('vpn', 'datacenter')).toBe('vpn');
    expect(proxy('datacenter', 'relay')).toBe('relay');
    expect(proxy('relay', 'vpn')).toBe('relay');
    expect(proxy('relay', 'residential')).toBe('residential');
    expect(proxy('residential', 'tor')).toBe('tor');
    expect(proxy('datacenter', 'datacenter')).toBe('datacenter');
  });

  it('a relay alone, or merged with others, never sets bot', () => {
    expect(mergeTraffic([entry('a', { proxy: 'relay' }), entry('b', { proxy: 'datacenter' })])).toEqual({ proxy: 'relay', sources: ['a', 'b'] });
  });

  it('score keeps the minimum; ties are kept', () => {
    expect(mergeTraffic([entry('a', { score: 40 }), entry('b', { score: 7 }), entry('c', { score: 90 })])?.score).toBe(7);
    expect(mergeTraffic([entry('a', { score: 7 }), entry('b', { score: 7 })])?.score).toBe(7);
  });

  it('internal: true if any report says so', () => {
    expect(mergeTraffic([entry('a', { internal: false }), entry('b', { internal: true })])?.internal).toBe(true);
    expect(mergeTraffic([entry('a', { internal: false })])?.internal).toBe(false);
  });

  it('sources is the union in order, without empty reports', () => {
    expect(mergeTraffic([entry('platform', { score: 3 }), entry('ua', {}), entry('bot', { internal: true }), entry('platform', { score: 3 })])?.sources).toEqual([
      'platform',
      'bot'
    ]);
  });

  it('is idempotent: the same report counted twice changes nothing but sources', () => {
    const report: TrafficReport = { bot: true, botKind: 'verified', proxy: 'vpn', score: 2, internal: true };
    expect(mergeTraffic([entry('a', report), entry('a', report)])).toEqual({ ...report, sources: ['a'] });
  });

  it('writes every field in a fixed order', () => {
    const merged = mergeTraffic([entry('b', { internal: true, score: 5 }), entry('a', { proxy: 'tor', botKind: 'likely', bot: true })]);
    expect(Object.keys(merged ?? {})).toEqual(['bot', 'botKind', 'proxy', 'score', 'internal', 'sources']);
  });
});

describe('skipsBot', () => {
  const signal = (fields: Partial<TrafficSignal>): TrafficSignal => ({ sources: ['x'], ...fields });
  const off = { skipBots: undefined, skipBotsScore: undefined };

  it('never skips when off, or without a signal', () => {
    expect(skipsBot(off, signal({ bot: true, botKind: 'verified', score: 1 }))).toBe(false);
    expect(skipsBot({ skipBots: 'likely', skipBotsScore: 99 }, undefined)).toBe(false);
  });

  it('skips bots this sure or surer', () => {
    const kinds = ['verified', 'declared', 'likely'] as const;
    const table = kinds.map(setting => kinds.map(kind => skipsBot({ ...off, skipBots: setting }, signal({ bot: true, botKind: kind }))));
    expect(table).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true]
    ]);
  });

  it('counts a bot without a botKind as likely', () => {
    expect(skipsBot({ ...off, skipBots: 'likely' }, signal({ bot: true }))).toBe(true);
    expect(skipsBot({ ...off, skipBots: 'declared' }, signal({ bot: true }))).toBe(false);
  });

  it('skips at or below the score threshold', () => {
    expect(skipsBot({ ...off, skipBotsScore: 10 }, signal({ score: 10 }))).toBe(true);
    expect(skipsBot({ ...off, skipBotsScore: 10 }, signal({ score: 11 }))).toBe(false);
    expect(skipsBot({ ...off, skipBotsScore: 10 }, signal({ bot: true, botKind: 'verified' }))).toBe(false);
  });

  it('never skips for internal traffic or a proxy alone', () => {
    expect(skipsBot({ skipBots: 'likely', skipBotsScore: 99 }, signal({ internal: true, proxy: 'tor' }))).toBe(false);
  });
});

function reporter(name: string, result: ModuleResult | undefined): EdgeModule {
  return defineModule({ name, run: () => result });
}

function handler(env: Record<string, string>, modules: EdgeModule[] = []): ReturnType<typeof createHandler> {
  return createHandler({ config: resolveConfig(env), modules, now: () => NOW, mintId: () => MINTED });
}

async function v1(h: ReturnType<typeof createHandler>, headers: Record<string, string> = {}, platform: PlatformInfo = {}, query = ''): Promise<{ response: Response; body: PayloadV1 }> {
  const response = await h(new Request(`https://www.example.com/_sid/v1${query}`, { headers }), platform);
  return { response, body: await response.json() as PayloadV1 };
}

function trafficOf(body: PayloadV1): unknown {
  const device = body.ortb2?.['device'];
  return typeof device === 'object' && device !== null && 'ext' in device && typeof device.ext === 'object' && device.ext !== null && 'traffic' in device.ext
    ? device.ext.traffic
    : undefined;
}

describe('the traffic signal in /v1', () => {
  it('merges module reports and the platform verdict into ortb2.device.ext.traffic', async () => {
    const h = handler({ SID_MODULES: 'ua,ipintel' }, [
      reporter('ua', { traffic: { bot: true, botKind: 'declared' } }),
      reporter('ipintel', { traffic: { proxy: 'datacenter', score: 30 } })
    ]);
    const { body } = await v1(h, {}, { traffic: { score: 12, proxy: 'vpn' } });
    expect(trafficOf(body)).toEqual({ bot: true, botKind: 'declared', proxy: 'vpn', score: 12, sources: ['platform', 'ua', 'ipintel'] });
    expect(body.ext.modules).toEqual({ ua: { ms: 0, status: 'ok' }, ipintel: { ms: 0, status: 'ok' } });
  });

  it('includes the platform verdict with no modules', async () => {
    const { body } = await v1(handler({}), {}, { traffic: { bot: true, botKind: 'verified', score: 1 } });
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { bot: true, botKind: 'verified', score: 1, sources: ['platform'] } } } });
    expect(body.sharedid).toBe(MINTED);
  });

  it('ignores an invalid platform verdict rather than failing', async () => {
    const platform = { traffic: { score: 500 } } as const;
    const { response, body } = await v1(handler({}), {}, platform);
    expect(response.status).toBe(200);
    expect(body.ortb2).toBeUndefined();
  });

  it('has no traffic field when nothing reports one', async () => {
    const { body } = await v1(handler({ SID_MODULES: 'x' }, [reporter('x', { traffic: {} })]));
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['x']?.status).toBe('empty');
  });

  it('reads a module-written ortb2.device.ext.traffic as its report, never as the merged value', async () => {
    const h = handler({ SID_MODULES: 'a,b' }, [
      reporter('a', { ortb2: { device: { ua: 'x', ext: { traffic: { bot: true, botKind: 'declared', sources: ['forged'] } } } } }),
      reporter('b', { ortb2: { device: { ext: { traffic: { bot: false, score: 80 } } } } })
    ]);
    const { body } = await v1(h);
    expect(body.ortb2).toEqual({ device: { ua: 'x', ext: { traffic: { bot: true, botKind: 'declared', score: 80, sources: ['a', 'b'] } } } });
    expect(body.ext.modules['b']?.status).toBe('ok');
  });

  it('makes a module with an invalid traffic report an error, with none of its output used', async () => {
    const h = handler({ SID_MODULES: 'bad,good' }, [
      reporter('bad', { ortb2: { site: { x: 1 } }, traffic: { botKind: 'nice' } as unknown as TrafficReport }),
      reporter('good', { traffic: { internal: true } })
    ]);
    const { body } = await v1(h);
    expect(body.ext.modules['bad']?.status).toBe('error');
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { internal: true, sources: ['good'] } } } });
  });

  it.each([
    ['Global Privacy Control', { 'Sec-GPC': '1' }, ''],
    ['COPPA', {}, '?coppa=1'],
    ['opt-out', { Cookie: '_pubcid_optout=1' }, ''],
    ['denied consent', {}, `?gdpr=1&gdpr_consent=${publisherTc([])}`]
  ])('still returns the traffic signal with %s', async (_name, headers, query) => {
    const h = handler({ SID_MODULES: 'ua' }, [reporter('ua', { traffic: { bot: true, botKind: 'declared' } })]);
    const { response, body } = await v1(h, headers, { traffic: { score: 3 } }, query);
    expect(response.headers.get('X-SharedID-Status')).toMatch(/^denied: /);
    expect(body.sharedid).toBeUndefined();
    expect(trafficOf(body)).toEqual({ bot: true, botKind: 'declared', score: 3, sources: ['platform', 'ua'] });
  });
});

describe('SID_SKIP_BOTS', () => {
  const declared = reporter('ua', { traffic: { bot: true, botKind: 'declared' } });

  it('is off by default: bots get an ID', async () => {
    const { response, body } = await v1(handler({ SID_MODULES: 'ua' }, [declared]));
    expect(body.sharedid).toBe(MINTED);
    expect(response.headers.get('X-SharedID-Status')).toBeNull();
  });

  it('sets no ID cookie and returns no SharedID for a qualifying module verdict', async () => {
    const { response, body } = await v1(handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'declared' }, [declared]));
    expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(response.headers.get('X-SharedID-Source')).toBeNull();
    expect(setCookies(response)).toEqual([]);
    expect(body.sharedid).toBeUndefined();
    expect(body.eids).toEqual([]);
    expect(trafficOf(body)).toEqual({ bot: true, botKind: 'declared', sources: ['ua'] });
  });

  it('never deletes or refreshes an existing ID', async () => {
    const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [declared]);
    const { response, body } = await v1(h, { Cookie: `_pubcid=${UUID}; _pubcid_sv=${UUID}` });
    expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(setCookies(response)).toEqual([]);
    expect(body.sharedid).toBeUndefined();
  });

  it("doesn't skip bots less sure than the setting", async () => {
    const { body } = await v1(handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'verified' }, [declared]));
    expect(body.sharedid).toBe(MINTED);
  });

  it('skips on the platform verdict alone, and modules then see no SharedID', async () => {
    const seen: (string | undefined)[] = [];
    const spy = defineModule({ name: 'spy', run: ({ sharedId }) => { seen.push(sharedId); return undefined; } });
    const h = handler({ SID_MODULES: 'spy', SID_SKIP_BOTS: 'verified' }, [spy]);
    const { response, body } = await v1(h, {}, { traffic: { bot: true, botKind: 'verified' } });
    expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(body.sharedid).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  it('skips at or below SID_SKIP_BOTS_SCORE', async () => {
    const h = handler({ SID_SKIP_BOTS_SCORE: '10' });
    expect((await v1(h, {}, { traffic: { score: 10 } })).body.sharedid).toBeUndefined();
    expect((await v1(h, {}, { traffic: { score: 11 } })).body.sharedid).toBe(MINTED);
  });

  it("doesn't skip internal traffic or a relay", async () => {
    const h = handler({ SID_MODULES: 'staff', SID_SKIP_BOTS: 'likely', SID_SKIP_BOTS_SCORE: '99' }, [reporter('staff', { traffic: { internal: true } })]);
    const { body } = await v1(h, {}, { traffic: { proxy: 'relay' } });
    expect(body.sharedid).toBe(MINTED);
  });

  it('leaves consent denial in charge: the status stays denied and cookies are still deleted', async () => {
    const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [declared]);
    const { response } = await v1(h, { 'Sec-GPC': '1', Cookie: `_pubcid=${UUID}` });
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: gpc');
    expect(setCookies(response).every(c => c.value === '')).toBe(true);
    expect(setCookies(response).length).toBeGreaterThan(0);
  });

  it('uses the platform verdict on /sync, with no module running there', async () => {
    const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'declared' }, [declared]);
    const bot = await h(new Request(`https://www.example.com/_sid/sync?id=pubcid:${UUID}`), { traffic: { bot: true, botKind: 'verified' } });
    expect(bot.headers.get('X-SharedID-Status')).toBe('skipped: bot');
    expect(bot.headers.get('Cache-Control')).toBe('no-store');
    expect(setCookies(bot)).toEqual([]);
    const human = await h(new Request(`https://www.example.com/_sid/sync?id=pubcid:${UUID}`), { traffic: { score: 90 } });
    expect(human.headers.get('X-SharedID-Status')).toBeNull();
    expect(setCookies(human).map(c => c.name)).toEqual(['_pubcid', '_pubcid_sv']);
  });

  describe('on /sync', () => {
    const syncDeclared = defineModule({ name: 'ua', routes: ['v1', 'sync'], run: () => ({ traffic: { bot: true, botKind: 'declared' } }) });
    const sync = (h: ReturnType<typeof createHandler>, platform: PlatformInfo = {}, cookie?: string): Promise<Response> =>
      h(new Request(`https://www.example.com/_sid/sync?id=pubcid:${UUID}`, cookie === undefined ? {} : { headers: { Cookie: cookie } }), platform);

    it('skips on the report of a module that runs there', async () => {
      const response = await sync(handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'declared' }, [syncDeclared]));
      expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
      expect(response.headers.get('X-SharedID-Source')).toBeNull();
      expect(response.headers.get('X-SharedID-Modules')).toBe('ua=ok');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(setCookies(response)).toEqual([]);
    });

    it('merges the platform verdict with the modules that run there', async () => {
      const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'verified' }, [syncDeclared]);
      // The module alone (declared) isn't sure enough for verified; the platform's verdict is.
      expect((await sync(h)).headers.get('X-SharedID-Status')).toBeNull();
      expect((await sync(h, { traffic: { bot: true, botKind: 'verified' } })).headers.get('X-SharedID-Status')).toBe('skipped: bot');
      const scored = handler({ SID_MODULES: 'ua,internal', SID_SKIP_BOTS_SCORE: '10' }, [
        defineModule({ name: 'ua', routes: ['v1', 'sync'], run: () => ({ traffic: { score: 50 } }) }),
        defineModule({ name: 'internal', routes: ['v1', 'sync'], run: () => ({ traffic: { internal: true } }) })
      ]);
      expect((await sync(scored, { traffic: { score: 5 } })).headers.get('X-SharedID-Status')).toBe('skipped: bot');
      expect((await sync(scored, { traffic: { score: 20 } })).headers.get('X-SharedID-Status')).toBeNull();
    });

    it("ignores the reports of modules that don't run there", async () => {
      const v1Only = await sync(handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [declared]));
      expect(v1Only.headers.get('X-SharedID-Status')).toBeNull();
      expect(v1Only.headers.get('X-SharedID-Modules')).toBeNull();
      const none = await sync(handler({ SID_MODULES: 'ua', SID_SYNC_MODULES: 'none', SID_SKIP_BOTS: 'likely' }, [syncDeclared]));
      expect(none.headers.get('X-SharedID-Status')).toBeNull();
      expect(setCookies(none).map(c => c.name)).toEqual(['_pubcid', '_pubcid_sv']);
    });

    it('reads a module-written ortb2.device.ext.traffic there as its report too', async () => {
      const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [
        defineModule({ name: 'ua', routes: ['v1', 'sync'], run: () => ({ ortb2: { device: { ext: { traffic: { bot: true } } } } }) })
      ]);
      expect((await sync(h)).headers.get('X-SharedID-Status')).toBe('skipped: bot');
    });

    it('never deletes an existing ID, and still sets the modules\' cookies', async () => {
      const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [
        defineModule({ name: 'ua', routes: ['v1', 'sync'], run: () => ({ traffic: { bot: true, botKind: 'likely' }, cookies: [{ name: 'other', value: 'x', maxAgeSeconds: 60, httpOnly: false }] }) })
      ]);
      const response = await sync(h, {}, `_pubcid=${UUID}; _pubcid_sv=${UUID}`);
      expect(response.headers.get('X-SharedID-Status')).toBe('skipped: bot');
      expect(setCookies(response).map(c => c.name)).toEqual(['other']);
    });

    it('makes a module with an invalid report an error there, and it counts for nothing', async () => {
      const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [
        defineModule({ name: 'ua', routes: ['v1', 'sync'], run: () => ({ traffic: { bot: false, botKind: 'likely' } }) })
      ]);
      const response = await sync(h);
      expect(response.headers.get('X-SharedID-Modules')).toBe('ua=error');
      expect(response.headers.get('X-SharedID-Status')).toBeNull();
    });

    it('lets consent decide first', async () => {
      const h = handler({ SID_MODULES: 'ua', SID_SKIP_BOTS: 'likely' }, [syncDeclared]);
      const response = await h(new Request(`https://www.example.com/_sid/sync?id=pubcid:${UUID}`, { headers: { 'Sec-GPC': '1', Cookie: `_pubcid=${UUID}` } }), {});
      expect(response.headers.get('X-SharedID-Status')).toBe('denied: gpc');
      expect(setCookies(response).every(c => c.value === '')).toBe(true);
    });
  });
});
