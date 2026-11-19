// Builds IP2Location LITE DB1 (country) and IP2Proxy LITE PX10 (proxy signals) into the ip2location module: downloads
// both ZIP downloads with your free IP2Location download token, or reads files you already have, keeps only what the
// module returns, and writes the compact tables to dist/data.js, replacing the fixtures the package ships with. Run it
// after `npm run build` and before you bundle; LITE is refreshed on the 1st and 15th of each month.
//
//   IP2LOCATION_DOWNLOAD_TOKEN=… node scripts/build-data.mjs [--ipv4-only] [--out <file>]
//   node scripts/build-data.mjs --file <DB1 .zip or .mmdb> --proxy-file <PX10 .zip or .mmdb> [--ipv4-only] [--out <file>]
//   node scripts/build-data.mjs --fixture [--out <file>]
//
//   --file        use a DB1 file you downloaded yourself instead of downloading it (no token needed for it)
//   --proxy-file  the same for the PX10 file
//   --ipv4-only   leave IPv6 out: a smaller bundle, and IPv6 visitors get no country or signal
//   --fixture     put the fixtures back (documentation addresses only)
//   --out         write somewhere other than dist/data.js (the tests use it)
//
// The token is read from the environment here and nowhere else: it goes to ip2location.com in the download URL, is
// never written to the data file, and is never printed. Errors name the file code, never the URL.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { buildCountryData, buildRangeTable, dataModuleSource, encodeRangeTable, FIXTURE_TABLE, isZip, MmdbReader, mmdbBytes } from '@sharedid-edge/ip-ranges/build';
import { IP2LOCATION_ATTRIBUTION, IP2PROXY_ATTRIBUTION } from '../dist/attribution.js';
import { PROXY_FIXTURE_TABLE } from '../dist/fixtures.js';

const COUNTRY_FILE = 'DB1LITEMMDB';
const PROXY_FILE = 'PX10LITEMMDB';
// Tests may replace the vendor endpoint with a loopback HTTP server.
const DOWNLOAD_OVERRIDE = process.env['IP2LOCATION_DOWNLOAD_URL'];
const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    'proxy-file': { type: 'string' },
    'ipv4-only': { type: 'boolean', default: false },
    fixture: { type: 'boolean', default: false },
    out: { type: 'string' }
  }
});

/** The download token, from the environment. */
function token() {
  const value = process.env['IP2LOCATION_DOWNLOAD_TOKEN'] ?? '';
  if (value === '') throw new Error('Set IP2LOCATION_DOWNLOAD_TOKEN (a free IP2Location download token), or use --file and --proxy-file');
  return value;
}

