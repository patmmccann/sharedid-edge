// Checks what a real CloudFront distribution passes to the SharedID Edge function behind it: this project's AWS live
// tests (.github/workflows/e2e-aws.yml; packages/adapters/aws-lambda/README.md, Live tests), not for deployers.
//
//   npx tsx scripts/check-cloudfront.ts --endpoint https://d111111abcdef8.cloudfront.net/_sid-platform
//                                       [--allowed-origin https://allowed.example] [--function-url https://….on.aws/]
//
// The endpoint is a behaviour with the managed CachingDisabled and AllViewerExceptHostHeader policies, in front of a
// function with SID_MODULES=ip,geo,ua,bot and SID_ALLOWED_ORIGINS=<allowed origin> (the live tests' platform stack).
// Each check reads something only the function can know: the IP and location CloudFront saw (CloudFront-Viewer-*),
// device data from the User-Agent and Client Hints, CORS from Origin, a GPC denial from Sec-GPC.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: {
    readonly device?: {
      readonly ip?: string;
      readonly ipv6?: string;
      readonly geo?: { readonly country?: string; readonly region?: string; readonly city?: string; readonly utcoffset?: number };
      readonly sua?: { readonly browsers?: readonly { readonly brand: string }[]; readonly platform?: { readonly brand: string } };
      readonly ext?: { readonly traffic?: { readonly bot?: boolean; readonly botKind?: string } };
    };
  };
  readonly ext?: { readonly modules?: Readonly<Record<string, { readonly status: string }>> };
}

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    'allowed-origin': { type: 'string', default: 'https://allowed.example' },
    'function-url': { type: 'string' }
  }
});
if (values.endpoint === undefined) {
  console.error('Usage: check-cloudfront --endpoint https://<distribution>/_sid-platform [--allowed-origin https://allowed.example] [--function-url https://<id>.lambda-url.<region>.on.aws/]');
  process.exit(2);
}
let endpoint = values.endpoint;
while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
const allowedOrigin = values['allowed-origin'];

// A desktop Chrome, as the browser sends it: the User-Agent, the default Client Hints and Accept-Language (whose
// absence the bot module reads as a likely bot).
const CHROME = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Accept-Language': 'en-US,en;q=0.9'
};

const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1;
}

async function v1(headers: Record<string, string>): Promise<{ response: Response; payload: Payload | undefined }> {
  const response = await fetch(`${endpoint}/v1`, { headers });
  const body: unknown = await response.json().catch(() => undefined);
  return { response, payload: isPayload(body) ? body : undefined };
}

function clientIp(payload: Payload | undefined): string | undefined {
  return payload?.ortb2?.device?.ip ?? payload?.ortb2?.device?.ipv6;
}

async function publicIp(): Promise<string | undefined> {
  // AWS's own echo service: the address this machine's requests come from, over the same address family as fetch's.
  const response = await fetch('https://checkip.amazonaws.com/').catch(() => undefined);
  return response?.ok === true ? (await response.text()).trim() : undefined;
}

