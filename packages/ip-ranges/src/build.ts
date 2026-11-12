import { MmdbReader, type MmdbMap, type MmdbNetwork, type MmdbValue } from './mmdb.js';
import { dataModuleSource, gunzip, isGzip, tarEntry } from './archive.js';
import type { DataInfo } from './module.js';
import { decodeRangeTable, RANGE_TABLE_VERSION } from './table.js';

export { MmdbReader, type MmdbMap, type MmdbMetadata, type MmdbNetwork, type MmdbValue } from './mmdb.js';
export { dataModuleSource, gunzip, isGzip, tarEntry } from './archive.js';
export type { DataInfo } from './module.js';
export { decodeRangeTable, lookupRange, RANGE_TABLE_VERSION, type RangeTable, type ValueColumn } from './table.js';

/** A range table before encoding: values, and each family's ranges as `[start, value index]` (0 for no data). */
export interface RangeTableSource {
  readonly values: readonly string[];
  /** IPv4 ranges: starts from 0 to 2^32 - 1, increasing, the first at 0. */
  readonly v4: readonly (readonly [start: number, value: number])[];
  /** IPv6 ranges keyed by the first 64 bits: starts increasing, the first at 0. */
  readonly v6: readonly (readonly [start: bigint, value: number])[];
}

/** What `buildRangeTable` did, for the build script's log. */
export interface RangeTableStats {
  readonly networks: number;
  readonly v4Ranges: number;
  readonly v6Ranges: number;
  readonly values: number;
  /**
   * IPv6 networks smaller than a /64, not at its start, with a value other than the /64's. The table is keyed by /64,
   * so each /64 takes the value of its first address, and these addresses get that value instead of their own.
   */
  readonly v6SubPrefixesFolded: number;
}

const V4_IN_V6 = 1n << 32n;
const LOW_64 = (1n << 64n) - 1n;

/** Appends a range, merging it into the previous one when the value is the same. */
function append<T>(ranges: (readonly [T, number])[], start: T, value: number): void {
  const last = ranges.at(-1);
  if (last?.[1] === value) return;
  ranges.push([start, value]);
}

/**
 * Cuts a database down to one value per address: `pick` maps each record to the value the module returns (a country
 * code, say), or undefined to leave the range without data. Adjacent ranges with the same value are merged.
 */
export function buildRangeTable(reader: MmdbReader, pick: (record: MmdbValue) => string | undefined): { source: RangeTableSource; stats: RangeTableStats } {
  const values: string[] = [];
  const valueIndex = new Map<string, number>();
  const byRecord = new Map<number, number>();
  const indexOf = (network: MmdbNetwork): number => {
    if (network.record === undefined) return 0;
    let index = byRecord.get(network.record);
    if (index === undefined) {
      const value = pick(reader.record(network.record));
      if (value === undefined) {
        index = 0;
      } else {
        index = valueIndex.get(value) ?? values.push(value);
        valueIndex.set(value, index);
      }
      byRecord.set(network.record, index);
    }
    return index;
  };
  const v4: (readonly [number, number])[] = [];
  const v6: (readonly [bigint, number])[] = [];
  let networks = 0;
  let folded = 0;
  const ipv6 = reader.metadata.ipVersion === 6;
  for (const network of reader.networks()) {
    networks++;
    if (!ipv6) {
      append(v4, Number(network.start), indexOf(network));
    } else if (network.start < V4_IN_V6 && network.prefixLength >= 96) {
      append(v4, Number(network.start), indexOf(network));
    } else if (network.prefixLength > 64 && (network.start & LOW_64) !== 0n) {
      if (indexOf(network) !== (v6.at(-1)?.[1] ?? 0)) folded++;
    } else {
      append(v6, network.start >> 64n, indexOf(network));
    }
  }
  // A database without IPv4 data has no ::/96 subtree: say "no data" for all of IPv4.
  if (v4.length === 0) v4.push([0, 0]);
  // ::/64 holds the IPv4 subtree, so in an IPv6 database no IPv6 network starts there: it has no data.
  if (v6[0]?.[0] !== 0n) v6.unshift([0n, 0]);
  return {
    source: { values, v4, v6 },
    stats: { networks, v4Ranges: v4.length, v6Ranges: v6.length, values: values.length, v6SubPrefixesFolded: folded }
  };
}

/** Writes unsigned LEB128 varints. */
class VarintWriter {
  readonly #bytes: number[] = [];

