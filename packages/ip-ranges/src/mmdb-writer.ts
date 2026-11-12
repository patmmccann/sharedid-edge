import type { MmdbValue } from './mmdb.js';

/** A network for `writeMmdb`: CIDR text (`192.0.2.0/24` or `2001:db8::/32`) and its record. */
export interface MmdbFixtureNetwork {
  readonly network: string;
  readonly record: MmdbValue;
}

export interface MmdbFixtureOptions {
  readonly databaseType: string;
  readonly ipVersion: 4 | 6;
  readonly recordSize?: 24 | 28 | 32;
  /** Seconds since the epoch. */
  readonly buildEpoch?: number;
  readonly networks: readonly MmdbFixtureNetwork[];
  /**
   * In an IPv6 database, also point `::ffff:0:0/96` and `2002::/16` at the IPv4 subtree, as MaxMind's databases do.
   * The reader must list those networks once, under `::/96`.
   */
  readonly ipv4Aliases?: boolean;
}

const encoder = new TextEncoder();

function control(type: number, size: number): number[] {
  const head = size < 29 ? [size] : size < 285 ? [29, size - 29] : [30, (size - 285) >> 8, (size - 285) & 0xff];
  const [first = 0, ...rest] = head;
  return type <= 7 ? [(type << 5) | first, ...rest] : [first, type - 7, ...rest];
}

function uint(value: number, bytes: number): number[] {
  const out: number[] = [];
  for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(value / 256 ** i) % 256);
  while (out.length > 0 && out[0] === 0) out.shift();
  return out;
}

