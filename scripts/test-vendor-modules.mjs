// Runs the tests of every vendor module (packages/vendor-modules/*), for the separate vendor-modules CI job. Each
// vendor's result is reported on its own line, and having no vendor modules yet is a success. Run after
// `npm run build`.
import { spawnSync } from 'node:child_process';
import { workspaceFolders, root } from './projects.mjs';

// Under `npm run`, call npm's own script with this Node.js; otherwise the npm on PATH.
const npmCli = process.env['npm_execpath'];
const [command, prefix, shell] = npmCli === undefined ? ['npm', [], process.platform === 'win32'] : [process.execPath, [npmCli], false];
const vendors = workspaceFolders().filter(folder => folder.startsWith('packages/vendor-modules/'));

if (vendors.length === 0) {
  console.log('No vendor modules in packages/vendor-modules/: nothing to test.');
} else {
  let failed = false;
  for (const folder of vendors) {
    const result = spawnSync(command, [...prefix, 'run', 'test', '--if-present', '-w', folder], { cwd: root, stdio: 'inherit', shell });
    console.log(`${result.status === 0 ? 'ok' : 'FAILED'} - ${folder}`);
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
