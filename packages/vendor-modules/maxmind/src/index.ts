import type { EdgeModule } from '@sharedid-edge/core';
import { ipDatabaseModule, type DataInfo } from '@sharedid-edge/ip-ranges';
import { DATA, DATA_INFO } from './data.js';

export { geoMode, type GeoMode } from '@sharedid-edge/ip-ranges';
export { MAXMIND_ATTRIBUTION } from './attribution.js';

/** MaxMind's value in AdCOM 1.0's List: IP Location Services, sent as `device.geo.ipservice`. */
export const MAXMIND_IPSERVICE = 3;

/**
 * What's built in: the database and its date, or `fixture: true` when `npm run data` hasn't been run, in which case
 * the module only knows the documentation addresses and finds nothing for real visitors.
 */
export const MAXMIND_DATA_INFO: DataInfo = DATA_INFO;

/**
 * The `maxmind` module: the visitor's country from MaxMind's GeoLite2 Country database, as
 * `ortb2.device.geo.country` (ISO 3166-1 alpha-3, `type` 2, `ipservice` 3). The database is downloaded with the
 * deployer's MaxMind account ID and licence key, cut down to country ranges and built into the bundle by
 * `npm run data` (scripts/build-data.mjs); the key is used only there and never reaches the bundle. Lookups happen in
 * memory, with no network access, and nothing about the request is stored or logged. `{"mode":"fill"}` (the default)
 * only fills a country the CDN doesn't give the `geo` module; `{"mode":"replace"}` always sends MaxMind's.
 */
export const maxmindModule: EdgeModule = ipDatabaseModule({ name: 'maxmind', data: DATA, info: DATA_INFO, ipservice: MAXMIND_IPSERVICE });
