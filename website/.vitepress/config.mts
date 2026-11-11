// sharedid.dev: the repository's Markdown, published as it is. Nothing is copied: VitePress reads the files where they
// live (srcDir is the repository root), and `pages` below maps each published file to its URL.
//
// Relative links are written for GitHub, between files in the repository. The `repoLinks` plugin turns each one into
// a site URL when it points at a published page, and into a GitHub URL otherwise (source files, AGENTS.md, folders),
// so the same Markdown works on GitHub, on npm and here.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defineConfig, type DefaultTheme } from 'vitepress';

const ROOT = resolve(import.meta.dirname, '..', '..');
const REPO = 'https://github.com/patmmccann/sharedid-edge';
const BRANCH = 'main';

interface Meta {
  kind?: string;
  platform?: string;
  name?: string;
  title?: string;
}

const posix = (path: string): string => path.split(sep).join('/');

function packageMeta(dir: string): Meta {
  const file = join(ROOT, dir, 'package.json');
  if (!existsSync(file)) return {};
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { sharedidEdge?: Meta };
  return pkg.sharedidEdge ?? {};
}

function subfolders(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(ROOT, dir, entry.name, 'README.md')))
    .map(entry => entry.name)
    .sort();
}

function firstHeading(file: string): string {
  const match = /^# (.+)$/m.exec(readFileSync(join(ROOT, file), 'utf8'));
  return (match?.[1] ?? file).replaceAll('`', '');
}

// Every published file: repository path -> page path (VitePress `rewrites`).
const pages: Record<string, string> = { 'README.md': 'index.md' };
for (const file of readdirSync(join(ROOT, 'docs')).filter(f => f.endsWith('.md'))) pages[`docs/${file}`] = `docs/${file}`;
pages['spec/SPEC.md'] = 'spec/index.md';
for (const file of readdirSync(join(ROOT, 'spec', 'modules')).filter(f => f.endsWith('.md'))) pages[`spec/modules/${file}`] = `spec/modules/${file}`;
pages['packages/core/README.md'] = 'core.md';
const adapters = subfolders('packages/adapters');
for (const name of adapters) pages[`packages/adapters/${name}/README.md`] = `adapters/${name}.md`;
const modules = subfolders('packages/modules');
for (const name of modules) pages[`packages/modules/${name}/README.md`] = `modules/${name}.md`;
pages['packages/vendor-modules/README.md'] = 'vendor-modules.md';
if (existsSync(join(ROOT, 'packages/adapters/vercel/example/README.md'))) pages['packages/adapters/vercel/example/README.md'] = 'adapters/vercel-example.md';

/** Every Markdown file in the repository that isn't in `pages` (skipping dependencies and build output). */
function unpublished(dir = ''): string[] {
  const skip = new Set(['node_modules', '.git', 'dist', 'website', '.wrangler', 'test-results', 'playwright-report']);
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : unpublished(path);
    return entry.name.endsWith('.md') && pages[path] === undefined ? [path] : [];
  });
}

/** The site URL of a published page, by repository path. */
function pageUrl(repoPath: string): string | undefined {
  const page = pages[repoPath];
  if (page === undefined) return undefined;
  return '/' + page.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
}

/** Where a relative link in `fromFile` (a repository path) should go on the site. */
function resolveLink(fromFile: string, href: string): string {
  const hashAt = href.indexOf('#');
  const path = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  if (path === '') return href;
  const target = posix(relative(ROOT, resolve(ROOT, dirname(fromFile), decodeURI(path))));
  if (target.startsWith('..')) return href;
  const direct = pageUrl(target);
  if (direct !== undefined) return direct + hash;
  const full = join(ROOT, target);
  const isDir = existsSync(full) && statSync(full).isDirectory();
  if (isDir) {
    const readme = pageUrl(posix(join(target, 'README.md')));
    if (readme !== undefined) return readme + hash;
  }
  return `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${target}${hash}`;
}

