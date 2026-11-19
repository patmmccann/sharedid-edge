import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHandler, resolveConfig, type EdgeModule, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { decodeRangeTable, lookupClient } from '@sharedid-edge/ip-ranges';
import { encodeRangeTable, FIXTURE_TABLE, writeMmdb } from '@sharedid-edge/ip-ranges/build';
import { geoModule } from '@sharedid-edge/module-geo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA, DATA_INFO, PROXY_DATA, PROXY_DATA_INFO, PROXY_FIXTURE_TABLE } from '../src/data.js';
import { createIp2LocationModule, IP2LOCATION_ATTRIBUTION, IP2LOCATION_DATA_INFO, IP2LOCATION_IPSERVICE, ip2locationModule, IP2PROXY_ATTRIBUTION, IP2PROXY_DATA_INFO } from '../src/index.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');

async function payload(platform: PlatformInfo, env: Record<string, string> = {}, modules: readonly EdgeModule[] = [ip2locationModule], path = '/_sid/v1', headers: Record<string, string> = {}): Promise<PayloadV1> {
  const handler = createHandler({ modules, config: resolveConfig({ SID_MODULES: 'ip2location', ...env }) });
  return (await (await handler(new Request(`https://www.example.com${path}`, { headers }), platform)).json()) as PayloadV1;
}

describe('the bundled fixtures', () => {
  it('are the shared country fixture and the hand-made proxy fixture, and say so', () => {
    expect(DATA).toBe(encodeRangeTable(FIXTURE_TABLE));
    expect(PROXY_DATA).toBe(encodeRangeTable(PROXY_FIXTURE_TABLE));
    expect(DATA_INFO).toEqual({ database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: IP2LOCATION_ATTRIBUTION });
    expect(PROXY_DATA_INFO).toEqual({ database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: IP2PROXY_ATTRIBUTION });
    expect(IP2LOCATION_DATA_INFO).toBe(DATA_INFO);
    expect(IP2PROXY_DATA_INFO).toBe(PROXY_DATA_INFO);
  });
});

