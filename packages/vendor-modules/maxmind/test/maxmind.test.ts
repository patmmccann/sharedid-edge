import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHandler, resolveConfig, type EdgeModule, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { ipDatabaseModule, type DataInfo } from '@sharedid-edge/ip-ranges';
import { encodeRangeTable, FIXTURE_TABLE, writeMmdb } from '@sharedid-edge/ip-ranges/build';
import { geoModule } from '@sharedid-edge/module-geo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA, DATA_INFO } from '../src/data.js';
import { MAXMIND_ATTRIBUTION, MAXMIND_DATA_INFO, MAXMIND_IPSERVICE, maxmindModule } from '../src/index.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');

async function payload(platform: PlatformInfo, env: Record<string, string> = {}, modules: readonly EdgeModule[] = [maxmindModule], path = '/_sid/v1', headers: Record<string, string> = {}): Promise<PayloadV1> {
  const handler = createHandler({ modules, config: resolveConfig({ SID_MODULES: 'maxmind', ...env }) });
  return (await (await handler(new Request(`https://www.example.com${path}`, { headers }), platform)).json()) as PayloadV1;
}

describe('the bundled fixture', () => {
  it('is the shared fixture table, and says so', () => {
    expect(DATA).toBe(encodeRangeTable(FIXTURE_TABLE));
    expect(DATA_INFO).toEqual({ database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: MAXMIND_ATTRIBUTION });
    expect(MAXMIND_DATA_INFO).toBe(DATA_INFO);
  });
});

describe('maxmindModule', () => {
  it('returns the country as alpha-3 with ipservice 3 (MaxMind in AdCOM 1.0)', async () => {
    expect(MAXMIND_IPSERVICE).toBe(3);
    const body = await payload({ clientIp: '192.0.2.10' });
    expect(body.ortb2).toEqual({ device: { geo: { type: 2, country: 'FRA', ipservice: 3 } } });
    expect(body.ext.modules['maxmind']).toMatchObject({ status: 'ok' });
    expect((await payload({ clientIp: '2001:db8:1::1' })).ortb2).toEqual({ device: { geo: { type: 2, country: 'JPN', ipservice: 3 } } });
  });

  it('returns nothing for an address it does not know', async () => {
    const body = await payload({ clientIp: '8.8.8.8' });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['maxmind']).toMatchObject({ status: 'empty' });
  });

  it('fills the country geo leaves out, and replaces it when told to, listed after geo', async () => {
    const modules = [geoModule, maxmindModule];
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,maxmind' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'DEU', region: 'BE' } } });
    expect((await payload({ clientIp: '192.0.2.10', region: 'IDF' }, { SID_MODULES: 'geo,maxmind' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'IDF', ipservice: 3 } } });
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,maxmind', SID_MODULE_CONFIG: '{"maxmind":{"mode":"replace"}}' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'BE', ipservice: 3 } } });
  });

  it('sends the country, coarse location, whatever the consent signals, as geo does', async () => {
    const ip = { clientIp: '198.51.100.20' };
    const expected = { device: { geo: { type: 2, country: 'JPN', ipservice: 3 } } };
    for (const [path, platform, headers] of [
      ['/_sid/v1', ip, { 'Sec-GPC': '1' }],
      ['/_sid/v1?gdpr=1', ip, {}],
      ['/_sid/v1', { ...ip, isEU: true }, {}],
      ['/_sid/v1?us_privacy=1YYN', ip, {}],
      ['/_sid/v1?coppa=1', ip, {}],
      ['/_sid/v1', ip, { Cookie: '_pubcid_optout=1' }]
    ] as const) {
      expect((await payload(platform, {}, [maxmindModule], path, headers)).ortb2).toEqual(expected);
    }
  });

  it('reports a bad setting as an error', async () => {
    expect((await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"maxmind":{"mode":"merge"}}' })).ext.modules['maxmind']).toMatchObject({ status: 'error' });
  });
});

