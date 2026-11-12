import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EU_COUNTRY_CODES } from '@sharedid-edge/core';
import type { BuildOption } from './cases.js';
import { freePort } from './emulator.js';
import { startFastlyTarget } from './fastly-viceroy.js';
import { join } from 'node:path';

export interface RunningTarget {
  readonly baseUrl: string;
  /**
   * The origin the implementation builds request URLs from: the case file's SID_PUBLIC_ORIGIN where the adapter reads
   * it, otherwise `baseUrl`. The Worker always sees the real request URL, so for `wrangler` it's `baseUrl`.
   */
  readonly publicOrigin: string;
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
  /**
   * Cases the platform can't pass, by `file#case name`, with the reason. The runner reports them as TODO instead of
   * failures, and fails if one passes. Only for a documented limitation of the platform itself, never to skip a
   * failure of the adapter; the adapter's README says what it means for publishers.
   */
  readonly limitations: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

export type TargetName = 'node' | 'wrangler' | 'lambda' | 'lambda-aws-emulator' | 'vercel' | 'azure' | 'gcp' | 'akamai' | 'fastly';

const ROOT = join(import.meta.dirname, '..', '..');

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
  // Cloudflare sets isEUCountry ("1" for the 27 EU member states) whenever it knows the country; the Worker reads it
  // to decide whether GDPR applies.
  const country = cf['country'];
  if (country !== undefined && country !== '') cf['isEUCountry'] = EU_COUNTRY_CODES.has(country.toUpperCase()) ? '1' : '0';
  return { ...headers, 'MF-CF-Blob': JSON.stringify({ ...cf, clientAcceptEncoding: '' }) };
}

/** What each target's platform doesn't report; see `RunningTarget.unavailable`. */
const UNAVAILABLE: Readonly<Record<TargetName, readonly string[]>> = {
  node: [],
  wrangler: [],
  lambda: [],
  // No location at all, so the cases that need one are limitations instead (see LIMITATIONS).
  'lambda-aws-emulator': [],
  // Vercel's geolocation headers have no metro (DMA) code.
  vercel: ['ortb2.device.geo.metro'],
  // The stand-in's rule set passes every location field, so nothing is missing here; the real Front Door template
  // passes only the country (see the adapter's README).
  azure: [],
  // The load balancer's location variables are the country, subdivision, city and coordinates: no metro code, postal
  // code or time zone (so no utcoffset).
  gcp: ['ortb2.device.geo.metro', 'ortb2.device.geo.zip', 'ortb2.device.geo.utcoffset'],
  // EdgeScape's userLocation has every location field (its zipCode only when it names one postal code).
  akamai: [],
  // Fastly's geolocation has a UTC offset but no IANA time zone, and the geo module computes utcoffset from the time
  // zone (with Intl, which Fastly Compute's runtime doesn't have either).
  fastly: ['ortb2.device.geo.utcoffset']
};

/** The cases of `file` named in `names`, each with `reason`. */
function limited(file: string, reason: string, names: readonly string[]): [string, string][] {
  return names.map(name => [`${file}#${name}`, reason]);
}

/**
 * Cases a target can't pass, by `file#case name`; see `RunningTarget.limitations`.
 *
 * AWS Emulator, with nothing in front of the function URL (SID_BEHIND_CLOUDFRONT=false):
 * - No location: that's CloudFront's (its CloudFront-Viewer-* headers), so the geo module has nothing, and GDPR can't
 *   follow from the visitor's country.
 * - The client IP is the connection's (`requestContext.http.sourceIp`), which the suite can't choose: it's always the
 *   loopback address, so the cases that set one (through X-Forwarded-For) for the ip, ec, dbip and maxmind modules can't
 *   pass.
 * - AWS Emulator answers every request that carries an Origin header, or `Sec-Fetch-Site: cross-site`, with its own 403
 *   AccessDenied (its guard against web pages driving a local emulator, with no setting to allow an origin), so the CORS
 *   cases and the clickid module's cross-site case never reach the function. Lambda function URLs on AWS pass them to
 *   the function.
 */
