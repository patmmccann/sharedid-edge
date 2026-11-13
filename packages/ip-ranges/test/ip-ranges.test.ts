import { createHandler, resolveConfig, type PayloadV1, type PlatformInfo } from '@sharedid-edge/core';
import { parseIp, type ParsedIp } from '@sharedid-edge/module-ip';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCountryData,
  buildRangeTable,
  countryCode,
  dataModuleSource,
  decodeRangeTable,
  encodeRangeTable,
  FIXTURE_TABLE,
  lookupRange,
  MmdbReader,
  tarEntry,
  writeMmdb,
  type MmdbFixtureNetwork,
  type RangeTable
} from '../src/build.js';
import { countryFor, geoMode, ipDatabaseModule, ipDatabaseSettings } from '../src/index.js';

function ip(text: string): ParsedIp {
  const parsed = parseIp(text);
  if (parsed === undefined) throw new Error(`not an address: ${text}`);
  return parsed;
}

const country = (code: string): MmdbFixtureNetwork['record'] => ({ country: { iso_code: code, names: { en: code } }, continent: { code: 'EU' } });

/** A small database with IPv4 and IPv6 networks, boundaries next to each other, and gaps. */
const NETWORKS: readonly MmdbFixtureNetwork[] = [
  { network: '1.0.0.0/24', record: country('AU') },
  { network: '1.0.1.0/24', record: country('CN') },
  { network: '1.0.2.0/23', record: country('CN') },
  { network: '5.0.0.0/8', record: country('DE') },
  { network: '192.0.2.0/25', record: country('FR') },
  { network: '192.0.2.128/25', record: { city: 'no country here' } },
  { network: '255.255.255.255/32', record: country('US') },
  { network: '2001:db8::/48', record: country('FR') },
  { network: '2001:db8:1::/48', record: country('JP') },
  { network: '2001:db8:2::/65', record: country('DE') },
  // Smaller than a /64: folded into the /64 it's in, which takes the value of its first address.
  { network: '2001:db8:2:0:8000::/65', record: country('NL') },
  { network: 'ffff:ffff:ffff:ffff::/64', record: country('US') }
];

function table(options: { recordSize?: 24 | 28 | 32; ipv4Aliases?: boolean } = {}): RangeTable {
  const reader = new MmdbReader(writeMmdb({ databaseType: 'Test-Country', ipVersion: 6, networks: NETWORKS, ...options }));
  return decodeRangeTable(encodeRangeTable(buildRangeTable(reader, countryCode).source));
}

