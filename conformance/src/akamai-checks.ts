// Checks of the Akamai EdgeWorker that the shared cases can't express, run against the bundle behind the EdgeWorkers
// stand-in (akamai-emulator.ts) after the suite (`npm run conformance:akamai`):
//
// - A visitor-sent X-Forwarded-For doesn't choose the location or client IP. Akamai documents that EdgeScape's
//   userLocation then describes the forwarded address, so the EdgeWorker must drop it, and must take the client IP
//   from PMUSER_SID_CLIENT_IP (the property's AK_CLIENT_REAL_IP), not the request.
// - Every response tells caches not to share it: `Cache-Control` has `no-store` or `private`. EdgeWorkers runs
//   responseProvider only on a cache miss, so a response cached at the edge would reach other visitors.
//
// The stand-in reads the case convention: with SID_TRUST_PROXY the first X-Forwarded-For entry is the connecting
// address, and later entries are what the visitor sent.
import { startTarget } from './targets.js';

interface Payload {
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly geo?: { readonly country?: string } } };
}

const CONNECTING = '192.0.2.77';
const LOCATION = { 'cf-ipcountry': 'US', 'cf-region-code': 'TX', 'cf-ipcity': 'Austin', 'cf-timezone': 'America/Chicago' };

let failures = 0;
let count = 0;
function check(name: string, ok: boolean, detail = ''): void {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok' : 'not ok'} - ${name}${ok || detail === '' ? '' : `\n  # ${detail}`}`);
}

const target = await startTarget('akamai', { SID_TRUST_PROXY: '1', SID_MODULES: 'ip,geo', SID_COOKIE_DOMAIN: 'host-only' });
try {
  const v1 = async (forwardedFor: string): Promise<Payload> => {
    const response = await fetch(new URL('/_sid/v1', target.baseUrl), { headers: { 'x-forwarded-for': forwardedFor, ...LOCATION } });
    return await response.json() as Payload;
  };

  console.log('# akamai: a visitor-sent X-Forwarded-For');
  const direct = await v1(CONNECTING);
  check('uses EdgeScape\'s location without one', direct.ortb2?.device?.geo?.country === 'USA', JSON.stringify(direct.ortb2));
  check('uses the connecting address without one', direct.ortb2?.device?.ip === CONNECTING, JSON.stringify(direct.ortb2));
  const spoofed = await v1(`${CONNECTING}, 203.0.113.9`);
  check('drops the location, which then describes the forwarded address', spoofed.ortb2?.device?.geo === undefined, JSON.stringify(spoofed.ortb2));
  check('keeps the connecting address from PMUSER_SID_CLIENT_IP', spoofed.ortb2?.device?.ip === CONNECTING, JSON.stringify(spoofed.ortb2));

  console.log('# akamai: no response may be shared by caches');
  for (const [method, path] of [['GET', '/_sid/sync?id=pubcid%3Ac29cb2ae-769d-42f6-891a-f53cadee823d'], ['GET', '/_sid/v1'], ['HEAD', '/_sid/sync'], ['GET', '/_sid/optout'], ['GET', '/_sid/nothing'], ['POST', '/_sid/v1']] as const) {
    const response = await fetch(new URL(path, target.baseUrl), { method, headers: { 'x-forwarded-for': CONNECTING } });
    const cacheControl = response.headers.get('cache-control') ?? '';
    check(`${method} ${path.split('?')[0] ?? path} (${String(response.status)}) has Cache-Control no-store or private`, /\b(no-store|private)\b/.test(cacheControl), `Cache-Control: ${cacheControl}`);
  }
} finally {
  await target.stop();
}

console.log(`\n${String(count - failures)}/${String(count)} Akamai checks passed`);
if (failures > 0) process.exitCode = 1;
