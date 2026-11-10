// Builds the function into deploy/, the source directory of a Cloud Run function (gcloud, or terraform/):
//
//   deploy/sharedid-edge.mjs  src/function.ts with core, @sharedid-edge/node's conversion and the built-in modules
//   deploy/package.json       "main" is the bundle; its one dependency is the Functions Framework, which Cloud Run
//                             functions installs at build time and which runs the function (entry point sharedidEdge)
//
// The Functions Framework isn't bundled: the runtime starts it and it loads the bundle. Fails if the bundle is over its
// size budget, like the Worker's. Run `npm run build` first: the workspace packages resolve to their dist/.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outdir = join(root, 'deploy');
const outfile = join(outdir, 'sharedid-edge.mjs');
const budget = 20 * 1024;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

await build({
  entryPoints: [join(root, 'src/function.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['@google-cloud/functions-framework'],
  legalComments: 'none',
  logLevel: 'warning'
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
console.log(`Cloud Run function bundle: deploy/sharedid-edge.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