describe('ip2locationModule', () => {
  it('returns the country as alpha-3 with ipservice 1, and the proxy signal', async () => {
    expect(IP2LOCATION_IPSERVICE).toBe(1);
    const body = await payload({ clientIp: '192.0.2.10' });
    expect(body.ortb2).toEqual({
      device: {
        geo: { type: 2, country: 'FRA', ipservice: 1 },
        ext: { traffic: { proxy: 'tor', sources: ['ip2location'] } }
      }
    });
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'ok' });
    expect((await payload({ clientIp: '2001:db8:1::1' })).ortb2).toEqual({
      device: {
        geo: { type: 2, country: 'JPN', ipservice: 1 },
        ext: { traffic: { proxy: 'vpn', sources: ['ip2location'] } }
      }
    });
  });

  it('returns only the traffic signal when the country has no alpha-3 code', async () => {
    const body = await payload({ clientIp: '192.0.2.150' });
    expect(body.ortb2).toEqual({ device: { ext: { traffic: { proxy: 'residential', sources: ['ip2location'] } } } });
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'ok' });
  });

  it('keeps the most specific proxy kind', async () => {
    expect((await payload({ clientIp: '198.51.100.5' })).ortb2).toEqual({
      device: {
        geo: { type: 2, country: 'JPN', ipservice: 1 },
        ext: { traffic: { proxy: 'public', sources: ['ip2location'] } }
      }
    });
  });

  it('returns nothing for an address it does not know', async () => {
    const body = await payload({ clientIp: '8.8.8.8' });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'empty' });
  });

  it('fills the country geo leaves out, and replaces it when told to, listed after geo', async () => {
    const modules = [geoModule, ip2locationModule];
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,ip2location' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'DEU', region: 'BE' }, ext: { traffic: { proxy: 'tor', sources: ['ip2location'] } } } });
    expect((await payload({ clientIp: '192.0.2.10', region: 'IDF' }, { SID_MODULES: 'geo,ip2location' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'IDF', ipservice: 1 }, ext: { traffic: { proxy: 'tor', sources: ['ip2location'] } } } });
    expect((await payload({ clientIp: '192.0.2.10', country: 'DE', region: 'BE' }, { SID_MODULES: 'geo,ip2location', SID_MODULE_CONFIG: '{"ip2location":{"mode":"replace"}}' }, modules)).ortb2)
      .toEqual({ device: { geo: { type: 2, country: 'FRA', region: 'BE', ipservice: 1 }, ext: { traffic: { proxy: 'tor', sources: ['ip2location'] } } } });
  });

  it('sends the country and the signal, coarse data, whatever the consent signals, as geo does', async () => {
    const ip = { clientIp: '203.0.113.9' };
    const expected = { device: { geo: { type: 2, country: 'BRA', ipservice: 1 } } };
    for (const [path, platform, headers] of [
      ['/_sid/v1', ip, { 'Sec-GPC': '1' }],
      ['/_sid/v1?gdpr=1', ip, {}],
      ['/_sid/v1', { ...ip, isEU: true }, {}],
      ['/_sid/v1?us_privacy=1YYN', ip, {}],
      ['/_sid/v1?coppa=1', ip, {}],
      ['/_sid/v1', ip, { Cookie: '_pubcid_optout=1' }]
    ] as const) {
      expect((await payload(platform, {}, [ip2locationModule], path, headers)).ortb2).toEqual(expected);
    }
  });

  it('reports stale data but keeps its output', async () => {
    const body = await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"ip2location":{"maxAgeDays":1}}' });
    expect(body.ortb2).toEqual({
      device: {
        geo: { type: 2, country: 'FRA', ipservice: 1 },
        ext: { traffic: { proxy: 'tor', sources: ['ip2location'] } }
      }
    });
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'ok', stale: true });
  });

  it('reports an old proxy table even when the lookup adds nothing', async () => {
    const module = createIp2LocationModule({
      country: { data: DATA, info: { ...DATA_INFO, built: '2026-11-17' } },
      proxy: { data: PROXY_DATA, info: { ...PROXY_DATA_INFO, built: '2020-01-01' } },
      now: () => Date.parse('2026-11-18T00:00:00Z')
    });
    const body = await payload({ clientIp: '8.8.8.8', country: 'DE' }, { SID_MODULE_CONFIG: '{"ip2location":{"maxAgeDays":1}}' }, [module]);
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'empty', stale: true });
  });

  it('uses the supplied clock to report an old country table with a fresh proxy table', async () => {
    const module = createIp2LocationModule({
      country: { data: DATA, info: { ...DATA_INFO, built: '2099-01-01' } },
      proxy: { data: PROXY_DATA, info: { ...PROXY_DATA_INFO, built: '2099-01-03' } },
      now: () => Date.UTC(2099, 0, 3)
    });
    const body = await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"ip2location":{"maxAgeDays":1}}' }, [module]);
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'ok', stale: true });
  });

  it('reports an invalid proxy date as an error when maxAgeDays is set', async () => {
    const module = createIp2LocationModule({
      country: { data: DATA, info: DATA_INFO },
      proxy: { data: PROXY_DATA, info: { ...PROXY_DATA_INFO, built: 'invalid' } }
    });
    const body = await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"ip2location":{"maxAgeDays":1}}' }, [module]);
    expect(body.ext.modules['ip2location']).toMatchObject({ status: 'error' });
    expect(body.ortb2).toBeUndefined();
  });

  it('reports a bad setting as an error', async () => {
    expect((await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"ip2location":{"mode":"merge"}}' })).ext.modules['ip2location']).toMatchObject({ status: 'error' });
    expect((await payload({ clientIp: '192.0.2.10' }, { SID_MODULE_CONFIG: '{"ip2location":{"unknown":1}}' })).ext.modules['ip2location']).toMatchObject({ status: 'error' });
  });
});

