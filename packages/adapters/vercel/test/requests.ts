/**
 * A request as a Vercel Function or Routing Middleware receives it when a browser on `www.example.com` loads
 * `GET https://www.example.com/_sid/sync?id=pubcid%3A<id>` from Prebid.js: Vercel's proxy has set the client IP and
 * the `x-vercel-ip-*` geolocation headers. Shaped after Vercel's documented request headers; the values are
 * documentation addresses and made-up IDs.
 */
export function vercelRequest(overrides: {
  readonly path?: string;
  readonly query?: string;
  readonly method?: string;
  readonly origin?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly omitHeaders?: readonly string[];
} = {}): Request {
  const headers: Record<string, string> = {
    'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'host': 'www.example.com',
    'referer': 'https://www.example.com/article',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'x-forwarded-for': '198.51.100.23',
    'x-forwarded-host': 'www.example.com',
    'x-forwarded-proto': 'https',
    'x-real-ip': '198.51.100.23',
    'x-vercel-deployment-url': 'example-site-abc123xyz-example-team.vercel.app',
    'x-vercel-forwarded-for': '198.51.100.23',
    'x-vercel-id': 'iad1::fra1::abcde-1794312000000-0123456789ab',
    'x-vercel-ip-as-number': '64496',
    'x-vercel-ip-city': 'Seattle',
    'x-vercel-ip-continent': 'NA',
    'x-vercel-ip-country': 'US',
    'x-vercel-ip-country-region': 'WA',
    'x-vercel-ip-latitude': '47.6062',
    'x-vercel-ip-longitude': '-122.3321',
    'x-vercel-ip-postal-code': '98101',
    'x-vercel-ip-timezone': 'America/Los_Angeles',
    ...overrides.headers
  };
  for (const name of overrides.omitHeaders ?? []) Reflect.deleteProperty(headers, name);
  const query = overrides.query ?? '';
  const url = `${overrides.origin ?? 'https://www.example.com'}${overrides.path ?? '/_sid/sync'}${query === '' ? '' : `?${query}`}`;
  return new Request(url, { method: overrides.method ?? 'GET', headers });
}

/** Every `x-vercel-ip-*` geolocation header, to leave a request without location. */
export const GEO_HEADERS: readonly string[] = [
  'x-vercel-ip-city', 'x-vercel-ip-continent', 'x-vercel-ip-country', 'x-vercel-ip-country-region',
  'x-vercel-ip-latitude', 'x-vercel-ip-longitude', 'x-vercel-ip-postal-code', 'x-vercel-ip-timezone'
];
