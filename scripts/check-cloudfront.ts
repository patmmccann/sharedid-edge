// Checks what a real CloudFront distribution passes to the SharedID Edge function behind it: this project's AWS live
// tests (.github/workflows/e2e-aws.yml; packages/adapters/aws-lambda/README.md, Live tests), not for deployers.
//
//   npx tsx scripts/check-cloudfront.ts --endpoint https://d111111abcdef8.cloudfront.net/platform/_sid
//                                       [--allowed-origin https://allowed.example] [--function-url https://….on.aws/]
//                                       [--event viewer-request]
//
// The endpoint is a behaviour with the managed CachingDisabled policy, in front of a function with
// SID_MODULES=ip,geo,ua,bot and SID_ALLOWED_ORIGINS=<allowed origin> (the live tests' platform stacks): the regional
// function behind AllViewerExceptHostHeader, or a Lambda@Edge function on the origin-request event behind
// AllViewerAndCloudFrontHeaders-2022-06. Each check reads something only the function can know: the IP and location
// CloudFront saw (CloudFront-Viewer-*), device data from the User-Agent and Client Hints, CORS from Origin, a GPC
// denial from Sec-GPC.
//
// --event viewer-request checks a Lambda@Edge function on the viewer-request event instead, with SID_MODULES=ip,ua,bot
// (no geo: there is no location) and GDPR applying to every visitor without a location (the default): without a TC
// string or gdpr=0 nothing is set, and the other checks send gdpr=0, as a page outside the EU may.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CHROME, checkClientIp, clientIp, runChecks, v1 as getV1 } from './live-checks.js';
import type { CheckFn, Payload } from './live-checks.js';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    'allowed-origin': { type: 'string', default: 'https://allowed.example' },
    'function-url': { type: 'string' },
    event: { type: 'string', default: 'origin-request' }
  }
});
if (values.endpoint === undefined) {
  console.error('Usage: check-cloudfront --endpoint https://<distribution>/platform/_sid [--allowed-origin https://allowed.example] [--function-url https://<id>.lambda-url.<region>.on.aws/] [--event viewer-request]');
  process.exit(2);
}
let endpoint = values.endpoint;
while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
const allowedOrigin = values['allowed-origin'];
const viewerRequest = values.event === 'viewer-request';
/** With viewer-request, gdpr=0: GDPR applies to every visitor otherwise, and the ip and ua modules would send nothing precise. */
const query = viewerRequest ? '?gdpr=0' : '';

async function v1(headers: Record<string, string>): Promise<{ response: Response; payload: Payload | undefined }> {
  return getV1(`${endpoint}/v1${query}`, headers);
}

async function run(check: CheckFn): Promise<void> {
  // Served by CloudFront, not cached, with the viewer's address, location and browser.
  const first = await v1(CHROME);
  const second = await v1(CHROME);
  check('v1 answers 200 with payload version 1, through CloudFront', first.response.status === 200 && first.payload !== undefined && first.response.headers.has('x-amz-cf-pop'),
    `${String(first.response.status)}, x-amz-cf-pop: ${first.response.headers.get('x-amz-cf-pop') ?? 'none'}, x-cache: ${first.response.headers.get('x-cache') ?? 'none'}`);
  const cache = [first, second].map(r => r.response.headers.get('x-cache') ?? '');
  check('caching disabled: each request reaches the function', first.payload?.sharedid !== undefined && first.payload.sharedid !== second.payload?.sharedid && cache.every(c => !/hit/i.test(c)) && !second.response.headers.has('age'),
    `two new ids: ${String(first.payload?.sharedid)}, ${String(second.payload?.sharedid)}; x-cache: ${cache.join(', ')}; cache-control: ${first.response.headers.get('cache-control') ?? 'none'}`);

  const ip = await checkClientIp(check, 'CloudFront-Viewer-Address reaches the function as the client IP (ip module)', first.payload);

  const geo = first.payload?.ortb2?.device?.geo;
  if (viewerRequest) {
    // No location, and GDPR applies to everyone without it: no ID without a TC string or gdpr=0.
    const closed = await getV1(`${endpoint}/v1`, CHROME);
    check('without a location, GDPR applies: no ID without a TC string (viewer-request)', closed.response.status === 200 && closed.payload?.sharedid === undefined && closed.response.headers.get('x-sharedid-status') === 'denied: tcf: GDPR applies and there is no TC string' && closed.response.headers.getSetCookie().length === 0,
      `x-sharedid-status: ${closed.response.headers.get('x-sharedid-status') ?? 'none'}, sharedid: ${String(closed.payload?.sharedid)}`);
  } else {
    check('the viewer location headers reach the function (geo module)', geo?.country !== undefined && /^[A-Z]{3}$/.test(geo.country),
      `device.geo: ${JSON.stringify(geo ?? null)}`);
  }

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
  const gpc = await fetch(`${endpoint}/sync?${viewerRequest ? 'gdpr=0&' : ''}id=${encodeURIComponent(encodeURIComponent(`pubcid:${id}`))}`, { headers: { ...CHROME, 'Sec-GPC': '1' } });
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

await runChecks(endpoint, run, 'CloudFront passes what the function needs.');
