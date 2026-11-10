// Checks every relative link in the repo's Markdown files: the target file or folder exists, and a `#fragment` names
// a heading in the target (GitHub's anchor rules). Links to other sites aren't fetched. Fenced code blocks and inline
// code are skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { root } from './projects.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.tsbuild', '.wrangler', '.git', 'deploy', 'test-results', 'playwright-report', 'coverage']);

function markdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...markdownFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.md')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

/** The lines outside fenced code blocks, with inline code removed. */
function prose(text) {
  const lines = [];
  let fence;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker !== null) {
      if (fence === undefined) fence = marker[1];
      else if (marker[1].startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence === undefined) lines.push({ number: index + 1, text: line.replace(/(`+)[^`]*?\1/g, '') });
  }
  return lines;
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, `-1`, `-2` … for repeats. */
const anchorCache = new Map();
function anchors(file) {
  let set = anchorCache.get(file);
  if (set !== undefined) return set;
  set = new Set();
  const counts = new Map();
  let fence;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker !== null) {
      if (fence === undefined) fence = marker[1];
      else if (marker[1].startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    for (const match of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(match[1]);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const base = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    set.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }
  anchorCache.set(file, set);
  return set;
}

const problems = [];
let checked = 0;
const files = markdownFiles(root);
for (const file of files) {
  for (const { number, text } of prose(readFileSync(file, 'utf8'))) {
    const targets = [
      ...Array.from(text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), m => m[1]),
      ...Array.from(text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/g), m => m[1])
    ];
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto: …
      checked++;
      const where = `${relative(root, file).split(sep).join('/')}:${String(number)}`;
      const [pathPart, fragment] = target.split('#', 2);
      const path = decodeURIComponent(pathPart ?? '');
      const resolved = path === '' ? file : path.startsWith('/') ? join(root, path) : resolve(dirname(file), path);
      if (!existsSync(resolved)) {
        problems.push(`${where}: ${target}: no such file or folder`);
        continue;
      }
      if (fragment !== undefined && fragment !== '' && statSync(resolved).isFile() && resolved.endsWith('.md')) {
        if (!anchors(resolved).has(decodeURIComponent(fragment).toLowerCase())) problems.push(`${where}: ${target}: no heading #${fragment}`);
      }
    }
  }
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) {
  console.error(`${String(problems.length)} broken links`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${String(checked)} relative links in ${String(files.length)} Markdown files resolve`);
}
