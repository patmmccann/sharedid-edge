// Builds MaxMind's GeoLite2 Country database into the maxmind module: downloads it with your MaxMind account ID and
// licence key (or reads a file you already have), keeps only the country of each address range, and writes the
// compact table to dist/data.js, replacing the fixture the package ships with. Run it after `npm run build` and before
// you bundle, and again at least every 30 days: MaxMind's GeoLite EULA requires you to stop using a release within 30
// days of a newer one.
//
//   MAXMIND_ACCOUNT_ID=… MAXMIND_LICENSE_KEY=… node scripts/build-data.mjs [--ipv4-only] [--out <file>]
//   node scripts/build-data.mjs --file <path to .tar.gz, .mmdb or .mmdb.gz> [--ipv4-only] [--out <file>]
//   node scripts/build-data.mjs --fixture [--out <file>]
//
//   --file       use a file you downloaded yourself instead of downloading (no credentials, no network access)
//   --ipv4-only  leave IPv6 out: a smaller bundle, and IPv6 visitors get no country
//   --fixture    put the fixture back (documentation addresses only)
//   --out        write somewhere other than dist/data.js (the tests use it)
//
// The credentials are read from the environment here and nowhere else: they're sent to download.maxmind.com as HTTP
// Basic authentication, never written to the data file, and never printed. The bundled adapters' builds fail if a
// bundle contains them (scripts/check-build-secrets.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { buildCountryData, dataModuleSource, encodeRangeTable, FIXTURE_TABLE } from '@sharedid-edge/ip-ranges/build';
import { MAXMIND_ATTRIBUTION } from '../dist/attribution.js';

const EDITION = 'GeoLite2-Country';
// MAXMIND_DOWNLOAD_URL replaces MaxMind's download URL, for the tests' local stand-in. Don't set it otherwise: the
// credentials go wherever it points.
const DOWNLOAD = process.env['MAXMIND_DOWNLOAD_URL'] ?? `https://download.maxmind.com/geoip/databases/${EDITION}/download`;
const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    'ipv4-only': { type: 'boolean', default: false },
    fixture: { type: 'boolean', default: false },
    out: { type: 'string' }
  }
});

/** The account ID and licence key, from the environment. */
function credentials() {
  const accountId = process.env['MAXMIND_ACCOUNT_ID'] ?? '';
  const licenseKey = process.env['MAXMIND_LICENSE_KEY'] ?? '';
  if (accountId === '' || licenseKey === '') {
    throw new Error('Set MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY (your MaxMind account ID and a licence key), or use --file');
  }
  return { accountId, licenseKey };
}

/** GETs a download URL with Basic authentication. Errors never include the credentials. */
async function get(url, { accountId, licenseKey }) {
  // fetch follows MaxMind's redirect to a presigned storage URL, and drops the Authorization header when it does.
  const response = await fetch(url, { headers: { Authorization: `Basic ${btoa(`${accountId}:${licenseKey}`)}` } });
  if (response.status === 401) throw new Error(`${url}: MaxMind rejected the account ID or licence key (HTTP 401)`);
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function download() {
  const creds = credentials();
  const archive = await get(`${DOWNLOAD}?suffix=tar.gz`, creds);
  // The .sha256 file is "<hex>  <file name>".
  const expected = new TextDecoder().decode(await get(`${DOWNLOAD}?suffix=tar.gz.sha256`, creds)).trim().split(/\s+/)[0] ?? '';
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', archive))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) throw new Error(`${EDITION}: the download doesn't match MaxMind's SHA-256`);
  console.log(`Downloaded ${EDITION} (SHA-256 checked)`);
  return archive;
}

const out = args.out ?? join(import.meta.dirname, '..', 'dist', 'data.js');
if (args.fixture) {
  const info = { database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: MAXMIND_ATTRIBUTION };
  writeFileSync(out, dataModuleSource(encodeRangeTable(FIXTURE_TABLE), info));
  console.log(`Wrote the fixture to ${out}`);
} else {
  const bytes = args.file === undefined ? await download() : new Uint8Array(readFileSync(args.file));
  const { source, info, stats } = await buildCountryData(bytes, {
    database: built => `${EDITION}-${built}`,
    ipv4Only: args['ipv4-only'],
    attribution: MAXMIND_ATTRIBUTION,
    databaseType: type => type === EDITION
  });
  // The data file is built from the table and its description only, so this can't happen; checked anyway, since the
  // file ships in the bundle. (scripts/check-build-secrets.mjs checks the bundles, with encodings too.)
  for (const name of ['MAXMIND_ACCOUNT_ID', 'MAXMIND_LICENSE_KEY']) {
    const value = process.env[name] ?? '';
    if (value.length >= 8 && source.includes(value)) throw new Error(`The data file would contain ${name}: not written`);
  }
  writeFileSync(out, source);
  console.log(`Wrote ${out}: ${info.database} (${info.families}), ${String(stats.v4Ranges)} IPv4 and ${args['ipv4-only'] ? 0 : String(stats.v6Ranges)} IPv6 ranges, ${String(stats.values)} countries, ${String(stats.v6SubPrefixesFolded)} IPv6 networks smaller than a /64 folded into theirs; ${String(source.length)} bytes, ${String(gzipSync(source).length)} gzipped`);
}
