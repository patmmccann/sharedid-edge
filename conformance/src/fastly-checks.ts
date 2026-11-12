// Checks of the Fastly Compute package that the shared cases can't express, run against the real WebAssembly in
// Viceroy (fastly-viceroy.ts) after the suite (`npm run conformance:fastly`):
//
// - The client IP and location come from the connection, IPv4 and IPv6: X-Forwarded-For and Fastly-Client-IP sent by
//   the visitor change neither. A Compute service gets both headers as the visitor sent them.
// - Every Set-Cookie reaches the client as its own header.
// - Every response tells caches not to share it: `Cache-Control` has `no-store` or `private`.
// - In trusted-upstream mode, a repeated auth header and a visitor's own Fastly-Client-IP get a 403, and an
//   authenticated request's client IP is the front service's header.
// - A service without the config store linked answers 500, without cookies.
// - One visitor's request leaves nothing for the next: two visitors in turn, with different cookies, click IDs and
//   locations, each get only their own. With the --reusable-sandbox build (deploy/main.js imports
//   fastly:experimental), Viceroy's log must show one sandbox answering both in turn; without it, a sandbox per request.
//
// The target reads the case convention: with SID_TRUST_PROXY the first X-Forwarded-For entry is the connecting
// address, and later entries are what the visitor sent. Only loopback addresses are used, so this runs anywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { freePort } from './emulator.js';
import { startFastlyTarget } from './fastly-viceroy.js';
import { checkCacheControl, Checks } from './checks.js';
import { startTarget } from './targets.js';

interface Payload {
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string; readonly geo?: { readonly country?: string; readonly region?: string } } };
}

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const LOCATION = { 'cf-ipcountry': 'US', 'cf-region-code': 'TX', 'cf-ipcity': 'Austin' };

const checks = new Checks();
const check = checks.check.bind(checks);

