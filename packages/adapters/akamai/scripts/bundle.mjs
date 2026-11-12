// Bundles the EdgeWorker (src/main.ts, with core and the built-in modules) into deploy/main.js and writes its manifest,
// deploy/bundle.json: the two files of an EdgeWorkers code bundle
// (https://techdocs.akamai.com/edgeworkers/docs/code-bundle-format). Upload the folder with
// `akamai edgeworkers upload --codeDir deploy <edgeworker-id>`, or pack it as a .tgz.
//
// EdgeWorkers has no web-platform globals (Request, Response, URL, TextEncoder, crypto…), so src/globals.ts is
// injected: every free reference to those names in the bundle uses its exports, which come from EdgeWorkers' built-in
// modules (left as imports) and src/web.ts.
//
// The manifest's edgeworker-version must be new for every upload, so it's the package version and a hash of main.js.
//
// Options: --bowser (Bowser in the ua module), --outdir <deploy* dir>, --module and --vendor-modules; see
// scripts/bundle-adapter.mjs.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bundleAdapter } from '../../../../scripts/bundle-adapter.mjs';

/** The EdgeWorkers built-in modules the bundle imports; the runtime provides them. */
const BUILT_IN_MODULES = ['create-response', 'crypto', 'encoding', 'log', 'streams'];

const root = dirname(import.meta.dirname);

const { outdir, outfile, pkg } = await bundleAdapter({
  root,
  entry: 'src/main.ts',
  file: 'main.js',
  label: 'EdgeWorker bundle',
  options: {
    // Neutral: no Node.js built-ins resolve. Packages resolve through their `exports`.
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2022',
    external: BUILT_IN_MODULES,
    inject: [join(root, 'src/globals.ts')],
    banner: { js: '// SharedID Edge for Akamai EdgeWorkers (@sharedid-edge/akamai), bundled with its built-in modules. https://github.com/patmmccann/sharedid-edge' }
  }
});

// The bundle may import nothing but the built-in modules: anything else wouldn't resolve on EdgeWorkers.
const code = readFileSync(outfile, 'utf8');
const imports = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map(match => match[1]);
const unknown = imports.filter(name => !BUILT_IN_MODULES.includes(name));
if (unknown.length > 0) {
  console.error(`${basename(outdir)}/main.js imports modules EdgeWorkers doesn't have: ${unknown.join(', ')}`);
  process.exitCode = 1;
}

// Version strings must match ^(?!.*?\.{2})[.a-zA-Z0-9_~-]{1,32}$ (the EdgeWorkers CLI's check).
const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);
const manifest = {
  'edgeworker-version': `${pkg.version}-${hash}`,
  'bundle-version': 1,
  description: 'SharedID Edge: the Prebid SharedID cookie, set first-party from the edge',
  misc: { package: '@sharedid-edge/akamai', version: pkg.version }
};
writeFileSync(join(outdir, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${basename(outdir)}/bundle.json: edgeworker-version ${manifest['edgeworker-version']}`);

const files = readdirSync(outdir).sort();
if (files.join(',') !== 'bundle.json,main.js') {
  console.error(`${basename(outdir)}/ must contain only main.js and bundle.json, found: ${files.join(', ')}`);
  process.exitCode = 1;
}
