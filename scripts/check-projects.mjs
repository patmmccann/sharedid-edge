// Checks that the root tsconfig.json (the `tsc -b` solution) references exactly the projects derived from the
// workspace folders (see projects.mjs), so a new package can't be left out of the build, lint or TypeScript 7 check.
// `node scripts/check-projects.mjs --write` rewrites the references.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { projects, root } from './projects.mjs';

const file = join(root, 'tsconfig.json');
const text = readFileSync(file, 'utf8');
const expected = projects().filter(project => project.build).map(project => project.path);

if (process.argv.includes('--write')) {
  const lines = expected.map(path => `    { "path": "${path}" }`).join(',\n');
  writeFileSync(file, text.replace(/"references": \[[\s\S]*?\n {2}\]/, `"references": [\n${lines}\n  ]`));
  console.log(`tsconfig.json: wrote ${String(expected.length)} references`);
} else {
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const actual = (config.references ?? []).map(reference => reference.path);
  const missing = expected.filter(path => !actual.includes(path));
  const extra = actual.filter(path => !expected.includes(path));
  for (const path of missing) console.error(`tsconfig.json: missing reference to ${path}`);
  for (const path of extra) console.error(`tsconfig.json: reference to ${path}, which isn't a workspace project`);
  if (missing.length + extra.length > 0) {
    console.error('Run `node scripts/check-projects.mjs --write` to fix.');
    process.exitCode = 1;
  } else {
    console.log(`ok - tsconfig.json references all ${String(expected.length)} buildable projects`);
  }
}
