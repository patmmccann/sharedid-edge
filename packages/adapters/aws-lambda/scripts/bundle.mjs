// Bundles the Lambda entry point (src/lambda.ts, with core and the built-in modules) into one ESM file,
// deploy/lambda.mjs, which is all the function needs: its handler is `lambda.handler`, and template.yaml uploads
// deploy/ as the code.
//
// The bundle has its own directory on purpose. dist/ also holds TypeScript's unbundled lambda.js, and Lambda's
// loader tries lambda.js before lambda.mjs: uploading dist/ would load the unbundled entry, whose workspace imports
// aren't in the archive, and the function would fail to start. So deploy/ is emptied first and must end up holding
// lambda.mjs alone.
//
// Fails if the bundle is over its size budget, like the Worker's. Run `npm run build` first: core and the modules
// resolve to their dist/.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleAdapter } from '../../../../scripts/bundle-adapter.mjs';

const bundle = await bundleAdapter({
  root: join(import.meta.dirname, '..'),
  entry: 'src/lambda.ts',
  file: 'lambda.mjs',
  label: 'Lambda bundle',
  options: { platform: 'node', target: 'node24' }
});

const files = readdirSync(dirname(bundle));
if (files.length !== 1 || files[0] !== 'lambda.mjs') {
  console.error(`deploy/ must contain only lambda.mjs, found: ${files.join(', ')}`);
  process.exitCode = 1;
}