describe('MmdbReader', () => {
  it('reads metadata', () => {
    const reader = new MmdbReader(writeMmdb({ databaseType: 'Test-Country', ipVersion: 6, networks: NETWORKS }));
    expect(reader.metadata).toMatchObject({ databaseType: 'Test-Country', ipVersion: 6, recordSize: 24, buildEpoch: 1_793_491_200 });
  });

  it.each([24, 28, 32] as const)('lists networks in address order with record size %i', recordSize => {
    const reader = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 6, networks: NETWORKS, recordSize }));
    const withData = [...reader.networks()].filter(network => network.record !== undefined);
    const starts = withData.map(network => network.start);
    expect(starts).toEqual([...starts].sort((a, b) => (a < b ? -1 : 1)));
    expect(withData.map(network => `${network.start.toString(16)}/${String(network.prefixLength)}`)).toEqual([
      '1000000/120',
      '1000100/120',
      '1000200/119',
      '5000000/104',
      'c0000200/121',
      'c0000280/121',
      'ffffffff/128',
      '20010db8000000000000000000000000/48',
      '20010db8000100000000000000000000/48',
      '20010db8000200000000000000000000/65',
      '20010db8000200008000000000000000/65',
      'ffffffffffffffff0000000000000000/64'
    ]);
  });

  it('lists the IPv4 subtree once when ::ffff:0:0/96 and 2002::/16 alias it', () => {
    const plain = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 6, networks: NETWORKS }));
    const aliased = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 6, networks: NETWORKS, ipv4Aliases: true }));
    const withData = (reader: MmdbReader): bigint[] => [...reader.networks()].filter(n => n.record !== undefined).map(n => n.start);
    expect(withData(aliased)).toEqual(withData(plain));
    // The aliases still resolve when looked up directly.
    expect(aliased.lookup((0xffffn << 32n) | 0x05010203n)).toBe(aliased.lookup(0x05010203n));
  });

  it('lists an alias as a network without data, so the network before it does not run into it', () => {
    // Reported in review: 2001:ffff::/32 ends right where the 2002::/16 alias starts.
    const reader = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 6, ipv4Aliases: true, networks: [
      { network: '5.0.0.0/8', record: country('DE') },
      { network: '2001:ffff::/32', record: country('FR') }
    ] }));
    expect([...reader.networks()].filter(n => n.start === 0x2002n << 112n)).toEqual([{ start: 0x2002n << 112n, prefixLength: 16, record: undefined }]);
    const t = decodeRangeTable(encodeRangeTable(buildRangeTable(reader, countryCode).source));
    expect(lookupRange(t, ip('2001:ffff:ffff::1'))).toBe('FR');
    expect(lookupRange(t, ip('2002:500::'))).toBeUndefined();
    expect(lookupRange(t, ip('2002:ffff:ffff::1'))).toBeUndefined();
    expect(lookupRange(t, ip('5.0.0.1'))).toBe('DE');
  });

  it('decodes records, following pointers', () => {
    const reader = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 4, networks: [
      { network: '10.0.0.0/8', record: { a: 'x', n: 7, big: 2n ** 70n, f: 1.5, yes: true, list: [1, 'two'], bytes: new Uint8Array([1, 2]) } },
      { network: '11.0.0.0/8', record: { a: 'x', n: 7, big: 2n ** 70n, f: 1.5, yes: true, list: [1, 'two'], bytes: new Uint8Array([1, 2]) } }
    ] }));
    const records = [...reader.networks()].flatMap(n => (n.record === undefined ? [] : [reader.record(n.record)]));
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(records[0]);
    expect(records[0]).toEqual({ a: 'x', n: 7, big: 2n ** 70n, f: 1.5, yes: true, list: [1, 'two'], bytes: new Uint8Array([1, 2]) });
  });

  it('rejects files that are not MMDB', () => {
    expect(() => new MmdbReader(new Uint8Array(100))).toThrow('no metadata marker');
  });
});

