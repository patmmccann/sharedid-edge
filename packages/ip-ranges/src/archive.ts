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
