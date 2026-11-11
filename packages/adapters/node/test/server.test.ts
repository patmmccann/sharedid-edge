import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { defineModule, resolveConfig } from '@sharedid-edge/core';
import { createNodeServer, type NodeServerOptions } from '../src/index.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
let server: Server | undefined;

async function start(options: NodeServerOptions): Promise<string> {
  server = createNodeServer(options);
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  await new Promise<void>(resolve => { server?.close(() => { resolve(); }); });
  server = undefined;
});

describe('node server', () => {
  it('serves the sync pixel with both cookies as separate Set-Cookie headers', async () => {
    const base = await start({ config: resolveConfig({}) });
    const response = await fetch(`${base}/_sid/sync?id=pubcid%253A${UUID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
    expect(cookies[1]).toMatch(/^_pubcid_sv=.*HttpOnly$/);
    expect((await response.arrayBuffer()).byteLength).toBe(43);
  });

  it('passes the socket address as the client IP, or the forwarded one when trusted', async () => {
    const ip = defineModule({ name: 'ip', run: ({ platform }) => ({ ortb2: { ip: platform.clientIp } }) });
    const config = resolveConfig({ SID_MODULES: 'ip' });
    const direct = await start({ config, modules: [ip] });
    const directBody = await (await fetch(`${direct}/_sid/v1`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json() as { ortb2: { ip: string } };
    expect(directBody.ortb2.ip).toBe('127.0.0.1');
    await new Promise<void>(resolve => { server?.close(() => { resolve(); }); });

    const proxied = await start({ config, modules: [ip], trustProxy: true });
    const proxiedBody = await (await fetch(`${proxied}/_sid/v1`, { headers: { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' } })).json() as { ortb2: { ip: string } };
    expect(proxiedBody.ortb2.ip).toBe('203.0.113.9');
  });

  it("reads Cloudflare's visitor location headers only when the proxy is trusted", async () => {
    const location = defineModule({ name: 'location', run: ({ platform }) => ({ ortb2: { platform: { ...platform, clientIp: undefined } } }) });
    const config = resolveConfig({ SID_MODULES: 'location' });
    const headers = {
      'cf-ipcountry': 'CH', 'cf-region-code': 'ZH', 'cf-ipcity': Buffer.from('Zürich', 'utf8').toString('latin1'), 'cf-postal-code': '8001',
      'cf-metro-code': '', 'cf-iplatitude': '47.37690', 'cf-iplongitude': '8.54170', 'cf-timezone': 'Europe/Zurich', 'cf-ipcontinent': 'EU'
    };
    const read = async (base: string, h: Record<string, string>): Promise<unknown> =>
      ((await (await fetch(`${base}/_sid/v1`, { headers: h })).json()) as { ortb2: { platform: unknown } }).ortb2.platform;

    const direct = await start({ config, modules: [location] });
    expect(await read(direct, headers)).toEqual({});
    await new Promise<void>(resolve => { server?.close(() => { resolve(); }); });

    const proxied = await start({ config, modules: [location], trustProxy: true });
    expect(await read(proxied, headers)).toEqual({
      country: 'CH', region: 'ZH', city: 'Zürich', postalCode: '8001', latitude: 47.3769, longitude: 8.5417, timezone: 'Europe/Zurich', continent: 'EU', isEU: false
    });
    expect(await read(proxied, { 'cf-ipcountry': 'T1', 'cf-iplatitude': 'abc', 'cf-iplongitude': '1' })).toEqual({});
    expect(await read(proxied, { 'cf-ipcountry': 'XX', 'cf-ipcity': 'Saint-Étienne' })).toEqual({ city: 'Saint-Étienne' });
  });

  it('treats a trusted EU country as GDPR applying: no TC string, no cookies', async () => {
    const config = resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' });
    const names = async (base: string, path: string, h: Record<string, string> = {}): Promise<string[]> =>
      (await fetch(`${base}/_sid/${path}`, { headers: h })).headers.getSetCookie().map(c => c.slice(0, c.indexOf('=')));

    const proxied = await start({ config, trustProxy: true });
    expect(await names(proxied, 'sync', { 'cf-ipcountry': 'DE' })).toEqual([]);
    expect(await names(proxied, 'sync', { 'cf-ipcountry': 'US' })).toEqual(['_pubcid', '_pubcid_sv']);
    // An explicit gdpr=0 still wins over the location.
    expect(await names(proxied, 'sync?gdpr=0', { 'cf-ipcountry': 'DE' })).toEqual(['_pubcid', '_pubcid_sv']);
    await new Promise<void>(resolve => { server?.close(() => { resolve(); }); });

    // Untrusted, the header is the visitor's own and is ignored: the country is unknown.
    const direct = await start({ config });
    expect(await names(direct, 'sync', { 'cf-ipcountry': 'DE' })).toEqual(['_pubcid', '_pubcid_sv']);
  });

  it("reads the location from a CDN's own headers when locationHeaders names them, and only those", async () => {
    const location = defineModule({ name: 'location', run: ({ platform }) => ({ ortb2: { platform: { ...platform, clientIp: undefined } } }) });
    const config = resolveConfig({ SID_MODULES: 'location', SID_COOKIE_DOMAIN: 'host-only' });
    const base = await start({ config, modules: [location], trustProxy: true, locationHeaders: { country: 'cloudfront-viewer-country', regionCode: 'cloudfront-viewer-country-region' } });
    const response = await fetch(`${base}/_sid/v1`, { headers: { 'cloudfront-viewer-country': 'FR', 'cloudfront-viewer-country-region': 'IDF', 'cf-ipcountry': 'US', 'cf-ipcity': 'Boston' } });
    expect(((await response.json()) as { ortb2: { platform: unknown } }).ortb2.platform).toEqual({ country: 'FR', region: 'IDF', isEU: true });
    // FR is in the EU and there's no TC string: GDPR applies, so no ID cookies.
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('builds request URLs from the public origin, so cookies are Secure behind TLS termination', async () => {
    const base = await start({ config: resolveConfig({}), publicOrigin: 'https://www.example.com' });
    const response = await fetch(`${base}/_sid/sync`);
    expect(response.headers.getSetCookie()[0]).toContain('; Secure');
  });

  it('answers HEAD without a body', async () => {
    const base = await start({ config: resolveConfig({}) });
    const response = await fetch(`${base}/_sid/sync`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});
