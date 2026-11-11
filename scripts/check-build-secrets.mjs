// Fails a bundle that contains a vendor module's build-time credential. A licence key a module's build uses to fetch
// its data (buildCredentials in its sharedidEdge block) must never ship: a Worker's code is readable by everyone on
// the account, and a Snippet's by anyone who can see the zone's rules. checkBudget (scripts/bundle-adapter.mjs) runs
// this on every bundle; run it yourself on anything else you deploy:
//
//   node scripts/check-build-secrets.mjs <file> [<file> …]
//
// For each credential named by a vendor module and set in the environment, it looks for the value as is, and
// base64-, base64url-, hex- and URI-encoded. It never prints the value.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { buildCredentialNames } from './vendor-modules.mjs';

/** Shorter values are too likely to match by chance, and too short to be a real key. */
const MIN_LENGTH = 8;

/** The forms a value could take in a bundle. */
function encodings(value) {
  const bytes = Buffer.from(value, 'utf8');
  return [value, bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex'), encodeURIComponent(value)];
}

/**
 * Logs and returns the names of the credentials found in `file`, and sets a failing exit code when there are any.
 *
 * @param {string} file
 * @param {{ from?: string, env?: Record<string, string | undefined>, names?: string[] }} [options] `names` and `env`
 *   default to every vendor module's `buildCredentials` and `process.env`
 * @returns {string[]}
 */
export function checkBuildSecrets(file, { from = process.cwd(), env = process.env, names = buildCredentialNames() } = {}) {
  const text = readFileSync(file, 'latin1');
  const found = names.filter(name => {
    const value = env[name];
    return value !== undefined && value.length >= MIN_LENGTH && encodings(value).some(form => text.includes(form));
  });
  if (found.length > 0) {
    console.error(`${relative(from, file).replaceAll('\\', '/')} contains the build-time credential ${found.join(', ')}. A licence key is for fetching data at build time and must not ship in the bundle: anyone who can read the deployed code can read it. Fix the module's build so the key stays out of its output.`);
    process.exitCode = 1;
  }
  return found;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/check-build-secrets.mjs <file> [<file> …]');
    process.exitCode = 2;
  }
  const names = buildCredentialNames();
  for (const file of files) {
    if (checkBuildSecrets(file, { names }).length === 0) console.log(`ok - ${file}: no build-time credentials (${names.length === 0 ? 'no vendor module declares any' : names.join(', ')})`);
  }
}
