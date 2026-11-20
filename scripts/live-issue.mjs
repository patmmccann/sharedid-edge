// The live test workflows' issue: a failing run on main opens it, or comments on the open one; a passing run closes
// it. Run by .github/actions/live-issue (each live workflow's report job), with the GITHUB_TOKEN and `gh`:
//
//   NEEDS     the report job's `toJSON(needs)`: each test job's result, and its `infrastructure` output, which a browser
//             job sets when its install failed on an apt outage (.github/actions/install-browser)
//   REQUIRED  the jobs, by id, that must have passed for the run to count as passing (space-separated); the other
//             needed jobs may also have been skipped, as optional parts that aren't set up are
//   TITLE     the issue's title, which identifies it with its author, github-actions[bot]
//   SUMMARY   the new issue's first words, before " (<event>): <run URL>"
//   EVENT_NAME, REF, SHA, RUN_URL, RUN_ATTEMPT  from the github context
//
// `--dry-run` prints the `gh` commands that change something instead of running them.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAIN = 'refs/heads/main';
// How `gh` names the author of issues opened with the GITHUB_TOKEN, and the REST API's name for it.
const BOT_LOGINS = new Set(['app/github-actions', 'github-actions[bot]']);

/**
 * How the run went: `failure` when a needed job failed, `success` when the required jobs passed and every other
 * needed job passed or was skipped, `none` otherwise (cancelled, or the required jobs skipped: nothing was tested).
 */
export function outcome(needs, required) {
  const results = Object.entries(needs).map(([id, job]) => [id, job.result]);
  if (results.some(([, result]) => result === 'failure')) return 'failure';
  for (const id of required) {
    if (needs[id] === undefined) throw new Error(`REQUIRED names ${id}, which isn't in the report job's needs`);
  }
  const passed = results.every(([id, result]) => result === 'success' || (result === 'skipped' && !required.includes(id)));
  return passed ? 'success' : 'none';
}

/**
 * Why the run failed outside the code under test: each needed job's `infrastructure` output, such as "apt outage
 * (webkit is missing libevent-2.1.so.7)", without repeats. Empty when no job set one.
 */
export function infrastructure(needs) {
  const reasons = Object.values(needs).map((job) => job.outputs?.infrastructure ?? '');
  return [...new Set(reasons.filter((reason) => reason !== ''))];
}

/** The open issues with this title that the workflows opened, oldest first. */
export function openIssues(gh, title) {
  const listed = JSON.parse(gh(['issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title,author', '--limit', '100']));
  return listed
    .filter((issue) => issue.title === title && BOT_LOGINS.has(issue.author.login))
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

/** Opens, comments on or closes the issue for this run. Returns what it did, for the log. */
export function report(env, gh) {
  if (env.REF !== MAIN) return `Not on main (${env.REF}): the issue is left as it is.`;
  const required = env.REQUIRED.split(/\s+/).filter((id) => id !== '');
  const result = outcome(JSON.parse(env.NEEDS), required);
  const attempt = env.RUN_ATTEMPT !== '' && env.RUN_ATTEMPT !== '1' ? `, attempt ${env.RUN_ATTEMPT}` : '';
  switch (result) {
    case 'failure': {
      // On-demand runs are someone watching; only merges and the nightly run report.
      if (env.EVENT_NAME === 'workflow_dispatch') return 'Failed on demand: no issue.';
      const event = env.EVENT_NAME === 'push' ? `after ${env.SHA}` : 'nightly';
      // So an apt outage isn't taken for a regression.
      const reasons = infrastructure(JSON.parse(env.NEEDS));
      const note = reasons.length === 0
        ? ''
        : `\n\nInfrastructure: ${reasons.join('; ')}, not a regression. A browser job couldn't install its system packages from the Ubuntu mirrors; re-run the failed jobs once they're back. Other jobs' failures, if any, are in the run.`;
      const [number] = openIssues(gh, env.TITLE);
      if (number === undefined) {
        gh(['issue', 'create', '--title', env.TITLE, '--body', `${env.SUMMARY} (${event}${attempt}): ${env.RUN_URL}${note}`]);
        return `Failed: opened "${env.TITLE}".`;
      }
      gh(['issue', 'comment', String(number), '--body', `Still failing (${event}${attempt}): ${env.RUN_URL}${note}`]);
      return `Failed: commented on #${number}.`;
    }
    case 'success': {
      const numbers = openIssues(gh, env.TITLE);
      for (const number of numbers) {
        const body = `Recovered: run ${env.RUN_URL} (${env.SHA.slice(0, 7)}${attempt}) passed.`;
        gh(['issue', 'close', String(number), '--reason', 'completed', '--comment', body]);
      }
      return numbers.length === 0 ? 'Passed: no open issue.' : `Passed: closed ${numbers.map((n) => `#${n}`).join(', ')}.`;
    }
    case 'none':
      return 'Neither passed nor failed (cancelled, or nothing was tested): the issue is left as it is.';
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = {};
  for (const name of ['NEEDS', 'REQUIRED', 'TITLE', 'SUMMARY', 'EVENT_NAME', 'REF', 'SHA', 'RUN_URL', 'RUN_ATTEMPT']) {
    const value = process.env[name];
    if (value === undefined || value === '') throw new Error(`Set ${name}.`);
    env[name] = value;
  }
  const gh = (args) => {
    if (dryRun && args[1] !== 'list') {
      console.log(`[dry run] gh ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
      return '';
    }
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  };
  console.log(report(env, gh));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
