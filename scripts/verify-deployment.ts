// Checks a SharedID Edge deployment from outside, as a browser would see it:
//
//   npx tsx scripts/verify-deployment.ts --site https://www.example.com [--endpoint https://www.example.com/_sid]
//                                         [--cookie-name _pubcid] [--min-days 300]
//
// 1. DNS: the endpoint's host resolves to at least one of the site's IP addresses. Safari caps cookies set by a
//    server whose IP address doesn't match the website's (its defence against CNAME and IP cloaking).
// 2. The sync endpoint returns the pixel, sets the SharedID cookie (Secure, SameSite=Lax, long-lived, readable by
//    script) and its HttpOnly recovery copy, adopts the id it's sent, and isn't served from a shared cache.
// 3. The JSON endpoint returns payload v1.
import { resolve4, resolve6 } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly warning?: boolean;
}

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    endpoint: { type: 'string' },
    'cookie-name': { type: 'string', default: '_pubcid' },
    'recovery-cookie-name': { type: 'string', default: '_pubcid_sv' },
    'min-days': { type: 'string', default: '300' }
  }
});

if (values.site === undefined) {
  console.error('Usage: verify-deployment --site https://www.example.com [--endpoint https://www.example.com/_sid] [--cookie-name _pubcid] [--min-days 300]');
  process.exit(2);
}

const site = new URL(values.site);
const endpoint = new URL((values.endpoint ?? `${site.origin}/_sid`).replace(/\/+$/, ''));
const cookieName = values['cookie-name'];
const recoveryName = values['recovery-cookie-name'];
const minSeconds = Number(values['min-days']) * 86_400;
const checks: Check[] = [];

function listOr(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.join(', ');
}

function check(name: string, ok: boolean, detail: string, warning = false): void {
  checks.push({ name, ok, detail, warning });
}

async function addresses(host: string): Promise<string[]> {
  const v4 = await resolve4(host).catch((): string[] => []);
  const v6 = await resolve6(host).catch((): string[] => []);
  return [...v4, ...v6];
}

function parseSetCookie(header: string): { name: string; value: string; attrs: Map<string, string> } {
  const [pair = '', ...rest] = header.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  const attrs = new Map<string, string>();
  for (const attr of rest) {
    const i = attr.indexOf('=');
    attrs.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? '' : attr.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

// 1. DNS
if (endpoint.protocol !== 'https:') check('endpoint uses https', false, `${endpoint.origin}: cookies need Secure, which needs https`);
const siteIps = await addresses(site.hostname);
const endpointIps = endpoint.hostname === site.hostname ? siteIps : await addresses(endpoint.hostname);
if (siteIps.length === 0) {
  check('site resolves', false, `${site.hostname} has no A or AAAA records`);
} else if (endpoint.hostname === site.hostname) {
  check('endpoint is on the site\'s own host', true, `${endpoint.hostname} (${siteIps.join(', ')})`);
} else {
  const shared = endpointIps.filter(ip => siteIps.includes(ip));
  check(
    'endpoint shares IP addresses with the site',
    shared.length > 0,
    shared.length > 0
      ? `shared: ${shared.join(', ')}`
      : `${endpoint.hostname} → ${listOr(endpointIps, 'nothing')}; ${site.hostname} → ${siteIps.join(', ')}. Safari will cap the cookie: serve the endpoint from the CDN that serves the site.`
  );
}

// 2. Sync endpoint, as Prebid.js calls pixelUrl on a first visit
const id = randomUUID();
const syncUrl = `${endpoint.href}/sync?id=${encodeURIComponent(encodeURIComponent(`pubcid:${id}`))}`;
try {
  const response = await fetch(syncUrl, { headers: { 'User-Agent': 'sharedid-edge-verify' }, redirect: 'manual' });
  check('sync returns 200 image/gif', response.status === 200 && response.headers.get('content-type') === 'image/gif', `${String(response.status)} ${String(response.headers.get('content-type'))}`);
  const cookies = response.headers.getSetCookie().map(parseSetCookie);
  const main = cookies.find(c => c.name === cookieName);
  const recovery = cookies.find(c => c.name === recoveryName);
  if (main === undefined) {
    check(`sets ${cookieName}`, false, `Set-Cookie: ${listOr(cookies.map(c => c.name), 'none')} (check SID_COOKIE_NAME, consent (X-SharedID-Status) and that the route reaches the worker)`);
  } else {
    check('adopts the id Prebid.js sends', main.value === id, `${cookieName}=${main.value}`);
    const maxAge = Number(main.attrs.get('max-age') ?? 0);
    check(`${cookieName} lives at least ${values['min-days']} days`, maxAge >= minSeconds, `Max-Age=${String(maxAge)}`);
    check(`${cookieName} is Secure`, main.attrs.has('secure'), [...main.attrs.keys()].join(', '));
    check(`${cookieName} is SameSite=Lax`, main.attrs.get('samesite') === 'Lax', `SameSite=${String(main.attrs.get('samesite'))}`);
    check(`${cookieName} is readable by Prebid.js (not HttpOnly)`, !main.attrs.has('httponly'), main.attrs.has('httponly') ? 'HttpOnly is set' : 'ok');
    const domain = main.attrs.get('domain');
    if (domain !== undefined) {
      const bare = domain.replace(/^\./, '');
      check('cookie Domain covers the site', site.hostname === bare || site.hostname.endsWith(`.${bare}`), `Domain=${domain}`);
    }
  }
  if (recovery === undefined) {
    check(`sets the ${recoveryName} recovery copy`, true, 'not set (SID_RECOVERY_COOKIE=none?); a capped cookie can\'t be restored', true);
  } else {
    check(`${recoveryName} is HttpOnly`, recovery.attrs.has('httponly'), [...recovery.attrs.keys()].join(', '));
  }
  const cacheStatus = response.headers.get('cf-cache-status') ?? response.headers.get('x-cache') ?? response.headers.get('age');
  check('not served from a shared cache', cacheStatus === null || !/HIT/i.test(cacheStatus), `cache status: ${cacheStatus ?? 'none'}`);
} catch (error) {
  check('sync endpoint reachable', false, `${syncUrl}: ${error instanceof Error ? error.message : String(error)}`);
}

// 3. JSON endpoint
try {
  const response = await fetch(`${endpoint.href}/v1`, { headers: { Cookie: `${cookieName}=${id}` } });
  const body: unknown = await response.json();
  const ok = typeof body === 'object' && body !== null && (body as { v?: unknown }).v === 1;
  check('v1 returns payload version 1', ok, `${String(response.status)} ${JSON.stringify(body).slice(0, 200)}`);
} catch (error) {
  check('v1 returns JSON', false, error instanceof Error ? error.message : String(error));
}

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? (c.warning === true ? 'warn' : 'ok') : 'FAIL';
  if (!c.ok) failed++;
  console.log(`${mark.padEnd(4)} ${c.name} - ${c.detail}`);
}
console.log(failed === 0 ? '\nDeployment looks good.' : `\n${String(failed)} check(s) failed.`);
process.exitCode = failed === 0 ? 0 : 1;
