import { defineModule, PROXY_KINDS, type EdgeModule, type ModuleContext, type ModuleResult, type ProxyKind, type TrafficReport } from '@sharedid-edge/core';
import { decodeRangeTable, ipDatabaseModule, ipDatabaseSettings, lookupClient, type DataInfo, type RangeTable } from '@sharedid-edge/ip-ranges';
import { DATA, DATA_INFO, PROXY_DATA, PROXY_DATA_INFO } from './data.js';

export { geoMode, type GeoMode } from '@sharedid-edge/ip-ranges';
export { IP2LOCATION_ATTRIBUTION, IP2PROXY_ATTRIBUTION } from './attribution.js';

/** IP2Location's value in AdCOM 1.0's List: IP Location Services, sent as `device.geo.ipservice`. */
export const IP2LOCATION_IPSERVICE = 1;

/**
 * What's built in for the country: the database and its date, or `fixture: true` when `npm run data` hasn't been run,
 * in which case the module only knows the documentation addresses and finds nothing for real visitors.
 */
export const IP2LOCATION_DATA_INFO: DataInfo = DATA_INFO;

/** The same for the proxy signals. */
export const IP2PROXY_DATA_INFO: DataInfo = PROXY_DATA_INFO;

/** A table and its description: base64 as bundled, or already decoded. */
export interface Ip2LocationTable {
  readonly data: string | RangeTable;
  readonly info: DataInfo;
}

export interface Ip2LocationOptions {
  readonly country: Ip2LocationTable;
  readonly proxy: Ip2LocationTable;
  /** Clock for `maxAgeDays`, in epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
}

/** The most specific proxy kind in a table value such as `vpn,public`, or undefined. */
function proxyFor(table: RangeTable, clientIp: string | undefined): ProxyKind | undefined {
  const code = lookupClient(table, clientIp);
  if (code === undefined) return undefined;
  const kinds = code.split(',');
  return PROXY_KINDS.find(kind => kinds.includes(kind));
}

/**
 * The `ip2location` module with the tables given. The bundled module is {@link ip2locationModule}; this lets a caller
 * supply decoded tables (a runtime snapshot, say) or a clock for tests.
 */
export function createIp2LocationModule(options: Ip2LocationOptions): EdgeModule {
  const now = options.now ?? Date.now;
  const country = ipDatabaseModule({ name: 'ip2location', data: options.country.data, info: options.country.info, ipservice: IP2LOCATION_IPSERVICE, now });
  const proxyTable = typeof options.proxy.data === 'string' ? decodeRangeTable(options.proxy.data) : options.proxy.data;
  const proxyBuilt = Date.parse(options.proxy.info.built);
  return defineModule({
    name: 'ip2location',
    async run(context: ModuleContext): Promise<ModuleResult | undefined> {
      const { maxAgeDays } = ipDatabaseSettings('ip2location', context.config);
      if (maxAgeDays !== undefined && !Number.isFinite(proxyBuilt)) throw new TypeError('ip2location: no proxy data publication date');
      const geo = (await country.run(context)) ?? {};
      const proxy = proxyFor(proxyTable, context.platform.clientIp);
      const proxyStale = maxAgeDays !== undefined && now() - proxyBuilt > maxAgeDays * 86_400_000;
      const stale = geo.stale === true || proxyStale;
      const traffic: TrafficReport | undefined = proxy === undefined ? undefined : { proxy };
      if (traffic === undefined && geo.ortb2 === undefined && !stale) return undefined;
      return { ...geo, ...(traffic === undefined ? {} : { traffic }), ...(stale ? { stale: true } : {}) };
    }
  });
}

/**
 * The `ip2location` module: the visitor's country from IP2Location LITE DB1, as `ortb2.device.geo.country` (ISO
 * 3166-1 alpha-3, `type` 2, `ipservice` 1), and proxy signals from IP2Proxy LITE PX10, as `ortb2.device.ext.traffic`.
 * Both databases are downloaded with the deployer's free download token and built into the bundle by `npm run data`
 * (scripts/build-data.mjs); the token is used only there and never reaches the bundle. Lookups happen in memory, with
 * no network access, and nothing about the request is stored or logged. `{"mode":"fill"}` (the default) only fills a
 * country the CDN doesn't give the `geo` module; `{"mode":"replace"}` always sends IP2Location's. The traffic signal
 * is sent whichever the mode.
 */
export const ip2locationModule: EdgeModule = createIp2LocationModule({ country: { data: DATA, info: DATA_INFO }, proxy: { data: PROXY_DATA, info: PROXY_DATA_INFO } });
