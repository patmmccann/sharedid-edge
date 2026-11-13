import { buildCountryData } from '@sharedid-edge/ip-ranges/build';
import { validateCountrySnapshot, type CountrySnapshot } from './country-data.js';
import type { Download, DownloadContext, UpdateSource } from './update.js';

export interface CountrySourceOptions {
  /** Pass the vendor module's attribution constant; it is retained in the private snapshot. */
  readonly attribution: string;
  readonly ipv4Only?: boolean;
}

/** Bound response bodies, including chunked downloads. fetch's AbortSignal also covers reading the body. */
async function bytes(response: Response, limit = 64 * 1024 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError('Missing download body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Invalid download stream');
      length += chunk.byteLength;
      if (length > limit) throw new RangeError('Download is too large');
      chunks.push(chunk);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function get(url: string, context: DownloadContext, authorization?: string): Promise<Response> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('Authorization', authorization);
  if (context.previous?.url === url && context.previous.etag !== undefined) headers.set('If-None-Match', context.previous.etag);
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    context.signal.throwIfAborted();
    const response = await context.fetch(current.href, { headers: new Headers(headers), signal: context.signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (location === null) throw new TypeError('Database redirect has no location');
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || next.username !== '' || next.password !== '') throw new TypeError('Invalid database redirect');
    // Workers and other Fetch implementations differ in automatic header forwarding: enforce the boundary here.
    if (next.origin !== current.origin) headers.delete('Authorization');
    current = next;
  }
  throw new TypeError('Too many database redirects');
}

async function downloaded(response: Response, url: string): Promise<Download> {
  if (!response.ok) throw new Error('Database download failed');
  const etag = response.headers.get('ETag');
  return { bytes: await bytes(response), url, ...(etag === null ? {} : { etag }) };
}

function checkNotModified(url: string, context: DownloadContext): void {
  if (context.previous?.url !== url || context.previous.etag === undefined) throw new TypeError('Unexpected conditional response');
}

export function dbipSource(options: CountrySourceOptions): UpdateSource<CountrySnapshot> {
  return {
    name: 'dbip', variant: JSON.stringify({ version: 1, ipv4Only: options.ipv4Only ?? false, attribution: options.attribution }), validate: validateCountrySnapshot,
    async download(context) {
      const date = new Date(context.now);
      for (const month of [date.toISOString().slice(0, 7), new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)]) {
        const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
        const response = await get(url, context);
        if (response.status === 304) { checkNotModified(url, context); return undefined; }
        if (response.status === 404) { await response.body?.cancel(); continue; }
        return downloaded(response, url);
      }
      throw new Error('No DB-IP release available');
    },
    async decode(file) {
      const result = await buildCountryData(file, {
        database: built => `dbip-country-lite-${built.slice(0, 7)}`, attribution: options.attribution,
        ipv4Only: options.ipv4Only ?? false, databaseType: type => type === 'DBIP-Country-Lite'
      });
      return { data: result.data, info: result.info };
    }
  };
}

export function maxmindSource(options: CountrySourceOptions): UpdateSource<CountrySnapshot> {
  const url = 'https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz';
  return {
    name: 'maxmind', variant: JSON.stringify({ version: 1, ipv4Only: options.ipv4Only ?? false, attribution: options.attribution }), validate: validateCountrySnapshot,
    async download(context) {
      const account = context.secrets['accountId'];
      const key = context.secrets['licenseKey'];
      if (account === undefined || account === '' || key === undefined || key === '') throw new TypeError('Set maxmind accountId and licenseKey in SID_MODULE_SECRETS');
      const authorization = `Basic ${btoa(`${account}:${key}`)}`;
      const response = await get(url, context, authorization);
      if (response.status === 304) { checkNotModified(url, context); return undefined; }
      const download = await downloaded(response, url);
      const checksum = await get(`${url}.sha256`, context, authorization);
      if (!checksum.ok) throw new Error('Checksum download failed');
      const expected = new TextDecoder().decode(await bytes(checksum, 4096)).trim().split(/\s+/)[0];
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', download.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (expected !== actual) throw new TypeError('Invalid database checksum');
      return download;
    },
    async decode(file) {
      const result = await buildCountryData(file, {
        database: built => `GeoLite2-Country-${built}`, attribution: options.attribution,
        ipv4Only: options.ipv4Only ?? false, databaseType: type => type === 'GeoLite2-Country'
      });
      return { data: result.data, info: result.info };
    }
  };
}
