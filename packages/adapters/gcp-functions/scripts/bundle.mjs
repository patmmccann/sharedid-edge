// Builds the function into deploy/, the source directory of a Cloud Run function (gcloud, or terraform/):
//
//   deploy/sharedid-edge.mjs  src/function.ts with core, @sharedid-edge/node's conversion and the built-in modules
//   deploy/package.json       "main" is the bundle; its one dependency is the Functions Framework, which Cloud Run
//                             functions installs at build time and which runs the function (entry point sharedidEdge)
//
// The Functions Framework isn't bundled: the runtime starts it and it loads the bundle. Fails if the bundle is over its
// size budget, like the Worker's. Run `npm run build` first: the workspace packages resolve to their dist/.
//
// Options:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser. Same 32 KB budget.
//   --outdir <dir>  write to another deploy* directory than deploy/ (the conformance suite builds the Bowser bundle
//                   into deploy-bowser/, next to the default one).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const { values: options } = parseArgs({ options: { bowser: { type: 'boolean', default: false }, outdir: { type: 'string', default: 'deploy' } } });
const root = join(import.meta.dirname, '..');
const outdir = resolve(root, options.outdir);
const outfile = join(outdir, 'sharedid-edge.mjs');
const budget = 32 * 1024;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The directory is emptied first, so it must be a deploy* directory of this package.
if (dirname(outdir) !== root || !basename(outdir).startsWith('deploy')) throw new Error(`--outdir must be a deploy* directory in packages/adapters/gcp-functions, not ${options.outdir}`);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

await build({
  entryPoints: [join(root, 'src/function.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Minified, as the Worker is; names kept so stack traces stay readable.
  minify: true,
  keepNames: true,
  external: ['@google-cloud/functions-framework'],
  legalComments: 'none',
  logLevel: 'warning',
  ...(options.bowser ? { alias: { '@sharedid-edge/modules': '@sharedid-edge/modules/bowser' } } : {})
});

writeFileSync(join(outdir, 'package.json'), JSON.stringify({
  name: 'sharedid-edge-gcp-function',
  version: pkg.version,
  private: true,
  type: 'module',
  main: 'sharedid-edge.mjs',
  engines: { node: '>=24' },
  scripts: { start: 'functions-framework --target=sharedidEdge' },
  dependencies: { '@google-cloud/functions-framework': pkg.devDependencies['@google-cloud/functions-framework'] }
}, null, 2) + '\n');

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Cloud Run function bundle${options.bowser ? ' with Bowser' : ''}: ${options.outdir}/sharedid-edge.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
