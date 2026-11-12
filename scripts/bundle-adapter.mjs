// Builds an adapter's one-file bundle into a deploy* folder and checks it against the size budget, for the bundled
// adapters' scripts/bundle.mjs. Run `npm run build` first: core and the modules resolve to their dist/.
//
// The adapters' bundle scripts take these options, parsed here:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser, as the Worker's src/bowser.ts entry point imports. Same budget.
//   --outdir <dir>  write to another deploy* directory than deploy/ (the conformance suite builds the Bowser bundle
//                   into deploy-bowser/, next to the default one).
//   --module <package>#<export>  add an opt-in module to the built-in ones (repeatable): `ec`
//                   (@sharedid-edge/module-ec#ecModule) or a vendor module. scripts/module-list.mjs writes the list
//                   to .sharedid-modules/ and @sharedid-edge/modules is aliased to it. The size budget is reported,
//                   not enforced: a build with opt-in modules answers to the platform's limit.
//   --vendor-modules  add every module in packages/vendor-modules/ (the conformance suite's build).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { checkBuildSecrets } from './check-build-secrets.mjs';
import { vendorModuleSpecs, writeModuleList } from './module-list.mjs';

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
  const { values: args } = parseArgs({
    options: {
      bowser: { type: 'boolean', default: false },
      outdir: { type: 'string', default: 'deploy' },
      module: { type: 'string', multiple: true, default: [] },
      'vendor-modules': { type: 'boolean', default: false }
    }
  });
  const extra = [...(args['vendor-modules'] ? vendorModuleSpecs() : []), ...args.module];
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
    ...moduleAlias(root, args.bowser, extra)
  });
  const labelled = `${label}${args.bowser ? ' with Bowser' : ''}${extra.length > 0 ? ` with ${extra.map(spec => spec.slice(0, spec.indexOf('#'))).join(', ')}` : ''}`;
  checkBudget(outfile, labelled, root, { enforce: extra.length === 0 });
  return { outdir, outfile, pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) };
}

/**
 * The esbuild alias for the module list: `@sharedid-edge/modules` to its Bowser variant with `--bowser`, or to a
 * generated list in `<root>/.sharedid-modules/` with opt-in modules (`extra`, `<package>#<export>` each).
 *
 * @param {string} root
 * @param {boolean} bowser
 * @param {string[]} extra
 * @returns {{ alias?: Record<string, string> }}
 */
function moduleAlias(root, bowser, extra) {
  if (extra.length > 0) {
    const list = writeModuleList(join(root, '.sharedid-modules'), { bowser, modules: extra });
    return { alias: { '@sharedid-edge/modules': list, '@sharedid-edge/modules/bowser': list } };
  }
  return bowser ? { alias: { '@sharedid-edge/modules': '@sharedid-edge/modules/bowser' } } : {};
}

/**
 * Logs a file's gzipped size, and sets a failing exit code when it's over `BUDGET` (unless `enforce` is false: a build
 * with opt-in modules), or when it contains a vendor module's build-time credential (scripts/check-build-secrets.mjs).
 *
 * @param {string} file
 * @param {string} label
 * @param {string} [from] the folder the logged path is relative to
 * @param {{ enforce?: boolean }} [options]
 */
export function checkBudget(file, label, from = process.cwd(), { enforce = true } = {}) {
  const gzipped = gzipSync(readFileSync(file)).length;
  console.log(`${label}: ${relative(from, file).replaceAll('\\', '/')}, ${String(gzipped)} bytes gzipped (budget ${String(BUDGET)}${enforce ? '' : ', not enforced with opt-in modules'})`);
  if (enforce && gzipped > BUDGET) {
    console.error('Over the bundle size budget');
    process.exitCode = 1;
  }
  checkBuildSecrets(file, { from });
}

/**
 * Sets a failing exit code when the bundle `file` imports any module `allowed` doesn't accept: on a platform whose
 * runtime provides only its own modules (EdgeWorkers' built-in modules, Fastly's `fastly:*`), anything else wouldn't
 * resolve. `platform` names the runtime in the message.
 *
 * @param {string} file
 * @param {(name: string) => boolean} allowed
 * @param {string} platform
 */
export function checkImports(file, allowed, platform) {
  const code = readFileSync(file, 'utf8');
  const imports = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map(match => match[1]);
  const unknown = imports.filter(name => !allowed(name));
  if (unknown.length > 0) {
    console.error(`${basename(dirname(file))}/${basename(file)} imports modules ${platform} doesn't have: ${unknown.join(', ')}`);
    process.exitCode = 1;
  }
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