async function run(): Promise<void> {
  // Served by CloudFront, not cached, with the viewer's address, location and browser.
  const first = await v1(CHROME);
  const second = await v1(CHROME);
  check('v1 answers 200 with payload version 1, through CloudFront', first.response.status === 200 && first.payload !== undefined && first.response.headers.has('x-amz-cf-pop'),
    `${String(first.response.status)}, x-amz-cf-pop: ${first.response.headers.get('x-amz-cf-pop') ?? 'none'}, x-cache: ${first.response.headers.get('x-cache') ?? 'none'}`);
  const cache = [first, second].map(r => r.response.headers.get('x-cache') ?? '');
  check('caching disabled: each request reaches the function', first.payload?.sharedid !== undefined && first.payload.sharedid !== second.payload?.sharedid && cache.every(c => !/hit/i.test(c)) && !second.response.headers.has('age'),
    `two new ids: ${String(first.payload?.sharedid)}, ${String(second.payload?.sharedid)}; x-cache: ${cache.join(', ')}; cache-control: ${first.response.headers.get('cache-control') ?? 'none'}`);

  const ip = clientIp(first.payload);
  const expectedIp = await publicIp();
  check('CloudFront-Viewer-Address reaches the function as the client IP (ip module)', ip !== undefined && (expectedIp === undefined || expectedIp === ip),
    `device.ip(v6): ${ip ?? 'none'}; checkip.amazonaws.com: ${expectedIp ?? 'unavailable'}`);

  const geo = first.payload?.ortb2?.device?.geo;
  check('the viewer location headers reach the function (geo module)', geo?.country !== undefined && /^[A-Z]{3}$/.test(geo.country),
    `device.geo: ${JSON.stringify(geo ?? null)}`);

  const sua = first.payload?.ortb2?.device?.sua;
  check('User-Agent and Client Hints reach the function (ua module)', sua?.browsers?.some(b => b.brand === 'Google Chrome') === true && sua.platform?.brand === 'Windows',
    `device.sua: ${JSON.stringify(sua ?? null)}`);
  check('Accept-Language reaches the function (bot module: no "likely" bot)', first.payload?.ortb2?.device?.ext?.traffic?.botKind !== 'likely',
    `traffic: ${JSON.stringify(first.payload?.ortb2?.device?.ext?.traffic ?? null)}`);

  // A visitor's own CloudFront-Viewer-* and X-Forwarded-For can't set the IP or location: CloudFront replaces them.
  const forged = await v1({ ...CHROME, 'CloudFront-Viewer-Address': '192.0.2.1:1234', 'X-Forwarded-For': '192.0.2.1', 'CloudFront-Viewer-Country': 'NZ', 'CloudFront-Viewer-City': 'Forged' });
  const forgedGeo = forged.payload?.ortb2?.device?.geo;
  check('forged CloudFront-Viewer-* and X-Forwarded-For headers are replaced', clientIp(forged.payload) === ip && forgedGeo?.city !== 'Forged' && (geo?.country === 'NZL' || forgedGeo?.country !== 'NZL'),
    `device.ip(v6): ${clientIp(forged.payload) ?? 'none'}; device.geo: ${JSON.stringify(forgedGeo ?? null)}`);

  // Origin: CORS for the allowed origin only.
  const allowed = await v1({ ...CHROME, Origin: allowedOrigin });
  check('Origin reaches the function (CORS for an allowed origin)', allowed.response.headers.get('access-control-allow-origin') === allowedOrigin && allowed.response.headers.get('access-control-allow-credentials') === 'true',
    `access-control-allow-origin: ${allowed.response.headers.get('access-control-allow-origin') ?? 'none'}`);
  const other = await v1({ ...CHROME, Origin: 'https://not-allowed.example' });
  check('no CORS for another origin', other.response.headers.get('access-control-allow-origin') === null,
    `access-control-allow-origin: ${other.response.headers.get('access-control-allow-origin') ?? 'none'}`);

  // Sec-GPC: denied, no id set.
  const id = randomUUID();
  const gpc = await fetch(`${endpoint}/sync?id=${encodeURIComponent(encodeURIComponent(`pubcid:${id}`))}`, { headers: { ...CHROME, 'Sec-GPC': '1' } });
  const setsId = gpc.headers.getSetCookie().some(c => c.startsWith(`_pubcid=${id}`));
  check('Sec-GPC reaches the function (denied: gpc, no id)', gpc.status === 200 && gpc.headers.get('x-sharedid-status') === 'denied: gpc' && !setsId,
    `${String(gpc.status)}, x-sharedid-status: ${gpc.headers.get('x-sharedid-status') ?? 'none'}`);

  // Host isn't forwarded: origin access control signs for the function URL's own host, so a forwarded Host would make
  // every request above a 403. And the function URL refuses requests that don't come through CloudFront.
  if (values['function-url'] !== undefined) {
    const direct = await fetch(new URL(`${new URL(endpoint).pathname}/v1`, values['function-url']), { headers: CHROME });
    check('the function URL refuses direct requests (AWS_IAM)', direct.status === 403, String(direct.status));
  }
}

try {
  await run();
} catch (error) {
  check('endpoint reachable', false, `${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${(c.ok ? 'ok' : 'FAIL').padEnd(4)} ${c.name} - ${c.detail}`);
}
console.log(failed === 0 ? '\nCloudFront passes what the function needs.' : `\n${String(failed)} check(s) failed.`);
process.exitCode = failed === 0 ? 0 : 1;
