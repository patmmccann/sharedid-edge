import { defineModule, type EdgeModule, type ModuleContext, type ModuleResult } from '@sharedid-edge/core';
import { alpha3 } from '@sharedid-edge/module-geo';
import { parseIp } from '@sharedid-edge/module-ip';
import { decodeRangeTable, lookupRange, type RangeTable } from './table.js';

/**
 * How an IP database module relates to the `geo` module (the CDN's location):
 *
 * - `fill` (the default): send the country only when the platform has none that `geo` could send, so the database
 *   fills the gap and never contradicts the CDN;
 * - `replace`: always send the database's country. List the module after `geo` in `SID_MODULES`, so it wins the merge.
 */
export type GeoMode = 'fill' | 'replace';

/** An IP database module's settings. */
export interface IpDatabaseSettings {
  readonly mode: GeoMode;
  /** Report `stale` once the data's publication date (`DataInfo.built`) is older than this many days. */
  readonly maxAgeDays?: number;
}

/**
 * Reads an IP database module's `SID_MODULE_CONFIG` entry. Throws on an unknown key, a `mode` other than `fill` or
 * `replace`, or a `maxAgeDays` that isn't a positive finite number, so a typo is reported as an `error` rather than
 * silently ignored.
 */
export function ipDatabaseSettings(name: string, config: Readonly<Record<string, unknown>>): IpDatabaseSettings {
  for (const key of Object.keys(config)) {
    if (key !== 'mode' && key !== 'maxAgeDays') throw new TypeError(`${name}: unknown setting "${key}"`);
  }
  const { mode, maxAgeDays } = config;
  if (maxAgeDays !== undefined && (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0)) {
    throw new TypeError(`${name}: maxAgeDays must be a positive number`);
  }
  const age = maxAgeDays === undefined ? {} : { maxAgeDays };
  if (mode === undefined || mode === 'fill') return { mode: 'fill', ...age };
  if (mode === 'replace') return { mode: 'replace', ...age };
  throw new TypeError(`${name}: "mode" must be "fill" or "replace"`);
}

/** The `mode` of an IP database module's settings, after checking all of them as {@link ipDatabaseSettings} does. */
export function geoMode(name: string, config: Readonly<Record<string, unknown>>): GeoMode {
  return ipDatabaseSettings(name, config).mode;
}

/** What a module's bundled data says about itself (the build script writes it next to the table). */
export interface DataInfo {
  /** The database the table was built from, such as `dbip-country-lite-2026-11`, or `fixture`. */
  readonly database: string;
  /** When the database was built, as an ISO 8601 date (`2026-11-01`). */
  readonly built: string;
  /** The address families in the table. */
  readonly families: 'ipv4' | 'ipv4,ipv6';
  /**
   * True for the small fixture the package ships with, which covers only documentation addresses (192.0.2.0/24,
   * 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) and so never matches a real visitor.
   */
  readonly fixture: boolean;
  /** The attribution the data's licence requires. */
  readonly attribution: string;
}

/** `device.geo` as an IP database module sends it. */
export interface IpDatabaseGeo {
  /** Location type: 2, IP address. */
  readonly type: 2;
  /** ISO 3166-1 alpha-3, as the `geo` module sends it. */
  readonly country: string;
  /** AdCOM 1.0 List: IP Location Services, when the vendor is on it (3 for MaxMind). */
  readonly ipservice?: number;
}

export interface IpDatabaseModuleOptions {
  /** The module name (`SID_MODULES`, `SID_MODULE_CONFIG`). */
  readonly name: string;
  /**
   * The range table, whose values are ISO 3166-1 alpha-2 country codes: base64 as bundled, or a table already decoded
   * with `decodeRangeTable` (so a runtime snapshot is decoded once, outside request handling).
   */
  readonly data: string | RangeTable;
  /** The data's publication date, needed only when `maxAgeDays` is configured. */
  readonly info?: DataInfo;
  /** Clock for `maxAgeDays`, in epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
  /** AdCOM's IP location service code for the vendor, if it has one. */
  readonly ipservice?: number;
}

/** The country for an address, as alpha-3, or undefined when the table has none or the code has no alpha-3. */
export function countryFor(table: RangeTable, clientIp: string | undefined): string | undefined {
  const ip = clientIp === undefined ? undefined : parseIp(clientIp);
  const code = ip === undefined ? undefined : lookupRange(table, ip);
  return code === undefined ? undefined : alpha3(code);
}

/**
 * An IP database module: looks the client IP up in a range table bundled at build time and returns its country as
 * `ortb2.device.geo` (OpenRTB 2.6, alpha-3), merged with the `geo` module's output under `mode`. The table is decoded
 * once, when the module is created; lookups are in memory, with no network access. The country is coarse location,
 * so it's sent whatever the consent signals, as `geo` sends the CDN's.
 */
export function ipDatabaseModule(options: IpDatabaseModuleOptions): EdgeModule {
  const table = typeof options.data === 'string' ? decodeRangeTable(options.data) : options.data;
  const { name, ipservice } = options;
  // Fixed for the module's lifetime: parsed once here, not per request.
  const built = options.info === undefined ? NaN : Date.parse(options.info.built);
  const now = options.now ?? Date.now;
  function run({ platform, config }: ModuleContext): ModuleResult | undefined {
    const { mode, maxAgeDays } = ipDatabaseSettings(name, config);
    if (maxAgeDays !== undefined && !Number.isFinite(built)) throw new TypeError(`${name}: no data publication date`);
    const stale = maxAgeDays !== undefined && now() - built > maxAgeDays * 86_400_000;
    const empty: ModuleResult | undefined = stale ? { stale: true } : undefined;
    if (mode === 'fill' && platform.country !== undefined && alpha3(platform.country) !== undefined) return empty;
    const country = countryFor(table, platform.clientIp);
    if (country === undefined) return empty;
    const geo: IpDatabaseGeo = { type: 2, country, ...(ipservice === undefined ? {} : { ipservice }) };
    return { ortb2: { device: { geo } }, ...(stale ? { stale: true } : {}) };
  }
  return defineModule({ name, run });
}
