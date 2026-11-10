// Bundles the Lambda entry point (src/lambda.ts, with core and the built-in modules) into one ESM file,
// deploy/lambda.mjs, which is all the function needs: its handler is `lambda.handler`, and template.yaml uploads
// deploy/ as the code.
//
// The bundle has its own directory on purpose. dist/ also holds TypeScript's unbundled lambda.js, and Lambda's
// loader tries lambda.js before lambda.mjs: uploading dist/ would load the unbundled entry, whose workspace imports
// aren't in the archive, and the function would fail to start. So deploy/ is emptied first and must end up holding
// lambda.mjs alone.
//
// Options:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser, as the Worker's Bowser build does.
//   --outdir <dir>  write somewhere other than deploy/ (the conformance suite builds the Bowser bundle into
//                   deploy-bowser/, next to the default one).
//
// Fails if the bundle is over its size budget, like the Worker's: 32 KB gzipped, with or without Bowser. Run
// `npm run build` first: core and the modules resolve to their dist/.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const { values: options } = parseArgs({ options: { bowser: { type: 'boolean', default: false }, outdir: { type: 'string', default: 'deploy' } } });
const root = join(import.meta.dirname, '..');
const outdir = resolve(root, options.outdir);
const outfile = join(outdir, 'lambda.mjs');
const budget = 32 * 1024;

// The directory is emptied first, so it must be a deploy* directory of this package.
if (dirname(outdir) !== root || !basename(outdir).startsWith('deploy')) throw new Error(`--outdir must be a deploy* directory in packages/adapters/aws-lambda, not ${options.outdir}`);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

await build({
  entryPoints: [join(root, 'src/lambda.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Minified, as the Worker is; names kept so stack traces stay readable. No source map: deploy/ must hold only
  // lambda.mjs (see above).
  minify: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  ...(options.bowser ? { alias: { '@sharedid-edge/modules': '@sharedid-edge/modules/bowser' } } : {})
});

const files = readdirSync(outdir);
if (files.length !== 1 || files[0] !== 'lambda.mjs') {
  console.error(`${options.outdir}/ must contain only lambda.mjs, found: ${files.join(', ')}`);
  process.exitCode = 1;
}

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Lambda bundle${options.bowser ? ' with Bowser' : ''}: ${options.outdir}/lambda.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
