import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface RunningTarget {
  readonly baseUrl: string;
  /**
   * Rewrites a case's request headers for this target. Cases describe the visitor's location with Cloudflare's
   * visitor location headers, which the Node.js target reads (with SID_TRUST_PROXY); for workerd they become
   * `request.cf`.
   */
  readonly requestHeaders: (headers: Readonly<Record<string, string>>) => Record<string, string>;
  /**
   * Payload paths the platform has no data for, such as `ortb2.device.geo.metro` where the platform reports no metro
   * code. The runner checks they're absent instead of their expected values (see `runCase`). Keep this to what the
   * platform genuinely doesn't provide, and document it in the adapter's README.
   */
  readonly unavailable: readonly string[];
  stop(): Promise<void>;
}

export type TargetName = 'node' | 'wrangler' | 'lambda' | 'vercel' | 'gcp';

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

/** Cloudflare's visitor location headers and the `request.cf` fields they come from. */
const LOCATION_HEADERS: Readonly<Record<string, string>> = {
  'cf-ipcountry': 'country',
  'cf-region-code': 'regionCode',
  'cf-ipcity': 'city',
  'cf-postal-code': 'postalCode',
  'cf-metro-code': 'metroCode',
  'cf-iplatitude': 'latitude',
  'cf-iplongitude': 'longitude',
  'cf-timezone': 'timezone',
  'cf-ipcontinent': 'continent'
};

/**
 * For `wrangler dev`: passes the case's visitor location headers to the worker as `request.cf`, and nothing else.
 * Locally, workerd fills `request.cf` from Cloudflare's view of the machine running the suite (or, offline,
 * Miniflare's placeholder, which includes a Bot Management score), and the only way to replace it per request is
 * Miniflare's `MF-CF-Blob` header (the JSON `cf` object Miniflare itself sends with `dispatchFetch`). It's sent on
 * every request, so results don't depend on where the suite runs. `clientAcceptEncoding` is kept empty, as in
 * Miniflare's default, so responses aren't compressed.
 */
function asRequestCf(headers: Readonly<Record<string, string>>): Record<string, string> {
  const cf: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const field = LOCATION_HEADERS[name.toLowerCase()];
    if (field !== undefined) cf[field] = value;
  }
  return { ...headers, 'MF-CF-Blob': JSON.stringify({ ...cf, clientAcceptEncoding: '' }) };
}

/** What each target's platform doesn't report; see `RunningTarget.unavailable`. */
const UNAVAILABLE: Readonly<Record<TargetName, readonly string[]>> = {
  node: [],
  wrangler: [],
  lambda: [],
  // Vercel's geolocation headers have no metro (DMA) code.
  vercel: ['ortb2.device.geo.metro'],
  // The load balancer's location variables are the country, subdivision, city and coordinates: no metro code, postal
  // code or time zone (so no utcoffset).
  gcp: ['ortb2.device.geo.metro', 'ortb2.device.geo.zip', 'ortb2.device.geo.utcoffset']
};

/** The custom request headers the Google Cloud stand-in's load balancer adds, by location field. */
const GCP_LOCATION_HEADERS: Readonly<Record<string, string>> = {
  country: 'x-client-region',
  region: 'x-client-region-subdivision',
  city: 'x-client-city',
  latLong: 'x-client-city-lat-long'
};

/** Starts a target configured with `config` (SID_* environment variables). */
export async function startTarget(target: TargetName, config: Readonly<Record<string, string>>): Promise<RunningTarget> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let child: ChildProcess;
  // A process the target needs besides `child`, stopped with it.
  let upstream: { readonly child: ChildProcess; readonly url: string } | undefined;
  if (target === 'node') {
    child = spawn(process.execPath, [join(ROOT, 'packages/adapters/node/dist/cli.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), HOST: '127.0.0.1', ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'lambda') {
    // The bundled Lambda handler behind a local CloudFront and function URL stand-in (lambda-emulator.ts). The
    // public origin is the emulator's own http URL, so cookies aren't Secure, as for the other local targets.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/lambda-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'vercel') {
    // The bundled Vercel adapter behind a local stand-in for Vercel's proxy (vercel-emulator.ts), which sets the
    // x-real-ip and x-vercel-ip-* headers. Plain http, so cookies aren't Secure, as for the other local targets.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/vercel-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'gcp') {
    // The real Functions Framework running the bundled function from its deploy/ directory, as Cloud Run functions
    // does, behind a local stand-in for the external Application Load Balancer (gcp-emulator.ts) that appends to
    // X-Forwarded-For and adds the location as custom request headers. Plain http, so cookies aren't Secure.
    const functionPort = await freePort();
    const location = JSON.stringify(GCP_LOCATION_HEADERS);
    const framework = join(ROOT, 'node_modules/@google-cloud/functions-framework/build/src/main.js');
    upstream = {
      url: `http://127.0.0.1:${String(functionPort)}`,
      child: spawn(process.execPath, [framework, '--target=sharedidEdge', `--source=${join(ROOT, 'packages/adapters/gcp-functions/deploy')}`, `--port=${String(functionPort)}`], {
        env: { PATH: process.env['PATH'] ?? '', SID_PUBLIC_ORIGIN: baseUrl, SID_LOCATION_HEADERS: location, ...config },
        stdio: ['ignore', 'ignore', 'inherit']
      })
    };
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/gcp-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), UPSTREAM_PORT: String(functionPort), SID_LOCATION_HEADERS: location, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else {
    // `wrangler dev` runs the worker in workerd, the Workers runtime, locally; no Cloudflare account needed.
    const vars = Object.entries(config).flatMap(([key, value]) => ['--var', `${key}:${value}`]);
    const wrangler = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
    child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'error', '--show-interactive-dev-session=false', ...vars], {
      cwd: join(ROOT, 'packages/adapters/cloudflare'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  }
  const stopChild = stopper(child);
  const stopUpstream = upstream === undefined ? () => Promise.resolve() : stopper(upstream.child);
  const stop = async (): Promise<void> => {
    await Promise.all([stopChild(), stopUpstream()]);
  };
  try {
    if (upstream !== undefined) await waitUntilUp(upstream.url, upstream.child, 15_000);
    await waitUntilUp(baseUrl, child, target === 'wrangler' ? 60_000 : 15_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    baseUrl,
    stop,
    requestHeaders: target === 'wrangler' ? asRequestCf : headers => ({ ...headers }),
    unavailable: UNAVAILABLE[target]
  };
}
