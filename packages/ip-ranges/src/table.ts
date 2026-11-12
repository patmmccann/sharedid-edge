import type { ParsedIp } from '@sharedid-edge/module-ip';

/**
 * A compact IP range table: the address space split into ranges, each with a value (a string such as a country code)
 * or none. Built at build time from a database (`buildRangeTable` in `@sharedid-edge/ip-ranges/build`) and bundled
 * with a module as a base64 string; decoded once when the module loads; looked up in memory with no network access.
 *
 * Format (version 1), before base64, every integer an unsigned LEB128 varint:
 *
 * - `1` (the format version);
 * - the values: their count, then each as its UTF-8 byte length and bytes. Value index 0 is "no data"; the first
 *   value is index 1;
 * - IPv4: the number of ranges, then each range's start minus the previous range's start (the first range starts at
 *   0.0.0.0), then each range's value index;
 * - IPv6, keyed by the first 64 bits of the address (the /64): the number of ranges, then for each range the high 32
 *   bits minus the previous range's, followed by the low 32 bits (minus the previous range's when the high bits are
 *   the same), then each range's value index.
 *
 * Starts and values are stored as separate columns because they compress better that way.
 */
export interface RangeTable {
  readonly values: readonly string[];
  readonly v4Starts: Uint32Array;
  readonly v4Values: ValueColumn;
  readonly v6High: Uint32Array;
  readonly v6Low: Uint32Array;
  readonly v6Values: ValueColumn;
}

/** Value indexes, in the smallest array that holds them. */
export type ValueColumn = Uint8Array | Uint16Array | Uint32Array;

/** The format version `encodeRangeTable` writes and `decodeRangeTable` reads. */
export const RANGE_TABLE_VERSION = 1;

/** Reads unsigned LEB128 varints (up to 2^53) from a byte array. */
class VarintReader {
  #at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  next(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.bytes[this.#at++];
      if (byte === undefined) throw new RangeError('IP range table: truncated');
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
      if (scale > 2 ** 49) throw new RangeError('IP range table: varint too long');
    }
  }

  take(length: number): Uint8Array {
    if (this.#at + length > this.bytes.length) throw new RangeError('IP range table: truncated');
    const out = this.bytes.subarray(this.#at, this.#at + length);
    this.#at += length;
    return out;
  }

  get done(): boolean {
    return this.#at === this.bytes.length;
  }
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function column(reader: VarintReader, count: number, max: number): ValueColumn {
  const out = max < 0x100 ? new Uint8Array(count) : max < 0x10000 ? new Uint16Array(count) : new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const value = reader.next();
    if (value > max) throw new RangeError('IP range table: value out of range');
    out[i] = value;
  }
  return out;
}

/** Decodes a base64 range table. Throws a `RangeError` when it's malformed. */
export function decodeRangeTable(encoded: string): RangeTable {
  const reader = new VarintReader(base64Bytes(encoded));
  if (reader.next() !== RANGE_TABLE_VERSION) throw new RangeError('IP range table: unsupported format version');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values: string[] = [];
  const valueCount = reader.next();
  for (let i = 0; i < valueCount; i++) values.push(decoder.decode(reader.take(reader.next())));

  const v4Count = reader.next();
  const v4Starts = new Uint32Array(v4Count);
  let start = 0;
  for (let i = 0; i < v4Count; i++) {
    const delta = reader.next();
    if (i > 0 && delta === 0) throw new RangeError('IP range table: IPv4 starts must increase');
    start += delta;
    if (start > 0xffffffff) throw new RangeError('IP range table: IPv4 start out of range');
    v4Starts[i] = start;
  }
  if (v4Count > 0 && v4Starts[0] !== 0) throw new RangeError('IP range table: the first IPv4 range must start at 0.0.0.0');
  const v4Values = column(reader, v4Count, values.length);

  const v6Count = reader.next();
  const v6High = new Uint32Array(v6Count);
  const v6Low = new Uint32Array(v6Count);
  let high = 0;
  let low = 0;
  for (let i = 0; i < v6Count; i++) {
    const highDelta = reader.next();
    const lowValue = reader.next();
    if (i > 0 && highDelta === 0 && lowValue === 0) throw new RangeError('IP range table: IPv6 starts must increase');
    high += highDelta;
    low = highDelta === 0 ? low + lowValue : lowValue;
    if (high > 0xffffffff || low > 0xffffffff) throw new RangeError('IP range table: IPv6 start out of range');
    v6High[i] = high;
    v6Low[i] = low;
  }
  if (v6Count > 0 && (v6High[0] !== 0 || v6Low[0] !== 0)) throw new RangeError('IP range table: the first IPv6 range must start at ::');
  const v6Values = column(reader, v6Count, values.length);
  if (!reader.done) throw new RangeError('IP range table: trailing data');
  return { values, v4Starts, v4Values, v6High, v6Low, v6Values };
}

/** The index of the last range starting at or before the key, or -1 (`after(i)` says whether range i starts after the key). */
function lastAtOrBefore(count: number, after: (i: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (after(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

/** The value for an address, or undefined when the table has none for it. */
export function lookupRange(table: RangeTable, ip: ParsedIp): string | undefined {
  let index: number;
  let value: number | undefined;
  if (ip.version === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = ip.octets;
    const key = a * 0x1000000 + ((b << 16) | (c << 8) | d);
    index = lastAtOrBefore(table.v4Starts.length, i => (table.v4Starts[i] ?? 0) > key);
    value = table.v4Values[index];
  } else {
    const [h0 = 0, h1 = 0, h2 = 0, h3 = 0] = ip.hextets;
    const high = h0 * 0x10000 + h1;
    const low = h2 * 0x10000 + h3;
    index = lastAtOrBefore(table.v6High.length, i => {
      const startHigh = table.v6High[i] ?? 0;
      return startHigh > high || (startHigh === high && (table.v6Low[i] ?? 0) > low);
    });
    value = table.v6Values[index];
  }
  return value === undefined || value === 0 ? undefined : table.values[value - 1];
}
