import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface RunningTarget {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export type TargetName = 'node' | 'wrangler';

const ROOT = join(import.meta.dirname, '..', '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => { resolve(port); });
    });
  });
}

async function waitUntilUp(baseUrl: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const state = { exited: false };
  child.once('exit', () => { state.exited = true; });
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`target exited before it was ready (${baseUrl})`);
    try {
      // Any response, even a 404, means the server is up.
      await fetch(new URL('/__conformance_ready', baseUrl));
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`target didn't start within ${String(timeoutMs)} ms (${baseUrl})`);
}

function stopper(child: ChildProcess): () => Promise<void> {
  return () => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => { resolve(); });
    child.kill();
  });
}

/** Starts a target configured with `config` (SID_* environment variables). */
export async function startTarget(target: TargetName, config: Readonly<Record<string, string>>): Promise<RunningTarget> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let child: ChildProcess;
  if (target === 'node') {
    child = spawn(process.execPath, [join(ROOT, 'packages/node/dist/cli.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), HOST: '127.0.0.1', ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else {
    // `wrangler dev` runs the worker in workerd, the Workers runtime, locally; no Cloudflare account needed.
    const vars = Object.entries(config).flatMap(([key, value]) => ['--var', `${key}:${value}`]);
    const wrangler = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
    child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'error', '--show-interactive-dev-session=false', ...vars], {
      cwd: join(ROOT, 'packages/cloudflare'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  }
  const stop = stopper(child);
  try {
    await waitUntilUp(baseUrl, child, target === 'wrangler' ? 60_000 : 15_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { baseUrl, stop };
}