const adapterItems: DefaultTheme.SidebarItem[] = adapters
  .filter(name => packageMeta(`packages/adapters/${name}`).kind === 'adapter')
  .map(name => ({ text: packageMeta(`packages/adapters/${name}`).platform ?? name, link: pageUrl(`packages/adapters/${name}/README.md`) }));
const moduleItems: DefaultTheme.SidebarItem[] = modules
  .filter(name => packageMeta(`packages/modules/${name}`).kind === 'module')
  .map(name => ({ text: `${name}: ${packageMeta(`packages/modules/${name}`).title ?? ''}`, link: pageUrl(`packages/modules/${name}/README.md`) }));
const docItems: DefaultTheme.SidebarItem[] = Object.keys(pages)
  .filter(path => path.startsWith('docs/'))
  .map(path => ({ text: firstHeading(path), link: pageUrl(path) }));
const specItems: DefaultTheme.SidebarItem[] = [
  { text: 'Specification', link: '/spec/' },
  ...Object.keys(pages).filter(path => path.startsWith('spec/modules/')).map(path => ({ text: firstHeading(path), link: pageUrl(path) }))
];

export default defineConfig({
  title: 'SharedID Edge',
  description: 'A durable Prebid SharedID, set as a first-party cookie from your own domain\'s CDN edge.',
  srcDir: ROOT,
  rewrites: pages,
  // Only the pages above. Everything else in the repository (AGENTS.md, CLAUDE.md, e2e, node_modules) stays out.
  srcExclude: ['**/node_modules/**', '**/dist/**', 'website/**', ...unpublished()],
  cleanUrls: true,
  lastUpdated: false,
  // The pages live outside website/, so Vite would look for Vue in the repository's node_modules, which doesn't have
  // it: resolve it from website/node_modules.
  vite: {
    // With the workspace installed, Vite bundles Vue's compiler into the server build, and its require('estree-walker')
    // needs bundling too: estree-walker has no default export to import at run time.
    ssr: { noExternal: ['estree-walker'] },
    resolve: {
      alias: [{ find: /^vue($|\/)/, replacement: posix(join(import.meta.dirname, '..', 'node_modules', 'vue')) + '$1' }]
    }
  },
  markdown: {
    config(md) {
      const render = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env: { path?: string; realPath?: string }, self) => {
        const token = tokens[idx];
        const href = token?.attrGet('href');
        if (token !== undefined && href != null && (env.realPath ?? env.path) !== undefined && !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) {
          const resolved = resolveLink(posix(relative(ROOT, env.realPath ?? env.path ?? '')), href);
          token.attrSet('href', resolved);
          if (resolved.startsWith('http')) token.attrSet('target', '_blank');
        }
        return render(tokens, idx, options, env, self);
      };
    }
  },
  themeConfig: {
    nav: [
      { text: 'Platforms', link: adapterItems[0]?.link ?? '/' },
      { text: 'Modules', link: '/docs/modules' },
      { text: 'Prebid.js', link: '/docs/prebid' },
      { text: 'Specification', link: '/spec/' }
    ],
    sidebar: [
      { text: 'Introduction', items: [{ text: 'SharedID Edge', link: '/' }] },
      { text: 'Deploy', items: adapterItems },
      { text: 'Guides', items: docItems },
      { text: 'Modules', collapsed: true, items: moduleItems },
      { text: 'Specification', collapsed: true, items: specItems },
      { text: 'Packages', collapsed: true, items: [{ text: '@sharedid-edge/core', link: '/core' }, { text: 'Vendor modules', link: '/vendor-modules' }] }
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: [2, 3],
    editLink: {
      // Serialized into the browser bundle, so it can't use the constants above.
      pattern: ({ filePath }) => `https://github.com/patmmccann/sharedid-edge/edit/main/${filePath}`,
      text: 'Edit this page on GitHub'
    }
  }
});
