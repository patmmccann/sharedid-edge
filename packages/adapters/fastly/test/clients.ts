// Recorded-style `event.client` objects and stores, as Fastly Compute hands them to the fetch listener.
import type { ConfigStoreLike, FastlyClientInfo, SecretStoreLike, Stores } from '../src/index.js';

/**
 * `event.client.geo` as Viceroy 0.22.0 (Fastly's local runtime, the same code paths as production) returned it for an
 * address without its own entry: every field, with Fastly's placeholders `?` for unknown proxy data and `0` for "no
 * metro code" (San Francisco's DMA is 807).
 */
export const SAN_FRANCISCO = {
  area_code: 415,
  as_name: 'Fastly, Inc',
  as_number: 54113,
  city: 'San Francisco',
  conn_speed: 'broadband',
  conn_type: 'wired',
  continent: 'NA',
  country_code: 'US',
  country_code3: 'USA',
  country_name: 'United States of America',
  latitude: 37.77869,
  longitude: -122.39557,
  metro_code: 0,
  postal_code: '94107',
  proxy_description: '?',
  proxy_type: '?',
  region: 'CA',
  utc_offset: -700
} as const;

/** A full record for a US city with a DMA code, in the type definitions' shape (`null` where Fastly has no value). */
export const AUSTIN = {
  as_name: null,
  as_number: null,
  area_code: 512,
  city: 'Austin',
  conn_speed: null,
  conn_type: null,
  continent: 'NA',
  country_code: 'US',
  country_code3: 'USA',
  country_name: 'United States of America',
  gmt_offset: '-600',
  latitude: 30.2672,
  longitude: -97.7431,
  metro_code: 635,
  postal_code: '78701',
  proxy_description: null,
  proxy_type: null,
  region: 'TX',
  utc_offset: -600
} as const;

/** An EU visitor, in Berlin: no area code or metro code outside North America. */
export const BERLIN = {
  ...AUSTIN,
  area_code: null,
  city: 'Berlin',
  continent: 'EU',
  country_code: 'DE',
  country_code3: 'DEU',
  country_name: 'Germany',
  gmt_offset: '+100',
  latitude: 52.52,
  longitude: 13.405,
  metro_code: 0,
  postal_code: '10115',
  region: 'BE',
  utc_offset: 100
} as const;

export function client(address: string, geo: FastlyClientInfo['geo'] = AUSTIN): FastlyClientInfo {
  return { address, geo };
}

/** A config store holding `entries`; a secret store holding `secrets`, or none linked when undefined. */
export function stores(entries: Readonly<Record<string, string>>, secrets?: Readonly<Record<string, string>>): Stores & { readonly reads: { count: number } } {
  const reads = { count: 0 };
  const config: ConfigStoreLike = {
    get: key => {
      reads.count++;
      return entries[key] ?? null;
    }
  };
  const secretStore: SecretStoreLike | undefined = secrets === undefined
    ? undefined
    : { get: key => Promise.resolve(secrets[key] === undefined ? null : { plaintext: () => secrets[key] ?? '' }) };
  return { reads, config: () => config, secrets: () => secretStore };
}

export function request(path = '/_sid/v1', init: RequestInit & { readonly host?: string } = {}): Request {
  return new Request(`https://${init.host ?? 'www.example.com'}${path}`, init);
}
