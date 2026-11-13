import type { EdgeModule } from '@sharedid-edge/core';
import { ipDatabaseModule, type DataInfo } from '@sharedid-edge/ip-ranges';
import { DATA, DATA_INFO } from './data.js';

export { geoMode, type GeoMode } from '@sharedid-edge/ip-ranges';

export { DBIP_ATTRIBUTION } from './attribution.js';

/**
 * What's built in: the database and its date, or `fixture: true` when `npm run data` hasn't been run, in which case
 * the module only knows the documentation addresses and finds nothing for real visitors.
 */
export const DBIP_DATA_INFO: DataInfo = DATA_INFO;

/**
 * The `dbip` module: the visitor's country from DB-IP's IP to Country Lite database, as `ortb2.device.geo.country`
 * (ISO 3166-1 alpha-3, `type` 2). The database is cut down to country ranges and built into the bundle by
 * `npm run data` (scripts/build-data.mjs); lookups happen in memory, with no network access, and nothing about the
 * request is stored or logged. `{"mode":"fill"}` (the default) only fills a country the CDN doesn't give the `geo`
 * module; `{"mode":"replace"}` always sends DB-IP's. DB-IP isn't on AdCOM's IP location service list, so there's no
 * `ipservice`.
 */
export const dbipModule: EdgeModule = ipDatabaseModule({ name: 'dbip', data: DATA, info: DATA_INFO });