/** A ZIP archive with stored entries. Checksums are 0: the reader doesn't use them. */
function zip(files: readonly { name: string; content: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, file.content.length, true);
    lv.setUint32(22, file.content.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, file.content.length, true);
    cv.setUint32(24, file.content.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, file.content);
    centrals.push(central);
    offset += local.length + file.content.length;
  }
  const directorySize = centrals.reduce((total, central) => total + central.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...parts, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('scripts/build-data.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sid-ip2location-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const script = join(import.meta.dirname, '..', 'scripts', 'build-data.mjs');
  // Made-up token, as a deployer's build would have it in its environment.
  const credentials = { IP2LOCATION_DOWNLOAD_TOKEN: 'Test_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_ip2l' };
  const run = (args: string[], env: Record<string, string> = credentials): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const checkSecrets = (file: string): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, [join(root, 'scripts', 'check-build-secrets.mjs'), file], { encoding: 'utf8', env: { ...process.env, ...credentials } });
  const load = async (file: string): Promise<{ DATA: string; DATA_INFO: { database: string; built: string; families: string; fixture: boolean; attribution: string }; PROXY_DATA: string; PROXY_DATA_INFO: { database: string; built: string; families: string; fixture: boolean; attribution: string } }> => {
    const loaded: unknown = await import(`${pathToFileURL(file).href}?${String(Date.now())}`);
    return loaded as never;
  };
  const country = (code: string): Record<string, Record<string, string>> => ({ country: { iso_code: code }, continent: { code: 'EU' } });
  const countryMmdb = writeMmdb({
    databaseType: 'IP2Location LITE DB1',
    ipVersion: 6,
    buildEpoch: Date.UTC(2026, 10, 15) / 1000,
    ipv4Aliases: true,
    networks: [
      { network: '5.0.0.0/8', record: country('DE') },
      { network: '2a00::/12', record: country('NL') }
    ]
  });
  const proxyMmdb = writeMmdb({
    databaseType: 'IP2Proxy LITE PX10',
    ipVersion: 6,
    buildEpoch: Date.UTC(2026, 10, 15) / 1000,
    ipv4Aliases: true,
    networks: [
      { network: '5.0.0.0/8', record: { is_public_proxy: true, is_hosting_provider: true } },
      { network: '6.0.0.0/8', record: { is_tor_exit_node: true } },
      { network: '7.0.0.0/8', record: { is_anonymous_vpn: true } },
      { network: '8.0.0.0/8', record: { is_residential_proxy: true } },
      { network: '2a00::/12', record: { is_anonymous_vpn: true } }
    ]
  });
  const countryZip = (bytes: Uint8Array): Uint8Array => zip([{ name: 'license.txt', content: new Uint8Array(3) }, { name: 'IP2LOCATION-LITE-DB1.MMDB', content: bytes }]);
  const proxyZip = (bytes: Uint8Array): Uint8Array => zip([{ name: 'IP2PROXY-LITE-PX10.MMDB', content: bytes }]);

  function files(): { country: string; proxy: string } {
    const countryFile = join(dir, 'DB1.zip');
    const proxyFile = join(dir, 'PX10.zip');
    writeFileSync(countryFile, countryZip(countryMmdb));
    writeFileSync(proxyFile, proxyZip(proxyMmdb));
    return { country: countryFile, proxy: proxyFile };
  }

  it('builds both tables from the ZIP downloads, without the network and with no token in the output', async () => {
    const { country: countryFile, proxy: proxyFile } = files();
    const out = join(dir, 'data.js');
    const result = run(['--file', countryFile, '--proxy-file', proxyFile, '--out', out]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/IP2Location-LITE-DB1-2026-11-15 \(ipv4,ipv6\), 3 IPv4 and \d+ IPv6 ranges, 2 countries; IP2Proxy-LITE-PX10-2026-11-15, 6 IPv4 and \d+ IPv6 ranges, 4 signal sets/);
    const { DATA_INFO: info, PROXY_DATA: proxyData, PROXY_DATA_INFO: proxyInfo } = await load(out);
    expect(info).toEqual({ database: 'IP2Location-LITE-DB1-2026-11-15', built: '2026-11-15', families: 'ipv4,ipv6', fixture: false, attribution: IP2LOCATION_ATTRIBUTION });
    expect(proxyInfo).toEqual({ database: 'IP2Proxy-LITE-PX10-2026-11-15', built: '2026-11-15', families: 'ipv4,ipv6', fixture: false, attribution: IP2PROXY_ATTRIBUTION });
    const table = decodeRangeTable(proxyData);
    expect(lookupClient(table, '5.6.7.8')).toBe('public,datacenter');
    expect(lookupClient(table, '6.6.6.6')).toBe('tor');
    expect(lookupClient(table, '2a01::1')).toBe('vpn');

    // The token was in the build's environment: neither it nor its encodings are in the output or the log.
    const text = readFileSync(out, 'latin1');
    for (const form of [credentials.IP2LOCATION_DOWNLOAD_TOKEN, btoa(credentials.IP2LOCATION_DOWNLOAD_TOKEN), Buffer.from(credentials.IP2LOCATION_DOWNLOAD_TOKEN).toString('hex'), encodeURIComponent(credentials.IP2LOCATION_DOWNLOAD_TOKEN)]) expect(text).not.toContain(form);
    expect(`${result.stdout}${result.stderr}`).not.toContain(credentials.IP2LOCATION_DOWNLOAD_TOKEN);
    const check = checkSecrets(out);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('IP2LOCATION_DOWNLOAD_TOKEN');
  });

  it('needs the token to download, and says so before reaching the network', () => {
    const result = run(['--out', join(dir, 'x.js')], { IP2LOCATION_DOWNLOAD_TOKEN: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set IP2LOCATION_DOWNLOAD_TOKEN');
  });

  it('builds IPv4 only', async () => {
    const { country: countryFile, proxy: proxyFile } = files();
    const out = join(dir, 'v4.js');
    expect(run(['--file', countryFile, '--proxy-file', proxyFile, '--out', out, '--ipv4-only']).status).toBe(0);
    const loaded = await load(out);
    expect(loaded.DATA_INFO.families).toBe('ipv4');
    expect(loaded.PROXY_DATA_INFO.families).toBe('ipv4');
  });

  it('refuses another database', () => {
    const file = join(dir, 'city.mmdb');
    writeFileSync(file, writeMmdb({ databaseType: 'IP2Location LITE DB11', ipVersion: 4, networks: [] }));
    const { proxy: proxyFile } = files();
    const result = run(['--file', file, '--proxy-file', proxyFile, '--out', join(dir, 'y.js')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unexpected database type "IP2Location LITE DB11"');
  });

  it('rejects a non-loopback download override without printing it', () => {
    const endpoint = 'https://example.invalid/download';
    const result = run(['--out', join(dir, 'remote.js')], { ...credentials, IP2LOCATION_DOWNLOAD_URL: endpoint });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('IP2LOCATION_DOWNLOAD_URL must be a loopback HTTP URL');
    expect(result.stderr).not.toContain(endpoint);
    expect(result.stderr).not.toContain(credentials.IP2LOCATION_DOWNLOAD_TOKEN);
  });

  describe('downloading, from a local stand-in for ip2location.com', () => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    let base = '';
    const download = createServer((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers });
      if (request.url?.startsWith('/redirect?') === true) {
        response.writeHead(302, { Location: '/download' }).end();
        return;
      }
      const file = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('file');
      if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') !== credentials.IP2LOCATION_DOWNLOAD_TOKEN) {
        response.writeHead(401).end('Invalid token');
        return;
      }
      response.end(file === 'PX10LITEMMDB' ? proxyZip(proxyMmdb) : countryZip(countryMmdb));
    });
    beforeAll(async () => {
      const port = await new Promise<number>(resolve => {
        download.listen(0, '127.0.0.1', () => { resolve((download.address() as AddressInfo).port); });
      });
      base = `http://127.0.0.1:${String(port)}/download`;
    });
    afterAll(() => {
      download.close();
    });
    // The server runs in this process, so the script runs asynchronously.
    const runAsync = async (args: string[], env: Record<string, string>): Promise<{ status: number | null; output: string }> =>
      await new Promise(resolve => {
        const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, IP2LOCATION_DOWNLOAD_URL: base, ...env } });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', status => { resolve({ status, output }); });
      });

    it('sends the token to the stand-in, and never prints it', async () => {
      seen.length = 0;
      const out = join(dir, 'downloaded.js');
      const result = await runAsync(['--out', out], credentials);
      expect(result.output).toContain('Downloaded DB1LITEMMDB');
      expect(result.output).toContain('Downloaded PX10LITEMMDB');
      expect(result.status).toBe(0);
      expect(seen.map(r => r.url)).toEqual([
        `/download?token=${credentials.IP2LOCATION_DOWNLOAD_TOKEN}&file=DB1LITEMMDB`,
        `/download?token=${credentials.IP2LOCATION_DOWNLOAD_TOKEN}&file=PX10LITEMMDB`
      ]);
      expect(result.output).not.toContain(credentials.IP2LOCATION_DOWNLOAD_TOKEN);
      expect(checkSecrets(out).status).toBe(0);
    });

    it('does not follow redirects from the download override', async () => {
      seen.length = 0;
      const result = await runAsync(['--out', join(dir, 'redirected.js')], {
        ...credentials,
        IP2LOCATION_DOWNLOAD_URL: new URL('/redirect', base).href
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('the request failed');
      expect(seen.map(request => request.url.split('?')[0])).toEqual(['/redirect']);
    });

    it('fails on a rejected token without printing it', async () => {
      const result = await runAsync(['--out', join(dir, 'rejected.js')], { IP2LOCATION_DOWNLOAD_TOKEN: 'Wrong_token_0123456789_ip2l' });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('IP2Location rejected the download token (HTTP 401)');
      expect(result.output).not.toContain('Wrong_token_0123456789_ip2l');
    });
  });

  it('puts the fixtures back', async () => {
    const out = join(dir, 'fixture.js');
    expect(run(['--fixture', '--out', out]).status).toBe(0);
    expect(await load(out)).toMatchObject({ DATA, DATA_INFO, PROXY_DATA, PROXY_DATA_INFO });
  });
});
