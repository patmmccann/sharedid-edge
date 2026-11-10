// Bundles the adapter (src/bundle.ts, with core and the built-in modules) into one ESM file a site copies into its
// Vercel project: deploy/sharedid-edge.mjs, with its declarations in deploy/sharedid-edge.d.mts.
//
// The bundle is built for a neutral platform with no Node.js built-ins, so it fails if anything that wouldn't run on
// Vercel's Edge runtime creeps in, and it fails over its size budget, like the Worker's and the Lambda function's.
// Run `npm run build` first: core and the modules resolve to their dist/, and the declarations come from
// dist/bundle.d.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outdir = join(root, 'deploy');
const outfile = join(outdir, 'sharedid-edge.mjs');
const declarations = join(outdir, 'sharedid-edge.d.mts');
const budget = 32 * 1024;

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
console.log(`Vercel bundle: deploy/sharedid-edge.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
