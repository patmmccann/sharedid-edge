// Checks the built site (.vitepress/dist) for links to a heading that isn't there: every href to a page on the site
// with a #fragment, including same-page links, must name an id on that page. VitePress's dead-link check covers
// pages, not fragments; a fragment that misses lands at the top of the page.
//
//   node check-anchors.mjs      (after npm run build)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = join(import.meta.dirname, '.vitepress', 'dist');

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'assets' ? [] : htmlFiles(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

/** The site URL path a built file answers (clean URLs: docs/prebid.html is /docs/prebid, spec/index.html is /spec/). */
function urlPath(file) {
  const path = '/' + relative(DIST, file).split(sep).join('/');
  return path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path.slice(0, -'.html'.length);
}

const ids = new Map();
const pages = htmlFiles(DIST);
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  ids.set(urlPath(file), new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => decodeURIComponent(m[1]))));
}

const problems = [];
for (const file of pages) {
  const from = urlPath(file);
  // Only the page content: the sidebar and outline links are generated from the same headings.
  const content = /<main[\s\S]*<\/main>/.exec(readFileSync(file, 'utf8'))?.[0] ?? '';
  for (const [, href] of content.matchAll(/\shref="([^"]*#[^"]*)"/g)) {
    if (/^[a-z]+:/i.test(href)) continue;
    const [path, fragment] = href.split('#', 2);
    if (fragment === undefined || fragment === '') continue;
    const target = path === '' ? from : path.replace(/\.html$/, '');
    const targetIds = ids.get(target) ?? ids.get(target.endsWith('/') ? target : `${target}/`);
    if (targetIds === undefined) continue; // not a built page (VitePress's dead-link check covers pages)
    if (!targetIds.has(decodeURIComponent(fragment))) problems.push(`${from}: ${href}: no heading #${fragment}`);
  }
}

if (!existsSync(DIST)) {
  console.error('No build in .vitepress/dist: run npm run build first.');
  process.exit(2);
}
for (const problem of problems) console.error(problem);
console.log(problems.length === 0 ? `ok - every #fragment link on ${String(pages.length)} pages names a heading` : `${String(problems.length)} link(s) to a missing heading`);
process.exitCode = problems.length === 0 ? 0 : 1;
