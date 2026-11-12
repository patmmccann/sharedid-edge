/**
 * A small reader for MaxMind DB (MMDB) files, the format DB-IP and MaxMind publish their databases in, as specified at
 * https://maxmind.github.io/MaxMind-DB/. It runs at build time: a module's build script reads the downloaded database
 * with it and keeps only what the module returns (see `buildRangeTable`). It uses web-standard `Uint8Array` only.
 */

/** A decoded MMDB data value. `uint64` and `uint128` are `bigint`; `bytes` are a `Uint8Array`. */
export type MmdbValue = string | number | bigint | boolean | Uint8Array | readonly MmdbValue[] | MmdbMap;
/** A decoded MMDB map. */
export interface MmdbMap {
  readonly [key: string]: MmdbValue;
}

/** The database's metadata (the fields this reader uses, plus the whole map). */
export interface MmdbMetadata {
  readonly nodeCount: number;
  readonly recordSize: 24 | 28 | 32;
  readonly ipVersion: 4 | 6;
  readonly databaseType: string;
  /** Seconds since the epoch. */
  readonly buildEpoch: number;
  readonly raw: MmdbMap;
}

/** A network in the search tree: its first address, prefix length, and the record's offset in the data section. */
export interface MmdbNetwork {
  /** The first address, as an unsigned integer of the tree's width (32 or 128 bits). */
  readonly start: bigint;
  readonly prefixLength: number;
  /** The record's offset in the data section, or undefined when the network has no data. */
  readonly record: number | undefined;
}

/** A record to visit while walking the tree: a node or a leaf, with the network it covers. */
interface TreeItem {
  readonly record: number;
  readonly start: bigint;
  readonly prefixLength: number;
}

const METADATA_MARKER = new Uint8Array([0xab, 0xcd, 0xef, ...new TextEncoder().encode('MaxMind.com')]);
/** The metadata section is at most 128 KiB from the end of the file. */
const METADATA_MAX = 128 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function isMap(value: MmdbValue | undefined): value is MmdbMap {
  return typeof value === 'object' && !(value instanceof Uint8Array) && !Array.isArray(value);
}

/** Reads an MMDB file held in memory. Throws on anything that isn't a valid MMDB file. */
export class MmdbReader {
  readonly metadata: MmdbMetadata;
  readonly #bytes: Uint8Array;
  readonly #nodeBytes: number;
  readonly #dataStart: number;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    const marker = lastIndexOf(bytes, METADATA_MARKER, Math.max(0, bytes.length - METADATA_MAX));
    if (marker < 0) throw new Error('Not an MMDB file: no metadata marker');
    const metadataStart = marker + METADATA_MARKER.length;
    const raw = this.#decode(metadataStart, metadataStart).value;
    if (!isMap(raw)) throw new Error('MMDB metadata is not a map');
    this.metadata = parseMetadata(raw);
    this.#nodeBytes = (this.metadata.recordSize * 2) / 8;
    const treeSize = this.metadata.nodeCount * this.#nodeBytes;
    this.#dataStart = treeSize + 16;
    if (this.#dataStart > marker) throw new Error('MMDB search tree is larger than the file');
  }

