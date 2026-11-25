/* global process */
// Writes the Wrangler configurations of this project's upstream-operator and Cloudflare for SaaS live tests (README.md,
// The upstream-operator and Cloudflare for SaaS setups) into live/.out/, from the hostnames in the environment. Not for
// deployers. upstream.sh and saas.sh run it; see either for the variables. The Cloudflare live tests workflow
// (.github/workflows/e2e-cloudflare.yml) runs platform.
//
//   node live/configs.mjs upstream       # .out/endpoint.json, .out/forward.json
//   node live/configs.mjs saas           # .out/saas.json, .out/saas-site.json
//   node live/configs.mjs node-upstream  # .out/node-upstream-publisher.json, .out/node-upstream-conformance.json
//   node live/configs.mjs node-upstream-hosts   # prints SID_HOSTS of the Node.js live test's endpoint
//   node live/configs.mjs platform       # .out/platform.json, .out/platform-site.json (the live demo's platform modules)
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');

function need(name) {
  const value = process.env[name] ?? '';
  if (value === '') throw new Error(`Set ${name}`);
  return value;
}

/**
 * One publisher site's settings, as the Cloudflare e2e environment's (wrangler.jsonc, env.e2e) so the Playwright tests
 * pass against it: no pixel caching, reflect with uid1 (on the site's cookie domain) and _ga, and clickid; plus ip and
 * geo, which the live checks read.
 */
function e2eSite(cookieDomain) {
  return {
    SID_COOKIE_DOMAIN: cookieDomain,
    SID_SYNC_CACHE_SECONDS: '0',
    SID_MODULES: 'ip,geo,reflect,clickid',
    SID_MODULE_CONFIG: {
      reflect: {
        cookies: [
          { name: 'uid1', maxAgeDays: 365, domain: cookieDomain, httpOnly: false, restore: true },
          { name: '_ga', maxAgeDays: 400, restore: true }
        ]
      }
    }
  };
}

// Every Worker: no workers.dev, no logs, and the date wrangler.jsonc uses.
const common = { compatibility_date: '2026-11-01', workers_dev: false, observability: { enabled: false } };
// The SharedID Edge Worker, from this package's source (relative to .out/).
const sharedIdWorker = { ...common, main: '../../src/index.ts', minify: true };

function write(name, config) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`live/.out/${name}.json\n`);
}

