// Builds an adapter's one-file bundle into a deploy* folder and checks it against the size budget, for the bundled
// adapters' scripts/bundle.mjs. Run `npm run build` first: core and the modules resolve to their dist/.
//
// The adapters' bundle scripts take these options, parsed here:
//   --bowser        build Bowser into the ua module (`npm run bundle:bowser`), so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}
//                   parses User-Agents fully. It aliases @sharedid-edge/modules to @sharedid-edge/modules/bowser, the
//                   same list with uaModuleWithBowser, as the Worker's src/bowser.ts entry point imports. Checked against
//                   BOWSER_BUDGET rather than BUDGET.
//   --outdir <dir>  write to another deploy* directory than deploy/ (the conformance suite builds the Bowser bundle
//                   into deploy-bowser/, next to the default one).
//   --module <package>#<export>  add an opt-in module to the built-in ones (repeatable): `ec`
//                   (@sharedid-edge/module-ec#ecModule), `cmp` (@sharedid-edge/module-cmp#cmpModule) or a vendor module. scripts/module-list.mjs writes the list
//                   to .sharedid-modules/ and @sharedid-edge/modules is aliased to it. The size budget is reported,
//                   not enforced: a build with opt-in modules answers to the platform's limit.
//   --vendor-modules  add every opt-in module: those in packages/vendor-modules/, and the project's opt-in modules
//                   (`"optIn": true` in packages/modules/, such as cmp). The conformance suite's build.
//   --no-tcf        leave core's TCF decoder out (NO_TCF in packages/core/src/consent.ts): a TC string then denies
//                   storage and precise location, as an unreadable one does. Only for deployments that never need
//                   TCF; the conformance suite builds it into deploy-no-tcf/ for consent-no-tcf.json.
//
// An adapter can add options of its own (`args`, parsed with these) and change the build from them (`variant`): the
// Fastly adapter's --reusable-sandbox builds another entry point.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { checkBuildSecrets } from './check-build-secrets.mjs';
import { vendorModuleSpecs, writeModuleList } from './module-list.mjs';

/** The size budget of every default bundle, gzipped, the Worker's included. */
export const BUDGET = 32 * 1024;

/**
 * The size budget of the opt-in Bowser builds (`--bowser`, the Worker's `src/bowser.ts`), gzipped. Full User-Agent
 * parsing adds about 8 to 9 KB, which leaves a default-sized bundle no room under `BUDGET`; this gives the Bowser
 * builds about the default bundles' headroom, 7 to 8 KB. Platform limits are far higher (an Akamai EdgeWorkers code
 * bundle, a Worker or a Lambda function take megabytes), so the budget keeps start-up and parse time small rather than
 * fitting a limit.
 */
export const BOWSER_BUDGET = 40 * 1024;

/**
 * Empties the output directory (`<root>/deploy`, or `--outdir`, which must be a deploy* directory of the package),
 * bundles `<root>/<entry>` into `<file>` there as minified ESM with esbuild (`options` add to or override the
 * defaults; `--bowser` aliases the module list), and checks the gzipped size. Sets a failing exit code when it's over
 * budget, so the caller can run its own checks first. Returns the output directory, the bundle's path and the
 * package's package.json, for writing the rest of the deployment, and the parsed options.
 *
 * `args` are the adapter's own options, in `parseArgs`'s form. `variant`, given their values, can replace the entry
 * point, add to the label and add esbuild options.
 *
 * @typedef {{ entry?: string, label?: string, options?: import('esbuild').BuildOptions }} Variant
 * @param {{ root: string, entry: string, file: string, label: string, options?: import('esbuild').BuildOptions, args?: import('node:util').ParseArgsOptionsConfig, variant?: (values: Record<string, unknown>) => Variant }} bundle
 * @returns {Promise<{ outdir: string, outfile: string, pkg: { version: string, devDependencies: Record<string, string> }, args: Record<string, unknown> }>}
 */
