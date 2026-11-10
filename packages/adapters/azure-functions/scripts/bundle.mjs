// Builds the function app into deploy/, ready to publish:
//
//   deploy/sharedid-edge.mjs  src/functions.ts with core and the built-in modules, in one ESM file
//   deploy/host.json          the Functions host settings: an empty route prefix, so the route is the URL path
//   deploy/package.json       "main" is the bundle; its one dependency is @azure/functions (the v4 programming model)
//
// @azure/functions isn't bundled: it reaches the Functions worker through `require('@azure/functions-core')`, which
// only the worker provides, so it stays an ordinary dependency, installed with `npm install --omit=dev` in deploy/
// (or by a remote build). Fails if the bundle is over its size budget, like the Worker's. Run `npm run build` first:
// core and the modules resolve to their dist/.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outdir = join(root, 'deploy');
const outfile = join(outdir, 'sharedid-edge.mjs');
const budget = 20 * 1024;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

await build({
  entryPoints: [join(root, 'src/functions.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['@azure/functions'],
  legalComments: 'none',
  logLevel: 'warning'
});

writeFileSync(join(outdir, 'host.json'), JSON.stringify({
  version: '2.0',
  // The function's route is the URL path itself (SID_BASE_PATH), not /api/….
  extensions: { http: { routePrefix: '' } },
  logging: {
    // No request telemetry: Application Insights would record each request's URL, including the sync's `id`.
    logLevel: { default: 'Warning', Function: 'Warning', 'Host.Results': 'Error', 'Host.Aggregator': 'Warning' }
  }
}, null, 2) + '\n');

writeFileSync(join(outdir, 'package.json'), JSON.stringify({
  name: 'sharedid-edge-azure-functions',
  version: pkg.version,
  private: true,
  type: 'module',
  main: 'sharedid-edge.mjs',
  engines: { node: '>=24' },
  dependencies: { '@azure/functions': pkg.devDependencies['@azure/functions'] }
}, null, 2) + '\n');

const gzipped = gzipSync(readFileSync(outfile)).length;
console.log(`Azure Functions bundle: deploy/sharedid-edge.mjs, ${String(gzipped)} bytes gzipped (budget ${String(budget)})`);
if (gzipped > budget) {
  console.error('Over the bundle size budget');
  process.exitCode = 1;
}