const kind = process.argv[2];
if (kind === 'upstream') {
  const endpoint = need('UO_ENDPOINT_HOST');
  const hosts = { [need('UO_CLOUDFRONT_PUBLISHER_HOST')]: e2eSite(need('UO_CLOUDFRONT_COOKIE_DOMAIN')) };
  const cloudflarePublisher = process.env['UO_CLOUDFLARE_PUBLISHER_HOST'] ?? '';
  // The second publisher, with its own cookie domain: the one Prebid.js writes _pubcid on there.
  if (cloudflarePublisher !== '') hosts[cloudflarePublisher] = e2eSite(need('UO_CLOUDFLARE_COOKIE_DOMAIN'));
  // Optionally a third, on the default settings (host-only cookies), for the conformance suite's default cases.
  const conformancePublisher = process.env['UO_CLOUDFLARE_CONFORMANCE_HOST'] ?? '';
  if (conformancePublisher !== '') hosts[conformancePublisher] = { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: '' };
  write('endpoint', {
    ...sharedIdWorker,
    name: process.env['UO_ENDPOINT_WORKER'] ?? 'sharedid-saleshouse',
    routes: [{ pattern: endpoint, custom_domain: true }],
    // docs/upstream-operators.md's worked example: trusted upstream (SID_UPSTREAM_SECRETS is a Worker secret), the
    // recipes' header names, and each publisher's site in SID_HOSTS.
    vars: {
      SID_MODULES: 'ip,geo,reflect,clickid',
      SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
      SID_LOCATION_HEADERS: JSON.stringify({ country: 'x-sid-country', regionCode: 'x-sid-region' }),
      SID_HOSTS: JSON.stringify(hosts)
    }
  });
  if (cloudflarePublisher !== '') {
    write('forward', {
      ...common,
      name: process.env['UO_FORWARD_WORKER'] ?? 'sharedid-saleshouse-forward',
      main: '../forward.js',
      routes: [cloudflarePublisher, conformancePublisher]
        .filter(host => host !== '')
        .map(host => ({ pattern: `${host}/_sid/*`, zone_name: need('UO_CLOUDFLARE_PUBLISHER_ZONE') })),
      vars: { SID_ENDPOINT: `https://${endpoint}` }
    });
  }
} else if (kind === 'saas') {
  const zone = need('SAAS_ZONE');
  const listed = need('SAAS_HOSTNAME');
  write('saas', {
    ...sharedIdWorker,
    name: process.env['SAAS_WORKER'] ?? 'sharedid-saas',
    // Every hostname on the SaaS zone, custom hostnames included; the zone's more specific routes still win.
    routes: [{ pattern: '*/_sid/*', zone_name: zone }],
    // Only the listed custom hostname has SharedID Edge; any other gets a 404 (docs/hosting-companies.md).
    vars: { SID_MODULES: 'ip,geo,reflect,clickid', SID_HOSTS: JSON.stringify({ [listed]: e2eSite(need('SAAS_COOKIE_DOMAIN')) }) }
  });
  // The hosted sites: the e2e test page on every custom hostname, as the SaaS customers' pages. The route is */*, as
  // in Cloudflare's "Workers as your fallback origin": a route on one custom hostname (saas.publisher.example/*)
  // would beat */_sid/*, since a route's hostname counts before its path. The zone's own hostnames with routes of
  // their own keep them.
  write('saas-site', {
    ...common,
    name: process.env['SAAS_SITE_WORKER'] ?? 'sharedid-saas-site',
    assets: { directory: '../../../../../e2e/site/public' },
    routes: [{ pattern: '*/*', zone_name: zone }]
  });
} else if (kind === 'node-upstream-hosts') {
  // The Node.js server's live test (packages/adapters/node/live/upstream.sh): SID_HOSTS of its endpoint, printed.
  process.stdout.write(`${JSON.stringify({ [need('NODE_UPSTREAM_SITE')]: e2eSite(need('NODE_UPSTREAM_COOKIE_DOMAIN')) })}\n`);
} else if (kind === 'node-upstream') {
  // The publisher in front of the Node.js server's container on AWS (packages/adapters/node/live/upstream.sh), on a
  // path of a hostname other setups share: forward.js on <site><prefix>/_sid/*, and the e2e test page as static
  // assets at <site><prefix>/, so the page and the endpoint share the hostname. A second forward.js on
  // <site><conformance prefix>/_sid/* sends the conformance suite to the default-settings endpoint.
  const site = need('NODE_UPSTREAM_SITE');
  const zone = need('NODE_UPSTREAM_ZONE');
  const prefix = need('NODE_UPSTREAM_PREFIX');
  const conformancePrefix = need('NODE_UPSTREAM_CONFORMANCE_PREFIX');
  const assets = join(out, 'node-upstream-site');
  rmSync(assets, { recursive: true, force: true });
  cpSync(join(here, '../../../../e2e/site/public'), join(assets, prefix), { recursive: true });
  write('node-upstream-publisher', {
    ...common,
    name: process.env['NODE_UPSTREAM_WORKER'] ?? 'sharedid-node-upstream-publisher',
    main: '../forward.js',
    // Only /_sid/* runs the Worker; the rest of the prefix is the page.
    assets: { directory: './node-upstream-site', run_worker_first: [`${prefix}/_sid/*`] },
    routes: [{ pattern: `${site}${prefix}/*`, zone_name: zone }],
    vars: { SID_ENDPOINT: need('NODE_UPSTREAM_ENDPOINT') }
  });
  write('node-upstream-conformance', {
    ...common,
    name: process.env['NODE_UPSTREAM_CONFORMANCE_WORKER'] ?? 'sharedid-node-upstream-conformance',
    main: '../forward.js',
    routes: [{ pattern: `${site}${conformancePrefix}/_sid/*`, zone_name: zone }],
    vars: { SID_ENDPOINT: need('NODE_UPSTREAM_CONFORMANCE_ENDPOINT') }
  });
} else if (kind === 'platform') {
  // The live demo's platform-modules deployment (.github/workflows/e2e-cloudflare.yml): a second SharedID Edge Worker
  // on <site><prefix>/_sid/*, with the e2e settings plus the modules that read the request (ip, geo, ua and bot, with
  // bot's missingHeaders, and SID_SKIP_BOTS=declared: a client that names itself as a bot gets none from /_sid/v1), and the e2e
  // test page as static assets at <site><prefix>/, so the main e2e environment (wrangler.jsonc, env.e2e) keeps its
  // settings. The more specific route wins: <prefix>/_sid/* over <prefix>/* over the test site's /*.
  const site = need('PLATFORM_SITE');
  const zone = need('PLATFORM_ZONE');
  const prefix = need('PLATFORM_PREFIX');
  const { SID_MODULE_CONFIG: moduleConfig, ...settings } = e2eSite(need('PLATFORM_COOKIE_DOMAIN'));
  write('platform', {
    ...sharedIdWorker,
    name: process.env['PLATFORM_WORKER'] ?? 'sharedid-edge-e2e-platform',
    routes: [{ pattern: `${site}${prefix}/_sid/*`, zone_name: zone }],
    vars: {
      ...settings,
      SID_BASE_PATH: `${prefix}/_sid`,
      SID_MODULES: 'ip,geo,ua,bot,reflect,clickid',
      SID_MODULE_CONFIG: JSON.stringify({ ...moduleConfig, bot: { missingHeaders: true } }),
      SID_SKIP_BOTS: 'declared'
    }
  });
  const assets = join(out, 'platform-site');
  rmSync(assets, { recursive: true, force: true });
  cpSync(join(here, '../../../../e2e/site/public'), join(assets, prefix), { recursive: true });
  write('platform-site', {
    ...common,
    name: process.env['PLATFORM_SITE_WORKER'] ?? 'sharedid-edge-e2e-platform-site',
    assets: { directory: './platform-site' },
    routes: [{ pattern: `${site}${prefix}/*`, zone_name: zone }]
  });
} else {
  throw new Error('Usage: node live/configs.mjs upstream|saas|node-upstream|node-upstream-hosts|platform');
}
