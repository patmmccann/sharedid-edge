// Builds SharedID Edge as a Cloudflare Snippet: one file, with the configuration baked in, checked against the
// Snippet size limit. Run `npm run build` at the repository root first (core and the modules resolve to their dist/).
//
//   npm run build:snippet -w @sharedid-edge/cloudflare -- [--config snippet.config.json] [--out dist-snippet/snippet.js]
//
// The configuration file is a JSON object of SID_* settings, as the Worker's vars (SID_MODULE_CONFIG may be an object).
// It's validated as a deployment validates it, SID_COOKIE_DOMAIN included, and only the modules SID_MODULES names are
// bundled. Snippets have no environment variables or secrets, so changing a setting means rebuilding and redeploying,
// and the ec module (which needs a secret) can't be used. See README.md, "Worker or Snippet?".
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { ConfigError, settingsFromEnv } from '@sharedid-edge/core';

const ROOT = resolve(import.meta.dirname, '..');
/** Cloudflare's limit on a Snippet's total package size. Measured on the minified file before gzip (the bytes you paste into the dashboard): the docs don't say whether the limit is compressed, and this is the safe reading. */
const SNIPPET_LIMIT = 32 * 1024;
/** Modules a Snippet can bundle, by name: package and export. ec isn't here: it needs a secret, and Snippets have none. */
const MODULES = {
  ip: ['@sharedid-edge/module-ip', 'ipModule'],
  geo: ['@sharedid-edge/module-geo', 'geoModule'],
  reflect: ['@sharedid-edge/module-reflect', 'reflectModule'],
  bot: ['@sharedid-edge/module-bot', 'botModule'],
  ua: ['@sharedid-edge/module-ua', 'uaModule'],
  clickid: ['@sharedid-edge/module-clickid', 'clickIdModule']
};
/** The ua module with Bowser, bundled instead when SID_MODULE_CONFIG sets {"ua":{"parser":"bowser"}}, as the Worker's Bowser build. */
const UA_WITH_BOWSER = ['@sharedid-edge/module-ua/bowser', 'uaModuleWithBowser'];
/** Third-party packages a module brings, so the over-limit advice counts them with it. */
const BROUGHT_BY = { isbot: 'ua', bowser: 'ua' };

const TRADE_OFFS = `Snippet or Worker? The Snippet's trade-offs (see README.md, "Worker or Snippet?"):
  - Cost: included at no extra cost on Pro, Business and Enterprise plans; not available on Free. The Worker runs on
    every plan, free up to 100,000 requests a day, then $5 a month and usage.
  - Settings are baked in: change the configuration file, rebuild and redeploy to change one. The Worker reads SID_*
    variables, so a setting changes without a rebuild.
  - No secrets: the ec module isn't available. The Worker has wrangler secrets.
  - 32 KB: only the modules in SID_MODULES are bundled, and not every combination fits. The Worker takes all of them.
  - Operations: no versions, rollbacks or logs for Snippets; deploy with the dashboard, the API or Terraform. The Worker
    has wrangler deploy, versions, rollbacks and logs.`;

const { values: args } = parseArgs({ options: { config: { type: 'string', default: 'snippet.config.json' }, out: { type: 'string', default: 'dist-snippet/snippet.js' } } });
const configFile = resolve(ROOT, args.config);
const outfile = resolve(ROOT, args.out);
/** The snippet rule expression, written next to the Snippet. */
const ruleFile = outfile.replace(/\.m?js$/, '.rule.txt');
const show = path => relative(process.cwd(), path).split(sep).join('/');

function fail(message, code = 1) {
  console.error(`\nSnippet build failed: ${message}`);
  process.exit(code);
}

