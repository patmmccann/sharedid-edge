import type { DataInfo } from './module.js';

/** Whether bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Decompresses gzip with the web-standard `DecompressionStream`. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whether bytes start with a ZIP local-file header or an empty archive's end record. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 && bytes[3] === 0x04 || bytes[2] === 0x05 && bytes[3] === 0x06);
}

function uint16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function uint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) + (bytes[at + 3] ?? 0) * 0x1000000;
}

/** Decompresses a raw deflate stream with the web-standard `DecompressionStream`. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The first file in a ZIP archive whose name ends with `suffix` (case-insensitive), with its path, or undefined.
 * Stored and deflated entries only. ZIP64 archives are rejected: they're over 4 GB, too big for a build.
 */
export async function zipEntry(archive: Uint8Array, suffix: string): Promise<{ readonly name: string; readonly bytes: Uint8Array } | undefined> {
  let end = -1;
  for (let at = Math.max(0, archive.length - 22 - 0xffff); at <= archive.length - 22; at++) {
    if (uint32(archive, at) === 0x06054b50) end = at;
  }
  if (end < 0) throw new Error('ZIP: no end of central directory');
  const count = uint16(archive, end + 10);
  const directorySize = uint32(archive, end + 12);
  const directoryStart = uint32(archive, end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) throw new Error('ZIP: ZIP64 archives are not supported');
  const directoryEnd = directoryStart + directorySize;
  if (directoryEnd > archive.length) throw new Error('ZIP: truncated central directory');
  const decoder = new TextDecoder();
  for (let at = directoryStart; at + 46 <= directoryEnd; ) {
    if (uint32(archive, at) !== 0x02014b50) throw new Error('ZIP: bad central directory entry');
    const flags = uint16(archive, at + 8);
    const method = uint16(archive, at + 10);
    const compressedSize = uint32(archive, at + 20);
    const size = uint32(archive, at + 24);
    const nameLength = uint16(archive, at + 28);
    const extraLength = uint16(archive, at + 30);
    const commentLength = uint16(archive, at + 32);
    const localStart = uint32(archive, at + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localStart === 0xffffffff) throw new Error('ZIP: ZIP64 archives are not supported');
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    if ((flags & 1) !== 0) throw new Error('ZIP: encrypted entries are not supported');
    if (uint32(archive, localStart) !== 0x04034b50) throw new Error('ZIP: bad local file header');
    const dataStart = localStart + 30 + uint16(archive, localStart + 26) + uint16(archive, localStart + 28);
    if (dataStart + compressedSize > archive.length) throw new Error('ZIP: truncated entry');
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const bytes = method === 0 ? stored.slice() : method === 8 ? await inflateRaw(stored) : undefined;
    if (bytes === undefined) throw new Error(`ZIP: unsupported compression method ${String(method)}`);
    if (bytes.length !== size) throw new Error('ZIP: entry size does not match its directory');
    return { name, bytes };
  }
  return undefined;
}

function tarString(block: Uint8Array, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

/**
 * The first regular file in a tar archive whose name ends with `suffix` (MaxMind ships each database as
 * `GeoLite2-Country_<date>/GeoLite2-Country.mmdb` in a `.tar.gz`), with its path, or undefined.
 */
export function tarEntry(archive: Uint8Array, suffix: string): { readonly name: string; readonly bytes: Uint8Array } | undefined {
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) return undefined;
    const prefix = tarString(header, 345, 155);
    const base = tarString(header, 0, 100);
    const name = prefix === '' ? base : `${prefix}/${base}`;
    const sizeField = tarString(header, 124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar: bad entry size');
    const type = header[156];
    const start = at + 512;
    if (start + size > archive.length) throw new Error('tar: truncated archive');
    // '0' or NUL: a regular file.
    if ((type === 0x30 || type === 0) && name.endsWith(suffix)) return { name, bytes: archive.subarray(start, start + size) };
    at = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * The JavaScript a module's build script writes as its data file (`dist/data.js`): the encoded table as `DATA` and
 * its description as `DATA_INFO`, the same exports as the module's `src/data.ts`, which holds the fixture. Only the
 * table and the description go in: nothing from the build's environment.
 */
export function dataModuleSource(encoded: string, info: DataInfo): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('The encoded table must be base64');
  return [
    `// Generated at build time from ${info.database}. ${info.attribution} Don't edit or commit this file.`,
    `export const DATA = ${JSON.stringify(encoded)};`,
    `export const DATA_INFO = Object.freeze(${JSON.stringify(info)});`,
    ''
  ].join('\n');
}
