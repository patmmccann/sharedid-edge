import { decodeRangeTable, type DataInfo } from '@sharedid-edge/ip-ranges';

export interface CountrySnapshot {
  readonly data: string;
  readonly info: DataInfo;
}

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
  return { data: value.data, info: { database: info.database, built: info.built, families: info.families, fixture: false, attribution: info.attribution } };
}
