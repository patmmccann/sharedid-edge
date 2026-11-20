import { buildCountryData } from '@sharedid-edge/ip-ranges/build';
import { validateCountrySnapshot, type CountrySnapshot } from './country-data.js';
import { bytes, checkNotModified, downloaded, get, requireOk } from './download.js';
import { hexDigest } from './snapshot.js';
import type { UpdateSource } from './update.js';

export interface CountrySourceOptions {
  /** Pass the vendor module's attribution constant; it is retained in the private snapshot. */
  readonly attribution: string;
  readonly ipv4Only?: boolean;
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
      await requireOk(checksum, 'Checksum download failed');
      const expected = new TextDecoder().decode(await bytes(checksum, 4096)).trim().split(/\s+/)[0];
      if (expected !== await hexDigest(download.bytes)) throw new TypeError('Invalid database checksum');
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