describe('range tables', () => {
  it.each([24, 28, 32] as const)('look IPv4 and IPv6 addresses up, at and around boundaries (record size %i)', recordSize => {
    const t = table({ recordSize, ipv4Aliases: true });
    const cases: [string, string | undefined][] = [
      ['0.0.0.0', undefined],
      ['0.255.255.255', undefined],
      ['1.0.0.0', 'AU'],
      ['1.0.0.255', 'AU'],
      ['1.0.1.0', 'CN'],
      ['1.0.3.255', 'CN'],
      ['1.0.4.0', undefined],
      ['4.255.255.255', undefined],
      ['5.0.0.0', 'DE'],
      ['5.255.255.255', 'DE'],
      ['6.0.0.0', undefined],
      ['192.0.2.127', 'FR'],
      ['192.0.2.128', undefined],
      ['255.255.255.254', undefined],
      ['255.255.255.255', 'US'],
      ['::ffff:5.1.2.3', 'DE'],
      ['::', undefined],
      ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', undefined],
      ['2001:db8::', 'FR'],
      ['2001:db8:0:ffff:ffff:ffff:ffff:ffff', 'FR'],
      ['2001:db8:1::1', 'JP'],
      ['2001:db8:2::1', 'DE'],
      ['2001:db8:2:0:8000::1', 'DE'],
      ['2001:db8:2:1::', undefined],
      ['2002:500::', undefined],
      ['ffff:ffff:ffff:fffe:ffff::', undefined],
      ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'US']
    ];
    for (const [address, expected] of cases) expect([address, lookupRange(t, ip(address))]).toEqual([address, expected]);
  });

  it('merges neighbouring ranges with the same value', () => {
    const reader = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 6, networks: NETWORKS }));
    const { source, stats } = buildRangeTable(reader, countryCode);
    // 1.0.1.0/24 and 1.0.2.0/23 are both CN: one range.
    expect(source.v4.filter(([, value]) => source.values[value - 1] === 'CN')).toHaveLength(1);
    expect(stats.v6SubPrefixesFolded).toBe(1);
    expect(source.v4[0]).toEqual([0, 0]);
    expect(source.v6[0]).toEqual([0n, 0]);
  });

  it('reads an IPv4-only database', () => {
    const reader = new MmdbReader(writeMmdb({ databaseType: 'T', ipVersion: 4, networks: [{ network: '5.0.0.0/8', record: country('DE') }] }));
    const t = decodeRangeTable(encodeRangeTable(buildRangeTable(reader, countryCode).source));
    expect(lookupRange(t, ip('5.6.7.8'))).toBe('DE');
    expect(lookupRange(t, ip('6.0.0.0'))).toBeUndefined();
    expect(lookupRange(t, ip('2001:db8::1'))).toBeUndefined();
  });

  it('rejects malformed tables', () => {
    expect(() => decodeRangeTable('')).toThrow(RangeError);
    expect(() => decodeRangeTable(btoa(String.fromCharCode(2, 0, 0, 0)))).toThrow('unsupported format version');
    const good = atob(encodeRangeTable(FIXTURE_TABLE));
    expect(() => decodeRangeTable(btoa(good.slice(0, -1)))).toThrow('truncated');
    expect(() => decodeRangeTable(btoa(`${good}\u0000`))).toThrow('trailing data');
    expect(() => encodeRangeTable({ values: ['A'], v4: [[0, 2]], v6: [[0n, 0]] })).toThrow('value index');
    expect(() => encodeRangeTable({ values: [], v4: [[5, 0]], v6: [[0n, 0]] })).toThrow('IPv4 starts');
    expect(() => encodeRangeTable({ values: [], v4: [[0, 0]], v6: [[0n, 0], [0n, 0]] })).toThrow('IPv6 starts');
  });

  it('round-trips the fixture', () => {
    const t = decodeRangeTable(encodeRangeTable(FIXTURE_TABLE));
    expect(lookupRange(t, ip('192.0.2.1'))).toBe('FR');
    expect(lookupRange(t, ip('192.0.2.200'))).toBe('XK');
    expect(lookupRange(t, ip('198.51.100.7'))).toBe('JP');
    expect(lookupRange(t, ip('203.0.113.255'))).toBe('BR');
    expect(lookupRange(t, ip('203.0.114.0'))).toBeUndefined();
    expect(lookupRange(t, ip('8.8.8.8'))).toBeUndefined();
    expect(lookupRange(t, ip('2001:db8::1'))).toBe('FR');
    expect(lookupRange(t, ip('2001:db8:1::1'))).toBe('JP');
    expect(lookupRange(t, ip('2001:db8:2::1'))).toBeUndefined();
    expect(lookupRange(t, ip('2606:4700::1111'))).toBeUndefined();
  });
});

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tar(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode(`${content.length.toString(8).padStart(11, '0')}\0`), 124);
  header[156] = 0x30;
  header.set(new TextEncoder().encode('ustar\u000000'), 257);
  const padded = Math.ceil(content.length / 512) * 512;
  const out = new Uint8Array(512 + padded + 1024);
  out.set(header, 0);
  out.set(content, 512);
  return out;
}

