import type { EdgeWorkerRequest, EdgeWorkerUserLocation } from '../src/index.js';

/** EdgeScape's location for a Cambridge, Massachusetts address, as the EdgeWorkers documentation shows it. */
export const CAMBRIDGE: EdgeWorkerUserLocation = {
  continent: 'NA',
  country: 'US',
  region: 'MA',
  city: 'CAMBRIDGE',
  zipCode: '02138',
  dma: '506',
  latitude: '42.364948',
  longitude: '-71.088783',
  timezone: 'America/New_York'
};

export interface RequestOptions {
  readonly method?: string;
  readonly scheme?: string;
  readonly host?: string;
  /** Path and query, as `request.url`. */
  readonly url?: string;
  readonly headers?: Readonly<Record<string, readonly string[]>>;
  readonly clientIp?: string;
  readonly userLocation?: EdgeWorkerUserLocation;
  /** Property Manager variables, by full name (`PMUSER_SID_COOKIE_DOMAIN`). */
  readonly variables?: Readonly<Record<string, string>>;
}

/**
 * A request object as EdgeWorkers passes it to `responseProvider`, for www.example.com over https: header names
 * lowercase, each value an array with one string per header line.
 */
export function edgeWorkerRequest(options: RequestOptions = {}): EdgeWorkerRequest {
  const host = options.host ?? 'www.example.com';
  const headers: Record<string, readonly string[]> = {
    host: [host],
    'user-agent': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'],
    accept: ['image/webp,image/avif,image/*,*/*;q=0.8'],
    'accept-language': ['en-US,en;q=0.9'],
    ...options.headers
  };
  const variables: Readonly<Record<string, string>> = { PMUSER_SID_COOKIE_DOMAIN: 'example.com', ...options.variables };
  return {
    method: options.method ?? 'GET',
    scheme: options.scheme ?? 'https',
    host,
    url: options.url ?? '/_sid/v1',
    clientIp: options.clientIp ?? '198.51.100.10',
    userLocation: options.userLocation ?? CAMBRIDGE,
    getHeaders: () => headers,
    getVariable: name => variables[name]
  };
}
