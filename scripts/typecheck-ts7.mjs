// Type-checks every project with TypeScript 7 as well as the main compiler (TypeScript 6.0, which typescript-eslint
// needs), so the code keeps compiling on the next major. Run after `npm run build`: test projects use the built
// declarations of the packages they reference.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const tsc = join(root, 'node_modules/typescript7/bin/tsc');
const projects = [
  'packages/core',
  'packages/core/test',
  'packages/module-ip',
  'packages/module-ip/test',
  'packages/module-ec',
  'packages/module-ec/test',
  'packages/node',
  'packages/node/test',
  'packages/aws-lambda',
  'packages/aws-lambda/test',
  'conformance',
  'scripts',
  'packages/cloudflare',
  'packages/cloudflare/test'
];

let failed = false;
for (const project of projects) {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, project), '--noEmit'], { stdio: 'inherit' });
  console.log(`${result.status === 0 ? 'ok' : 'FAILED'} - TypeScript 7: ${project}`);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
