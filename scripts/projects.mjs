// The TypeScript projects in the repo, derived from the root package.json `workspaces` (globs included), so a new
// package is picked up without editing lists. Used by typecheck-ts7.mjs and check-projects.mjs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const root = join(import.meta.dirname, '..');

/** Projects that aren't workspaces. */
const EXTRA_PROJECTS = ['scripts'];

/** Workspace folders, relative to the root and with `/` separators, in package.json order. */
export function workspaceFolders() {
  const { workspaces } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const folders = [];
  for (const pattern of workspaces) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      const children = readdirSync(join(root, parent), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')))
        .map(entry => `${parent}/${entry.name}`)
        .sort();
      folders.push(...children);
    } else if (pattern.includes('*')) {
      throw new Error(`Unsupported workspace pattern ${pattern}: use a folder or folder/*`);
    } else {
      folders.push(pattern);
    }
  }
  return folders;
}

function readTsconfig(project) {
  const file = join(root, project, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return config;
}

/**
 * Every TypeScript project (a folder with a tsconfig.json): each workspace, its `test/` project, and `scripts`.
 * `build` is false for projects that `tsc -b` can't build because they don't emit (`composite: false`, such as the
 * Cloudflare Worker, which is checked against the Workers runtime types by its own `typecheck` script).
 */
export function projects() {
  const result = [];
  for (const folder of [...workspaceFolders(), ...EXTRA_PROJECTS]) {
    for (const project of [folder, `${folder}/test`]) {
      if (!existsSync(join(root, project, 'tsconfig.json'))) continue;
      result.push({ path: project, build: readTsconfig(project).compilerOptions?.composite !== false });
    }
  }
  // A test project of a non-composite package inherits its settings.
  for (const project of result) {
    if (project.path.endsWith('/test') && result.some(p => p.path === project.path.slice(0, -5) && !p.build)) project.build = false;
  }
  return result;
}