const NO_LOCATION = 'no location without CloudFront in front of the function URL';
const CLIENT_IP = "the client IP is the connection's, which the suite can't set";
const NO_LOCATION_OR_CLIENT_IP = `${NO_LOCATION}, and ${CLIENT_IP}`;
const LIMITATIONS: Readonly<Partial<Record<TargetName, Readonly<Record<string, string>>>>> = {
  'lambda-aws-emulator': Object.fromEntries([
    ...limited('consent-eu-location.json', NO_LOCATION, [
      'an EU visitor without a TC string gets no ID cookies',
      "an EU visitor's existing ID cookies are deleted without a TC string"
    ]),
    ...limited('module-geo.json', NO_LOCATION, [
      'returns the location as device.geo, precise fields included',
      'strips the country prefix from the region and leaves out unknown fields',
      'ignores invalid coordinates and an unknown time zone',
      'sends only coarse fields with Global Privacy Control',
      'sends only coarse fields for a COPPA request',
      'sends only coarse fields with a US privacy opt-out of sale',
      'sends only coarse fields when GDPR applies and there is no TC string',
      'sends only coarse fields without opt-in to precise geolocation',
      'sends only coarse fields with an invalid TC string',
      'sends the precise fields with opt-in to precise geolocation'
    ]),
    ...limited('module-geo-coarse.json', NO_LOCATION, [
      'sends only the coarse fields',
      'sends only the coarse fields even with opt-in to precise geolocation'
    ]),
    ...limited('module-ip.json', CLIENT_IP, [
      'adds an IPv4 client address as device.ip',
      'adds an IPv6 client address as device.ipv6, in RFC 5952 form',
      'sends the full address with opt-in to precise geolocation'
    ]),
    ...limited('module-ec.json', CLIENT_IP, [
      'mints ts-ec from an IPv4 address',
      "mints ts-ec from an IPv6 address's /64",
      "mints ts-ec on /sync (Prebid.js's pixelUrl call), with the pixel response otherwise unchanged"
    ]),
    ...limited('module-dbip.json', CLIENT_IP, [
      'fills in the country for an IPv4 address when the CDN has none',
      'fills in the country for an IPv6 address',
      'sends the country with Global Privacy Control and for a COPPA request'
    ]),
    ...limited('module-dbip.json', NO_LOCATION, ["leaves the CDN's country alone"]),
    ...limited('module-dbip.json', NO_LOCATION_OR_CLIENT_IP, ["fills in the country when the CDN's has no alpha-3 code (Tor, T1)"]),
    ...limited('module-dbip-replace.json', NO_LOCATION_OR_CLIENT_IP, ["replaces the CDN's country, keeping geo's other fields"]),
    ...limited('module-maxmind.json', CLIENT_IP, [
      'fills in the country, with ipservice 3, when the CDN has none',
      'fills in the country for an IPv6 address',
      'sends the country with Global Privacy Control and for a COPPA request'
    ]),
    ...limited('module-maxmind.json', NO_LOCATION, ["leaves the CDN's country alone, with no ipservice"]),
    ...limited('module-maxmind-replace.json', NO_LOCATION_OR_CLIENT_IP, ["replaces the CDN's country, keeping geo's other fields"]),
    ...limited('routes.json', 'AWS Emulator refuses requests with an Origin header before they reach the function', [
      'v1 allows credentialed CORS from a configured origin',
      'v1 sends no CORS headers for other origins',
      'v1 answers a CORS preflight from a configured origin'
    ]),
    ...limited('module-clickid.json', 'AWS Emulator refuses requests with Sec-Fetch-Site: cross-site before they reach the function', [
      'ignores the url parameter on a request from another site (Sec-Fetch-Site: cross-site), even naming an allowed host'
    ])
  ])
};

/** The environment without SID_* settings, so only the case file's reach a target that's given the environment. */
function withoutSettings(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('SID_')));
}

/** The custom request headers the Google Cloud stand-in's load balancer adds, by location field. */
const GCP_LOCATION_HEADERS: Readonly<Record<string, string>> = {
  country: 'x-client-region',
  region: 'x-client-region-subdivision',
  city: 'x-client-city',
  latLong: 'x-client-city-lat-long'
};

