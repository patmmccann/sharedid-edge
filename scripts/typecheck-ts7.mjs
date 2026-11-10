// Type-checks every project with TypeScript 7 as well as the main compiler (TypeScript 6.0, which typescript-eslint
// needs), so the code keeps compiling on the next major. Run after `npm run build`: test projects use the built
// declarations of the packages they reference.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projects as allProjects, root } from './projects.mjs';

const tsc = join(root, 'node_modules/typescript7/bin/tsc');
// Every project, including the ones `tsc -b` skips (the Cloudflare Worker), from the workspace folders.
const projects = allProjects().map(project => project.path);

let failed = false;
for (const project of projects) {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, project), '--noEmit'], { stdio: 'inherit' });
  console.log(`${result.status === 0 ? 'ok' : 'FAILED'} - TypeScript 7: ${project}`);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