const target = await startTarget('fastly', { SID_TRUST_PROXY: '1', SID_MODULES: 'ip,geo', SID_COOKIE_DOMAIN: 'host-only' }, [], [
  { 'x-forwarded-for': '127.0.0.1', ...LOCATION },
  { 'x-forwarded-for': '::1', ...LOCATION }
]);
try {
  const v1 = async (headers: Readonly<Record<string, string>>): Promise<Payload> => {
    const response = await fetch(new URL('/_sid/v1', target.baseUrl), { headers: { ...LOCATION, ...headers } });
    return await response.json() as Payload;
  };

  console.log('# fastly: the client IP and location come from the connection');
  const direct = await v1({ 'x-forwarded-for': '127.0.0.1' });
  check('uses the connecting address, IPv4', direct.ortb2?.device?.ip === '127.0.0.1', JSON.stringify(direct.ortb2));
  check("uses Fastly's location of it", direct.ortb2?.device?.geo?.country === 'USA' && direct.ortb2.device.geo.region === 'TX', JSON.stringify(direct.ortb2));
  const spoofed = await v1({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9', 'fastly-client-ip': '198.51.100.1' });
  check('ignores X-Forwarded-For and Fastly-Client-IP for the client IP', spoofed.ortb2?.device?.ip === '127.0.0.1', JSON.stringify(spoofed.ortb2));
  check('ignores them for the location', spoofed.ortb2?.device?.geo?.country === 'USA', JSON.stringify(spoofed.ortb2));
  const ipv6 = await v1({ 'x-forwarded-for': '::1, 203.0.113.9', 'fastly-client-ip': '198.51.100.1' });
  check('uses the connecting address, IPv6 (::1)', ipv6.ortb2?.device?.ipv6 === '::1', JSON.stringify(ipv6.ortb2));
  check("uses Fastly's location of the IPv6 address", ipv6.ortb2?.device?.geo?.country === 'USA', JSON.stringify(ipv6.ortb2));

  console.log('# fastly: cookies and caching');
  const sync = await fetch(new URL(`/_sid/sync?id=pubcid%3A${UUID}`, target.baseUrl), { headers: { 'x-forwarded-for': '127.0.0.1' } });
  const cookies = sync.headers.getSetCookie();
  check('sends each Set-Cookie as its own header', cookies.length === 2 && cookies.every(cookie => cookie.includes(UUID)), JSON.stringify(cookies));
  await checkCacheControl(checks, target.baseUrl, { 'x-forwarded-for': '127.0.0.1' });
} finally {
  await target.stop();
}

// Trusted upstream, as in service chaining: the shared cases (trusted-upstream.json) cover a missing or wrong secret;
// these cover what they can't send, a repeated auth header, and Fastly-Client-IP from a visitor.
console.log('# fastly: trusted upstream');
const SECRET = 'conformance-upstream-0123456789abcdef0123456789abcdef';
const upstream = await startTarget('fastly', {
  SID_TRUST_PROXY: '1',
  SID_MODULES: 'ip',
  SID_COOKIE_DOMAIN: 'host-only',
  SID_UPSTREAM_SECRETS: JSON.stringify([SECRET]),
  SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
  SID_LOCATION_HEADERS: '{"country":"x-sid-country"}'
}, [], [{ 'x-forwarded-for': '127.0.0.1', ...LOCATION }]);
try {
  const repeated = new Headers({ 'x-forwarded-for': '127.0.0.1', 'x-sid-country': 'US' });
  repeated.append('x-sid-upstream-auth', SECRET);
  repeated.append('x-sid-upstream-auth', SECRET);
  const twice = await fetch(new URL(`/_sid/sync?id=pubcid%3A${UUID}`, upstream.baseUrl), { headers: repeated });
  check('refuses a repeated auth header, with no cookies', twice.status === 403 && twice.headers.getSetCookie().length === 0, String(twice.status));
  const visitor = await fetch(new URL('/_sid/v1', upstream.baseUrl), { headers: { 'x-forwarded-for': '127.0.0.1', 'fastly-client-ip': '198.51.100.1', 'x-sid-client-ip': '198.51.100.2' } });
  check('refuses a visitor sending Fastly-Client-IP without the secret', visitor.status === 403, String(visitor.status));
  const chained = await fetch(new URL('/_sid/v1', upstream.baseUrl), { headers: { 'x-forwarded-for': '127.0.0.1', 'x-sid-upstream-auth': SECRET, 'x-sid-client-ip': '203.0.113.5', 'x-sid-country': 'US', 'fastly-client-ip': '198.51.100.1' } });
  const body = await chained.json() as Payload;
  check("uses the front service's client IP, not the connection's or Fastly-Client-IP", body.ortb2?.device?.ip === '203.0.113.5', JSON.stringify(body.ortb2));
} finally {
  await upstream.stop();
}

const PACKAGE = join(import.meta.dirname, '..', '..', 'packages/adapters/fastly/deploy');
const reusable = readFileSync(join(PACKAGE, 'main.js'), 'utf8').includes('fastly:experimental');
console.log(`# fastly: one visitor's request leaves nothing for the next (${reusable ? 'reusable sandboxes' : 'a sandbox per request'})`);
{
  // With SID_TRUST_PROXY, the relay sends each visitor's request from the X-Forwarded-For address, located as the cf-*
  // headers say: visitor A from 127.0.0.1 in Texas, visitor B from 127.0.0.2 in Quebec.
  const visitorA = { 'x-forwarded-for': '127.0.0.1', 'cf-ipcountry': 'US', 'cf-region-code': 'TX' };
  const visitorB = { 'x-forwarded-for': '127.0.0.2', 'cf-ipcountry': 'CA', 'cf-region-code': 'QC' };
  const lines: string[] = [];
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const stop = await startFastlyTarget({
    port,
    config: {
      SID_TRUST_PROXY: '1',
      SID_COOKIE_DOMAIN: 'host-only',
      SID_MODULES: 'ip,geo,reflect,clickid',
      SID_MODULE_CONFIG: JSON.stringify({ reflect: { cookies: [{ name: 'uid1', maxAgeDays: 365 }] }, clickid: { hosts: ['127.0.0.1'] } })
    },
    viceroy: process.env['VICEROY'] ?? 'viceroy',
    wasm: join(PACKAGE, 'main.wasm'),
    requests: [visitorA, visitorB],
    log: line => { lines.push(line); }
  });
  try {
    for (let round = 1; round <= 3; round++) {
      const landing = encodeURIComponent(`http://127.0.0.1/?gclid=VisitorA${String(round)}`);
      const a = await fetch(`${base}/_sid/v1?url=${landing}`, { headers: { ...visitorA, cookie: `_pubcid=${UUID}; uid1=visitor-a-${String(round)}` } });
      const aText = JSON.stringify([await a.json(), a.headers.getSetCookie()]);
      check(`visitor A (${String(round)}) gets its own cookies, click ID, address and location`, [UUID, `visitor-a-${String(round)}`, `VisitorA${String(round)}`, '"127.0.0.1"', '"USA"'].every(marker => aText.includes(marker)), aText);
      const b = await fetch(`${base}/_sid/v1`, { headers: visitorB });
      const bPayload = await b.json() as Payload & { readonly sharedid?: string };
      const bText = JSON.stringify([bPayload, b.headers.getSetCookie()]);
      check(`visitor B (${String(round)}), next, gets nothing of visitor A's`, ![UUID, 'visitor-a', 'VisitorA', '"127.0.0.1"', '"USA"', '"TX"'].some(marker => bText.includes(marker)), bText);
      check(`visitor B (${String(round)}) gets a new ID, its own address and location`, bPayload.sharedid !== undefined && bPayload.sharedid !== UUID && bPayload.ortb2?.device?.ip === '127.0.0.2' && bPayload.ortb2.device.geo?.country === 'CAN', bText);
    }
    // A sandbox that's waiting for another request ends after its 2 s between-request timeout, and logs it then.
    await new Promise(resolve => setTimeout(resolve, 3000));
  } finally {
    await stop();
  }
  // Viceroy numbers requests from 0, in the order they come (the relay sends one at a time), and logs
  // "request{id=N}: response status" for each, and "request{id=N}: request completed" when a sandbox ends, N being
  // the sandbox's first request. The last six requests are the visits: A, B, A, B, A, B.
  const ids = new Set<number>();
  // A sandbox's end is logged twice (memory and time), with the same N.
  const ended = new Set<number>();
  for (const colored of lines) {
    const line = stripVTControlCharacters(colored);
    const answered = /request\{id=(\d+)\}: response status/.exec(line);
    if (answered !== null) ids.add(Number(answered[1]));
    const completed = /request\{id=(\d+)\}: request completed/.exec(line);
    if (completed !== null) ended.add(Number(completed[1]));
  }
  const firsts = [...ended];
  const visits = [...ids].sort((x, y) => x - y).slice(-6);
  const sandboxOf = (id: number): number => Math.max(-1, ...firsts.filter(first => first <= id));
  // Visitor B's requests (the 2nd, 4th and 6th visit) answered by the sandbox that answered visitor A just before.
  const shared = [1, 3, 5].filter(i => sandboxOf(visits[i] ?? -1) === sandboxOf(visits[i - 1] ?? -2)).length;
  const detail = `${String(ids.size)} requests, ${String(firsts.length)} sandboxes, ${String(shared)} of 3 B visits in A's sandbox`;
  check('Viceroy logged every request and the sandboxes that answered them', visits.length === 6 && firsts.length > 0 && Math.min(...firsts) <= Math.min(...visits), detail);
  if (reusable) check('one sandbox answered visitor A, then visitor B (reuse happened)', shared > 0, detail);
  else check('each request had a sandbox of its own (no reuse)', firsts.length === ids.size && shared === 0, detail);
}

console.log('# fastly: a service without its config store');
const port = await freePort();
const stop = await startFastlyTarget({
  port,
  config: {},
  viceroy: process.env['VICEROY'] ?? 'viceroy',
  wasm: join(PACKAGE, 'main.wasm'),
  requests: [],
  stores: false
});
try {
  const response = await fetch(`http://127.0.0.1:${String(port)}/_sid/sync?id=pubcid%3A${UUID}`);
  check('answers 500, without cookies', response.status === 500 && response.headers.getSetCookie().length === 0, `${String(response.status)} ${JSON.stringify(response.headers.getSetCookie())}`);
  check('says only that it is misconfigured', await response.text() === 'SharedID Edge is misconfigured');
} finally {
  await stop();
}

checks.done('Fastly');
