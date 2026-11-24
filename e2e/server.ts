// Test site: serves a page that loads unmodified Prebid.js (a bundle of the npm package's chunks, bundle-prebid.ts), and answers
// /_sid/* with SharedID Edge (the built core package and the reflect, clickid and gpp modules), on one origin, as a publisher's CDN would.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { createHandler, resolveConfig, settingsFromEnv, trustedUpstreamFromEnv, withTrustedUpstream, type SharedIdEdgeHandler } from '../packages/core/dist/index.js';
import { clickIdModule } from '../packages/modules/clickid/dist/index.js';
import { gppModule } from '../packages/modules/gpp/dist/index.js';
import { reflectModule } from '../packages/modules/reflect/dist/index.js';

// The live test site's files (site/public): the page, its scripts, the demo (demo/) and the Prebid.js bundle
// bundle-prebid.ts builds into prebid/ (Playwright's webServer command runs it first).
const siteRoot = join(import.meta.dirname, 'site', 'public');
const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const port = Number(process.env['PORT'] ?? 4310);
// No pixel caching, so every visit reaches the endpoint and the tests can observe it. The reflect module runs on
// /sync, so Prebid.js's pixel call refreshes uid1 and keeps _ga; so does clickid, which keeps ad click IDs from the
// landing page's URL (the pixel call's Referer). The opt-in gpp module reads the US opt-outs in the gpp and gpp_sid
// parameters Prebid.js adds to the pixel call with pixelConsent: true. The live deployments don't build it, so the
// tests that need it run locally only.
const handler = createHandler({
  config: resolveConfig({
    // The tests browse http://e2e.sharedid.test through this server as their proxy (playwright.config.ts), and Prebid.js
    // writes _pubcid on sharedid.test, so the endpoint does too, as on the live site with sharedid.dev.
    SID_COOKIE_DOMAIN: 'sharedid.test',
    SID_SYNC_CACHE_SECONDS: '0',
    SID_MODULES: 'reflect,clickid,gpp',
    // uid1 as the reflect README's walkthrough configures it: on the domain the vendor tag writes it on, readable by
    // script, and restored from the keeper.
    SID_MODULE_CONFIG: JSON.stringify({ reflect: { cookies: [{ name: 'uid1', maxAgeDays: 365, domain: 'sharedid.test', httpOnly: false, restore: true }, { name: '_ga', maxAgeDays: 400, restore: true }] } })
  }),
  modules: [reflectModule, clickIdModule, gppModule]
});

// SID_COOKIE_DOMAIN=auto and the fixed settings beside it (tests/cookie-domain-auto.spec.ts), each on its own site, local
// runs only. The page adds pixelCookieDomain: true with ?pixelCookieDomain=1.
const sites = new Map<string, SharedIdEdgeHandler>([
  ['auto.sharedid.test', createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'auto', SID_SYNC_CACHE_SECONDS: '0' }) })],
  ['fixed.sharedid.test', createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'fixed.sharedid.test', SID_SYNC_CACHE_SECONDS: '0' }) })],
  ['hostonly.sharedid.test', createHandler({ config: resolveConfig({ SID_COOKIE_DOMAIN: 'host-only', SID_SYNC_CACHE_SECONDS: '0' }) })]
]);

// An upstream operator's endpoint (sid.upstream.test) in trusted-upstream mode with SID_COOKIE_DOMAIN=auto, serving the
// publisher sites www.pub-a.test and www.pub-b.test. For those, this server is also the publisher's CDN: it forwards
// /_sid/* to the endpoint with the shared secret and the site in X-Forwarded-Host, as docs/upstream-operators.md says.
const UPSTREAM_SECRET = 'e2e-upstream-0123456789abcdef0123456789abcdef';
const upstreamEnv = {
  SID_UPSTREAM_SECRETS: JSON.stringify([UPSTREAM_SECRET]),
  SID_LOCATION_HEADERS: JSON.stringify({ country: 'x-sid-country' }),
  SID_COOKIE_DOMAIN: 'auto',
  SID_SYNC_CACHE_SECONDS: '0',
  SID_HOSTS: JSON.stringify({ 'www.pub-a.test': {}, 'www.pub-b.test': {} })
};
const upstream = withTrustedUpstream(createHandler(settingsFromEnv(upstreamEnv, { requireCookieDomain: true })), trustedUpstreamFromEnv(upstreamEnv));

/** The handler for a site, and the request it gets: as sent, or through the publisher's CDN to the upstream endpoint. */
function route(url: URL, headers: Headers): [SharedIdEdgeHandler, Request] {
  const site = sites.get(url.hostname);
  if (site !== undefined) return [site, new Request(url, { headers })];
  if (url.hostname === 'www.pub-a.test' || url.hostname === 'www.pub-b.test') {
    for (const name of ['x-sid-upstream-auth', 'x-forwarded-host', 'x-sid-country']) headers.delete(name);
    headers.set('x-sid-upstream-auth', UPSTREAM_SECRET);
    headers.set('x-forwarded-host', url.hostname);
    headers.set('x-sid-country', 'US');
    return [upstream, new Request(new URL(url.pathname + url.search, 'http://sid.upstream.test'), { headers })];
  }
  return [handler, new Request(url, { headers })];
}

/** The file under site/public a path names (a folder's index.html for a path ending in /), or undefined. */
function siteFile(pathname: string): string | undefined {
  const file = normalize(join(siteRoot, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
  if (!file.startsWith(siteRoot + sep) || TYPES[extname(file)] === undefined) return undefined;
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer((req, res) => {
  // As the browsers' proxy, the server gets absolute URLs (http://e2e.sharedid.test/...); requests tunnelled with CONNECT
  // (below) and Playwright's readiness check get a path, with the host in the Host header.
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${String(port)}`}`);
  if (url.pathname.startsWith('/_sid/')) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const [siteHandler, request] = route(url, headers);
    void siteHandler(request).then(async response => {
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') out[key] = value; });
      out['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
    });
    return;
  }
  // A missing file is a 404; any other path gets the test page.
  const found = siteFile(url.pathname);
  if (found === undefined && extname(url.pathname) !== '') {
    res.writeHead(404).end();
    return;
  }
  const file = found ?? join(siteRoot, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// page.request (Playwright's APIRequestContext) tunnels through the proxy with CONNECT, even for http: loop the tunnel
// back into this server.
server.on('connect', (_req, client, head) => {
  const upstream = connect(port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => {
  console.log(`e2e site on http://127.0.0.1:${String(port)}`);
});
