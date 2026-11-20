// scripts/live-issue.mjs against a mocked `gh`: which runs open, comment on, close or leave the live tests' issue.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { outcome, report } from '../live-issue.mjs';

const TITLE = 'Live Cloudflare tests are failing';
const BOT = { login: 'app/github-actions' };
const RUN_URL = 'https://github.com/owner/repo/actions/runs/42';
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** A report job's `toJSON(needs)`. */
const needs = (results) => JSON.stringify(Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { result, outputs: {} }])));
const PASSED = needs({ deploy: 'success', browsers: 'success' });
const DEPLOY_FAILED = needs({ deploy: 'failure', browsers: 'skipped' });

function env(overrides) {
  return {
    NEEDS: PASSED,
    REQUIRED: 'deploy browsers',
    TITLE,
    SUMMARY: 'The live tests on sharedid.dev failed',
    EVENT_NAME: 'push',
    REF: 'refs/heads/main',
    SHA,
    RUN_URL,
    RUN_ATTEMPT: '1',
    ...overrides
  };
}

/** A `gh` that lists `issues` and records every other command. */
function mockGh(issues) {
  const calls = [];
  const gh = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      assert.deepEqual(args.slice(2, 6), ['--state', 'open', '--search', `"${TITLE}" in:title`]);
      return JSON.stringify(issues);
    }
    calls.push(args);
    return '';
  };
  return { gh, calls };
}

const OPEN = [{ number: 161, title: TITLE, author: BOT }];

describe('outcome', () => {
  const cloudflare = ['deploy', 'browsers'];
  const upstream = ['config', 'cloudflare', 'browsers'];
  const of = (results, required) => outcome(JSON.parse(needs(results)), required);

  it('fails when any needed job failed', () => {
    assert.equal(of({ deploy: 'success', browsers: 'failure' }, cloudflare), 'failure');
    assert.equal(of({ config: 'success', cloudflare: 'success', cloudfront: 'failure', browsers: 'success' }, upstream), 'failure');
  });

  it('passes when the required jobs passed and the optional ones passed or were skipped', () => {
    assert.equal(of({ deploy: 'success', browsers: 'success' }, cloudflare), 'success');
    assert.equal(of({ config: 'success', cloudflare: 'success', cloudfront: 'skipped', browsers: 'success' }, upstream), 'success');
  });

  it('is neither when a required job was skipped or a job was cancelled', () => {
    // AWS without AWS_E2E_ROLE_ARN: deploy, and so browsers, skipped. Nothing was tested.
    assert.equal(of({ deploy: 'skipped', browsers: 'skipped' }, cloudflare), 'none');
    assert.equal(of({ config: 'success', cloudflare: 'skipped', cloudfront: 'skipped', browsers: 'skipped' }, upstream), 'none');
    assert.equal(of({ deploy: 'success', browsers: 'cancelled' }, cloudflare), 'none');
  });

  it('rejects a required job the report job does not need', () => {
    assert.throws(() => of({ deploy: 'success' }, cloudflare), /browsers/);
  });
});