// 1. The configuration, validated as a deployment would validate it.
if (!existsSync(configFile)) fail(`no ${show(configFile)}. Copy snippet.config.example.json to snippet.config.json and set your values, or pass --config.`, 2);
let raw;
try {
  raw = JSON.parse(readFileSync(configFile, 'utf8'));
} catch (error) {
  fail(`${show(configFile)} isn't valid JSON (${error.message}).`, 2);
}
if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${show(configFile)} must be a JSON object of SID_* settings.`, 2);
const env = {};
for (const [key, value] of Object.entries(raw)) {
  if (key.startsWith('$')) continue; // "$comment" and the like
  if (!key.startsWith('SID_')) fail(`${key}: only SID_* settings go in a Snippet's configuration.`, 2);
  if (key === 'SID_MODULE_SECRETS') fail('SID_MODULE_SECRETS: Snippets have no secrets, and a secret baked into the script is readable by anyone who can see it. Use the Worker for modules that need one (ec).', 2);
  if (key.startsWith('SID_UPSTREAM_') || key === 'SID_CLIENT_IP_HEADER' || key === 'SID_LOCATION_HEADERS') fail(`${key}: trusted-upstream mode needs a shared secret (SID_UPSTREAM_SECRETS), and Snippets have none: a secret baked into the script is readable by anyone who can see it. Use the Worker behind a publisher's CDN.`, 2);
  env[key] = typeof value === 'string' ? value : JSON.stringify(value);
}
let settings;
try {
  settings = settingsFromEnv(env, { requireCookieDomain: true });
} catch (error) {
  if (error instanceof ConfigError) fail(`${error.message} (in ${show(configFile)}).`, 2);
  throw error;
}
// With SID_HOSTS, one Snippet serves several sites: the first listed is smoke-tested, and the bundle has every site's
// modules. The base path is the deployment's (core refuses it per host), so one snippet rule covers them all.
const sites = settings.hosts === undefined ? [] : [...settings.hosts];
const [smokeHost, config] = sites[0] ?? [undefined, settings.config];
const configs = sites.length === 0 ? [settings.config] : sites.map(([, siteConfig]) => siteConfig);
const moduleNames = [...new Set(configs.flatMap(c => c.modules))];
if (moduleNames.includes('ec')) fail('SID_MODULES includes ec, which needs its passphrase from SID_MODULE_SECRETS, and Snippets have no secrets. Leave ec out, or use the Worker.', 2);
const unknown = moduleNames.filter(name => !(name in MODULES));
if (unknown.length > 0) fail(`SID_MODULES names modules a Snippet can't bundle: ${unknown.join(', ')}. Available: ${Object.keys(MODULES).join(', ')}.`, 2);

// The User-Agent parser: isbot (the default: the bot flag only, small) or Bowser (parses the User-Agent fully, larger).
const bowser = moduleNames.includes('ua') && configs.some(c => c.moduleConfig['ua']?.['parser'] === 'bowser');
const moduleSource = name => (name === 'ua' && bowser ? UA_WITH_BOWSER : MODULES[name]);
const parserLine = !moduleNames.includes('ua') ? 'none (no ua module)'
  : bowser ? 'Bowser (SID_MODULE_CONFIG ua.parser "bowser": parses the User-Agent fully; the larger option)'
    : 'isbot only (the default: the bot flag; set ua.parser to "bowser" to parse the User-Agent fully, which is larger)';

// 2. The bundle: the Snippet entry, the validated settings, and only the listed modules.
const imports = moduleNames.map(name => `import { ${moduleSource(name)[1]} } from '${moduleSource(name)[0]}';`).join('\n');
const entry = `${imports}
import { settingsFromEnv } from '@sharedid-edge/core';
import { createSnippet } from './src/snippet.ts';
// Generated by scripts/build-snippet.mjs from ${show(configFile)}: Snippets have no environment variables.
export default createSnippet(settingsFromEnv(${JSON.stringify(env)}, { requireCookieDomain: true }), [${moduleNames.map(name => moduleSource(name)[1]).join(', ')}]);
`;
// Only the files this build writes are replaced or removed, never the folder: --out may point anywhere.
if (!/\.m?js$/.test(outfile)) fail(`--out must name a .js or .mjs file, not ${show(outfile)}.`, 2);
for (const file of [outfile, ruleFile]) rmSync(file, { force: true });
mkdirSync(dirname(outfile), { recursive: true });
const result = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'snippet-entry.mjs', loader: 'ts' },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning'
});
const bundle = readFileSync(outfile);
const size = bundle.length;
const gzipped = gzipSync(bundle).length;

