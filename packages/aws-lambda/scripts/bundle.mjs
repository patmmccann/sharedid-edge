// Bundles the Lambda entry point (src/lambda.ts, with core and the built-in modules) into one ESM file,
// dist/lambda.mjs, which is all the function needs: its handler is `lambda.handler`. Fails if the bundle is over
// its size budget, like the Worker's. Run `npm run build` first: core and the modules resolve to their dist/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outfile = join(root, 'dist/lambda.mjs');
const budget = 20 * 1024;

await build({
  entryPoints: [join(root, 'src/lambda.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning'
});

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Lambda bundle: dist/lambda.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