describe('report', () => {
  it('opens the issue on a failing run when none is open', () => {
    const { gh, calls } = mockGh([]);
    report(env({ NEEDS: needs({ deploy: 'success', browsers: 'failure' }) }), gh);
    assert.deepEqual(calls, [['issue', 'create', '--title', TITLE, '--body', `The live tests on sharedid.dev failed (after ${SHA}): ${RUN_URL}`]]);
  });

  it('comments on the open issue on a failing nightly run', () => {
    const { gh, calls } = mockGh(OPEN);
    report(env({ NEEDS: DEPLOY_FAILED, EVENT_NAME: 'schedule' }), gh);
    assert.deepEqual(calls, [['issue', 'comment', '161', '--body', `Still failing (nightly): ${RUN_URL}`]]);
  });

  it('says when a browser job failed on an apt outage', () => {
    // #197, #200: WebKit couldn't install its system packages. Matrix jobs share one set of outputs.
    const failed = JSON.stringify({
      deploy: { result: 'success', outputs: {} },
      browsers: { result: 'failure', outputs: { infrastructure: 'apt outage (webkit is missing libevent-2.1.so.7)' } }
    });
    const note = "\n\nInfrastructure: apt outage (webkit is missing libevent-2.1.so.7), not a regression. A browser job couldn't install its system packages from the Ubuntu mirrors; re-run the failed jobs once they're back. Other jobs' failures, if any, are in the run.";
    const opened = mockGh([]);
    report(env({ NEEDS: failed }), opened.gh);
    assert.deepEqual(opened.calls, [['issue', 'create', '--title', TITLE, '--body', `The live tests on sharedid.dev failed (after ${SHA}): ${RUN_URL}${note}`]]);
    const commented = mockGh(OPEN);
    report(env({ NEEDS: failed, EVENT_NAME: 'schedule' }), commented.gh);
    assert.deepEqual(commented.calls, [['issue', 'comment', '161', '--body', `Still failing (nightly): ${RUN_URL}${note}`]]);
  });

  it('reports nothing for a failing on-demand run', () => {
    const { gh, calls } = mockGh(OPEN);
    report(env({ NEEDS: DEPLOY_FAILED, EVENT_NAME: 'workflow_dispatch' }), gh);
    assert.deepEqual(calls, []);
  });

  it('closes the open issue as completed on a passing run, with a comment', () => {
    const { gh, calls } = mockGh(OPEN);
    assert.equal(report(env({}), gh), 'Passed: closed #161.');
    assert.deepEqual(calls, [['issue', 'close', '161', '--reason', 'completed', '--comment', `Recovered: run ${RUN_URL} (0123456) passed.`]]);
  });

  it('closes it when a re-run of the failed jobs passes, naming the attempt', () => {
    // #161: WebKit failed on attempt 1. The re-run's report job sees attempt 1's deploy and attempt 2's browsers.
    const { gh, calls } = mockGh(OPEN);
    report(env({ RUN_ATTEMPT: '2' }), gh);
    assert.deepEqual(calls, [['issue', 'close', '161', '--reason', 'completed', '--comment', `Recovered: run ${RUN_URL} (0123456, attempt 2) passed.`]]);
  });

  it('closes it on a passing on-demand run on main', () => {
    const { gh, calls } = mockGh(OPEN);
    report(env({ EVENT_NAME: 'workflow_dispatch' }), gh);
    assert.deepEqual(calls.map((args) => args.slice(0, 3)), [['issue', 'close', '161']]);
  });

  it('closes only issues with the exact title that the workflows opened', () => {
    const { gh, calls } = mockGh([
      { number: 7, title: TITLE, author: { login: 'someone' } },
      { number: 8, title: `${TITLE} again`, author: BOT },
      { number: 9, title: 'Live AWS tests are failing', author: BOT },
      { number: 12, title: TITLE, author: { login: 'github-actions[bot]' } },
      { number: 10, title: TITLE, author: BOT }
    ]);
    assert.equal(report(env({}), gh), 'Passed: closed #10, #12.');
    assert.deepEqual(calls.map((args) => args[2]), ['10', '12']);
  });

  it('does nothing on a passing run with no open issue', () => {
    const { gh, calls } = mockGh([]);
    assert.equal(report(env({}), gh), 'Passed: no open issue.');
    assert.deepEqual(calls, []);
  });

  it('leaves the issue alone off main, or when nothing was tested', () => {
    for (const overrides of [
      { REF: 'refs/heads/feature' },
      { REF: 'refs/heads/feature', NEEDS: DEPLOY_FAILED },
      { NEEDS: needs({ deploy: 'skipped', browsers: 'skipped' }) }
    ]) {
      const { gh, calls } = mockGh(OPEN);
      report(env(overrides), gh);
      assert.deepEqual(calls, [], JSON.stringify(overrides));
    }
  });
});

describe('the command', () => {
  it('reads its settings from the environment', () => {
    // Off main it calls no `gh` at all, so none is needed on PATH.
    const script = fileURLToPath(new URL('../live-issue.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, ...env({ REF: 'refs/heads/feature' }) }
    });
    assert.equal(out.trim(), 'Not on main (refs/heads/feature): the issue is left as it is.');
  });

  it('refuses to run without its settings', () => {
    const script = fileURLToPath(new URL('../live-issue.mjs', import.meta.url));
    assert.throws(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env({ TITLE: '' }) } }), /Set TITLE/);
  });
});