// 3. What takes the space, by package.
const parts = new Map();
for (const [path, { bytesInOutput }] of Object.entries(Object.values(result.metafile.outputs)[0]?.inputs ?? {})) {
  // esbuild reports paths relative to the working directory (ROOT); resolve them to tell packages apart.
  const p = path.startsWith('snippet-entry') ? path : resolve(ROOT, path).split(sep).join('/');
  const dependency = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p)?.[1];
  const module = /packages\/modules\/([^/]+)\//.exec(p)?.[1];
  const label = dependency !== undefined && !dependency.startsWith('@sharedid-edge/') ? `dependency ${dependency}`
    : module !== undefined ? `module ${module}`
      : p.includes('packages/core/') ? 'core'
        : 'Cloudflare adapter and settings';
  parts.set(label, (parts.get(label) ?? 0) + bytesInOutput);
}
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const breakdown = [...parts].sort((a, b) => b[1] - a[1]).map(([label, bytes]) => `    ${label.padEnd(34)} ${kb(bytes).padStart(9)}`).join('\n');
console.log(`\nSharedID Edge Snippet: ${show(outfile)}
  Modules: ${moduleNames.length === 0 ? 'none' : moduleNames.join(', ')}
  User-Agent parser: ${parserLine}
  Size: ${kb(size)} minified, of the ${kb(SNIPPET_LIMIT)} limit (${kb(gzipped)} gzipped; the check uses the minified size)
  By part (minified, before gzip):
${breakdown}`);

// 4. Over the limit: fail, with what to do.
if (size > SNIPPET_LIMIT) {
  const over = size - SNIPPET_LIMIT;
  // Each module with what it brings, largest first; then the largest modules that, dropped together, get under the limit.
  const groups = new Map(moduleNames.map(name => [name, { bytes: 0, with: [] }]));
  for (const [label, bytes] of parts) {
    const [kind, name] = label.split(' ');
    const owner = kind === 'module' ? name : kind === 'dependency' ? BROUGHT_BY[name] : undefined;
    const group = owner === undefined ? undefined : groups.get(owner);
    if (group === undefined) continue;
    group.bytes += bytes;
    if (kind === 'dependency') group.with.push(name);
  }
  const modules = [...groups].sort((a, b) => b[1].bytes - a[1].bytes);
  const drop = [];
  let saved = 0;
  for (const [name, { bytes }] of modules) {
    if (saved >= over) break;
    drop.push(name);
    saved += bytes;
  }
  const keep = moduleNames.filter(name => !drop.includes(name));
  const bowserBytes = parts.get('dependency bowser') ?? 0;
  const bowserTip = bowser
    ? `  First, use the small parser: remove "parser": "bowser" from ua in SID_MODULE_CONFIG. That drops Bowser (${kb(bowserBytes)});
     ua keeps the bot flag and Client Hints, without parsing the User-Agent.${bowserBytes >= over ? ' That alone fits.' : ''}\n`
    : '';
  const suggestion = saved >= over
    ? `     For example, dropping ${drop.join(' and ')} saves ${kb(saved)}: SID_MODULES "${keep.join(',')}"${keep.length === 0 ? ' (core alone)' : ''} fits.`
    : "     Even core alone is over the limit, which shouldn't happen; please report it.";
  rmSync(outfile, { force: true });
  console.error(`
OVER THE SNIPPET LIMIT by ${kb(over)}: ${kb(size)} is more than Cloudflare's ${kb(SNIPPET_LIMIT)}. Nothing was written: a
Snippet this size may be refused by Cloudflare. (Measured on the minified file before gzip, since Cloudflare doesn't say whether the limit
is compressed; gzipped it's ${kb(gzipped)}.)

What you can do:
${bowserTip}  1. Drop modules from SID_MODULES. Largest first:
${modules.map(([name, group]) => `     - ${name}: ${kb(group.bytes)}${group.with.length > 0 ? ` (with ${group.with.join(', ')})` : ''}${group.bytes >= over ? ', enough on its own' : ''}`).join('\n')}
${suggestion}
  2. Deploy the Worker instead (npm run deploy, configured in wrangler.jsonc), which has no such limit and takes every
     module, secrets included. The trade-off is cost: usage-based past the free tier (see below).

${TRADE_OFFS}`);
  process.exit(1);
}

