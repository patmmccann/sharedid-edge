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
