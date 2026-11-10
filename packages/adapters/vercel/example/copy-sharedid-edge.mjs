// Copies the bundled adapter (`packages/adapters/vercel/deploy/sharedid-edge.mjs`) into lib/, as a site copies it into
// its own project. `npm run dev` and `npm run build` run this first.
//
// The bundle is build output, not committed. When it's missing (a fresh clone, or a Vercel build of this folder), this
// builds it from the repository first: `npm ci` (if the workspace isn't installed), `npm run build`, then
// `npm run bundle -w @sharedid-edge/vercel`. On Vercel that works because the build clones the whole repository and
// can read files outside the project's root directory (Vercel's default; see the README).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const deploy = join(import.meta.dirname, '..', 'deploy');
const repo = join(import.meta.dirname, '..', '..', '..', '..');
const files = ['sharedid-edge.mjs', 'sharedid-edge.d.mts'];

if (!files.every(file => existsSync(join(deploy, file)))) {
  if (!existsSync(join(repo, 'package.json')) || !existsSync(join(repo, 'packages', 'core'))) {
    console.error(`The SharedID Edge bundle is missing and the repository isn't at ${repo}. Build it there with ` +
      '`npm ci && npm run build && npm run bundle -w @sharedid-edge/vercel`, or copy deploy/ here.');
    process.exit(1);
  }
  const run = command => {
    console.log(`> ${command}`);
    execSync(command, { cwd: repo, stdio: 'inherit' });
  };
  console.log('Building the SharedID Edge bundle from the repository…');
  if (!existsSync(join(repo, 'node_modules'))) run('npm ci');
  run('npm run build');
  run('npm run bundle -w @sharedid-edge/vercel');
}

mkdirSync(join(import.meta.dirname, 'lib'), { recursive: true });
for (const file of files) copyFileSync(join(deploy, file), join(import.meta.dirname, 'lib', file));
console.log('lib/sharedid-edge.mjs: copied from ../deploy');