// 5. A smoke test of the bundle: a first sync, and /v1 with each module's status.
const snippet = (await import(`${pathToFileURL(outfile).href}?t=${String(Date.now())}`)).default;
const host = smokeHost ?? (config.cookieDomain === undefined ? 'www.example.com' : `www.${config.cookieDomain.replace(/^\./, '')}`);
const base = `https://${host}${config.basePath === '/' ? '' : config.basePath}`;
const sync = await snippet.fetch(new Request(`${base}/sync?id=pubcid%3Ac29cb2ae-769d-42f6-891a-f53cadee823d`));
const setsId = sync.headers.getSetCookie().some(c => c.startsWith(`${config.cookieName}=c29cb2ae-769d-42f6-891a-f53cadee823d;`));
if (sync.status !== 200 || !setsId) fail(`the smoke test's sync got ${String(sync.status)}${setsId ? '' : `, without the ${config.cookieName} cookie`}.`);
const v1 = await (await snippet.fetch(new Request(`${base}/v1`))).json();
const errors = Object.entries(v1?.ext?.modules ?? {}).filter(([, m]) => m?.status === 'error').map(([name]) => name);
if (errors.length > 0) fail(`modules report an error in the smoke test: ${errors.join(', ')}. Check their SID_MODULE_CONFIG.`);

// 6. Time per request against Snippets' 5 ms CPU limit, on this machine (an estimate: the edge's CPUs differ). The
// handler does no I/O, so time per request is its CPU time. A visitor's first sync and a returning visitor's /v1, with
// a client IP, a User-Agent and request.cf location data so every module does its work.
const timed = [];
for (let i = 0; i < 300; i++) {
  const request = new Request(`${base}/${i % 2 === 0 ? 'sync' : 'v1'}`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', ...(i % 2 === 0 ? {} : { cookie: `${config.cookieName}=c29cb2ae-769d-42f6-891a-f53cadee823d` }) }
  });
  Object.defineProperty(request, 'cf', { value: { country: 'DE', city: 'Berlin', timezone: i % 3 === 0 ? 'Europe/Berlin' : 'Asia/Tokyo', latitude: '52.52', longitude: '13.40', isEUCountry: '1' } });
  const start = performance.now();
  await (await snippet.fetch(request)).arrayBuffer();
  timed.push(performance.now() - start);
}
timed.sort((a, b) => a - b);
const ms = n => `${n.toFixed(2)} ms`;
const p50 = timed[150] ?? 0;
const p99 = timed[297] ?? 0;
const CPU_LIMIT_MS = 5;

writeFileSync(ruleFile, `${snippetRule(config.basePath)}\n`);
console.log(`  Headroom: ${kb(SNIPPET_LIMIT - size)}
  Smoke test: ok (a first sync sets ${config.cookieName}; /v1 answers${moduleNames.length > 0 ? ' with no module errors' : ''})
  Time per request (on this machine, an estimate of CPU time): median ${ms(p50)}, 99th percentile ${ms(p99)}, of Snippets' ${String(CPU_LIMIT_MS)} ms CPU limit${p99 > CPU_LIMIT_MS / 2 ? `
  WARNING: the 99th percentile is over half the ${String(CPU_LIMIT_MS)} ms limit here. Cloudflare's CPUs differ from this machine,
  but at this rate some requests may hit the limit, and a Snippet over it fails. Fewer modules, or the Worker, avoid it.` : ''}
  Snippet rule (also in ${show(ruleFile)}): add your hostname with http.host
    ${snippetRule(config.basePath)}

${TRADE_OFFS}`);

/** The Snippet rule expression for the base path: core's routes only with the root path, as the Worker's routes are. */
function snippetRule(basePath) {
  if (basePath === '/') return '(http.request.uri.path in {"/sync" "/v1" "/optout" "/optin"})';
  return `(starts_with(http.request.uri.path, "${basePath}/"))`;
}
