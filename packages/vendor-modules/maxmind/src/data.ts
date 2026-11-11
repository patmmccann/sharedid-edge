import type { DataInfo } from '@sharedid-edge/ip-ranges';
import { MAXMIND_ATTRIBUTION } from './attribution.js';

// The fixture the package ships with: documentation addresses only (FIXTURE_TABLE in @sharedid-edge/ip-ranges/build),
// so a deployment without real data finds nothing. `npm run data` (scripts/build-data.mjs) replaces the compiled
// dist/data.js with the real table; this file stays as it is. test/maxmind.test.ts checks it matches the fixture.

/** The bundled range table, base64 (see `RangeTable` in `@sharedid-edge/ip-ranges`). */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- typed string, not this literal: the built data file has another
export const DATA: string = 'AQQCRlICWEsCSlACQlIIAICEgIAMgAGAAYDCzTGAAoCYtCaAAgABAgADAAQABAAAuJuEgAIAAICABACAgAQAAQMA';

/** What the bundled table is. */
export const DATA_INFO: DataInfo = Object.freeze({
  database: 'fixture',
  built: '2026-11-01',
  families: 'ipv4,ipv6',
  fixture: true,
  attribution: MAXMIND_ATTRIBUTION
});
