import { HttpRequest } from '@azure/functions';

export const FRONT_DOOR_ID = '0f1e2d3c-4b5a-4978-8a7b-6c5d4e3f2a1b';

/**
 * An HTTP trigger request as the Functions host delivers it when Azure Front Door forwards
 * `GET https://www.example.com/_sid/sync?id=pubcid%3A<id>` from Prebid.js: Front Door has added `X-Azure-ClientIP`,
 * `X-Azure-SocketIP`, `X-Azure-FDID`, `X-Azure-Ref` and `X-Forwarded-*`, and the request arrives on the function
 * app's own host name. Built with @azure/functions' own `HttpRequest` (in its test mode). The values are
 * documentation addresses and made-up IDs.
 */
export function frontDoorRequest(overrides: {
  readonly path?: string;
  readonly query?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly omitHeaders?: readonly string[];
  readonly body?: string;
} = {}): HttpRequest {
  const headers: Record<string, string> = {
    'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'host': 'sharedid-edge-abc123.azurewebsites.net',
    'referer': 'https://www.example.com/article',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'via': '1.1 Azure',
    'x-azure-clientip': '198.51.100.23',
    'x-azure-fdid': FRONT_DOOR_ID,
    'x-azure-ref': '20261110T120000Z-abcdef0123456789abcdef0123',
    'x-azure-requestchain': 'hops=1',
    'x-azure-socketip': '198.51.100.23',
    'x-forwarded-for': '198.51.100.23',
    'x-forwarded-host': 'www.example.com',
    'x-forwarded-proto': 'https',
    ...overrides.headers
  };
  for (const name of overrides.omitHeaders ?? []) Reflect.deleteProperty(headers, name);
  const query = overrides.query ?? '';
  return new HttpRequest({
    method: overrides.method ?? 'GET',
    url: `https://sharedid-edge-abc123.azurewebsites.net${overrides.path ?? '/_sid/sync'}${query === '' ? '' : `?${query}`}`,
    headers,
    ...(overrides.body === undefined ? {} : { body: { string: overrides.body } })
  });
}
