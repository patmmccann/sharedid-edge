// Bundles the Lambda entry point (src/lambda.ts, with core and the built-in modules) into one ESM file,
// deploy/lambda.mjs, which is all the function needs: its handler is `lambda.handler`, and template.yaml uploads
// deploy/ as the code.
//
// The bundle has its own directory on purpose. dist/ also holds TypeScript's unbundled lambda.js, and Lambda's
// loader tries lambda.js before lambda.mjs: uploading dist/ would load the unbundled entry, whose workspace imports
// aren't in the archive, and the function would fail to start. So deploy/ is emptied first and must end up holding
// lambda.mjs alone.
//
// Fails if the bundle is over its size budget, like the Worker's. Run `npm run build` first: core and the modules
// resolve to their dist/.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outdir = join(root, 'deploy');
const outfile = join(outdir, 'lambda.mjs');
const budget = 20 * 1024;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

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

const files = readdirSync(outdir);
if (files.length !== 1 || files[0] !== 'lambda.mjs') {
  console.error(`deploy/ must contain only lambda.mjs, found: ${files.join(', ')}`);
  process.exitCode = 1;
}

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Lambda bundle: deploy/lambda.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