describe('buildCountryData', () => {
  const mmdb = writeMmdb({ databaseType: 'Test-Country', ipVersion: 6, networks: NETWORKS, ipv4Aliases: true });
  const options = { database: 'test-2026-11', ipv4Only: false, attribution: 'Test data.', databaseType: (type: string) => type === 'Test-Country' };

  it('reads a plain, gzipped or tar.gz database into the same data file', async () => {
    const plain = await buildCountryData(mmdb, options);
    const gzipped = await buildCountryData(await gzip(mmdb), options);
    const archived = await buildCountryData(await gzip(tar('Test-Country_20261101/Test-Country.mmdb', mmdb)), options);
    expect(gzipped.source).toBe(plain.source);
    expect(archived.source).toBe(plain.source);
    expect(plain.info).toEqual({ database: 'test-2026-11', built: '2026-11-01', families: 'ipv4,ipv6', fixture: false, attribution: 'Test data.' });
    expect(plain.source).toMatch(/^\/\/ Generated at build time from test-2026-11\. Test data\./);
  });

  it('names the database from its build date when asked', async () => {
    const { info } = await buildCountryData(mmdb, { ...options, database: built => `test-${built.slice(0, 7)}` });
    expect(info.database).toBe('test-2026-11');
  });

  it('leaves IPv6 out with ipv4Only', async () => {
    const both = await buildCountryData(mmdb, options);
    const v4 = await buildCountryData(mmdb, { ...options, ipv4Only: true });
    expect(v4.info.families).toBe('ipv4');
    expect(v4.encodedLength).toBeLessThan(both.encodedLength);
  });

  it('rejects another database type', async () => {
    await expect(buildCountryData(mmdb, { ...options, databaseType: type => type === 'Other' })).rejects.toThrow('Unexpected database type "Test-Country"');
  });

  it('finds the .mmdb file in a tar archive', () => {
    const archive = tar('dir/readme.txt', new Uint8Array(3));
    expect(tarEntry(archive, '.mmdb')).toBeUndefined();
    expect(tarEntry(tar('dir/x.mmdb', mmdb), '.mmdb')?.name).toBe('dir/x.mmdb');
  });

  it('writes only base64', () => {
    expect(() => dataModuleSource('"; alert(1); "', { database: 'x', built: '2026-11-01', families: 'ipv4', fixture: false, attribution: '' })).toThrow('base64');
  });
});

