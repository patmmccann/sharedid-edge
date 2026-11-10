// Bundles the adapter (src/bundle.ts, with core and the built-in modules) into one ESM file a site copies into its
// Vercel project: deploy/sharedid-edge.mjs, with its declarations in deploy/sharedid-edge.d.mts.
//
// The bundle is built for a neutral platform with no Node.js built-ins, so it fails if anything that wouldn't run on
// Vercel's Edge runtime creeps in, and it fails over its size budget, like the Worker's and the Lambda function's.
// Run `npm run build` first: core and the modules resolve to their dist/, and the declarations come from
// dist/bundle.d.ts.
//
// Options:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser, as the Worker's src/bowser.ts entry point imports. Same 32 KB budget.
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
const declarations = join(outdir, 'sharedid-edge.d.mts');
const budget = 32 * 1024;

// The directory is emptied first, so it must be a deploy* directory of this package.
if (dirname(outdir) !== root || !basename(outdir).startsWith('deploy')) throw new Error(`--outdir must be a deploy* directory in packages/adapters/vercel, not ${options.outdir}`);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

await build({
  entryPoints: [join(root, 'src/bundle.ts')],
  outfile,
  bundle: true,
  // Neutral: no Node.js built-ins resolve, as on the Edge runtime. Packages resolve through their `exports`.
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  format: 'esm',
  // Minified, as the Worker is; names kept so stack traces stay readable.
  minify: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  ...(options.bowser ? { alias: { '@sharedid-edge/modules': '@sharedid-edge/modules/bowser' } } : {}),
  banner: { js: '// SharedID Edge for Vercel (@sharedid-edge/vercel), bundled with its built-in modules. https://github.com/patmmccann/sharedid-edge' }
});

// The entry point's declarations stand alone (no imports), so they can sit next to the bundle.
const types = readFileSync(join(root, 'dist/bundle.d.ts'), 'utf8');
if (/^\s*import\b/m.test(types)) {
  console.error('dist/bundle.d.ts imports other declarations; src/bundle.ts must spell out its types');
  process.exitCode = 1;
}
writeFileSync(declarations, types.replace(/^\/\/# sourceMappingURL=.*$/m, '').trimEnd() + '\n');

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Vercel bundle${options.bowser ? ' with Bowser' : ''}: ${options.outdir}/sharedid-edge.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
