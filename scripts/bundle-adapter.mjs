// Builds an adapter's one-file bundle into its deploy/ folder and checks it against the size budget, for the bundled
// adapters' scripts/bundle.mjs. Run `npm run build` first: core and the modules resolve to their dist/.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

/** The size budget of every bundled adapter, gzipped, like the Worker's. */
export const BUDGET = 20 * 1024;

/**
 * Empties `<root>/deploy`, bundles `<root>/<entry>` into `<root>/deploy/<file>` as ESM with esbuild (`options` add to
 * or override the defaults), and checks the gzipped size. Sets a failing exit code when it's over budget, so the
 * caller can run its own checks first. Returns the bundle's path.
 *
 * @param {{ root: string, entry: string, file: string, label: string, options?: import('esbuild').BuildOptions }} bundle
 * @returns {Promise<string>}
 */
export async function bundleAdapter({ root, entry, file, label, options = {} }) {
  const outdir = join(root, 'deploy');
  const outfile = join(outdir, file);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir);
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    legalComments: 'none',
    logLevel: 'warning',
    ...options
  });
  checkBudget(outfile, label, root);
  return outfile;
}

/**
 * Logs a file's gzipped size, and sets a failing exit code when it's over `BUDGET`.
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
}

// `node scripts/bundle-adapter.mjs <file> <label>` checks a bundle built elsewhere (the Worker's dry run).
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const [file, label = 'Bundle'] = process.argv.slice(2);
  if (file === undefined) {
    console.error('usage: node scripts/bundle-adapter.mjs <file> [label]');
    process.exitCode = 2;
  } else {
    checkBudget(file, label);
  }
}
