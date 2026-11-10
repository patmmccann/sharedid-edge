import type { LambdaEventV2 } from '../src/index.js';

/**
 * A function URL event as Lambda delivers it when CloudFront (with origin access control) forwards
 * `GET https://www.example.com/_sid/sync?id=pubcid%3A<id>` from Prebid.js: Prebid.js encodes the `:` in the `id`
 * parameter, and the browser sends the page's cookies. Shaped after recorded payload format 2.0 events; the
 * values are documentation addresses and made-up IDs.
 */
export function cloudFrontEvent(overrides: {
  readonly path?: string;
  readonly query?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
  readonly omitHeaders?: readonly string[];
} = {}): LambdaEventV2 {
  const headers: Record<string, string> = {
    'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-encoding': 'gzip',
    'cloudfront-viewer-address': '198.51.100.23:51234',
    'cloudfront-viewer-country': 'US',
    'cloudfront-viewer-country-region': 'WA',
    'host': 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-west-2.on.aws',
    'referer': 'https://www.example.com/article',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'via': '2.0 0123456789abcdef0123456789abcdef.cloudfront.net (CloudFront)',
    'x-amz-cf-id': 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c2v3b4n5m6==',
    'x-amzn-trace-id': 'Root=1-6730c0de-0123456789abcdef01234567',
    'x-forwarded-for': '198.51.100.23, 64.252.0.10',
    'x-forwarded-port': '443',
    'x-forwarded-proto': 'https',
    ...overrides.headers
  };
  for (const name of overrides.omitHeaders ?? []) Reflect.deleteProperty(headers, name);
  // Every field a function URL sends; the adapter reads only some of them.
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: overrides.path ?? '/_sid/sync',
    rawQueryString: overrides.query ?? '',
    ...(overrides.cookies === undefined ? {} : { cookies: overrides.cookies }),
    headers,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abcdefghijklmnopqrstuvwxyz012345',
      domainName: 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-west-2.on.aws',
      domainPrefix: 'abcdefghijklmnopqrstuvwxyz012345',
      http: {
        method: overrides.method ?? 'GET',
        path: overrides.path ?? '/_sid/sync',
        protocol: 'HTTP/1.1',
        sourceIp: '64.252.0.10',
        userAgent: 'Amazon CloudFront'
      },
      requestId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      routeKey: '$default',
      stage: '$default',
      time: '10/Nov/2026:12:00:00 +0000',
      timeEpoch: 1794312000000
    },
    isBase64Encoded: false
  };
  return event;
}