/** Encodes a value in the MMDB data section format (no pointers). */
export function encodeMmdbValue(value: MmdbValue): number[] {
  if (typeof value === 'string') {
    const bytes = [...encoder.encode(value)];
    return [...control(2, bytes.length), ...bytes];
  }
  if (typeof value === 'boolean') return control(14, value ? 1 : 0);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value);
      return [...control(3, 8), ...bytes];
    }
    const bytes = uint(value, 4);
    return [...control(6, bytes.length), ...bytes];
  }
  if (typeof value === 'bigint') {
    const bytes: number[] = [];
    for (let rest = value; rest > 0n; rest >>= 8n) bytes.unshift(Number(rest & 0xffn));
    return [...control(bytes.length > 8 ? 10 : 9, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...control(4, value.length), ...value];
  if (Array.isArray(value)) {
    const items: readonly MmdbValue[] = value;
    return [...control(11, items.length), ...items.flatMap(encodeMmdbValue)];
  }
  const entries = Object.entries(value);
  return [...control(7, entries.length), ...entries.flatMap(([key, item]) => [...encodeMmdbValue(key), ...encodeMmdbValue(item)])];
}

function parseCidr(text: string, ipVersion: 4 | 6): { bits: bigint; prefixLength: number } {
  const [address = '', length = ''] = text.split('/');
  let bits: bigint;
  let width: number;
  if (address.includes(':')) {
    const [head = '', tail = ''] = address.split('::');
    const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
    const h = groups(head);
    const t = groups(tail);
    const all = address.includes('::') ? [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
    bits = all.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
    width = 128;
  } else {
    bits = address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
    width = 32;
  }
  let prefixLength = Number(length);
  // An IPv4 network in an IPv6 database lives at ::a.b.c.d.
  if (width === 32 && ipVersion === 6) prefixLength += 96;
  return { bits, prefixLength };
}

/**
 * Writes a small MMDB file: for test fixtures and published examples, never for real data. Networks must not overlap.
 * Records are stored in the data section without pointers, except that identical records share one copy, reached
 * through a pointer from the second network on (so the reader's pointer handling is exercised too).
 */
export function writeMmdb(options: MmdbFixtureOptions): Uint8Array {
  const recordSize = options.recordSize ?? 24;
  const width = options.ipVersion === 6 ? 128 : 32;
  // The tree under construction: node i has children [left, right], each a node index, a data key or empty.
  type Child = { node: number } | { data: number } | undefined;
  const nodes: [Child, Child][] = [[undefined, undefined]];
  const data: number[] = [];
  const dataOffsets = new Map<string, number>();
  const pointerTo = (offset: number): number[] => [0x20 | ((offset >> 8) & 0x7), offset & 0xff];
  const dataFor = (record: MmdbValue): number => {
    const encoded = encodeMmdbValue(record);
    const key = encoded.join(',');
    const existing = dataOffsets.get(key);
    const offset = data.length;
    if (existing === undefined) {
      data.push(...encoded);
      dataOffsets.set(key, offset);
    } else {
      if (existing >= 2048) throw new RangeError('writeMmdb: fixture too large for its pointers');
      data.push(...pointerTo(existing));
    }
    return offset;
  };
  const walk = (bits: bigint, prefixLength: number, create: boolean): { node: number; bit: 0 | 1 } => {
    let node = 0;
    for (let depth = 0; depth < prefixLength - 1; depth++) {
      const bit = ((bits >> BigInt(width - depth - 1)) & 1n) === 0n ? 0 : 1;
      const pair = nodes[node];
      if (pair === undefined) throw new Error('writeMmdb: broken tree');
      const child = pair[bit];
      if (child !== undefined && 'node' in child) {
        node = child.node;
      } else {
        if (child !== undefined || !create) throw new Error('writeMmdb: overlapping networks');
        nodes.push([undefined, undefined]);
        pair[bit] = { node: nodes.length - 1 };
        node = nodes.length - 1;
      }
    }
    const bit = ((bits >> BigInt(width - prefixLength)) & 1n) === 0n ? 0 : 1;
    return { node, bit };
  };
  for (const { network, record } of options.networks) {
    const { bits, prefixLength } = parseCidr(network, options.ipVersion);
    const { node, bit } = walk(bits, prefixLength, true);
    const pair = nodes[node];
    if (pair === undefined || pair[bit] !== undefined) throw new Error('writeMmdb: overlapping networks');
    pair[bit] = { data: dataFor(record) };
  }
  if (options.ipv4Aliases === true && options.ipVersion === 6) {
    const ipv4 = walk(0n, 96, true);
    const ipv4Pair = nodes[ipv4.node];
    const ipv4Child = ipv4Pair?.[ipv4.bit];
    if (ipv4Child === undefined || !('node' in ipv4Child)) throw new Error('writeMmdb: aliases need IPv4 networks');
    for (const [bits, prefixLength] of [[0xffffn << 32n, 96], [0x2002n << 112n, 16]] as const) {
      const { node, bit } = walk(bits, prefixLength, true);
      const pair = nodes[node];
      if (pair === undefined) throw new Error('writeMmdb: broken tree');
      pair[bit] = ipv4Child;
    }
  }

  const nodeCount = nodes.length;
  const recordValue = (child: Child): number => (child === undefined ? nodeCount : 'node' in child ? child.node : nodeCount + 16 + child.data);
  const tree: number[] = [];
  for (const [leftChild, rightChild] of nodes) {
    const left = recordValue(leftChild);
    const right = recordValue(rightChild);
    if (recordSize === 24) tree.push(...uint24(left), ...uint24(right));
    else if (recordSize === 32) tree.push(...uint32(left), ...uint32(right));
    else {
      const l = uint32(left);
      const r = uint32(right);
      tree.push(l[1] ?? 0, l[2] ?? 0, l[3] ?? 0, (((l[0] ?? 0) & 0x0f) << 4) | ((r[0] ?? 0) & 0x0f), r[1] ?? 0, r[2] ?? 0, r[3] ?? 0);
    }
  }
  const metadata: MmdbValue = {
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: BigInt(options.buildEpoch ?? 1_793_491_200),
    database_type: options.databaseType,
    description: { en: 'Test fixture' },
    ip_version: options.ipVersion,
    languages: ['en'],
    node_count: nodeCount,
    record_size: recordSize
  };
  return Uint8Array.from([
    ...tree,
    ...new Array<number>(16).fill(0),
    ...data,
    0xab, 0xcd, 0xef, ...encoder.encode('MaxMind.com'),
    ...encodeMmdbValue(metadata)
  ]);
}

function uint24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