  /** The two records of a node: values below `nodeCount` are nodes, `nodeCount` is "no data", above it data. */
  node(index: number): readonly [number, number] {
    const b = this.#bytes;
    const o = index * this.#nodeBytes;
    if (o + this.#nodeBytes > this.#dataStart) throw new Error('MMDB node out of range');
    const at = (i: number): number => b[o + i] ?? 0;
    switch (this.metadata.recordSize) {
      case 24:
        return [(at(0) << 16) | (at(1) << 8) | at(2), (at(3) << 16) | (at(4) << 8) | at(5)];
      case 28:
        return [
          ((at(3) & 0xf0) * 0x100000) + ((at(0) << 16) | (at(1) << 8) | at(2)),
          ((at(3) & 0x0f) * 0x1000000) + ((at(4) << 16) | (at(5) << 8) | at(6))
        ];
      case 32:
        return [readUint(b, o, 4), readUint(b, o + 4, 4)];
    }
  }

  /** The data-section offset a record value points to. */
  recordOffset(record: number): number {
    const offset = record - this.metadata.nodeCount - 16;
    if (offset < 0 || this.#dataStart + offset >= this.#bytes.length) throw new Error('MMDB record points outside the data section');
    return offset;
  }

  /** Decodes the value at a data-section offset. */
  record(offset: number): MmdbValue {
    return this.#decode(this.#dataStart + offset, this.#dataStart).value;
  }

  /**
   * Every network in the tree, in address order, each with its record offset (undefined for no data). In an IPv6
   * database, IPv4 addresses are the subtree at `::/96`; other paths to that subtree (MaxMind aliases `::ffff:0:0/96`
   * and `2002::/16` to it) are listed as networks without data, so each IPv4 network is listed once.
   */
  *networks(): Generator<MmdbNetwork> {
    const { nodeCount, ipVersion } = this.metadata;
    const bits = ipVersion === 6 ? 128 : 32;
    const ipv4Root = ipVersion === 6 ? this.#ipv4Root() : undefined;
    // Depth-first, right child pushed before left, so networks come out in address order.
    const stack: TreeItem[] = [{ record: 0, start: 0n, prefixLength: 0 }];
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const { record, start, prefixLength } = item;
      if (record >= nodeCount) {
        yield { start, prefixLength, record: record === nodeCount ? undefined : this.recordOffset(record) };
        continue;
      }
      // Another path to the IPv4 subtree (an alias such as ::ffff:0:0/96 or 2002::/16): its networks are listed under
      // ::/96, so the alias is listed as one network without data. Leaving it out would let the network before it run on
      // into its addresses in a range table.
      if (record === ipv4Root && !(prefixLength === 96 && start === 0n)) {
        yield { start, prefixLength, record: undefined };
        continue;
      }
      if (prefixLength >= bits) throw new Error('MMDB search tree is deeper than the address');
      const [left, right] = this.node(record);
      stack.push(
        { record: right, start: start | (1n << BigInt(bits - prefixLength - 1)), prefixLength: prefixLength + 1 },
        { record: left, start, prefixLength: prefixLength + 1 }
      );
    }
  }

  /**
   * The record offset for an address given as an unsigned integer of the tree's width (an IPv4 address in an IPv6
   * tree is `::a.b.c.d`), or undefined when there's no data for it. For checking a built table against the database.
   */
  lookup(address: bigint): number | undefined {
    const bits = this.metadata.ipVersion === 6 ? 128 : 32;
    let record = 0;
    for (let depth = 0; depth < bits && record < this.metadata.nodeCount; depth++) {
      const [left, right] = this.node(record);
      record = ((address >> BigInt(bits - depth - 1)) & 1n) === 0n ? left : right;
    }
    if (record < this.metadata.nodeCount) throw new Error('MMDB search tree is deeper than the address');
    return record === this.metadata.nodeCount ? undefined : this.recordOffset(record);
  }

  /** The node 96 zero bits down an IPv6 tree: the IPv4 subtree. */
  #ipv4Root(): number | undefined {
    let node = 0;
    for (let i = 0; i < 96; i++) {
      const [left] = this.node(node);
      if (left >= this.metadata.nodeCount) return undefined;
      node = left;
    }
    return node;
  }

