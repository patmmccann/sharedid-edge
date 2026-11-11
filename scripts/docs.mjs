// Generates the doc sections that every new module or adapter would otherwise edit by hand, so pull requests don't
// collide on shared tables. Each section sits between `<!-- generated:<name>:start -->` and
// `<!-- generated:<name>:end -->` markers. Sources:
//
// - the `sharedidEdge` block in each adapter's and module's package.json (the platform table and module lists);
// - `SETTINGS` in packages/core/src/config.ts (the configuration reference);
// - the files in spec/modules/ (the spec's list of module specifications).
//
// `node scripts/docs.mjs` checks that every section is up to date (`npm run check:docs`); `--write` rewrites them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { root, workspaceFolders } from './projects.mjs';

const ROUTES = ['v1', 'sync'];
const problems = [];

/** Every adapter and module package with its `sharedidEdge` metadata, validated. */
function packages() {
  const result = [];
  for (const folder of workspaceFolders()) {
    const group = /^packages\/(adapters|modules|vendor-modules)\/([^/]+)$/.exec(folder);
    if (group === null) continue;
    const [, parent, dir] = group;
    const pkg = JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8'));
    const meta = pkg.sharedidEdge;
    const where = `${folder}/package.json`;
    if (typeof meta !== 'object' || meta === null) {
      problems.push(`${where}: no "sharedidEdge" block (see docs/development.md#package-metadata)`);
      continue;
    }
    const expectedKinds = parent === 'adapters' ? ['adapter'] : ['module', 'module-list'];
    if (!expectedKinds.includes(meta.kind)) {
      problems.push(`${where}: sharedidEdge.kind must be ${expectedKinds.join(' or ')}`);
      continue;
    }
    const required = { adapter: ['platform', 'summary'], module: ['name', 'title', 'summary', 'settings'], 'module-list': [] }[meta.kind];
    const missing = required.filter(key => typeof meta[key] !== 'string' || meta[key].trim() === '');
    if (missing.length > 0) problems.push(`${where}: sharedidEdge needs ${missing.join(', ')}`);
    if (meta.kind === 'module') {
      if (meta.name !== dir) problems.push(`${where}: sharedidEdge.name must be the folder name, "${dir}"`);
      const routes = meta.routes;
      if (!Array.isArray(routes) || routes.length === 0 || routes.some(route => !ROUTES.includes(route)) || new Set(routes).size !== routes.length) {
        problems.push(`${where}: sharedidEdge.routes must be a non-empty list of ${ROUTES.join(' and ')}`);
      } else if (parent === 'modules') {
        const declared = declaredRoutes(join(root, folder, 'src'));
        if (declared.join() !== [...routes].sort().join()) problems.push(`${where}: sharedidEdge.routes is ${routes.join(', ')}, but the module's routes are ${declared.join(', ')}`);
      }
      if (meta.forwards !== undefined && (!Array.isArray(meta.forwards) || meta.forwards.some(host => typeof host !== 'string'))) {
        problems.push(`${where}: sharedidEdge.forwards must be a list of host names`);
      }
      if (meta.ipDerived !== undefined && typeof meta.ipDerived !== 'boolean') problems.push(`${where}: sharedidEdge.ipDerived must be true or false`);
      // IP-derived IDs are for vendor modules; ec, IAB Tech Lab's Trusted Server port, is held to the same rules.
      if (meta.ipDerived === true && parent === 'modules' && dir !== 'ec') problems.push(`${where}: a project module can't derive an ID from the IP address (see packages/vendor-modules/AGENTS.md#ip-derived-ids)`);
      if (parent === 'modules' && !existsSync(join(root, 'spec/modules', `${dir}.md`))) problems.push(`${where}: no specification in spec/modules/${dir}.md`);
    }
    if (meta.kind !== 'module-list' && !existsSync(join(root, folder, 'README.md'))) problems.push(`${folder}: no README.md`);
    result.push({ folder, parent, dir, meta });
  }
  return result;
}

/** The `routes` a module's `defineModule` call declares (read from its source), sorted; `v1` when it declares none. */
function declaredRoutes(src) {
  for (const file of readdirSync(src).filter(name => name.endsWith('.ts'))) {
    const match = /\broutes:\s*\[([^\]]*)\]/.exec(readFileSync(join(src, file), 'utf8'));
    if (match !== null) return Array.from(match[1].matchAll(/'([a-z0-9]+)'/g), m => m[1]).sort();
  }
  return ['v1'];
}

/** A relative link from one repo file to another repo path, with `/` separators. */
function link(fromFile, toPath) {
  return relative(dirname(join(root, fromFile)), join(root, toPath)).split(sep).join('/');
}

/** Text for a Markdown table cell: backslashes and pipes escaped, so neither ends the cell nor escapes the next character. */
const cell = text => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const codeList = items => items.map(item => `\`${item}\``).join(', ');

