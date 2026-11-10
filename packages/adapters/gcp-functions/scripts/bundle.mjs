// Builds the function into deploy/, the source directory of a Cloud Run function (gcloud, or terraform/):
//
//   deploy/sharedid-edge.mjs  src/function.ts with core, @sharedid-edge/node's conversion and the built-in modules
//   deploy/package.json       "main" is the bundle; its one dependency is the Functions Framework, which Cloud Run
//                             functions installs at build time and which runs the function (entry point sharedidEdge)
//
// The Functions Framework isn't bundled: the runtime starts it and it loads the bundle. Fails if the bundle is over its
// size budget, like the Worker's. Run `npm run build` first: the workspace packages resolve to their dist/.
//
// Options: --bowser (Bowser in the ua module) and --outdir <deploy* dir>; see scripts/bundle-adapter.mjs.
// jscpd:ignore-start -- the call to the shared bundle helper, as in every adapter; only its arguments differ.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleAdapter } from '../../../../scripts/bundle-adapter.mjs';

const { outdir, pkg } = await bundleAdapter({
  root: dirname(import.meta.dirname),
  entry: 'src/function.ts',
  file: 'sharedid-edge.mjs',
  label: 'Cloud Run function bundle',
  options: { platform: 'node', target: 'node24', external: ['@google-cloud/functions-framework'] }
});
// jscpd:ignore-end

writeFileSync(join(outdir, 'package.json'), JSON.stringify({
  name: 'sharedid-edge-gcp-function',
  version: pkg.version,
  private: true,
  type: 'module',
  main: 'sharedid-edge.mjs',
  engines: { node: '>=24' },
  scripts: { start: 'functions-framework --target=sharedidEdge' },
  dependencies: { '@google-cloud/functions-framework': pkg.devDependencies['@google-cloud/functions-framework'] }
}, null, 2) + '\n');