export async function bundleAdapter({ root, entry, file, label, options = {}, args: own = {}, variant = () => ({}) }) {
  const { values: args } = parseArgs({
    options: {
      bowser: { type: 'boolean', default: false },
      outdir: { type: 'string', default: 'deploy' },
      module: { type: 'string', multiple: true, default: [] },
      'vendor-modules': { type: 'boolean', default: false },
      'no-tcf': { type: 'boolean', default: false },
      ...own
    }
  });
  const chosen = variant(args);
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
    entryPoints: [join(root, chosen.entry ?? entry)],
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
    ...chosen.options,
    // Settings are validated at run time here: only the Cloudflare Snippet, which validates them when it's built, sets
    // this to true. Defined false so the modules' check for it compiles away.
    // Without --module the list is the built-in modules, none of which has a consent hook: core's code that runs them
    // compiles away (NO_CONSENT_HOOKS in packages/core/src/modules.ts).
    // No bundled adapter wires a rate limiter (`rateLimit`): core's check for one compiles away (NO_RATE_LIMIT in
    // packages/core/src/handler.ts).
    // The TCF decoder is in unless --no-tcf leaves it out (NO_TCF in packages/core/src/consent.ts).
    define: { 'globalThis.__SID_PREVALIDATED__': 'false', 'globalThis.__SID_NO_CONSENT_HOOKS__': String(extra.length === 0), 'globalThis.__SID_NO_RATE_LIMIT__': 'true', 'globalThis.__SID_NO_TCF__': String(args['no-tcf']), ...options.define, ...chosen.options?.define },
    ...moduleAlias(root, args.bowser, extra)
  });
  const labelled = `${label}${chosen.label === undefined ? '' : ` ${chosen.label}`}${args.bowser ? ' with Bowser' : ''}${extra.length > 0 ? ` with ${extra.map(spec => spec.slice(0, spec.indexOf('#'))).join(', ')}` : ''}${args['no-tcf'] ? ' without TCF' : ''}`;
  checkBudget(outfile, labelled, root, { enforce: extra.length === 0, bowser: args.bowser });
  return { outdir, outfile, pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), args };
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
 * Logs a file's gzipped size, and sets a failing exit code when it's over its budget (`BUDGET`, or `BOWSER_BUDGET` for a
 * Bowser build; unless `enforce` is false: a build with opt-in modules), or when it contains a vendor module's
 * build-time credential (scripts/check-build-secrets.mjs).
 *
 * @param {string} file
 * @param {string} label
 * @param {string} [from] the folder the logged path is relative to
 * @param {{ enforce?: boolean, bowser?: boolean }} [options] `bowser`: a Bowser build, checked against `BOWSER_BUDGET`
 */
export function checkBudget(file, label, from = process.cwd(), { enforce = true, bowser = false } = {}) {
  const gzipped = gzipSync(readFileSync(file)).length;
  const budget = bowser ? BOWSER_BUDGET : BUDGET;
  console.log(`${label}: ${relative(from, file).replaceAll('\\', '/')}, ${String(gzipped)} bytes gzipped (${bowser ? 'Bowser budget' : 'budget'} ${String(budget)}${enforce ? '' : ', not enforced with opt-in modules'})`);
  if (enforce && gzipped > budget) {
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

// `node scripts/bundle-adapter.mjs [--bowser] <file> <label> [[--bowser] <file> <label> …]` checks bundles built
// elsewhere (the Worker's dry runs); `--bowser` before a pair checks that bundle against BOWSER_BUDGET.
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  /** @type {{ file: string, label: string, bowser: boolean }[]} */
  const bundles = [];
  let valid = args.length > 0;
  for (let i = 0; valid && i < args.length; i += 2) {
    const bowser = args[i] === '--bowser';
    if (bowser) i++;
    const file = args[i];
    const label = args[i + 1];
    if (file === undefined || label === undefined) valid = false;
    else bundles.push({ file, label, bowser });
  }
  if (!valid) {
    console.error('usage: node scripts/bundle-adapter.mjs [--bowser] <file> <label> [[--bowser] <file> <label> …]');
    process.exitCode = 2;
  }
  for (const { file, label, bowser } of bundles) checkBudget(file, label, process.cwd(), { bowser });
}
