// Runs the tests of every vendor module (packages/vendor-modules/*), for the separate vendor-modules CI job. Each
// vendor's result is reported on its own line, and having no vendor modules yet is a success. Run after
// `npm run build`.
//
// Each vendor's tests run with scripts/no-network.mjs preloaded, set from the module's `network` declaration: a test
// run that reaches a host the module didn't declare fails, even if the module catches the error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceFolders, root } from './projects.mjs';
import { allowedHosts, vendorModules } from './vendor-modules.mjs';

const preload = `--import=${pathToFileURL(join(root, 'scripts/no-network.mjs')).href}`;
const declared = new Map(vendorModules().map(({ folder, meta }) => [folder, allowedHosts(meta.network)]));

// Under `npm run`, call npm's own script with this Node.js; otherwise the npm on PATH.
const npmCli = process.env['npm_execpath'];
const [command, prefix, shell] = npmCli === undefined ? ['npm', [], process.platform === 'win32'] : [process.execPath, [npmCli], false];
const vendors = workspaceFolders().filter(folder => folder.startsWith('packages/vendor-modules/'));

if (vendors.length === 0) {
  console.log('No vendor modules in packages/vendor-modules/: nothing to test.');
} else {
  let failed = false;
  for (const folder of vendors) {
    const hosts = declared.get(folder);
    if (hosts === undefined) {
      // docs.mjs (npm run check:docs) reports the missing declaration too; without one the module can't be tested.
      console.log(`FAILED - ${folder}: its sharedidEdge block must declare network: "none" or a list of hosts`);
      failed = true;
      continue;
    }
    // The preload appends each blocked attempt here: test runners ignore their workers' exit codes, and a module may
    // catch the error, so the log, not the test result, is what proves there was no network access.
    const log = join(mkdtempSync(join(tmpdir(), 'sid-network-')), 'attempts.log');
    const env = {
      ...process.env,
      SID_TEST_NETWORK: hosts.length === 0 ? 'none' : hosts.join(','),
      SID_TEST_NETWORK_LOG: log,
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} ${preload}`.trim()
    };
    const result = spawnSync(command, [...prefix, 'run', 'test', '--if-present', '-w', folder], { cwd: root, stdio: 'inherit', shell, env });
    const attempts = existsSync(log) ? [...new Set(readFileSync(log, 'utf8').split('\n').filter(line => line !== ''))] : [];
    rmSync(dirname(log), { recursive: true, force: true });
    const declaredText = hosts.length === 0 ? 'network "none"' : `network [${hosts.join(', ')}]`;
    if (attempts.length > 0) console.log(`  ${folder} reached the network outside its declaration (${declaredText}):\n${attempts.map(a => `    - ${a}`).join('\n')}`);
    const ok = result.status === 0 && attempts.length === 0;
    console.log(`${ok ? 'ok' : 'FAILED'} - ${folder} (${declaredText})`);
    if (!ok) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
