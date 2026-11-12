// Builds DB-IP's IP to Country Lite database into the dbip module: downloads the month's MMDB file from db-ip.com (or
// reads one you already have), keeps only the country of each address range, and writes the compact table to
// dist/data.js, replacing the fixture the package ships with. Run it after `npm run build` and before you bundle; run
// it again each month, when DB-IP publishes a new release. No account or key is needed.
//
//   node scripts/build-data.mjs [--month YYYY-MM] [--file <path to .mmdb or .mmdb.gz>] [--ipv4-only] [--fixture] [--out <file>]
//
//   --month      the release to download (default: this month's, or last month's if this month's isn't out yet)
//   --file       use a file you downloaded yourself instead of downloading (no network access)
//   --ipv4-only  leave IPv6 out: a smaller bundle, and IPv6 visitors get no country
//   --fixture    put the fixture back (documentation addresses only)
//   --out        write somewhere other than dist/data.js (the tests use it)
//
// The data is licensed by DB-IP under CC BY 4.0 (https://db-ip.com/db/lite.php): see the README's "Data and licence".
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { buildCountryData, dataModuleSource, encodeRangeTable, FIXTURE_TABLE } from '@sharedid-edge/ip-ranges/build';
import { DBIP_ATTRIBUTION } from '../dist/attribution.js';

const DIST = join(import.meta.dirname, '..', 'dist');
const { values: args } = parseArgs({
  options: {
    month: { type: 'string' },
    file: { type: 'string' },
    'ipv4-only': { type: 'boolean', default: false },
    fixture: { type: 'boolean', default: false },
    out: { type: 'string' }
  }
});

/** The release name for a month, like dbip-country-lite-2026-11. */
const release = month => `dbip-country-lite-${month}`;
const monthOf = date => date.toISOString().slice(0, 7);

async function download(month) {
  const url = `https://download.db-ip.com/free/${release(month)}.mmdb.gz`;
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  console.log(`Downloaded ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function databaseBytes() {
  if (args.file !== undefined) {
    // Named after the month the file says it was built in.
    return { bytes: new Uint8Array(readFileSync(args.file)), database: built => release(built.slice(0, 7)) };
  }
  if (args.month !== undefined) {
    if (!/^\d{4}-\d{2}$/.test(args.month)) throw new Error('--month must be YYYY-MM');
    const bytes = await download(args.month);
    if (bytes === undefined) throw new Error(`DB-IP has no release for ${args.month}`);
    return { bytes, database: release(args.month) };
  }
  // A month's release comes out on its first days: fall back to last month's until then.
  const now = new Date();
  for (const month of [monthOf(now), monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))]) {
    const bytes = await download(month);
    if (bytes !== undefined) return { bytes, database: release(month) };
  }
  throw new Error('No DB-IP release found for this month or last month');
}

const out = args.out ?? join(DIST, 'data.js');
if (args.fixture) {
  const info = { database: 'fixture', built: '2026-11-01', families: 'ipv4,ipv6', fixture: true, attribution: DBIP_ATTRIBUTION };
  writeFileSync(out, dataModuleSource(encodeRangeTable(FIXTURE_TABLE), info));
  console.log(`Wrote the fixture to ${out}`);
} else {
  const { bytes, database } = await databaseBytes();
  const { source, info, stats } = await buildCountryData(bytes, {
    database,
    ipv4Only: args['ipv4-only'],
    attribution: DBIP_ATTRIBUTION,
    databaseType: type => type === 'DBIP-Country-Lite'
  });
  writeFileSync(out, source);
  console.log(`Wrote ${out}: ${info.database} (built ${info.built}, ${info.families}), ${String(stats.v4Ranges)} IPv4 and ${args['ipv4-only'] ? 0 : String(stats.v6Ranges)} IPv6 ranges, ${String(stats.values)} countries, ${String(stats.v6SubPrefixesFolded)} IPv6 networks smaller than a /64 folded into theirs; ${String(source.length)} bytes, ${String(gzipSync(source).length)} gzipped`);
}