/** The Front Door profile ID the Azure stand-in sends as X-Azure-FDID, and the function app accepts. */
const AZURE_FRONT_DOOR_ID = '0f1e2d3c-4b5a-4978-8a7b-6c5d4e3f2a1b';

/** The headers the Azure stand-in's "rule set" adds, by location field (SID_LOCATION_HEADERS). */
const AZURE_LOCATION_HEADERS: Readonly<Record<string, string>> = {
  country: 'x-sid-country',
  regionCode: 'x-sid-region',
  city: 'x-sid-city',
  postalCode: 'x-sid-postal-code',
  metroCode: 'x-sid-metro-code',
  latitude: 'x-sid-latitude',
  longitude: 'x-sid-longitude',
  timezone: 'x-sid-timezone',
  continent: 'x-sid-continent'
};

/**
 * Starts a target configured with `config` (SID_* environment variables) and built with `build`. With `bowser`, the
 * Worker runs its Bowser entry point (src/bowser.ts), and the Lambda, Vercel, Azure, Google Cloud, Akamai and Fastly targets load
 * the bundles `npm run conformance:lambda`, `conformance:vercel`, `conformance:azure`, `conformance:gcp`,
 * `conformance:akamai` and `conformance:fastly` build into deploy-bowser/. The Node.js
 * server always has Bowser. `requests` are the case file's request headers: the Fastly target seeds Viceroy's
 * geolocation entries from them, so Viceroy needn't restart for each new location.
 */
