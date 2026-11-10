import { parseArgs } from 'node:util';
import { loadCaseFiles, type CaseFile } from './cases.js';
import { runCase, type HeaderAdapter } from './check.js';
import { startTarget, type TargetName } from './targets.js';

const USAGE = `Usage:
  conformance --target node|wrangler|lambda|vercel|azure  start each configuration locally and run every case
  conformance --base-url https://...                       run the default-configuration cases against a deployment`;

interface FileResult {
  readonly failed: number;
  /** Cases that failed as a known platform limitation of the target. */
  readonly limited: number;
}

/** What a target can't do: payload paths it has no data for, and cases it can't pass (see `RunningTarget`). */
interface TargetGaps {
  readonly unavailable: readonly string[];
  readonly limitations: Readonly<Record<string, string>>;
}

const NO_GAPS: TargetGaps = { unavailable: [], limitations: {} };

/**
 * Runs a file's cases. A case in `limitations` (the target's known platform limitations, by `file#case name`) is
 * reported as TAP `# TODO` and doesn't count as a failure when it fails; when it passes, it does count, so the list
 * can't go stale.
 */
async function runFile(baseUrl: string, file: CaseFile, adaptHeaders?: HeaderAdapter, gaps: TargetGaps = NO_GAPS): Promise<FileResult> {
  let failed = 0;
  let limited = 0;
  console.log(`# ${file.file}: ${file.description}`);
  for (const testCase of file.cases) {
    const failures = await runCase(baseUrl, testCase, adaptHeaders, gaps.unavailable);
    const limitation = gaps.limitations[`${file.file}#${testCase.name}`];
    if (failures.length === 0 && limitation === undefined) {
      console.log(`ok - ${testCase.name}`);
    } else if (failures.length === 0) {
      failed++;
      console.log(`not ok - ${testCase.name}`);
      console.log('  # passes, but is listed as a known limitation of this target: remove it from src/targets.ts');
    } else if (limitation !== undefined) {
      limited++;
      console.log(`not ok - ${testCase.name} # TODO known platform limitation: ${limitation}`);
      for (const failure of failures) console.log(`  # ${failure}`);
    } else {
      failed++;
      console.log(`not ok - ${testCase.name}`);
      for (const failure of failures) console.log(`  # ${failure}`);
    }
  }
  return { failed, limited };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { target: { type: 'string' }, 'base-url': { type: 'string' } } });
  const files = await loadCaseFiles();
  let failed = 0;
  let limited = 0;
  let total = 0;

  if (values['base-url'] !== undefined) {
    // A deployment has one configuration; run the files that use the defaults.
    for (const file of files.filter(f => Object.keys(f.config).length === 0)) {
      total += file.cases.length;
      failed += (await runFile(values['base-url'], file)).failed;
    }
  } else if (values.target === 'node' || values.target === 'wrangler' || values.target === 'lambda' || values.target === 'vercel' || values.target === 'azure') {
    const target: TargetName = values.target;
    for (const file of files) {
      const running = await startTarget(target, file.config);
      try {
        total += file.cases.length;
        const result = await runFile(running.baseUrl, file, running.requestHeaders, running);
        failed += result.failed;
        limited += result.limited;
      } finally {
        await running.stop();
      }
    }
  } else {
    console.error(USAGE);
    return 2;
  }

  const known = limited === 0 ? '' : `, and ${String(limited)} failed as known platform limitations (TODO)`;
  console.log(`\n${String(total - failed - limited)}/${String(total)} cases passed${known}`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
