// Checks @sharedid-edge/core's published types the way a consumer sees them: packs the package as npm would, installs
// the tarball into a throwaway project, and type-checks a strict consumer for each module resolution and each
// TypeScript version we support. Catches declarations that only work inside this repo.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const compilers = {
  'TypeScript 6.0': join(root, 'node_modules/typescript/bin/tsc'),
  'TypeScript 7': join(root, 'node_modules/typescript7/bin/tsc')
};
const resolutions = [
  { name: 'bundler', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'WebWorker'] },
  { name: 'node16', module: 'Node16', moduleResolution: 'Node16', lib: ['ES2023', 'DOM'] },
  { name: 'nodenext', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'] }
];

const work = mkdtempSync(join(tmpdir(), 'sharedid-edge-consumer-'));
let failed = false;
try {
  const packed = execFileSync(npm, ['pack', '--pack-destination', work, '--json'], {
    cwd: join(root, 'packages/core'),
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  const tarball = join(work, JSON.parse(packed)[0].filename);

  for (const resolution of resolutions) {
    const dir = join(work, resolution.name);
    cpSync(join(root, 'consumer-types/fixture'), dir, { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: resolution.module,
        moduleResolution: resolution.moduleResolution,
        lib: resolution.lib,
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        noEmit: true
      },
      include: ['consumer.ts']
    }, null, 2));
    execFileSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', tarball], {
      cwd: dir,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    for (const [label, tsc] of Object.entries(compilers)) {
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      const ok = result.status === 0;
      console.log(`${ok ? 'ok' : 'FAILED'} - ${label}, moduleResolution ${resolution.name}`);
      if (!ok) {
        failed = true;
        console.log(result.stdout + result.stderr);
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