describe('ipDatabaseModule', () => {
  const data = encodeRangeTable(FIXTURE_TABLE);

  async function payload(platform: PlatformInfo, options: { config?: Record<string, unknown>; ipservice?: number; modules?: string } = {}): Promise<PayloadV1> {
    const module = ipDatabaseModule({ name: 'test-db', data, ...(options.ipservice === undefined ? {} : { ipservice: options.ipservice }) });
    const handler = createHandler({
      modules: [module],
      config: resolveConfig({ SID_MODULES: options.modules ?? 'test-db', SID_MODULE_CONFIG: JSON.stringify({ 'test-db': options.config ?? {} }) })
    });
    return (await (await handler(new Request('https://www.example.com/_sid/v1'), platform)).json()) as PayloadV1;
  }

  it('sends the country as alpha-3 when the platform has none', async () => {
    expect(await payload({ clientIp: '192.0.2.1' })).toMatchObject({ ortb2: { device: { geo: { type: 2, country: 'FRA' } } }, ext: { modules: { 'test-db': { status: 'ok' } } } });
    expect(await payload({ clientIp: '2001:db8:1::5' })).toMatchObject({ ortb2: { device: { geo: { type: 2, country: 'JPN' } } } });
    expect(await payload({ clientIp: '::ffff:203.0.113.9' })).toMatchObject({ ortb2: { device: { geo: { type: 2, country: 'BRA' } } } });
  });

  it('adds ipservice when the vendor has one', async () => {
    expect(await payload({ clientIp: '192.0.2.1' }, { ipservice: 3 })).toMatchObject({ ortb2: { device: { geo: { type: 2, country: 'FRA', ipservice: 3 } } } });
  });

  it('reports publication-age staleness with last-good output, on misses, and rejects invalid ages', async () => {
    const info = { database: 'test', built: '2026-11-01', families: 'ipv4,ipv6' as const, fixture: true, attribution: 'Test' };
    const module = ipDatabaseModule({ name: 'test-db', data, info, now: () => Date.parse('2026-11-13') });
    for (const maxAgeDays of [1, 20, 0, -1, 'old']) {
      const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'test-db', SID_MODULE_CONFIG: JSON.stringify({ 'test-db': { maxAgeDays } }) }) });
      for (const clientIp of ['192.0.2.7', '203.0.114.1']) {
        const body = await (await handler(new Request('https://example.com/_sid/v1'), { clientIp })).json() as PayloadV1;
        const report = body.ext.modules['test-db'];
        if (maxAgeDays === 1) expect(report?.stale).toBe(true);
        else expect(report?.stale).toBeUndefined();
        if (maxAgeDays === 1 || maxAgeDays === 20) {
          expect(body.ortb2 === undefined).toBe(clientIp === '203.0.114.1');
        } else expect(report?.status).toBe('error');
      }
    }
  });

  it('parses the publication date once, at creation, not per request', async () => {
    const info = { database: 'test', built: '2026-11-01', families: 'ipv4,ipv6' as const, fixture: true, attribution: 'Test' };
    const parse = vi.spyOn(Date, 'parse');
    try {
      const module = ipDatabaseModule({ name: 'test-db', data: decodeRangeTable(data), info, now: () => Date.UTC(2026, 10, 13) });
      expect(parse).toHaveBeenCalledOnce();
      const handler = createHandler({ modules: [module], config: resolveConfig({ SID_MODULES: 'test-db', SID_MODULE_CONFIG: '{"test-db":{"maxAgeDays":1}}' }) });
      for (let request = 0; request < 3; request++) {
        const body = await (await handler(new Request('https://example.com/_sid/v1'), { clientIp: '192.0.2.7' })).json() as PayloadV1;
        expect(body.ext.modules['test-db']).toMatchObject({ status: 'ok', stale: true });
      }
      expect(parse).toHaveBeenCalledOnce();
    } finally { parse.mockRestore(); }
  });

  it('validates every IP database setting in geoMode and ipDatabaseSettings', () => {
    expect(ipDatabaseSettings('db', { mode: 'replace', maxAgeDays: 30 })).toEqual({ mode: 'replace', maxAgeDays: 30 });
    expect(ipDatabaseSettings('db', {})).toEqual({ mode: 'fill' });
    expect(geoMode('db', { maxAgeDays: 30 })).toBe('fill');
    for (const config of [{ maxAgeDays: 0 }, { maxAgeDays: '30' }, { maxAgeDays: Infinity }, { other: 1 }, { mode: 'merge' }]) {
      expect(() => geoMode('db', config)).toThrow(TypeError);
    }
  });

  it('sends nothing for a miss, a code without alpha-3, a missing or invalid address', async () => {
    for (const platform of [{ clientIp: '8.8.8.8' }, { clientIp: '192.0.2.200' }, {}, { clientIp: 'not an ip' }]) {
      const body = await payload(platform);
      expect(body.ortb2).toBeUndefined();
      expect(body).toMatchObject({ ext: { modules: { 'test-db': { status: 'empty' } } } });
    }
  });

  it('fills only when the platform has no usable country, and replaces with mode replace', async () => {
    expect((await payload({ clientIp: '192.0.2.1', country: 'DE' })).ortb2).toBeUndefined();
    expect(await payload({ clientIp: '192.0.2.1', country: 'XK' })).toMatchObject({ ortb2: { device: { geo: { country: 'FRA' } } } });
    expect(await payload({ clientIp: '192.0.2.1', country: 'DE' }, { config: { mode: 'fill' } })).not.toHaveProperty('ortb2');
    expect(await payload({ clientIp: '192.0.2.1', country: 'DE' }, { config: { mode: 'replace' } })).toMatchObject({ ortb2: { device: { geo: { country: 'FRA' } } } });
  });

  it('reports a bad setting as an error', async () => {
    expect(await payload({ clientIp: '192.0.2.1' }, { config: { mode: 'merge' } })).toMatchObject({ ext: { modules: { 'test-db': { status: 'error' } } } });
    expect(await payload({ clientIp: '192.0.2.1' }, { config: { mod: 'fill' } })).toMatchObject({ ext: { modules: { 'test-db': { status: 'error' } } } });
    expect(() => geoMode('x', { mode: 1 })).toThrow('"mode" must be "fill" or "replace"');
  });

  it('countryFor maps to alpha-3', () => {
    const t = decodeRangeTable(data);
    expect(countryFor(t, '198.51.100.1')).toBe('JPN');
    expect(countryFor(t, undefined)).toBeUndefined();
  });
});
