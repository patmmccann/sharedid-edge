// Builds the Prebid.js the test page loads, site/public/prebid/prebid.js, from the installed prebid.js package: only
// the modules the page uses, not the 4 MB not-for-prod build with every module.
//
// It assembles the bundle the way Prebid's download page does (its web bundler, assets/js/prebidBundler.js on
// docs.prebid.org): a banner, the precompiled chunks the release publishes under dist/chunks for the modules and
// everything they depend on, and a processQueue() call; the same shape as `gulp bundle`. It reads them from
// node_modules instead of the CDN, so the bundle is the locked version (package.json pins it; Dependabot bumps it),
// and checks each chunk against the release's checksums.json.
//
//   node --experimental-strip-types bundle-prebid.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A typical publisher setup around SharedID, so the tests show it works next to consent enforcement, storage control,
 * other ID modules, bidders and analytics, not only alone. The list is prebid-modules.json, which tc-string.ts also
 * reads: the page's TC string consents to every vendor these modules declare. Parent modules are added as on the
 * download page.
 */
const MODULES = readModules();

function readModules(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'prebid-modules.json'), 'utf8'));
  const modules = typeof parsed === 'object' && parsed !== null && 'modules' in parsed ? parsed.modules : undefined;
  if (!Array.isArray(modules) || !modules.every((m): m is string => typeof m === 'string')) throw new Error('prebid-modules.json: "modules" must be a list of module names');
  return modules;
}

const CORE = 'prebid-core';
const METADATA_SUFFIX = '.metadata.js';
// Mirrors MODULES_REQUIRING_METADATA in Prebid.js' web-bundler/dependencies.mjs.
const MODULES_REQUIRING_METADATA = ['storageControl'];

const root = join(import.meta.dirname, 'node_modules', 'prebid.js');
const chunksDir = join(root, 'dist', 'chunks');
const out = join(import.meta.dirname, 'site', 'public', 'prebid', 'prebid.js');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null
    && Object.values(value).every(v => Array.isArray(v) && v.every(item => typeof item === 'string'));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every(v => typeof v === 'string');
}

const pkg = readJson(join(root, 'package.json'));
if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
  throw new Error('prebid.js/package.json has no version');
}
const version = pkg.version;
const globalVarName = 'globalVarName' in pkg && typeof pkg.globalVarName === 'string' ? pkg.globalVarName : 'pbjs';

const dependencies = readJson(join(chunksDir, 'dependencies.json'));
const checksums = readJson(join(chunksDir, 'checksums.json'));
const submodules = readJson(join(root, 'modules', '.submodules.json'));
const parentModules = typeof submodules === 'object' && submodules !== null && 'parentModules' in submodules ? submodules.parentModules : undefined;
if (!isStringArrayRecord(dependencies) || !isStringRecord(checksums) || !isStringArrayRecord(parentModules)) {
  throw new Error(`prebid.js ${version} doesn't publish dist/chunks with dependencies.json and checksums.json (10.0 and later, checksums from 11.40)`);
}

/** Submodules need their parent module; add any that are missing to the front, as `gulp bundle` does. */
function withParents(modules: readonly string[], parents: Record<string, string[]>): string[] {
  const result = [...modules];
  for (const module of modules) {
    const parent = Object.keys(parents).find(p => parents[p]?.includes(module) === true);
    if (parent !== undefined && !result.includes(parent)) result.unshift(parent);
  }
  return result;
}

/** prebid-core, the modules, their metadata when a module needs it, and every dependency of those. */
function chunksFor(modules: readonly string[], deps: Record<string, string[]>, available: Record<string, string>): string[] {
  const hasMetadata = (module: string): boolean => Object.hasOwn(available, module + METADATA_SUFFIX);
  const metadata = modules.some(m => MODULES_REQUIRING_METADATA.includes(m))
    ? [...modules, CORE].filter(hasMetadata).map(m => m + METADATA_SUFFIX)
    : [];
  const chunks = new Set([`${CORE}.js`, ...modules.map(m => `${m}.js`), ...metadata]);
  for (const chunk of chunks) for (const dependency of deps[chunk] ?? []) chunks.add(dependency);
  return [...chunks];
}

const modules = withParents(MODULES, parentModules);
const missing = modules.filter(m => !Object.hasOwn(checksums, `${m}.js`));
if (missing.length > 0) throw new Error(`Modules not in prebid.js ${version}: ${missing.join(', ')}`);

const sources = chunksFor(modules, dependencies, checksums).map(chunk => {
  const source = readFileSync(join(chunksDir, chunk));
  // Some chunks (buildOptions.js) have no checksum; the download page loads those unchecked too.
  const expected = checksums[chunk];
  const actual = `sha256-${createHash('sha256').update(source).digest('base64')}`;
  if (expected !== undefined && expected !== actual) throw new Error(`${chunk} doesn't match prebid.js ${version}'s checksums.json`);
  return source.toString('utf8');
});

const g = globalVarName;
const header = `/* prebid.js v${version}\nModules: ${modules.join(', ')} */\n`
  + `if(window.${g}&&window.${g}.libLoaded)try{window.${g}.getConfig("debug")&&console.warn("Attempted to load a copy of Prebid.js that clashes with the existing '${g}' instance. Load aborted.")}catch(e){}else (function(){`;
const footer = `})(),${g}.processQueue();`;
const bundle = [header, ...sources, footer].join('\n');

mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, bundle);
console.log(`Prebid.js ${version} (${modules.join(', ')}): ${String(Math.round(bundle.length / 1024))} KB -> ${out}`);
