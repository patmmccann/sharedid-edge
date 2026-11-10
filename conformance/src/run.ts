import { parseArgs } from 'node:util';
import { loadCaseFiles, type CaseFile } from './cases.js';
import { runCase } from './check.js';
import { startTarget, type TargetName } from './targets.js';

const USAGE = `Usage:
  conformance --target node|wrangler|lambda  start each configuration locally and run every case
  conformance --base-url https://...          run the default-configuration cases against a deployment`;

async function runFile(baseUrl: string, file: CaseFile): Promise<number> {
  let failed = 0;
  console.log(`# ${file.file}: ${file.description}`);
  for (const testCase of file.cases) {
    const failures = await runCase(baseUrl, testCase);
    if (failures.length === 0) {
      console.log(`ok - ${testCase.name}`);
    } else {
      failed++;
      console.log(`not ok - ${testCase.name}`);
      for (const failure of failures) console.log(`  # ${failure}`);
    }
  }
  return failed;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { target: { type: 'string' }, 'base-url': { type: 'string' } } });
  const files = await loadCaseFiles();
  let failed = 0;
  let total = 0;

  if (values['base-url'] !== undefined) {
    // A deployment has one configuration; run the files that use the defaults.
    for (const file of files.filter(f => Object.keys(f.config).length === 0)) {
      total += file.cases.length;
      failed += await runFile(values['base-url'], file);
    }
  } else if (values.target === 'node' || values.target === 'wrangler' || values.target === 'lambda') {
    const target: TargetName = values.target;
    for (const file of files) {
      const running = await startTarget(target, file.config);
      try {
        total += file.cases.length;
        failed += await runFile(running.baseUrl, file);
      } finally {
        await running.stop();
      }
    }
  } else {
    console.error(USAGE);
    return 2;
  }

  console.log(`\n${String(total - failed)}/${String(total)} cases passed`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
