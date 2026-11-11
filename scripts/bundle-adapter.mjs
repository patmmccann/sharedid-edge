// Builds an adapter's one-file bundle into a deploy* folder and checks it against the size budget, for the bundled
// adapters' scripts/bundle.mjs. Run `npm run build` first: core and the modules resolve to their dist/.
//
// The adapters' bundle scripts take these options, parsed here:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser, as the Worker's src/bowser.ts entry point imports. Same budget.
//   --outdir <dir>  write to another deploy* directory than deploy/ (the conformance suite builds the Bowser bundle
//                   into deploy-bowser/, next to the default one).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { checkBuildSecrets } from './check-build-secrets.mjs';

/** The size budget of every bundle, gzipped, the Worker's included, with or without Bowser. */
export const BUDGET = 32 * 1024;

/**
 * Empties the output directory (`<root>/deploy`, or `--outdir`, which must be a deploy* directory of the package),
 * bundles `<root>/<entry>` into `<file>` there as minified ESM with esbuild (`options` add to or override the
 * defaults; `--bowser` aliases the module list), and checks the gzipped size. Sets a failing exit code when it's over
 * budget, so the caller can run its own checks first. Returns the output directory, the bundle's path and the
 * package's package.json, for writing the rest of the deployment.
 *
 * @param {{ root: string, entry: string, file: string, label: string, options?: import('esbuild').BuildOptions }} bundle
 * @returns {Promise<{ outdir: string, outfile: string, pkg: { version: string, devDependencies: Record<string, string> } }>}
 */
export async function bundleAdapter({ root, entry, file, label, options = {} }) {
  const { values: args } = parseArgs({ options: { bowser: { type: 'boolean', default: false }, outdir: { type: 'string', default: 'deploy' } } });
  const outdir = resolve(root, args.outdir);
  // The directory is emptied first, so it must be a deploy* directory of this package.
  if (dirname(outdir) !== root || !basename(outdir).startsWith('deploy')) {
    throw new Error(`--outdir must be a deploy* directory in ${relative(process.cwd(), root).replaceAll('\\', '/') || '.'}, not ${args.outdir}`);
  }
  const outfile = join(outdir, file);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir);
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    // Minified, as the Worker is; names kept so stack traces stay readable. No source map: a deploy* folder holds
    // only what's deployed.
    minify: true,
    keepNames: true,
    legalComments: 'none',
    logLevel: 'warning',
    ...options,
    ...(args.bowser ? { alias: { '@sharedid-edge/modules': '@sharedid-edge/modules/bowser' } } : {})
  });
  checkBudget(outfile, args.bowser ? `${label} with Bowser` : label, root);
  return { outdir, outfile, pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) };
}

/**
 * Logs a file's gzipped size, and sets a failing exit code when it's over `BUDGET`, or when it contains a vendor
 * module's build-time credential (scripts/check-build-secrets.mjs).
 *
 * @param {string} file
 * @param {string} label
 * @param {string} [from] the folder the logged path is relative to
 */
export function checkBudget(file, label, from = process.cwd()) {
  const gzipped = gzipSync(readFileSync(file)).length;
  console.log(`${label}: ${relative(from, file).replaceAll('\\', '/')}, ${String(gzipped)} bytes gzipped (budget ${String(BUDGET)})`);
  if (gzipped > BUDGET) {
    console.error('Over the bundle size budget');
    process.exitCode = 1;
  }
  checkBuildSecrets(file, { from });
}

// `node scripts/bundle-adapter.mjs <file> <label> [<file> <label> …]` checks bundles built elsewhere (the Worker's
// dry runs).
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error('usage: node scripts/bundle-adapter.mjs <file> <label> [<file> <label> …]');
    process.exitCode = 2;
  }
  for (let i = 0; i + 1 < args.length; i += 2) checkBudget(args[i], args[i + 1]);
}
