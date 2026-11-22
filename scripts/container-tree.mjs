// The Node.js server's container image (packages/adapters/node/Dockerfile) runs from a node_modules tree with only
// what the server loads: @sharedid-edge/node, every opt-in module (the project's and the vendor modules, so
// SID_MODULE_PACKAGES works without building another image), and their runtime dependencies. Workspace packages are
// copied as npm would publish them (package.json and their `files`, here dist/ without build info); third-party ones
// whole. No symlinks, no devDependencies, no other adapters.
//
//   node scripts/container-tree.mjs --projects       # the tsc -b projects to build first, space-separated
//   node scripts/container-tree.mjs <out>            # writes <out>/node_modules/… and <out>/package.json
//
// Run from a built checkout (npm ci, then tsc -b of the --projects).
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { vendorModuleSpecs, parseModuleSpec } from './module-list.mjs';
import { optInModules } from './vendor-modules.mjs';

const ROOT = join(import.meta.dirname, '..');
const SERVER = '@sharedid-edge/node';

/** The packages the image starts from: the server, and every opt-in module. */
function entries() {
  return [SERVER, ...vendorModuleSpecs().map(spec => parseModuleSpec(spec).pkg)];
}

/**
 * Where `name` resolves from `from` (a package folder), as Node.js finds it: the nearest node_modules/<name> above it.
 *
 * @param {string} name
 * @param {string} from
 */
function resolvePackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === ROOT || dirname(dir) === dir) throw new Error(`can't resolve ${name} from ${relative(ROOT, from) || '.'}`);
  }
}

/** Whether a resolved package folder is one of this repository's workspace packages. */
function isWorkspace(dir) {
  const rel = relative(ROOT, dir);
  return !rel.startsWith('..') && !rel.split(sep).includes('node_modules');
}

/**
 * Every package the entries need at run time, by name: its folder, and whether it's a workspace package. One version
 * of each, so the tree is flat; two would be an error.
 */
function closure() {
  /** @type {Map<string, { dir: string, workspace: boolean }>} */
  const found = new Map();
  /** @type {[string, string][]} */
  const queue = entries().map(name => [name, ROOT]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [name, from] = next;
    const dir = resolvePackage(name, from);
    const seen = found.get(name);
    if (seen !== undefined) {
      if (seen.dir !== dir) throw new Error(`two copies of ${name} (${relative(ROOT, seen.dir)}, ${relative(ROOT, dir)}): the image's tree is flat`);
      continue;
    }
    found.set(name, { dir, workspace: isWorkspace(dir) });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) queue.push([dep, dir]);
  }
  return found;
}

/** Copies a workspace package as npm would publish it: package.json, README and its `files`, minus negated patterns' build info. */
function copyWorkspace(dir, to) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  mkdirSync(to, { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE']) if (existsSync(join(dir, file))) cpSync(join(dir, file), join(to, file));
  const files = Array.isArray(pkg.files) ? pkg.files.filter(entry => typeof entry === 'string' && !entry.startsWith('!')) : ['dist'];
  for (const entry of files) {
    if (!existsSync(join(dir, entry))) throw new Error(`${pkg.name}: ${entry} is missing; build it first (node scripts/container-tree.mjs --projects)`);
    cpSync(join(dir, entry), join(to, entry), { recursive: true, filter: source => !source.endsWith('.tsbuildinfo') });
  }
}

const arg = process.argv[2];
if (arg === '--projects') {
  // tsc -b builds each project's references too.
  const folders = ['packages/adapters/node', ...optInModules().map(({ folder }) => folder)];
  process.stdout.write(`${folders.join(' ')}\n`);
} else if (arg !== undefined && !arg.startsWith('-')) {
  const out = resolve(arg);
  rmSync(out, { recursive: true, force: true });
  const packages = closure();
  for (const [name, { dir, workspace }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const to = join(out, 'node_modules', name);
    if (workspace) copyWorkspace(dir, to);
    else cpSync(dir, to, { recursive: true, filter: source => !relative(dir, source).split(sep).includes('node_modules') });
  }
  // An ESM package root, so the server's dynamic imports resolve from /app/node_modules.
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'sharedid-edge-node-image', private: true, type: 'module' }, null, 2)}\n`);
  process.stdout.write(`${String(packages.size)} packages in ${relative(process.cwd(), out) || '.'}/node_modules: ${[...packages.keys()].sort().join(', ')}\n`);
} else {
  process.stderr.write('Usage: node scripts/container-tree.mjs --projects | <out>\n');
  process.exit(2);
}
