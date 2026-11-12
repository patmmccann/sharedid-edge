// Bundles the Fastly Compute service (src/main.ts, with core and the built-in modules) into deploy/main.js: one ES
// module whose only imports are Fastly's own modules (fastly:*), which the JavaScript SDK provides when it compiles
// the bundle. Checked against the 32 KB gzipped budget, like every adapter's bundle. `npm run wasm` (scripts/wasm.mjs)
// then compiles it to deploy/main.wasm, the Compute package's WebAssembly.
//
// Options: --bowser (Bowser in the ua module), --outdir <deploy* dir>, --module and --vendor-modules; see
// scripts/bundle-adapter.mjs.
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { bundleAdapter, checkImports } from '../../../../scripts/bundle-adapter.mjs';

const root = dirname(import.meta.dirname);

const { outdir, outfile } = await bundleAdapter({
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
  }
});

// The bundle may import nothing but Fastly's modules: anything else wouldn't resolve when it's compiled.
checkImports(outfile, name => name.startsWith('fastly:'), 'Fastly Compute');

const files = readdirSync(outdir).sort();
if (files.join(',') !== 'main.js') {
  console.error(`${basename(outdir)}/ must contain only main.js, found: ${files.join(', ')}`);
  process.exitCode = 1;
}
