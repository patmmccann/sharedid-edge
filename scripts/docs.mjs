// Generates the doc sections that every new module or adapter would otherwise edit by hand, so pull requests don't
// collide on shared tables. Each section sits between `<!-- generated:<name>:start -->` and
// `<!-- generated:<name>:end -->` markers. Sources:
//
// - the `sharedidEdge` block in each adapter's and module's package.json (the platform tables and module lists);
// - `SETTINGS` in packages/core/src/config.ts (the configuration reference);
// - the files in spec/modules/ (the spec's list of module specifications, grouped by where each module lives).
//
// `node scripts/docs.mjs` checks that every section is up to date (`npm run check:docs`); `--write` rewrites them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { root, workspaceFolders } from './projects.mjs';
import { allowedHosts } from './vendor-modules.mjs';

const ROUTES = ['v1', 'sync'];
/** The built-in module list's source, to check which project modules it imports. */
const builtIn = readFileSync(join(root, 'packages/modules/all/src/index.ts'), 'utf8');
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
      if (meta.forwards !== undefined && (!Array.isArray(meta.forwards) || meta.forwards.length === 0 || meta.forwards.some(host => typeof host !== 'string'))) {
        problems.push(`${where}: sharedidEdge.forwards must be a list of host names`);
      } else if (Array.isArray(meta.forwards)) {
        problems.push(...forwardingProblems(folder, meta.forwards, parent === 'modules' ? join(root, folder, 'src') : undefined));
      }
      if (meta.optIn !== undefined && (meta.optIn !== true || parent !== 'modules')) {
        problems.push(`${where}: sharedidEdge.optIn is true or left out, and only for project modules (vendor modules are always opt-in)`);
      }
      // Deployers add an opt-in module as <package>#<export>, and the conformance suite builds it in by its export.
      if ((parent === 'vendor-modules' || meta.optIn === true) && (typeof meta.export !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(meta.export))) {
        problems.push(`${where}: sharedidEdge.export must be the module's export name, like ecModule`);
      }
      // The built-in list has every project module but the opt-in ones.
      if (parent === 'modules' && builtIn.includes(`'@sharedid-edge/module-${dir}'`) === (meta.optIn === true)) {
        problems.push(`${where}: ${meta.optIn === true ? 'an opt-in module must not be' : 'a project module must be'} in the built-in list, packages/modules/all/src/index.ts`);
      }
      if (parent === 'vendor-modules') {
        // Every vendor module says whether it reaches the network: npm run test:vendor-modules enforces it.
        const hosts = allowedHosts(meta.network);
        if (hosts === undefined) problems.push(`${where}: sharedidEdge.network must be "none" or a non-empty list of host names`);
        else if (Array.isArray(meta.forwards) && meta.forwards.some(host => !hosts.includes(host))) problems.push(`${where}: every host in sharedidEdge.forwards must also be in sharedidEdge.network`);
      } else if (meta.network !== undefined) {
        problems.push(`${where}: sharedidEdge.network is for vendor modules; project modules make no network calls`);
      }
      if (meta.buildCredentials !== undefined && (!Array.isArray(meta.buildCredentials) || meta.buildCredentials.some(name => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)))) {
        problems.push(`${where}: sharedidEdge.buildCredentials must be a list of environment variable names, like FIFTYONE_DEGREES_LICENSE_KEY`);
      }
      if (meta.ipDerived !== undefined && typeof meta.ipDerived !== 'boolean') problems.push(`${where}: sharedidEdge.ipDerived must be true or false`);
      // IP-derived IDs are for vendor modules (ec among them), never the project's own.
      if (meta.ipDerived === true && parent === 'modules') problems.push(`${where}: a project module can't derive an ID from the IP address (see packages/vendor-modules/AGENTS.md#ip-derived-ids)`);
      if (parent === 'modules' && !existsSync(join(root, 'spec/modules', `${dir}.md`))) problems.push(`${where}: no specification in spec/modules/${dir}.md`);
    }
    if (meta.kind === 'adapter') problems.push(...dataUpdatesProblems(where, meta.dataUpdates));
    if (meta.kind !== 'module-list' && !existsSync(join(root, folder, 'README.md'))) problems.push(`${folder}: no README.md`);
    result.push({ folder, parent, dir, meta });
  }
  return result;
}

/**
 * An adapter's `dataUpdates`: whether the platform supports scheduled data updates (docs/data-updates.md), and how
 * (or, when it doesn't, what deployments get instead), for the generated platform table there.
 */