  #decode(offset: number, base: number): { value: MmdbValue; next: number } {
    const b = this.#bytes;
    let at = offset;
    const ctrl = b[at++];
    if (ctrl === undefined) throw new Error('MMDB data out of range');
    let type = ctrl >> 5;
    if (type === 1) {
      // A pointer: to a value elsewhere in the data section, relative to its start.
      const size = (ctrl >> 3) & 0x3;
      const low = ctrl & 0x7;
      let pointer: number;
      if (size === 0) pointer = (low << 8) | readUint(b, at, 1);
      else if (size === 1) pointer = ((low << 16) | readUint(b, at, 2)) + 2048;
      else if (size === 2) pointer = ((low * 0x1000000) + readUint(b, at, 3)) + 526336;
      else pointer = readUint(b, at, 4);
      return { value: this.#decode(base + pointer, base).value, next: at + size + 1 };
    }
    if (type === 0) {
      const extended = b[at++];
      if (extended === undefined) throw new Error('MMDB data out of range');
      type = extended + 7;
    }
    let size = ctrl & 0x1f;
    if (size === 29) size = 29 + readUint(b, at++, 1);
    else if (size === 30) {
      size = 285 + readUint(b, at, 2);
      at += 2;
    } else if (size === 31) {
      size = 65821 + readUint(b, at, 3);
      at += 3;
    }
    switch (type) {
      case 2:
        return { value: decoder.decode(slice(b, at, size)), next: at + size };
      case 3:
        if (size !== 8) throw new Error('MMDB double must be 8 bytes');
        return { value: new DataView(b.buffer, b.byteOffset + at, 8).getFloat64(0), next: at + 8 };
      case 4:
        return { value: slice(b, at, size).slice(), next: at + size };
      case 5:
      case 6:
        if (size > (type === 5 ? 2 : 4)) throw new Error('MMDB unsigned integer too long');
        return { value: readUint(b, at, size), next: at + size };
      case 7: {
        const map: Record<string, MmdbValue> = {};
        let next = at;
        for (let i = 0; i < size; i++) {
          const key = this.#decode(next, base);
          if (typeof key.value !== 'string') throw new Error('MMDB map key is not a string');
          const value = this.#decode(key.next, base);
          Object.defineProperty(map, key.value, { value: value.value, enumerable: true, writable: false, configurable: false });
          next = value.next;
        }
        return { value: map, next };
      }
      case 8: {
        if (size > 4) throw new Error('MMDB int32 too long');
        return { value: readUint(b, at, size) | 0, next: at + size };
      }
      case 9:
      case 10: {
        if (size > (type === 9 ? 8 : 16)) throw new Error('MMDB unsigned integer too long');
        let value = 0n;
        for (const byte of slice(b, at, size)) value = (value << 8n) | BigInt(byte);
        return { value, next: at + size };
      }
      case 11: {
        const items: MmdbValue[] = [];
        let next = at;
        for (let i = 0; i < size; i++) {
          const item = this.#decode(next, base);
          items.push(item.value);
          next = item.next;
        }
        return { value: items, next };
      }
      case 14:
        return { value: size !== 0, next: at };
      case 15:
        if (size !== 4) throw new Error('MMDB float must be 4 bytes');
        return { value: new DataView(b.buffer, b.byteOffset + at, 4).getFloat32(0), next: at + 4 };
      default:
        throw new Error(`MMDB data type ${String(type)} is not supported`);
    }
  }
}


function slice(bytes: Uint8Array, at: number, size: number): Uint8Array {
  if (at + size > bytes.length) throw new Error('MMDB data out of range');
  return bytes.subarray(at, at + size);
}

function readUint(bytes: Uint8Array, at: number, size: number): number {
  let value = 0;
  for (const byte of slice(bytes, at, size)) value = value * 256 + byte;
  return value;
}

function lastIndexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = bytes.length - needle.length; i >= from; i--) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function parseMetadata(raw: MmdbMap): MmdbMetadata {
  const nodeCount = raw['node_count'];
  const recordSize = raw['record_size'];
  const ipVersion = raw['ip_version'];
  const databaseType = raw['database_type'];
  const buildEpoch = raw['build_epoch'];
  if (typeof nodeCount !== 'number' || !Number.isInteger(nodeCount) || nodeCount <= 0) throw new Error('MMDB metadata: bad node_count');
  if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) throw new Error('MMDB metadata: record_size must be 24, 28 or 32');
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error('MMDB metadata: ip_version must be 4 or 6');
  if (typeof databaseType !== 'string') throw new Error('MMDB metadata: bad database_type');
  const epoch = typeof buildEpoch === 'bigint' ? Number(buildEpoch) : buildEpoch;
  if (typeof epoch !== 'number') throw new Error('MMDB metadata: bad build_epoch');
  return { nodeCount, recordSize, ipVersion, databaseType, buildEpoch: epoch, raw };
}