export async function startTarget(
  target: TargetName,
  caseConfig: Readonly<Record<string, string>>,
  build: readonly BuildOption[] = [],
  requests: readonly Readonly<Record<string, string>>[] = []
): Promise<RunningTarget> {
  // Every deployment must set SID_COOKIE_DOMAIN. The targets answer on 127.0.0.1, where cookies are host-only, so that's
  // the default here; a case sets a domain to test one, or "" to test the error for a missing one.
  const config: Readonly<Record<string, string>> = { SID_COOKIE_DOMAIN: 'host-only', ...caseConfig };
  const bowser = build.includes('bowser');
  // With vendor-modules, every module in packages/vendor-modules/ is added to the built-in ones, as a deployer adds
  // them: the bundled targets load deploy-vendor/ (built by the root conformance:* scripts), the Node.js server gets
  // SID_MODULE_PACKAGES, and the Worker a generated entry point (scripts/module-list.mjs).
  const vendor = build.includes('vendor-modules');
  const bundle = bowser ? 'deploy-bowser' : vendor ? 'deploy-vendor' : 'deploy';
  const moduleList = (...args: string[]): string => execFileSync(process.execPath, [join(ROOT, 'scripts/module-list.mjs'), ...args], { encoding: 'utf8', cwd: join(ROOT, 'packages/adapters/cloudflare') }).trim();
  const vendorPackages = vendor ? { SID_MODULE_PACKAGES: moduleList('--print-vendor-modules') } : {};
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  if (target === 'fastly') {
    // The real Compute package (deploy*/main.wasm) in Viceroy, Fastly's local runtime, behind a relay that sends each
    // request from the case's client IP and gives that address the case's location (fastly-viceroy.ts). It runs in
    // this process. Viceroy keeps the request's Host, so the adapter sees the URL the runner calls: plain http on a
    // local address, so cookies aren't Secure, as for the other local targets.
    const stop = await startFastlyTarget({
      port,
      config,
      viceroy: process.env['VICEROY'] ?? 'viceroy',
      wasm: join(ROOT, 'packages/adapters/fastly', bundle, 'main.wasm'),
      requests
    });
    return { baseUrl, publicOrigin: caseConfig['SID_PUBLIC_ORIGIN'] ?? baseUrl, stop, requestHeaders: headers => ({ ...headers }), unavailable: UNAVAILABLE[target], limitations: LIMITATIONS[target] ?? {} };
  }
  let child: ChildProcess;
  // A process the target needs besides `child`, stopped with it.
  let upstream: { readonly child: ChildProcess; readonly url: string } | undefined;
  if (target === 'node') {
    child = spawn(process.execPath, [join(ROOT, 'packages/adapters/node/dist/cli.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), HOST: '127.0.0.1', ...vendorPackages, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'lambda') {
    // The bundled Lambda handler behind a local CloudFront and function URL stand-in (lambda-emulator.ts). The
    // public origin is the emulator's own http URL, so cookies aren't Secure, as for the other local targets.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/lambda-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, CONFORMANCE_LAMBDA_BUNDLE: bundle, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'lambda-aws-emulator') {
    // The bundled Lambda handler deployed to AWS Emulator, which must already be running, behind its function URL
    // (aws-emulator.ts deploys it and relays plain http to the function URL). The public origin is the relay's http URL,
    // so cookies aren't Secure, as for the other local targets. The environment passes on what the AWS CLI needs (its
    // HOME and PATH); aws-emulator.ts replaces anything AWS_* with the emulator's own files.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/aws-emulator.js')], {
      env: { ...withoutSettings(process.env), PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, CONFORMANCE_LAMBDA_BUNDLE: bundle, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'vercel') {
    // The bundled Vercel adapter behind a local stand-in for Vercel's proxy (vercel-emulator.ts), which sets the
    // x-real-ip and x-vercel-ip-* headers. Plain http, so cookies aren't Secure, as for the other local targets.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/vercel-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, CONFORMANCE_VERCEL_BUNDLE: bundle, ...config },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'azure') {
    // The bundled function app behind a local stand-in for Front Door and the Functions host (azure-emulator.ts). The
    // handler checks X-Azure-FDID against a fixed profile ID the stand-in sends, and reads every location field from
    // the headers a Front Door rule set would add. Plain http, so cookies aren't Secure, as for the other targets.
    child = spawn(process.execPath, [join(ROOT, 'conformance/dist/azure-emulator.js')], {
      env: {
        PATH: process.env['PATH'] ?? '',
        PORT: String(port),
        SID_PUBLIC_ORIGIN: baseUrl,
        CONFORMANCE_AZURE_BUNDLE: bundle,
        AZURE_FRONT_DOOR_ID: AZURE_FRONT_DOOR_ID,
        SID_FRONT_DOOR_ID: AZURE_FRONT_DOOR_ID,
        SID_LOCATION_HEADERS: JSON.stringify(AZURE_LOCATION_HEADERS),
        ...config
      },
      stdio: ['ignore', 'ignore', 'inherit']
    });
  } else if (target === 'akamai') {
    // The bundled EdgeWorker in a V8 context of its own, behind a local stand-in for EdgeWorkers (akamai-emulator.ts)
    // that calls its responseProvider with the request object, EdgeScape's location and the PMUSER_SID_* variables.
    // node:vm's SourceTextModule needs --experimental-vm-modules. Plain http, so cookies aren't Secure.
    child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', join(ROOT, 'conformance/dist/akamai-emulator.js')], {
      env: { PATH: process.env['PATH'] ?? '', PORT: String(port), SID_PUBLIC_ORIGIN: baseUrl, CONFORMANCE_AKAMAI_BUNDLE: bundle, ...config },
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
      child: spawn(process.execPath, [framework, '--target=sharedidEdge', `--source=${join(ROOT, 'packages/adapters/gcp-functions', bundle)}`, `--port=${String(functionPort)}`], {
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
    // The Bowser build is its own entry point, src/bowser.ts, as in the Worker's dev:bowser and deploy:bowser scripts.
    if (vendor) moduleList('.sharedid-modules', '--worker', '--vendor-modules');
    const entry = bowser ? ['src/bowser.ts'] : vendor ? ['.sharedid-modules/worker.ts'] : [];
    const wrangler = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
    child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'error', '--show-interactive-dev-session=false', ...entry, ...vars], {
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
    // wrangler dev starts slowly, and the AWS Emulator target deploys a function first.
    await waitUntilUp(baseUrl, child, target === 'wrangler' || target === 'lambda-aws-emulator' ? 60_000 : 15_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    baseUrl,
    publicOrigin: target === 'wrangler' ? baseUrl : caseConfig['SID_PUBLIC_ORIGIN'] ?? baseUrl,
    stop,
    requestHeaders: target === 'wrangler' ? asRequestCf : headers => ({ ...headers }),
    unavailable: UNAVAILABLE[target],
    limitations: LIMITATIONS[target] ?? {}
  };
}