  write(value: number | bigint): void {
    let rest = BigInt(value);
    if (rest < 0n) throw new RangeError('varint: negative value');
    while (rest >= 0x80n) {
      this.#bytes.push(Number(rest & 0x7fn) | 0x80);
      rest >>= 7n;
    }
    this.#bytes.push(Number(rest));
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) this.#bytes.push(byte);
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Encodes a range table in the format `decodeRangeTable` reads (described on `RangeTable`), as base64. */
export function encodeRangeTable(source: RangeTableSource): string {
  const out = new VarintWriter();
  const encoder = new TextEncoder();
  out.write(RANGE_TABLE_VERSION);
  out.write(source.values.length);
  for (const value of source.values) {
    const bytes = encoder.encode(value);
    out.write(bytes.length);
    out.writeBytes(bytes);
  }
  const checkValue = (value: number): number => {
    if (!Number.isInteger(value) || value < 0 || value > source.values.length) throw new RangeError('IP range table: value index out of range');
    return value;
  };

  out.write(source.v4.length);
  let previous = 0;
  source.v4.forEach(([start], i) => {
    if (!Number.isInteger(start) || start > 0xffffffff || (i === 0 ? start !== 0 : start <= previous)) throw new RangeError('IP range table: IPv4 starts must increase from 0');
    out.write(start - previous);
    previous = start;
  });
  for (const [, value] of source.v4) out.write(checkValue(value));

  out.write(source.v6.length);
  let previousHigh = 0n;
  let previousLow = 0n;
  let previousStart = -1n;
  source.v6.forEach(([start], i) => {
    if (start > LOW_64 || (i === 0 ? start !== 0n : start <= previousStart)) throw new RangeError('IP range table: IPv6 starts must increase from 0');
    const high = start >> 32n;
    const low = start & 0xffffffffn;
    out.write(high - previousHigh);
    out.write(high === previousHigh ? low - previousLow : low);
    previousHigh = high;
    previousLow = low;
    previousStart = start;
  });
  for (const [, value] of source.v6) out.write(checkValue(value));
  return base64(out.bytes);
}

/** The `country.iso_code` of a GeoIP2/GeoLite2- or DB-IP-style country record, or undefined. */
export function countryCode(record: MmdbValue): string | undefined {
  const country = isMap(record) ? record['country'] : undefined;
  const code = isMap(country) ? country['iso_code'] : undefined;
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

function isMap(value: MmdbValue | undefined): value is MmdbMap {
  return typeof value === 'object' && !(value instanceof Uint8Array) && !Array.isArray(value);
}

export interface CountryDataOptions {
  /**
   * The database's name for `DATA_INFO.database`, such as `dbip-country-lite-2026-11`, or a function giving it from the
   * database's build date (`2026-11-01`).
   */
  readonly database: string | ((built: string) => string);
  /** Leave IPv6 out (every IPv6 address is then a miss), for a smaller table. */
  readonly ipv4Only: boolean;
  /** The attribution the data's licence requires, for `DATA_INFO.attribution`. */
  readonly attribution: string;
  /** Checks the database type in the file's metadata (`DBIP-Country-Lite`, `GeoLite2-Country`). */
  readonly databaseType: (type: string) => boolean;
}

/**
 * Turns a downloaded country database (an `.mmdb` file, gzipped, or in a `.tar.gz` as MaxMind ships it) into the
 * contents of a module's `dist/data.js`: a range table of ISO 3166-1 alpha-2 country codes. The table is decoded
 * again before it's returned, so a broken one fails the build rather than the worker.
 */
export async function buildCountryData(file: Uint8Array, options: CountryDataOptions): Promise<{ readonly source: string; readonly info: DataInfo; readonly stats: RangeTableStats; readonly encodedLength: number }> {
  let bytes = isGzip(file) ? await gunzip(file) : file;
  // A tar archive has "ustar" at offset 257 of its first header.
  if (new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar') {
    const entry = tarEntry(bytes, '.mmdb');
    if (entry === undefined) throw new Error('No .mmdb file in the archive');
    bytes = entry.bytes;
  }
  const reader = new MmdbReader(bytes);
  if (!options.databaseType(reader.metadata.databaseType)) throw new Error(`Unexpected database type "${reader.metadata.databaseType}"`);
  const { source, stats } = buildRangeTable(reader, countryCode);
  const table: RangeTableSource = options.ipv4Only ? { ...source, v6: [[0n, 0]] } : source;
  const encoded = encodeRangeTable(table);
  decodeRangeTable(encoded);
  const built = new Date(reader.metadata.buildEpoch * 1000).toISOString().slice(0, 10);
  const info: DataInfo = {
    database: typeof options.database === 'string' ? options.database : options.database(built),
    built,
    families: options.ipv4Only ? 'ipv4' : 'ipv4,ipv6',
    fixture: false,
    attribution: options.attribution
  };
  return { source: dataModuleSource(encoded, info), info, stats, encodedLength: encoded.length };
}

export { FIXTURE_TABLE } from './fixture.js';
export { encodeMmdbValue, writeMmdb, type MmdbFixtureNetwork, type MmdbFixtureOptions } from './mmdb-writer.js';