function dataUpdatesProblems(where, value) {
  if (typeof value !== 'object' || value === null || typeof value.supported !== 'boolean' || typeof value.how !== 'string' || value.how.trim() === '' ||
    Object.keys(value).some(key => key !== 'supported' && key !== 'how')) {
    return [`${where}: sharedidEdge.dataUpdates must be { "supported": true or false, "how": "…" } (see docs/development.md#package-metadata)`];
  }
  return [];
}

/** The box a forwarding module's README starts with: a blockquote whose first line begins with this. */
const FORWARDING_BOX = '> **⚠ This module forwards data to';

/**
 * A forwarding module (`forwards` in its metadata) discloses it at the top of its README: before the first `##`
 * section, a blockquote starting with FORWARDING_BOX that names every host, in backticks. For a project module (whose
 * source `src` is given), every host is also in its code, where core enforces the list (`forwarding.hosts`).
 */
function forwardingProblems(folder, forwards, src) {
  const problems = [];
  const readme = join(root, folder, 'README.md');
  if (existsSync(readme)) {
    const top = readFileSync(readme, 'utf8').split(/^## /m)[0];
    const start = top.indexOf(FORWARDING_BOX);
    const box = start < 0 ? '' : top.slice(start).split(/\n(?!>)/)[0];
    if (box === '') problems.push(`${folder}/README.md: a module that forwards data needs a box at the top of its README, before the first section, starting "${FORWARDING_BOX}" (see packages/vendor-modules/AGENTS.md#forwarding-requests-or-data)`);
    for (const host of forwards) if (box !== '' && !box.includes(`\`${host}\``)) problems.push(`${folder}/README.md: the forwarding box must name \`${host}\``);
  }
  if (src !== undefined) {
    const code = readdirSync(src).filter(name => name.endsWith('.ts')).map(name => readFileSync(join(src, name), 'utf8')).join('\n');
    for (const host of forwards) if (!code.includes(`'${host}'`)) problems.push(`${folder}/package.json: sharedidEdge.forwards lists ${host}, which the module's code doesn't declare`);
  }
  return problems;
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

/** Where scheduled data updates are supported, from each adapter's `dataUpdates`. */
function dataUpdatesTable(file, adapters) {
  const rows = [...adapters]
    .sort((a, b) => a.meta.platform.localeCompare(b.meta.platform))
    .map(({ folder, meta }) => `| [${cell(meta.platform)}](${link(file, `${folder}/README.md`)}#scheduled-data-updates) | ${meta.dataUpdates?.supported === true ? 'Yes' : 'No'} | ${cell(meta.dataUpdates?.how ?? '')} |`);
  return ['| Platform | Supported | How, or what you get instead |', '| --- | --- | --- |', ...rows].join('\n');
}

function moduleName({ parent, meta }) {
  const marks = [];
  if (parent === 'vendor-modules') marks.push(meta.network === 'none' ? 'vendor module, offline' : 'vendor module');
  if (meta.optIn === true) marks.push('opt-in build');
  if (Array.isArray(meta.network) && meta.network.length > 0) marks.push(`⚠ network: ${codeList(meta.network)}`);
  if (Array.isArray(meta.buildCredentials) && meta.buildCredentials.length > 0) marks.push(`needs ${codeList(meta.buildCredentials)} at build time`);
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

/**
 * The spec's list of module specifications, in two groups as on the website's sidebar: project modules
 * (`packages/modules/`) and vendor modules (`packages/vendor-modules/`), by where the module named after the file lives.
 */
function specModules(modules) {
  const dir = join(root, 'spec/modules');
  const groups = { modules: [], 'vendor-modules': [] };
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md')).sort()) {
    const name = file.slice(0, -'.md'.length);
    const heading = /^#\s+(.+)$/m.exec(readFileSync(join(dir, file), 'utf8'));
    if (heading === null) problems.push(`spec/modules/${file}: no heading`);
    const module = modules.find(m => m.meta.name === name);
    if (module === undefined) {
      problems.push(`spec/modules/${file}: no module named ${name} in packages/modules or packages/vendor-modules`);
      continue;
    }
    groups[module.parent].push(`  - [${heading?.[1] ?? file}](modules/${file})`);
  }
  const list = items => (items.length > 0 ? items.join('\n') : '  - none yet');
  return [
    `- **Core modules** (\`packages/modules/\`):\n${list(groups.modules)}`,
    `- **Vendor modules** (\`packages/vendor-modules/\`):\n${list(groups['vendor-modules'])}`
  ].join('\n');
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
  'docs/data-updates.md': { 'data-updates-platforms': dataUpdatesTable('docs/data-updates.md', adapters) },
  'spec/SPEC.md': { 'spec-modules': specModules(modules) },
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
