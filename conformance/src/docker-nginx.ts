// Runs the conformance suite against the Node.js server's container image (packages/adapters/node/Dockerfile) behind a
// real nginx, configured with the README's snippet (packages/adapters/node/README.md, "Deploy behind your proxy"):
// room for URLs over 8 KB, the base path to the server, `Host` passed on, `X-Forwarded-For` overwritten with the
// connecting address, no cache.
// No account: Docker on this machine (CI's ubuntu runners have it).
//
// Per case file, two containers on the host's network:
//
// - the image, with the case's SID_* settings, listening on 127.0.0.1 only, and conformance/ mounted read-only so the
//   server preloads the upstream stand-in (forwarding modules never reach the internet) and, for `no-tcf`, no-tcf.js,
//   as the Node.js target does;
// - nginx (the image NGINX_IMAGE pins), listening on 127.0.0.1 and [::1], with `location <base path>/` as the README
//   writes it. Requests outside the base path would go to the site's application; here the same block sends them to
//   the server too, so the cases about paths outside SharedID Edge's routes (and forwarding modules' own paths) reach
//   it. With the root base path, that's the one block.
//
// nginx overwrites X-Forwarded-For with the connecting address, as the README requires, so a case's client IP must be
// the connection's: a relay in the runner's process sends each request to nginx from the case's client IP (the first
// X-Forwarded-For entry with SID_TRUST_PROXY; otherwise 127.0.0.1), as fastly-viceroy.ts does. Those addresses must be
// local: on Linux, `sudo ip route add local 192.0.2.0/24 dev lo`, as CI does for the cases' ranges. The cases'
// Cloudflare location headers pass through nginx unchanged, as they would from Cloudflare in front of it.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { caseClientIp, forwardFrom, freePort, readBody, serveRelay } from './emulator.js';

const run = promisify(execFile);

/** nginx, as the sGTM tests' stack pins it (e2e/sgtm/docker-compose.yml). */
export const NGINX_IMAGE = 'nginx:1.29-alpine';

export interface DockerTargetOptions {
  /** The port the relay listens on, on 127.0.0.1. */
  readonly port: number;
  /** The case file's settings (SID_*), and anything else the server's environment needs (SID_MODULE_PACKAGES). */
  readonly env: Readonly<Record<string, string>>;
  /** The image to run (SID_DOCKER_IMAGE, or sharedid-edge-node:conformance). */
  readonly image: string;
  /** The repository's conformance/ folder, mounted at /conformance. */
  readonly conformanceDir: string;
  /** Files under conformance/dist/ the server preloads with --import, like upstream-preload.js. */
  readonly preload: readonly string[];
}

/**
 * The README's nginx snippet for `basePath`, sending requests to the server on `upstreamPort`, and the catch-all that
 * stands in for the site's application.
 */
export function nginxConfig(basePath: string, listenPort: number, upstreamPort: number): string {
  const proxy = [
    `        proxy_pass http://127.0.0.1:${String(upstreamPort)};`,
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, don\'t append: the server takes the first entry',
    '        proxy_cache off;',
    '        access_log off;                                  # its URLs carry the ID and consent strings'
  ];
  const base = basePath.replace(/\/+$/, '');
  return [
    'server {',
    `    listen 127.0.0.1:${String(listenPort)};`,
    `    listen [::1]:${String(listenPort)};`,
    '    large_client_header_buffers 4 16k;',
    ...(base === '' ? [] : [`    location ${base}/ {`, ...proxy, '    }']),
    '    # The site\'s application, in a real deployment; here the same server, for the cases outside the base path.',
    '    location / {',
    ...proxy,
    '    }',
    '}',
    ''
  ].join('\n');
}

async function docker(...args: string[]): Promise<string> {
  return (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

/** Starts the server's container and nginx, and the relay in front; resolves once nginx answers, to a function that stops them. */
export async function startDockerTarget(options: DockerTargetOptions): Promise<() => Promise<void>> {
  const trustProxy = /^(1|true|yes|on)$/i.test(options.env['SID_TRUST_PROXY'] ?? '');
  const [serverPort, nginxPort] = [await freePort(), await freePort()];
  const name = `sharedid-conformance-${String(options.port)}`;
  const dir = mkdtempSync(join(tmpdir(), 'sharedid-nginx-'));
  const conf = join(dir, 'default.conf');
  writeFileSync(conf, nginxConfig(options.env['SID_BASE_PATH'] ?? '/_sid', nginxPort, serverPort));

  const env = {
    ...options.env,
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    // The image's health check isn't used here; off, so it doesn't take a port.
    HEALTH_PORT: '',
    NODE_OPTIONS: options.preload.map(file => `--import /conformance/dist/${file}`).join(' ')
  };
  const stopAll = async (): Promise<void> => {
    await docker('rm', '-f', `${name}-server`, `${name}-nginx`).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await docker('run', '-d', '--name', `${name}-server`, '--network', 'host', '--no-healthcheck',
      '-v', `${options.conformanceDir}:/conformance:ro`,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      options.image);
    await docker('run', '-d', '--name', `${name}-nginx`, '--network', 'host', '-v', `${conf}:/etc/nginx/conf.d/default.conf:ro`, NGINX_IMAGE);
    await ready(`http://127.0.0.1:${String(nginxPort)}/__conformance_ready`, `${name}-server`, `${name}-nginx`);
  } catch (error) {
    await stopAll();
    throw error;
  }

  const closeRelay = serveRelay(options.port, 'nginx relay failed', async req => {
    const from = caseClientIp({ headers: req.headers, socket: {} }, trustProxy) ?? '127.0.0.1';
    return forwardFrom(isIPv6(from) ? '::1' : '127.0.0.1', nginxPort, from, req.method ?? 'GET', req.url ?? '/', req.rawHeaders, await readBody(req));
  });

  return async () => {
    await closeRelay();
    await stopAll();
  };
}

/**
 * Waits until nginx answers with the server's own answer (any status but nginx's 502, which means the server isn't up
 * yet). Fails with the server's log when its container stops first, as it does on invalid settings.
 */
async function ready(url: string, server: string, nginx: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).status !== 502) return;
    } catch { /* nginx isn't up yet */ }
    for (const container of [server, nginx]) {
      if (await docker('inspect', '-f', '{{.State.Running}}', container) !== 'true') {
        throw new Error(`${container} stopped before it was ready:\n${await logs(container)}`);
      }
    }
    if (Date.now() > deadline) throw new Error(`${server} behind nginx didn't answer within 30 s`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** A container's output, stdout and stderr. */
async function logs(container: string): Promise<string> {
  try {
    const { stdout, stderr } = await run('docker', ['logs', container]);
    return `${stdout}${stderr}`.trim();
  } catch {
    return '';
  }
}