/** GETs one of the LITE downloads. Errors name the file code, never the URL or the token. */
async function get(file) {
  const value = token();
  const url = URL.parse(DOWNLOAD_OVERRIDE ?? 'https://www.ip2location.com/download');
  if (url === null || (DOWNLOAD_OVERRIDE !== undefined &&
    (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username !== '' || url.password !== ''))) {
    throw new Error('IP2LOCATION_DOWNLOAD_URL must be a loopback HTTP URL without credentials');
  }
  url.searchParams.set('token', value);
  url.searchParams.set('file', file);
  let response;
  try {
    response = await fetch(url, { redirect: DOWNLOAD_OVERRIDE === undefined ? 'follow' : 'error' });
  } catch {
    throw new Error(`IP2Location download (${file}): the request failed`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`IP2Location download (${file}): IP2Location rejected the download token (HTTP ${String(response.status)})`);
  if (!response.ok) throw new Error(`IP2Location download (${file}): HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isZip(bytes)) throw new Error(`IP2Location download (${file}): not a ZIP archive`);
  console.log(`Downloaded ${file} (${String(bytes.length)} bytes)`);
  return bytes;
}

/** The proxy kinds in a PX10 record, most specific first, as a table value; undefined when it names none. */
const FLAGS = [
  ['is_tor_exit_node', 'tor'],
  ['is_residential_proxy', 'residential'],
  ['is_anonymous_vpn', 'vpn'],
  ['is_public_proxy', 'public'],
  ['is_hosting_provider', 'datacenter']
];
function proxyCode(record) {
  if (typeof record !== 'object' || record === null || record instanceof Uint8Array || Array.isArray(record)) return undefined;
  const kinds = FLAGS.filter(([key]) => record[key] === true).map(([, kind]) => kind);
  return kinds.length === 0 ? undefined : kinds.join(',');
}

/** Writes the four exports the module reads, from the encoded tables and their descriptions. */
function dataSource(countryData, countryInfo, proxyData, proxyInfo) {
  return [
    dataModuleSource(countryData, countryInfo),
    `export const PROXY_DATA = ${JSON.stringify(proxyData)};`,
    `export const PROXY_DATA_INFO = Object.freeze(${JSON.stringify(proxyInfo)});`,
    ''
  ].join('\n');
}

const out = args.out ?? join(import.meta.dirname, '..', 'dist', 'data.js');
if (args.fixture) {
  const country = { database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: IP2LOCATION_ATTRIBUTION };
  const proxy = { database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: IP2PROXY_ATTRIBUTION };
  writeFileSync(out, dataSource(encodeRangeTable(FIXTURE_TABLE), country, encodeRangeTable(PROXY_FIXTURE_TABLE), proxy));
  console.log(`Wrote the fixtures to ${out}`);
} else {
  const countryBytes = args.file === undefined ? await get(COUNTRY_FILE) : new Uint8Array(readFileSync(args.file));
  const { data: countryData, info: countryInfo, stats: countryStats } = await buildCountryData(countryBytes, {
    database: built => `IP2Location-LITE-DB1-${built}`,
    ipv4Only: args['ipv4-only'],
    attribution: IP2LOCATION_ATTRIBUTION,
    databaseType: type => /^IP2Location LITE DB1$/i.test(type) || type === 'GeoLite2-Country'
  });

  const proxyBytes = args['proxy-file'] === undefined ? await get(PROXY_FILE) : new Uint8Array(readFileSync(args['proxy-file']));
  const reader = new MmdbReader(await mmdbBytes(proxyBytes));
  const type = reader.metadata.databaseType;
  if (!/IP2Proxy.*PX10/i.test(type) && type !== 'GeoIP2-Anonymous-IP') throw new Error(`Unexpected database type "${type}"`);
  const built = new Date(reader.metadata.buildEpoch * 1000).toISOString().slice(0, 10);
  const { source: proxyTable, stats: proxyStats } = buildRangeTable(reader, proxyCode);
  const proxyData = encodeRangeTable(args['ipv4-only'] ? { ...proxyTable, v6: [[0n, 0]] } : proxyTable);
  const proxyInfo = {
    database: `IP2Proxy-LITE-PX10-${built}`,
    built,
    families: args['ipv4-only'] ? 'ipv4' : 'ipv4,ipv6',
    fixture: false,
    attribution: IP2PROXY_ATTRIBUTION
  };
  const source = dataSource(countryData, countryInfo, proxyData, proxyInfo);

  // The data file is built from the tables and their descriptions only, so this can't happen; checked anyway, since
  // the file ships in the bundle. (scripts/check-build-secrets.mjs checks the bundles, with encodings too.)
  const value = process.env['IP2LOCATION_DOWNLOAD_TOKEN'] ?? '';
  if (value.length >= 8 && source.includes(value)) throw new Error('The data file would contain IP2LOCATION_DOWNLOAD_TOKEN: not written');
  writeFileSync(out, source);
  console.log(`Wrote ${out}: ${countryInfo.database} (${countryInfo.families}), ${String(countryStats.v4Ranges)} IPv4 and ${args['ipv4-only'] ? 0 : String(countryStats.v6Ranges)} IPv6 ranges, ${String(countryStats.values)} countries; ${proxyInfo.database}, ${String(proxyStats.v4Ranges)} IPv4 and ${args['ipv4-only'] ? 0 : String(proxyStats.v6Ranges)} IPv6 ranges, ${String(proxyStats.values)} signal sets; ${String(source.length)} bytes, ${String(gzipSync(source).length)} gzipped`);
}
