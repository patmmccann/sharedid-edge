// Tests the Snippet build against the Worker. The Snippet ships settings validated when it's built, and leaves the
// validators out (see PREVALIDATED in build-snippet.mjs); the Worker validates them at run time. So for each
// configuration, this builds both (the Snippet with build-snippet.mjs, the Worker from src/worker.ts with the same
// modules), sends each the same requests, and checks the responses are identical. And it checks that an invalid
// configuration still fails the Snippet build, with the message the Worker gives for it, since the build is now the
// only place a Snippet's settings are checked. Run `npm run build` at the repository root first.
//
//   npm run test:snippet -w @sharedid-edge/cloudflare
//
// The configurations: every conformance case file the Snippet can be built with (its requests are the case's), and
// the ones below, with the requests in REQUESTS.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { EU_COUNTRY_CODES, settingsFromEnv } from '@sharedid-edge/core';
import { reflectModuleConfig } from '@sharedid-edge/module-reflect';

const ROOT = resolve(import.meta.dirname, '..');
// The conformance runner's case loader (built by `npm run build`).
const { loadCaseFiles } = await import(pathToFileURL(resolve(ROOT, '../../../conformance/dist/cases.js')).href);
const BUILD = join(ROOT, 'scripts', 'build-snippet.mjs');
const temp = mkdtempSync(join(tmpdir(), 'sid-snippet-test-'));
const ID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER_ID = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';
/** Modules a Snippet can bundle, as the Worker's entry imports them. */
const MODULES = {
  ip: ['@sharedid-edge/module-ip', 'ipModule'],
  geo: ['@sharedid-edge/module-geo', 'geoModule'],
  reflect: ['@sharedid-edge/module-reflect', 'reflectModule'],
  bot: ['@sharedid-edge/module-bot', 'botModule'],
  ua: ['@sharedid-edge/module-ua', 'uaModule'],
  clickid: ['@sharedid-edge/module-clickid', 'clickIdModule']
};
/** Settings a Snippet refuses (secrets, trusted upstream): case files with them aren't Snippet configurations. */
const NOT_SNIPPET = /^SID_(MODULE_SECRETS|UPSTREAM_|CLIENT_IP_HEADER$|LOCATION_HEADERS$)/;

