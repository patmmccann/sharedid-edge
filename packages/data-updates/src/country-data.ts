import { decodeRangeTable, type DataInfo, type RangeTable } from '@sharedid-edge/ip-ranges';

export interface CountrySnapshot {
  readonly data: string;
  readonly info: DataInfo;
}

/**
 * Tables decoded while validating, keyed by the snapshot object validateCountrySnapshot returned. SnapshotCache
 * validates during its background reload, so a request never decodes; the snapshot stays plain JSON-serializable data.
 */
const decoded = new WeakMap<CountrySnapshot, RangeTable>();

/** Runtime validation shares the same range-table decoder as bundled databases; downloaded code is never executed. */
export function validateCountrySnapshot(value: unknown): CountrySnapshot {
  if (typeof value !== 'object' || value === null || !('data' in value) || typeof value.data !== 'string' ||
      !('info' in value) || typeof value.info !== 'object' || value.info === null) throw new TypeError('Invalid country snapshot');
  const info = value.info;
  if (!('database' in info) || typeof info.database !== 'string' || info.database === '' ||
      !('built' in info) || typeof info.built !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(info.built) || !Number.isFinite(Date.parse(info.built)) ||
      !('families' in info) || (info.families !== 'ipv4' && info.families !== 'ipv4,ipv6') ||
      !('fixture' in info) || info.fixture !== false || !('attribution' in info) || typeof info.attribution !== 'string' || info.attribution === '') {
    throw new TypeError('Invalid country snapshot metadata');
  }
  const table = decodeRangeTable(value.data);
  if (table.values.length === 0) throw new TypeError('Empty country snapshot');
  const snapshot: CountrySnapshot = { data: value.data, info: { database: info.database, built: info.built, families: info.families, fixture: false, attribution: info.attribution } };
  decoded.set(snapshot, table);
  return snapshot;
}

/** The table decoded during validation; a snapshot built some other way is validated (and decoded) here instead. */
export function countryTable(snapshot: CountrySnapshot): RangeTable {
  const table = decoded.get(snapshot) ?? decoded.get(validateCountrySnapshot(snapshot));
  if (table === undefined) throw new TypeError('Invalid country snapshot');
  return table;
}
