// Copies the bundled adapter (built by `npm run bundle -w @sharedid-edge/vercel` in the repository) into lib/, as a
// site copies it into its own project. Run from the example folder; `npm run dev` and `npm run build` do it first.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const deploy = join(import.meta.dirname, '..', 'deploy');
for (const file of ['sharedid-edge.mjs', 'sharedid-edge.d.mts']) {
  if (!existsSync(join(deploy, file))) {
    console.error(`${join(deploy, file)} is missing: run \`npm run build && npm run bundle -w @sharedid-edge/vercel\` in the repository root first`);
    process.exit(1);
  }
  copyFileSync(join(deploy, file), join(import.meta.dirname, 'lib', file));
}
console.log('lib/sharedid-edge.mjs: copied from ../deploy');