const reflect = (cookies, keeper) => ({ reflect: { cookies, ...(keeper === undefined ? {} : { keeper }) } });
/** Configurations beyond the conformance cases': every reflect feature, clickid and bot settings, and SID_HOSTS with modules. */
const CONFIGS = {
  'example (reflect, a restore cookie in the keeper)': { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'reflect', SID_MODULE_CONFIG: reflect([{ name: 'uid1', maxAgeDays: 365, restore: true }]) },
  'reflect: per-cookie backups, prefer backup and older, opt-out': {
    SID_COOKIE_DOMAIN: 'host-only',
    SID_MODULES: 'reflect,clickid',
    SID_MODULE_CONFIG: {
      ...reflect([
        { name: 'uid1', maxAgeDays: 365, restore: true, prefer: 'backup', deleteOnOptOut: true },
        { name: '_ga', maxAgeDays: 400, restore: true, prefer: 'older' },
        { name: 'fpid', maxAgeDays: 30, httpOnly: true }
      ], { mode: 'per-cookie', suffix: '_bk', maxAgeDays: 200 }),
      clickid: { params: [{ name: 'gclid', enabled: false }, { name: 'li_fat_id' }], maxAgeDays: 30, httpOnly: true }
    }
  },
  'ip, geo (coarse) and bot, with SID_SKIP_BOTS': {
    SID_COOKIE_DOMAIN: 'host-only',
    SID_MODULES: 'ip,geo,bot',
    SID_SKIP_BOTS: 'likely',
    SID_MODULE_CONFIG: { geo: { precision: 'coarse' }, bot: { missingHeaders: true, internalCookie: 'staff' } }
  },
  'ua with the raw User-Agent, and SID_SKIP_BOTS': { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ua', SID_SKIP_BOTS: 'declared', SID_MODULE_CONFIG: { ua: { ua: true } } },
  'SID_HOSTS: reflect on one host, not on the other': {
    SID_MODULES: 'reflect',
    SID_HOSTS: {
      '127.0.0.1': { SID_COOKIE_DOMAIN: 'host-only', SID_MODULE_CONFIG: reflect([{ name: 'uid1', maxAgeDays: 90, restore: true, deleteOnOptOut: true }]) },
      'localhost': { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ip' }
    }
  }
};
const keeper = Buffer.from(JSON.stringify({ uid1: 'kept-value', _ga: 'GA1.1.111.1600000000' })).toString('base64url');
const ga = (seconds) => `GA1.1.222.${String(seconds)}`;
/** Requests for the configurations above: each route, with cookies that exercise each module's paths. */
const REQUESTS = [
  { path: '/_sid/sync?id=pubcid%3A' + ID },
  { path: '/_sid/sync', headers: { referer: 'http://127.0.0.1/landing?gclid=abc&li_fat_id=xyz&msclkid=m1' } },
  { path: '/_sid/v1', headers: { cookie: `_pubcid=${ID}; uid1=from-page; _ga=${ga(1700000000)}; fpid=f1` } },
  { path: '/_sid/v1', headers: { cookie: `_pubcid=${ID}; _pubcid_sv=${OTHER_ID}; _sid_keep=${keeper}` } },
  { path: '/_sid/v1', headers: { cookie: `_pubcid=${ID}; uid1=new; uid1_bk=old; _ga=${ga(1700000000)}; _ga_bk=${ga(1600000000)}; uid1=dup` } },
  { path: '/_sid/v1', headers: { cookie: `_pubcid=${ID}; uid1=a; uid1=a; staff=1`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' } },
  { path: '/_sid/v1', headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)', 'cf-ipcountry': 'DE', 'cf-ipcity': 'Berlin', 'cf-timezone': 'Europe/Berlin' } },
  { path: '/_sid/v1', headers: { 'sec-gpc': '1', cookie: `_pubcid=${ID}; _sid_keep=${keeper}; uid1_bk=old; uid1=x` } },
  { path: '/_sid/v1', headers: { 'sec-ch-ua': '"Chromium";v="130", "Not?A_Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'cf-ipcountry': 'US', 'cf-region-code': 'CA', 'x-forwarded-for': '203.0.113.9' } },
  { path: '/_sid/optout', headers: { cookie: `_pubcid=${ID}; uid1=x; _sid_keep=${keeper}; uid1_bk=old; _sid_li_fat_id=1.x` } },
  { path: '/_sid/optin', headers: { cookie: '_pubcid_optout=1' } },
  { path: '/_sid/v1', method: 'OPTIONS', headers: { origin: 'https://www.example.com' } },
  { path: '/_sid/v1', method: 'POST' },
  { path: '/elsewhere' }
];
const LOCATION = { 'cf-ipcountry': 'country', 'cf-region-code': 'regionCode', 'cf-ipcity': 'city', 'cf-postal-code': 'postalCode', 'cf-metro-code': 'metroCode', 'cf-iplatitude': 'latitude', 'cf-iplongitude': 'longitude', 'cf-timezone': 'timezone', 'cf-ipcontinent': 'continent' };

let failures = 0;
let checks = 0;
let files = 0;
function check(ok, what) {
  checks++;
  if (ok) return;
  failures++;
  console.error(`not ok: ${what}`);
}

/** The request a case describes, as Cloudflare gives it: the location headers as `request.cf`, the client IP in CF-Connecting-IP. */
function request({ path, method = 'GET', headers = {} }, host = '127.0.0.1') {
  const cf = {};
  const plain = {};
  for (const [name, value] of Object.entries(headers)) {
    const field = LOCATION[name.toLowerCase()];
    if (field === undefined) plain[name] = value;
    else cf[field] = value;
  }
  if (cf.country !== undefined) cf.isEUCountry = EU_COUNTRY_CODES.has(cf.country.toUpperCase()) ? '1' : '0';
  const forwarded = plain['x-forwarded-for']?.split(',')[0]?.trim();
  const r = new Request(`http://${host}${path}`, { method, headers: { 'cf-connecting-ip': forwarded ?? '198.51.100.7', ...plain } });
  Object.defineProperty(r, 'cf', { value: cf });
  return r;
}

/** A response as comparable text: status, headers (Set-Cookie in order, without Expires) and body (without timings and minted IDs). */
async function comparable(response, known) {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const minted = text => text.replace(uuid, id => (known.includes(id) ? id : '<minted>'));
  const headers = [...response.headers].filter(([name]) => name !== 'set-cookie').map(([name, value]) => `${name}: ${minted(value)}`).sort();
  const cookies = response.headers.getSetCookie().map(c => minted(c.replace(/; Expires=[^;]*/i, '')));
  const body = minted((await response.text()).replace(/"ms":\d+/g, '"ms":0'));
  return JSON.stringify({ status: response.status, headers, cookies, body }, null, 1);
}

/** The module list a configuration bundles: SID_MODULES across the deployment and its hosts, as build-snippet.mjs works it out. */
function modulesOf(env) {
  const settings = settingsFromEnv(env);
  const configs = settings.hosts === undefined ? [settings.config] : [...settings.hosts.values()];
  const names = [...new Set(configs.flatMap(c => c.modules))];
  const bowser = configs.some(c => c.moduleConfig['ua']?.['parser'] === 'bowser');
  return names.map(name => (name === 'ua' && bowser ? ['@sharedid-edge/module-ua/bowser', 'uaModuleWithBowser'] : MODULES[name]));
}

/** SID_* settings as the Worker's vars (strings), and the configuration file for the Snippet. */
function asEnv(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
}

let serial = 0;
function buildSnippet(config) {
  const n = String(++serial);
  const file = join(temp, `config-${n}.json`);
  const out = join(temp, `snippet-${n}.js`);
  writeFileSync(file, JSON.stringify(config));
  const run = spawnSync(process.execPath, [BUILD, '--config', file, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}`, out };
}

async function buildWorker(modules) {
  const out = join(temp, `worker-${String(++serial)}.mjs`);
  const imports = modules.map(([pkg, name]) => `import { ${name} } from '${pkg}';`).join('\n');
  await build({
    stdin: { contents: `${imports}\nimport { createWorker } from './src/worker.ts';\nexport default createWorker([${modules.map(m => m[1]).join(', ')}]);\n`, resolveDir: ROOT, sourcefile: 'worker-entry.mjs', loader: 'ts' },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    logLevel: 'warning'
  });
  return (await import(pathToFileURL(out).href)).default;
}

/** Builds both for `config`, sends `requests` (to each host given) to each, and checks the responses are the same. */
async function compare(label, config, requests, hosts = ['127.0.0.1']) {
  const snippetBuild = buildSnippet(config);
  check(snippetBuild.status === 0, `${label}: the Snippet builds\n${snippetBuild.output}`);
  if (snippetBuild.status !== 0) return;
  const snippet = (await import(pathToFileURL(snippetBuild.out).href)).default;
  const env = asEnv(config);
  const worker = await buildWorker(modulesOf(env));
  for (const host of hosts) {
    for (const r of requests) {
      const known = [ID, OTHER_ID, ...JSON.stringify(r).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []];
      const fromSnippet = await comparable(await snippet.fetch(request(r, host)), known);
      const fromWorker = await comparable(await worker.fetch(request(r, host), env), known);
      check(fromSnippet === fromWorker, `${label}: ${r.method ?? 'GET'} ${host}${r.path} differs\n  Snippet: ${fromSnippet}\n  Worker:  ${fromWorker}`);
    }
  }
}

/** What the Worker logs for an invalid configuration (it answers 500 and logs `sharedid-edge: <message>`). */
async function workerConfigError(config) {
  const env = asEnv(config);
  const worker = await buildWorker([]);
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const response = await worker.fetch(request({ path: '/_sid/v1' }), env);
    check(response.status === 500, `the Worker answers 500 for an invalid configuration (${JSON.stringify(config)})`);
  } finally {
    console.error = original;
  }
  return logged.find(line => line.startsWith('sharedid-edge: '))?.slice('sharedid-edge: '.length);
}

try {
  // 1. The conformance case files the Snippet can be built with, and their requests.
  for (const file of await loadCaseFiles()) {
    if (file.build.includes('vendor-modules') || Object.keys(file.config).some(key => NOT_SNIPPET.test(key))) continue;
    const config = { SID_COOKIE_DOMAIN: 'host-only', ...file.config };
    // Bowser alone is over the Snippet's size limit.
    if (file.build.includes('bowser')) continue;
    const env = asEnv(config);
    if (modulesOf(env).some(m => m === undefined)) continue;
    // A configuration that makes a module an error on every request in the Worker fails the Snippet build (section 3).
    if (file.cases.some(c => c.expect.jsonIncludes?.ext?.modules !== undefined && JSON.stringify(c.expect.jsonIncludes.ext.modules).includes('"error"'))) continue;
    files++;
    await compare(file.file, config, file.cases.map(c => c.request));
  }
  check(files >= 20, `at least 20 conformance case files run against both (${String(files)})`);

  // 2. The configurations above, with every request, on each host for SID_HOSTS.
  for (const [label, config] of Object.entries(CONFIGS)) {
    await compare(label, config, REQUESTS, config.SID_HOSTS === undefined ? ['127.0.0.1'] : ['127.0.0.1', 'localhost', 'other.example']);
  }

  // 3. Invalid configurations fail the Snippet build, with the Worker's message.
  for (const config of [
    { SID_COOKIE_DOMAIN: 'example.com', SID_MAX_AGE_DAYS: '500' },
    { SID_COOKIE_DOMAIN: 'not a domain' },
    { SID_COOKIE_DOMAIN: 'example.com', SID_MODULES: 'reflect', SID_SYNC_MODULES: 'ip' },
    { SID_HOSTS: { 'www.example.com': { SID_COOKIE_DOMAIN: 'example.com', SID_RECOVERY_COOKIE: '_pubcid' } } }
  ]) {
    const message = await workerConfigError(config);
    const result = buildSnippet(config);
    check(message !== undefined && result.status === 2 && result.output.includes(message), `an invalid configuration fails the Snippet build with the Worker's message "${String(message)}"\n${result.output}`);
  }
  // A module's settings: the Worker reports the module as an error on each request (its parser threw); the Snippet build
  // fails with that parser's message, for the deployment and for a site in SID_HOSTS.
  const badReflect = { cookies: [{ name: 'uid1', maxAgeDays: 365, prefer: 'backup' }] };
  let parserMessage = '';
  try {
    reflectModuleConfig(badReflect);
  } catch (error) {
    parserMessage = error.message;
  }
  for (const config of [
    { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'reflect', SID_MODULE_CONFIG: { reflect: badReflect } },
    { SID_MODULES: 'reflect', SID_HOSTS: { '127.0.0.1': { SID_COOKIE_DOMAIN: 'host-only', SID_MODULE_CONFIG: reflect([{ name: 'uid1', maxAgeDays: 1 }]) }, 'www.example.com': { SID_COOKIE_DOMAIN: 'example.com', SID_MODULE_CONFIG: { reflect: badReflect } } } }
  ]) {
    const worker = await buildWorker(modulesOf(asEnv(config)));
    const host = config.SID_HOSTS === undefined ? '127.0.0.1' : 'www.example.com';
    const payload = await (await worker.fetch(request({ path: '/_sid/v1' }, host), asEnv(config))).json();
    check(payload.ext.modules.reflect?.status === 'error', 'the Worker reports reflect as an error with invalid settings');
    const result = buildSnippet(config);
    check(parserMessage !== '' && result.status === 2 && result.output.includes(parserMessage), `invalid reflect settings fail the Snippet build with the parser's message "${parserMessage}"\n${result.output}`);
  }
  // The geo module's settings are still checked when it runs: the build's smoke test fails on its error.
  const geo = buildSnippet({ SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'geo', SID_MODULE_CONFIG: { geo: { precision: 'exact' } } });
  check(geo.status === 1 && geo.output.includes('modules report an error in the smoke test: geo'), `invalid geo settings fail the Snippet build\n${geo.output}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`${String(checks)} checks (${String(files)} conformance case files, ${String(Object.keys(CONFIGS).length)} other configurations), ${String(failures)} failed`);
if (failures > 0) process.exit(1);
