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
//
// The target reads the case convention: with SID_TRUST_PROXY the first X-Forwarded-For entry is the connecting
// address, and later entries are what the visitor sent. Only loopback addresses are used, so this runs anywhere.
import { join } from 'node:path';
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

console.log('# fastly: a service without its config store');
const port = await freePort();
const stop = await startFastlyTarget({
  port,
  config: {},
  viceroy: process.env['VICEROY'] ?? 'viceroy',
  wasm: join(import.meta.dirname, '..', '..', 'packages/adapters/fastly/deploy/main.wasm'),
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
