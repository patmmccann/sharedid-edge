// Test site: serves a page that loads the unmodified Prebid.js build from the prebid.js npm package, and answers
// /_sid/* with SharedID Edge (the built core package and the reflect module), on one origin, as a publisher's CDN would.
// Requests to /_sid/* are recorded so tests can check what Prebid.js sent.
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, sep } from 'node:path';
import { createHandler, resolveConfig } from '../packages/core/dist/index.js';
import { reflectModule } from '../packages/modules/reflect/dist/index.js';

// prebid.js doesn't export its package.json, so locate the install directly.
const prebidDist = join(import.meta.dirname, 'node_modules', 'prebid.js', 'dist');
const port = Number(process.env['PORT'] ?? 4310);
// No pixel caching, so every visit reaches the endpoint and the tests can observe it. The reflect module runs on
// /sync, so Prebid.js's pixel call refreshes uid1 and keeps _ga (host-only cookies: the site is 127.0.0.1).
const handler = createHandler({
  config: resolveConfig({
    SID_SYNC_CACHE_SECONDS: '0',
    SID_MODULES: 'reflect',
    SID_MODULE_CONFIG: JSON.stringify({ reflect: { cookies: [{ name: 'uid1', maxAgeDays: 365 }, { name: '_ga', maxAgeDays: 400, restore: true }] } })
  }),
  modules: [reflectModule]
});
const syncLog: { path: string; cookie: string }[] = [];

const PAGE = `<!doctype html>
<html><head><title>SharedID Edge e2e</title>
<script>window.pbjs = window.pbjs || { que: [] };</script>
<script src="/prebid/not-for-prod/prebid.js"></script>
<script>
  pbjs.que.push(function () {
    pbjs.setConfig({
      userSync: {
        syncDelay: 0,
        userIds: [{
          name: 'sharedId',
          params: { pixelUrl: '/_sid/sync', extend: true },
          storage: { type: 'cookie', name: '_pubcid', expires: 365 }
        }]
      }
    });
  });
</script>
</head><body>SharedID Edge e2e</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
  if (url.pathname === '/__sync-log') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(syncLog));
    return;
  }
  if (url.pathname === '/__reset') {
    syncLog.length = 0;
    res.writeHead(204).end();
    return;
  }
  if (url.pathname.startsWith('/_sid/')) {
    syncLog.push({ path: url.pathname + url.search, cookie: req.headers.cookie ?? '' });
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    void handler(new Request(url, { headers })).then(async response => {
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') out[key] = value; });
      out['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
    });
    return;
  }
  if (url.pathname.startsWith('/prebid/')) {
    const file = normalize(join(prebidDist, url.pathname.slice('/prebid/'.length)));
    if (!file.startsWith(prebidDist + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
}).listen(port, '127.0.0.1', () => {
  console.log(`e2e site on http://127.0.0.1:${String(port)}`);
});
