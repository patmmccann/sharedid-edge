import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHandler, resolveConfig, type EdgeModule, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { ipDatabaseModule, type DataInfo } from '@sharedid-edge/ip-ranges';
import { encodeRangeTable, FIXTURE_TABLE, writeMmdb } from '@sharedid-edge/ip-ranges/build';
import { geoModule } from '@sharedid-edge/module-geo';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA, DATA_INFO } from '../src/data.js';
import { DBIP_ATTRIBUTION, DBIP_DATA_INFO, dbipModule } from '../src/index.js';

async function payload(platform: PlatformInfo, env: Record<string, string> = {}, modules: readonly EdgeModule[] = [dbipModule], path = '/_sid/v1', headers: Record<string, string> = {}): Promise<PayloadV1> {
  const handler = createHandler({ modules, config: resolveConfig({ SID_MODULES: 'dbip', ...env }) });
  return (await (await handler(new Request(`https://www.example.com${path}`, { headers }), platform)).json()) as PayloadV1;
}

describe('the bundled fixture', () => {
  it('is the shared fixture table, and says so', () => {
    expect(DATA).toBe(encodeRangeTable(FIXTURE_TABLE));
    expect(DATA_INFO).toEqual({ database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: DBIP_ATTRIBUTION });
    expect(DBIP_DATA_INFO).toBe(DATA_INFO);
  });
});

describe('dbipModule', () => {
  it('returns the country as alpha-3, with no ipservice (DB-IP is not on the AdCOM list)', async () => {
    const body = await payload({ clientIp: '192.0.2.10' });
    expect(body.ortb2).toEqual({ device: { geo: { type: 2, country: 'FRA' } } });
    expect(body.ext.modules['dbip']).toMatchObject({ status: 'ok' });
    expect((await payload({ clientIp: '2001:db8:1::1' })).ortb2).toEqual({ device: { geo: { type: 2, country: 'JPN' } } });
  });

  it('returns nothing for an address it does not know', async () => {
    const body = await payload({ clientIp: '8.8.8.8' });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['dbip']).toMatchObject({ status: 'empty' });
  });

  it('fills the country geo leaves out, and replaces it when told to, listed after geo', async () => {
    const modules = [geoModule, dbipModule];
    // The CDN knows the country: geo sends it, dbip adds nothing.
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,dbip' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'DEU', region: 'BE' } } });
    // It doesn't: dbip fills it in.
    expect((await payload({ clientIp: '192.0.2.10', region: 'IDF' }, { SID_MODULES: 'geo,dbip' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'IDF' } } });
    // replace, after geo: DB-IP's country wins; geo's other fields stay.
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,dbip', SID_MODULE_CONFIG: '{"dbip":{"mode":"replace"}}' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'BE' } } });
    // replace, before geo: the merge goes geo's way.
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE' }, { SID_MODULES: 'dbip,geo', SID_MODULE_CONFIG: '{"dbip":{"mode":"replace"}}' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'DEU' } } });
  });

  it('sends the country, coarse location, whatever the consent signals, as geo does', async () => {
    const ip = { clientIp: '198.51.100.20' };
    const expected = { device: { geo: { type: 2, country: 'JPN' } } };
    for (const [path, platform, headers] of [
      ['/_sid/v1', ip, { 'Sec-GPC': '1' }],
      ['/_sid/v1?gdpr=1', ip, {}],
      ['/_sid/v1', { ...ip, isEU: true }, {}],
      ['/_sid/v1?us_privacy=1YYN', ip, {}],
      ['/_sid/v1?coppa=1', ip, {}],
      ['/_sid/v1', ip, { Cookie: '_pubcid_optout=1' }]
    ] as const) {
      expect((await payload(platform, {}, [dbipModule], path, headers)).ortb2).toEqual(expected);
    }
  });

  it('reports a bad setting as an error', async () => {
    expect((await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"dbip":{"mode":"merge"}}' })).ext.modules['dbip']).toMatchObject({ status: 'error' });
  });
});

describe('scripts/build-data.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sid-dbip-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const script = join(import.meta.dirname, '..', 'scripts', 'build-data.mjs');
  const run = (args: string[]): string => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`build-data failed: ${result.stderr}`);
    return result.stdout;
  };
  const load = async (file: string): Promise<{ DATA: string; DATA_INFO: DataInfo }> => {
    const loaded: unknown = await import(`${pathToFileURL(file).href}?${String(Date.now())}`);
    return loaded as { DATA: string; DATA_INFO: DataInfo };
  };
  const country = (code: string): Record<string, Record<string, string>> => ({ country: { iso_code: code } });
  const mmdb = writeMmdb({
    databaseType: 'DBIP-Country-Lite',
    ipVersion: 6,
    buildEpoch: Date.UTC(2026, 10, 1) / 1000,
    ipv4Aliases: true,
    networks: [
      { network: '5.0.0.0/8', record: country('DE') },
      { network: '2a00::/12', record: country('NL') }
    ]
  });

  it('builds a data file from a local database, without the network', async () => {
    const file = join(dir, 'dbip-country-lite-2026-11.mmdb.gz');
    writeFileSync(file, gzipSync(mmdb));
    const out = join(dir, 'data.js');
    expect(run(['--file', file, '--out', out])).toMatch(/dbip-country-lite-2026-11 \(built 2026-11-01, ipv4,ipv6\), 3 IPv4 and \d+ IPv6 ranges, 2 countries/);
    const { DATA: data, DATA_INFO: info } = await load(out);
    expect(info).toEqual({ database: 'dbip-country-lite-2026-11', built: '2026-11-01', families: 'ipv4,ipv6', fixture: false, attribution: DBIP_ATTRIBUTION });
    expect(readFileSync(out, 'utf8')).toContain('IP Geolocation by DB-IP');
    const module = ipDatabaseModule({ name: 'dbip', data });
    expect((await payload({ clientIp: '5.6.7.8' }, {}, [module])).ortb2).toEqual({ device: { geo: { type: 2, country: 'DEU' } } });
    expect((await payload({ clientIp: '2a01::1' }, {}, [module])).ortb2).toEqual({ device: { geo: { type: 2, country: 'NLD' } } });
    expect((await payload({ clientIp: '192.0.2.10' }, {}, [module])).ortb2).toBeUndefined();

    run(['--file', file, '--out', out, '--ipv4-only']);
    const v4 = await load(out);
    expect(v4.DATA_INFO.families).toBe('ipv4');
    const v4Module = ipDatabaseModule({ name: 'dbip', data: v4.DATA });
    expect((await payload({ clientIp: '2a01::1' }, {}, [v4Module])).ortb2).toBeUndefined();
  });

  it('refuses another database', () => {
    const file = join(dir, 'other.mmdb');
    writeFileSync(file, writeMmdb({ databaseType: 'GeoLite2-City', ipVersion: 4, networks: [] }));
    expect(() => run(['--file', file, '--out', join(dir, 'x.js')])).toThrow('Unexpected database type "GeoLite2-City"');
  });

  it('puts the fixture back', async () => {
    const out = join(dir, 'fixture.js');
    run(['--fixture', '--out', out]);
    expect(await load(out)).toMatchObject({ DATA, DATA_INFO });
  });
});
