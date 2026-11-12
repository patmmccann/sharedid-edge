// Bundles the Fastly Compute service (src/main.ts, with core and the built-in modules) into deploy/main.js: one ES
// module whose only imports are Fastly's own modules (fastly:*), which the JavaScript SDK provides when it compiles
// the bundle. Checked against the 32 KB gzipped budget, like every adapter's bundle. `npm run wasm` (scripts/wasm.mjs)
// then compiles it to deploy/main.wasm, the Compute package's WebAssembly.
//
// Options: --bowser (Bowser in the ua module), --outdir <deploy* dir>, --module and --vendor-modules; see
// scripts/bundle-adapter.mjs. And this adapter's own:
//   --reusable-sandbox  bundle src/reusable.ts instead: the same service with Fastly's reusable sandboxes on
//                   (experimental), so one sandbox answers several requests in turn. Off by default; the default bundle
//                   must not import fastly:experimental, and this checks it doesn't.
//   --reusable-sandbox-option <name>=<integer>  override a default of src/sandbox.ts (repeatable): maxRequests,
//                   betweenRequestTimeoutMs, maxMemoryMiB or sandboxTimeoutMs. Needs --reusable-sandbox.
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { bundleAdapter, checkImports } from '../../../../scripts/bundle-adapter.mjs';

const root = dirname(import.meta.dirname);

/** The options of `setReusableSandboxOptions` (src/sandbox.ts). */
const SANDBOX_OPTIONS = ['maxRequests', 'betweenRequestTimeoutMs', 'maxMemoryMiB', 'sandboxTimeoutMs'];

/**
 * The --reusable-sandbox-option values as an object, checked: known names, whole numbers of 0 or more.
 *
 * @param {string[]} values
 * @returns {Record<string, number>}
 */
function sandboxOverrides(values) {
  /** @type {Record<string, number>} */
  const overrides = {};
  for (const value of values) {
    const [name = '', number = ''] = value.split('=');
    if (!SANDBOX_OPTIONS.includes(name) || !/^\d+$/.test(number)) {
      throw new Error(`--reusable-sandbox-option takes <name>=<whole number>, name one of ${SANDBOX_OPTIONS.join(', ')}; not ${value}`);
    }
    overrides[name] = Number(number);
  }
  return overrides;
}

const { outdir, outfile, args } = await bundleAdapter({
  root,
  entry: 'src/main.ts',
  file: 'main.js',
  label: 'Fastly Compute bundle',
  options: {
    // Neutral: no Node.js built-ins resolve. Packages resolve through their `exports`. Fastly's modules stay imports.
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2022',
    external: ['fastly:*'],
    banner: { js: '// SharedID Edge for Fastly Compute (@sharedid-edge/fastly), bundled with its built-in modules. https://github.com/patmmccann/sharedid-edge' }
  },
  args: {
    'reusable-sandbox': { type: 'boolean', default: false },
    'reusable-sandbox-option': { type: 'string', multiple: true, default: [] }
  },
  variant: values => {
    const overrides = /** @type {string[]} */ (values['reusable-sandbox-option']);
    if (values['reusable-sandbox'] !== true) {
      if (overrides.length > 0) throw new Error('--reusable-sandbox-option needs --reusable-sandbox');
      return {};
    }
    return {
      entry: 'src/reusable.ts',
      label: 'with reusable sandboxes',
      options: { define: { SHAREDID_REUSABLE_SANDBOX_OPTIONS: JSON.stringify(sandboxOverrides(overrides)) } }
    };
  }
});

// The bundle may import nothing but Fastly's modules: anything else wouldn't resolve when it's compiled. Only the
// reusable-sandbox build may import the experimental one.
const reusable = args['reusable-sandbox'] === true;
checkImports(outfile, name => name.startsWith('fastly:') && (reusable || name !== 'fastly:experimental'), 'Fastly Compute (fastly:experimental only with --reusable-sandbox)');

const files = readdirSync(outdir).sort();
if (files.join(',') !== 'main.js') {
  console.error(`${basename(outdir)}/ must contain only main.js, found: ${files.join(', ')}`);
  process.exitCode = 1;
}