describe('scripts/build-data.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sid-maxmind-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const script = join(import.meta.dirname, '..', 'scripts', 'build-data.mjs');
  // Made-up credentials, as a deployer's build would have them in its environment.
  const credentials = { MAXMIND_ACCOUNT_ID: '7654321', MAXMIND_LICENSE_KEY: 'Test_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_mmk' };
  const run = (args: string[], env: Record<string, string> = credentials): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const checkSecrets = (file: string): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, [join(root, 'scripts', 'check-build-secrets.mjs'), file], { encoding: 'utf8', env: { ...process.env, ...credentials } });
  const load = async (file: string): Promise<{ DATA: string; DATA_INFO: DataInfo }> => {
    const loaded: unknown = await import(`${pathToFileURL(file).href}?${String(Date.now())}`);
    return loaded as { DATA: string; DATA_INFO: DataInfo };
  };
  const country = (code: string): Record<string, Record<string, string>> => ({ country: { iso_code: code }, registered_country: { iso_code: 'US' } });
  const mmdb = writeMmdb({
    databaseType: 'GeoLite2-Country',
    ipVersion: 6,
    buildEpoch: Date.UTC(2026, 10, 10) / 1000,
    ipv4Aliases: true,
    networks: [
      { network: '5.0.0.0/8', record: country('DE') },
      { network: '2a00::/12', record: country('NL') }
    ]
  });

  /** MaxMind ships each database as `<edition>_<date>/<edition>.mmdb` in a .tar.gz. */
  function tarGz(name: string, content: Uint8Array): Uint8Array {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name), 0);
    header.set(new TextEncoder().encode(`${content.length.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = 0x30;
    header.set(new TextEncoder().encode('ustar\u000000'), 257);
    const out = new Uint8Array(512 + Math.ceil(content.length / 512) * 512 + 1024);
    out.set(header, 0);
    out.set(content, 512);
    return gzipSync(out);
  }

  it('builds a data file from the tar.gz MaxMind ships, without the network, with no credential in it', async () => {
    const file = join(dir, 'GeoLite2-Country.tar.gz');
    writeFileSync(file, tarGz('GeoLite2-Country_20261110/GeoLite2-Country.mmdb', mmdb));
    const out = join(dir, 'data.js');
    const result = run(['--file', file, '--out', out]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/GeoLite2-Country-2026-11-10 \(ipv4,ipv6\), 3 IPv4 and \d+ IPv6 ranges, 2 countries/);
    const { DATA: data, DATA_INFO: info } = await load(out);
    expect(info).toEqual({ database: 'GeoLite2-Country-2026-11-10', built: '2026-11-10', families: 'ipv4,ipv6', fixture: false, attribution: MAXMIND_ATTRIBUTION });
    const module = ipDatabaseModule({ name: 'maxmind', data, ipservice: 3 });
    expect((await payload({ clientIp: '5.6.7.8' }, {}, [module])).ortb2).toEqual({ device: { geo: { type: 2, country: 'DEU', ipservice: 3 } } });
    expect((await payload({ clientIp: '2a01::1' }, {}, [module])).ortb2).toEqual({ device: { geo: { type: 2, country: 'NLD', ipservice: 3 } } });

    // The credentials were in the build's environment: neither they nor their encodings are in the output or the log.
    const text = readFileSync(out, 'latin1');
    for (const value of [...Object.values(credentials), `${credentials.MAXMIND_ACCOUNT_ID}:${credentials.MAXMIND_LICENSE_KEY}`]) {
      for (const form of [value, btoa(value), Buffer.from(value).toString('hex'), encodeURIComponent(value)]) expect(text).not.toContain(form);
    }
    expect(`${result.stdout}${result.stderr}`).not.toContain(credentials.MAXMIND_LICENSE_KEY);
    // And the repository's check, which the bundled adapters run on every bundle, agrees.
    const check = checkSecrets(out);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY');
  });

  it('the credential check catches a key that leaks into a data file, without printing it', () => {
    const leaked = join(dir, 'leaked.js');
    writeFileSync(leaked, `export const KEY = ${JSON.stringify(btoa(credentials.MAXMIND_LICENSE_KEY))};\n`);
    const check = checkSecrets(leaked);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('MAXMIND_LICENSE_KEY');
    expect(`${check.stdout}${check.stderr}`).not.toContain(credentials.MAXMIND_LICENSE_KEY);
  });

  it('needs credentials to download, and says so before reaching the network', () => {
    const result = run(['--out', join(dir, 'x.js')], { MAXMIND_ACCOUNT_ID: '', MAXMIND_LICENSE_KEY: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY');
  });

  it('builds IPv4 only', async () => {
    const file = join(dir, 'GeoLite2-Country.mmdb');
    writeFileSync(file, mmdb);
    const out = join(dir, 'v4.js');
    expect(run(['--file', file, '--out', out, '--ipv4-only']).status).toBe(0);
    expect((await load(out)).DATA_INFO.families).toBe('ipv4');
  });

  it('refuses another database', () => {
    const file = join(dir, 'city.mmdb');
    writeFileSync(file, writeMmdb({ databaseType: 'GeoLite2-City', ipVersion: 4, networks: [] }));
    const result = run(['--file', file, '--out', join(dir, 'y.js')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unexpected database type "GeoLite2-City"');
  });

  describe('downloading, from a local stand-in for download.maxmind.com', () => {
    // Two servers on different ports, so the redirect to "storage" is cross-origin, as MaxMind's to R2 is.
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const archive = tarGz('GeoLite2-Country_20261110/GeoLite2-Country.mmdb', mmdb);
    let sha = createHash('sha256').update(archive).digest('hex');
    const listen = async (server: Server): Promise<number> => await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port); });
    });
    const storage = createServer((request, response) => {
      seen.push({ url: `storage${request.url ?? ''}`, headers: request.headers });
      response.end(request.url === '/sha256' ? `${sha}  GeoLite2-Country_20261110.tar.gz
` : archive);
    });
    let storagePort = 0;
    const expectedAuth = `Basic ${btoa(`${credentials.MAXMIND_ACCOUNT_ID}:${credentials.MAXMIND_LICENSE_KEY}`)}`;
    const download = createServer((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers });
      if (request.headers.authorization !== expectedAuth) {
        response.writeHead(401).end('An account ID and license key are required to use this service.');
        return;
      }
      const target = request.url?.endsWith('suffix=tar.gz.sha256') === true ? '/sha256' : '/archive';
      response.writeHead(302, { Location: `http://127.0.0.1:${String(storagePort)}${target}` }).end();
    });
    let base = '';
    beforeAll(async () => {
      storagePort = await listen(storage);
      base = `http://127.0.0.1:${String(await listen(download))}/geoip/databases/GeoLite2-Country/download`;
    });
    afterAll(() => {
      storage.close();
      download.close();
    });
    // The servers run in this process, so the script runs asynchronously.
    const runAsync = async (args: string[], env: Record<string, string>): Promise<{ status: number | null; output: string }> =>
      await new Promise(resolve => {
        const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, MAXMIND_DOWNLOAD_URL: base, ...env } });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', status => { resolve({ status, output }); });
      });

    it('authenticates with Basic auth, follows the redirect without the credentials, and checks the SHA-256', async () => {
      seen.length = 0;
      sha = createHash('sha256').update(archive).digest('hex');
      const out = join(dir, 'downloaded.js');
      const result = await runAsync(['--out', out], credentials);
      expect(result.output).toContain('Downloaded GeoLite2-Country (SHA-256 checked)');
      expect(result.status).toBe(0);
      expect((await load(out)).DATA_INFO.database).toBe('GeoLite2-Country-2026-11-10');
      expect(seen.map(r => r.url)).toEqual([
        '/geoip/databases/GeoLite2-Country/download?suffix=tar.gz',
        'storage/archive',
        '/geoip/databases/GeoLite2-Country/download?suffix=tar.gz.sha256',
        'storage/sha256'
      ]);
      for (const request of seen.filter(r => r.url.startsWith('storage'))) expect(request.headers.authorization).toBeUndefined();
      expect(result.output).not.toContain(credentials.MAXMIND_LICENSE_KEY);
      expect(checkSecrets(out).status).toBe(0);
    });

    it('fails on rejected credentials without printing them', async () => {
      const result = await runAsync(['--out', join(dir, 'rejected.js')], { ...credentials, MAXMIND_LICENSE_KEY: 'Wrong_key_0123456789_mmk' });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('MaxMind rejected the account ID or licence key (HTTP 401)');
      expect(result.output).not.toContain('Wrong_key_0123456789_mmk');
    });

    it('fails when the download does not match its SHA-256', async () => {
      sha = '0'.repeat(64);
      const result = await runAsync(['--out', join(dir, 'corrupt.js')], credentials);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("the download doesn't match MaxMind's SHA-256");
    });
  });

  it('puts the fixture back', async () => {
    const out = join(dir, 'fixture.js');
    expect(run(['--fixture', '--out', out]).status).toBe(0);
    expect(await load(out)).toMatchObject({ DATA, DATA_INFO });
  });
});
