// What the container image relies on (Dockerfile, README's "Run in a container"): secrets from mounted files, the
// health check on its own port, and the CLI's fail-fast start-up and SIGTERM handling. The CLI tests run the built
// dist/cli.js (npm run build first), as the image does.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@sharedid-edge/core';
import { withSecretFiles } from '../src/env-files.js';
import { createHealthServer, healthPortFromEnv } from '../src/health.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');

describe('withSecretFiles', () => {
  const files: Record<string, string> = { '/run/secrets/modules': '{"ec":{"passphrase":"x"}}\n', '/run/secrets/upstream': '["a"]' };
  const read = (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error('ENOENT');
    return content;
  };

  it('reads SID_MODULE_SECRETS and SID_UPSTREAM_SECRETS from their _FILE, without the trailing newline', () => {
    const env = withSecretFiles({ SID_MODULE_SECRETS_FILE: '/run/secrets/modules', SID_UPSTREAM_SECRETS_FILE: '/run/secrets/upstream', PORT: '1' }, read);
    expect(env).toEqual({ SID_MODULE_SECRETS: '{"ec":{"passphrase":"x"}}', SID_UPSTREAM_SECRETS: '["a"]', PORT: '1' });
  });

  it('leaves the environment as it is without a _FILE', () => {
    expect(withSecretFiles({ SID_MODULE_SECRETS: '{}' }, read)).toEqual({ SID_MODULE_SECRETS: '{}' });
  });

  it('refuses both a setting and its _FILE, a blank _FILE, and a file it can\'t read', () => {
    expect(() => withSecretFiles({ SID_MODULE_SECRETS: '{}', SID_MODULE_SECRETS_FILE: '/run/secrets/modules' }, read)).toThrow(ConfigError);
    expect(() => withSecretFiles({ SID_UPSTREAM_SECRETS_FILE: ' ' }, read)).toThrow(/SID_UPSTREAM_SECRETS_FILE is empty/);
    expect(() => withSecretFiles({ SID_MODULE_SECRETS_FILE: '/run/secrets/missing' }, read)).toThrow(/can't read \/run\/secrets\/missing/);
  });

  it('refuses a blank file, which would otherwise turn trusted-upstream authentication off', () => {
    for (const contents of ['', '\n', '  \n']) {
      const blank = (): string => contents;
      expect(() => withSecretFiles({ SID_UPSTREAM_SECRETS_FILE: '/run/secrets/upstream' }, blank)).toThrow(/SID_UPSTREAM_SECRETS_FILE: \/run\/secrets\/upstream is empty/);
      expect(() => withSecretFiles({ SID_MODULE_SECRETS_FILE: '/run/secrets/modules' }, blank)).toThrow(ConfigError);
    }
  });
});

describe('healthPortFromEnv', () => {
  it('is off when unset or blank, and a port otherwise', () => {
    expect(healthPortFromEnv(undefined, 8787)).toBeUndefined();
    expect(healthPortFromEnv('', 8787)).toBeUndefined();
    expect(healthPortFromEnv('8788', 8787)).toBe(8788);
  });

  it('refuses a value that isn\'t a port, and the public port', () => {
    for (const value of ['0', '65536', '88.5', 'eighty']) expect(() => healthPortFromEnv(value, 8787)).toThrow(/HEALTH_PORT must be a port number/);
    expect(() => healthPortFromEnv('8787', 8787)).toThrow(/must differ from PORT/);
  });
});

describe('createHealthServer', () => {
  it('answers GET and HEAD /healthz with 200, and anything else with 404, never cached', async () => {
    const server = createHealthServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const ok = await fetch(`${base}/healthz`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('ok\n');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.getSetCookie()).toEqual([]);
      expect((await fetch(`${base}/healthz?probe=1`, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
      for (const path of ['/', '/_sid/v1', '/healthz/x']) expect((await fetch(`${base}${path}`)).status).toBe(404);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => { resolve(port); });
    });
  });
}

/** Runs the built CLI with `env` (and PATH); resolves with its exit code and output once it exits. */
function cli(env: Record<string, string>): { child: ChildProcessByStdio<null, Readable, Readable>; output: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [CLI], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  return { child, output: () => output, exited };
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

describe('the CLI', () => {
  it('exits with 1 and a configuration error, before listening, when the configuration is invalid', async () => {
    const run = cli({ PORT: String(await freePort()) });
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(/^Configuration error: .*SID_COOKIE_DOMAIN/m);
  });

  it('exits with 1 when a secret file is missing', async () => {
    const run = cli({ PORT: String(await freePort()), SID_COOKIE_DOMAIN: 'host-only', SID_MODULE_SECRETS_FILE: join(tmpdir(), 'sharedid-no-such-file') });
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(/^Configuration error: SID_MODULE_SECRETS_FILE: can't read/m);
  });

  it('reads the upstream secrets from a file, answers the health check on HEALTH_PORT, and exits with 0 on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sharedid-cli-'));
    const secret = 'a'.repeat(32);
    writeFileSync(join(dir, 'upstream'), `${JSON.stringify([secret])}\n`);
    const [port, healthPort] = [await freePort(), await freePort()];
    const run = cli({
      PORT: String(port),
      HEALTH_PORT: String(healthPort),
      SID_COOKIE_DOMAIN: 'host-only',
      SID_UPSTREAM_SECRETS_FILE: join(dir, 'upstream'),
      SID_LOCATION_HEADERS: '{"country":"x-sid-country"}'
    });
    try {
      await until(async () => (await fetch(`http://127.0.0.1:${String(healthPort)}/healthz`)).status === 200);
      // Trusted-upstream mode is on, with the file's secret: without it a 403, with it the ID.
      expect((await fetch(`http://127.0.0.1:${String(port)}/_sid/v1`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${String(port)}/_sid/v1`, { headers: { 'x-sid-upstream-auth': secret } })).status).toBe(200);
      // The public port answers only SharedID Edge's routes.
      expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`, { headers: { 'x-sid-upstream-auth': secret } })).status).toBe(404);
    } finally {
      run.child.kill('SIGTERM');
    }
    // Windows has no SIGTERM handler to run: kill() ends the process there.
    expect(await run.exited).toBe(process.platform === 'win32' ? null : 0);
  });
});
