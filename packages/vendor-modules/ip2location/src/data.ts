import type { DataInfo } from '@sharedid-edge/ip-ranges';
import { IP2LOCATION_ATTRIBUTION, IP2PROXY_ATTRIBUTION } from './attribution.js';

// The fixtures the package ships with: documentation addresses only, so a deployment without real data finds nothing.
// `npm run data` (scripts/build-data.mjs) replaces the compiled dist/data.js with the real tables; this file stays.
// test/ip2location.test.ts checks both tables against the hand-made sources (FIXTURE_TABLE and PROXY_FIXTURE_TABLE).

export { PROXY_FIXTURE_TABLE } from './fixtures.js';

/** The country table, base64 (see `RangeTable` in `@sharedid-edge/ip-ranges`). */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- typed string, not this literal: the built data file has another
export const DATA: string = 'AQQCRlICWEsCSlACQlIIAICEgIAMgAGAAYDCzTGAAoCYtCaAAgABAgADAAQABAAAuJuEgAIAAICABACAgAQAAQMA';

/** What the country table is. */
export const DATA_INFO: DataInfo = Object.freeze({
  database: 'fixture',
  built: '2026-11-01',
  families: 'ipv4,ipv6',
  fixture: true,
  attribution: IP2LOCATION_ATTRIBUTION
});

/** The proxy signal table, base64: values are comma-separated proxy kinds. */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- typed string, not this literal: the built data file has another
export const PROXY_DATA: string = 'AQUDdG9yA3ZwbgtyZXNpZGVudGlhbAZwdWJsaWMRcHVibGljLGRhdGFjZW50ZXIIAICEgIAMQEBAQIDCzTGAAQABAgMEAAUABAAAuJuEgAIAAICABACAgAQAAQIA';

/** What the proxy table is. */
export const PROXY_DATA_INFO: DataInfo = Object.freeze({
  database: 'fixture',
  built: '2026-11-01',
  families: 'ipv4,ipv6',
  fixture: true,
  attribution: IP2PROXY_ATTRIBUTION
});