function platformTable(file, adapters) {
  const rows = [...adapters]
    .sort((a, b) => a.meta.platform.localeCompare(b.meta.platform))
    .map(({ folder, meta }) => `| [${cell(meta.platform)}](${link(file, `${folder}/README.md`)}) | ${cell(meta.summary)} |`);
  return ['| Platform | How it runs |', '| --- | --- |', ...rows].join('\n');
}

function moduleName({ parent, meta }) {
  const marks = [];
  if (parent === 'vendor-modules') marks.push('vendor module');
  if (meta.ipDerived === true) marks.push('⚠ IP-derived ID');
  if (Array.isArray(meta.forwards) && meta.forwards.length > 0) marks.push(`⚠ forwards data to ${codeList(meta.forwards)}`);
  return marks.length === 0 ? '' : ` (${marks.join('; ')})`;
}

function moduleList(file, modules) {
  return `${modules.map(m => `[\`${m.meta.name}\`](${link(file, `${m.folder}/README.md`)}): ${m.meta.title}${moduleName(m)}`).join('; ')}.`;
}

function moduleIndex(file, modules) {
  const rows = modules.map(m => {
    const spec = `spec/modules/${m.meta.name}.md`;
    const specLink = existsSync(join(root, spec)) ? `[spec](${link(file, spec)})` : '';
    const sync = m.meta.routes.includes('sync') ? 'yes' : 'no';
    return `| [\`${m.meta.name}\`](${link(file, `${m.folder}/README.md`)})${cell(moduleName(m))} | ${cell(m.meta.summary)} | ${cell(m.meta.settings)} | ${sync} | ${specLink} |`;
  });
  return ['| Name | Adds | Settings | On `/_sid/sync` | Specification |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

function settingsTable(settings) {
  const rows = settings.map(s => `| \`${s.name}\` | ${cell(s.default)} | ${cell(s.description)} |`);
  return ['| Variable | Default | Description |', '| --- | --- | --- |', ...rows].join('\n');
}

function specModules() {
  const dir = join(root, 'spec/modules');
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const heading = /^#\s+(.+)$/m.exec(readFileSync(join(dir, name), 'utf8'));
      if (heading === null) problems.push(`spec/modules/${name}: no heading`);
      return `- [${heading?.[1] ?? name}](modules/${name})`;
    })
    .join('\n');
}

function packageList(file, adapters, modules, lists) {
  const entries = items => items.map(({ folder, dir, label }) => `[\`${dir}/\`](${link(file, `${folder}/README.md`)}): ${label}`).join('; ');
  const vendor = modules.filter(m => m.parent === 'vendor-modules');
  return [
    `- **Adapters** (\`packages/adapters/\`): ${entries(adapters.map(a => ({ ...a, label: a.meta.platform })))}.`,
    `- **Modules** (\`packages/modules/\`): ${entries(modules.filter(m => m.parent === 'modules').map(m => ({ ...m, label: m.meta.title })))}; and ${entries(lists.map(l => ({ ...l, label: 'the built-in list' })))}.`,
    `- **Vendor modules** (\`packages/vendor-modules/\`): ${vendor.length > 0 ? entries(vendor.map(m => ({ ...m, label: m.meta.title }))) : 'none yet'}.`
  ].join('\n');
}

const all = packages();
const adapters = all.filter(p => p.meta.kind === 'adapter');
const modules = all.filter(p => p.meta.kind === 'module');
const lists = all.filter(p => p.meta.kind === 'module-list');
const { SETTINGS } = await tsImport(pathToFileURL(join(root, 'packages/core/src/config.ts')).href, import.meta.url);

/** Each file's generated sections: marker name to content. */
const sections = {
  'README.md': { platforms: platformTable('README.md', adapters), modules: moduleList('README.md', modules) },
  'docs/modules.md': { 'module-index': moduleIndex('docs/modules.md', modules) },
  'docs/configuration.md': { settings: settingsTable(SETTINGS) },
  'spec/SPEC.md': { 'spec-modules': specModules() },
  'AGENTS.md': { packages: packageList('AGENTS.md', adapters, modules, lists) }
};

const write = process.argv.includes('--write');
const stale = [];
for (const [file, generated] of Object.entries(sections)) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  let next = text;
  for (const [name, content] of Object.entries(generated)) {
    const pattern = new RegExp(`(<!-- generated:${name}:start -->)[\\s\\S]*?(<!-- generated:${name}:end -->)`);
    if (!pattern.test(next)) {
      problems.push(`${file}: no <!-- generated:${name}:start --> and <!-- generated:${name}:end --> markers`);
      continue;
    }
    next = next.replace(pattern, (_all, start, end) => `${start}\n${content}\n${end}`);
  }
  if (next === text) continue;
  if (write) {
    writeFileSync(path, next);
    console.log(`${file}: updated`);
  } else {
    stale.push(file);
  }
}

for (const problem of problems) console.error(problem);
for (const file of stale) console.error(`${file}: generated sections are out of date`);
if (stale.length > 0) console.error('Run `node scripts/docs.mjs --write` to fix.');
if (problems.length + stale.length > 0) process.exitCode = 1;
else if (!write) console.log(`ok - generated doc sections are up to date in ${String(Object.keys(sections).length)} files`);
