// Builds the e2e page's consent scenarios and writes site/public/tcf.js, which the page loads. The page picks a scenario
// with ?consent=<name> (given by default); tcf.js then hands Prebid.js its static consent data and, when GDPR applies,
// writes the TC string to euconsent-v2, where SharedID Edge reads it.
//
//   npm run tc-string              fetch the current Global Vendor List, encode, verify, write site/public/tcf.js
//   npm run tc-string -- --check   offline: fail if tcf.js doesn't match the bundle's modules and tcf-config.json
//
// tcf-config.json has the scenarios (purpose and publisher consents, or gdprApplies: false) and extraVendors (vendors
// with no module in the bundle). Every scenario with a TC string gets vendor consent for every GVL ID the bundle's
// modules (prebid-modules.json) declare in prebid.js's metadata, plus extraVendors, so it stays in step with the bundle.
// Encoded and checked with the IAB Tech Lab's @iabtechlabtcf/core; https://iabgpp.com decodes the strings too.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GVL, TCModel, TCString, type VendorList } from '@iabtechlabtcf/core';

const ROOT = import.meta.dirname;
const OUT = join(ROOT, 'site', 'public', 'tcf.js');
const GVL_URL = 'https://vendor-list.consensu.org/v3/vendor-list.json';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberList(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || !value.every((n): n is number => Number.isInteger(n) && n > 0)) throw new Error(`${what} must be a list of positive whole numbers`);
  return [...value].sort((a, b) => a - b);
}

/** A scenario where GDPR applies, with a TC string, or one where it doesn't. */
type Scenario =
  | { readonly name: string; readonly description: string; readonly gdprApplies: true; readonly purposeConsents: number[]; readonly publisherConsents: number[] }
  | { readonly name: string; readonly description: string; readonly gdprApplies: false };

interface Config {
  readonly scenarios: Scenario[];
  readonly extraVendors: ReadonlyMap<number, string>;
}

function readConfig(): Config {
  const parsed = readJson(join(ROOT, 'tcf-config.json'));
  if (!isRecord(parsed) || !isRecord(parsed['scenarios']) || !isRecord(parsed['extraVendors'])) throw new Error('tcf-config.json needs "scenarios" and "extraVendors" objects');
  const scenarios = Object.entries(parsed['scenarios']).map(([name, value]): Scenario => {
    if (!isRecord(value)) throw new Error(`tcf-config.json: scenario ${name} must be an object`);
    const description = typeof value['description'] === 'string' ? value['description'] : name;
    if (value['gdprApplies'] === false) return { name, description, gdprApplies: false };
    return {
      name,
      description,
      gdprApplies: true,
      purposeConsents: numberList(value['purposeConsents'], `tcf-config.json: ${name}.purposeConsents`),
      publisherConsents: numberList(value['publisherConsents'], `tcf-config.json: ${name}.publisherConsents`)
    };
  });
  if (!scenarios.some(s => s.name === 'given')) throw new Error('tcf-config.json needs a "given" scenario (the page\'s default)');
  const extraVendors = new Map(Object.entries(parsed['extraVendors']).map(([id, name]) => [Number(id), String(name)]));
  numberList([...extraVendors.keys()], 'tcf-config.json: extraVendors keys');
  return { scenarios, extraVendors };
}

/** GVL ID -> the bundle's modules (with their component names) that declare it, from prebid.js's metadata. */
function moduleVendors(): Map<number, string[]> {
  const parsed = readJson(join(ROOT, 'prebid-modules.json'));
  const modules = isRecord(parsed) ? parsed['modules'] : undefined;
  if (!Array.isArray(modules)) throw new Error('prebid-modules.json: "modules" must be a list');
  const vendors = new Map<number, string[]>();
  for (const module of modules) {
    if (typeof module !== 'string') continue;
    let metadata: unknown;
    try {
      metadata = readJson(join(ROOT, 'node_modules', 'prebid.js', 'metadata', 'modules', `${module}.json`));
    } catch {
      continue; // core modules (consentManagementTcf, userId, ...) have no metadata file and no vendor
    }
    const components = isRecord(metadata) && Array.isArray(metadata['components']) ? metadata['components'] as unknown[] : [];
    for (const component of components) {
      if (!isRecord(component)) continue;
      const gvlid = component['gvlid'];
      const componentName = component['componentName'];
      if (typeof gvlid !== 'number' || !Number.isInteger(gvlid) || gvlid <= 0) continue;
      const label = `${module}${typeof componentName === 'string' && componentName !== '' ? ` (${componentName})` : ''}`;
      vendors.set(gvlid, [...(vendors.get(gvlid) ?? []), label]);
    }
  }
  return vendors;
}

function expectedVendors(config: Config): number[] {
  return [...new Set([...moduleVendors().keys(), ...config.extraVendors.keys()])].sort((a, b) => a - b);
}

function setIds(set: { forEach(callback: (value: boolean, id: number) => void): void }): number[] {
  const ids: number[] = [];
  set.forEach((value, id) => { if (value) ids.push(id); });
  return ids.sort((a, b) => a - b);
}

const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((n, i) => n === b[i]);

/** What tcf.js embeds per scenario: null when GDPR doesn't apply. */
interface Encoded {
  readonly tcString: string;
  readonly purposes: number[];
  readonly publisherPurposes: number[];
  readonly vendors: number[];
}

function check(config: Config): void {
  const vendors = expectedVendors(config);
  const json = /^ {2}var scenarios = (.*);$/m.exec(readFileSync(OUT, 'utf8'))?.[1];
  if (json === undefined) throw new Error('tcf.js has no scenarios');
  const embedded = JSON.parse(json) as Record<string, Encoded | null>;
  const problems: string[] = [];
  const compare = (what: string, want: number[], got: number[]): void => {
    if (!same(want, got)) problems.push(`${what}: has ${got.join(',') || 'none'}, expected ${want.join(',') || 'none'}`);
  };
  for (const scenario of config.scenarios) {
    const entry = embedded[scenario.name];
    if (entry === undefined) { problems.push(`${scenario.name}: missing from tcf.js`); continue; }
    if (!scenario.gdprApplies) {
      if (entry !== null) problems.push(`${scenario.name}: tcf.js has a TC string, but GDPR doesn't apply`);
      continue;
    }
    if (entry === null) { problems.push(`${scenario.name}: tcf.js has no TC string`); continue; }
    const decoded = TCString.decode(entry.tcString);
    for (const [label, want, listed, inString] of [
      ['vendor consents', vendors, entry.vendors, setIds(decoded.vendorConsents)],
      ['purpose consents', scenario.purposeConsents, entry.purposes, setIds(decoded.purposeConsents)],
      ['publisher consents', scenario.publisherConsents, entry.publisherPurposes, setIds(decoded.publisherConsents)]
    ] as const) {
      compare(`${scenario.name} ${label} (tcf.js list)`, [...want], [...listed]);
      compare(`${scenario.name} ${label} (TC string)`, [...want], [...inString]);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('Run `npm run tc-string` in e2e/ to rebuild site/public/tcf.js (see e2e/AGENTS.md).');
    process.exit(1);
  }
  console.log(`ok - tcf.js matches the bundle's modules and tcf-config.json (${config.scenarios.map(s => s.name).join(', ')}; vendors ${vendors.join(', ')})`);
}

async function generate(config: Config): Promise<void> {
  const response = await fetch(GVL_URL);
  if (!response.ok) throw new Error(`Global Vendor List: HTTP ${String(response.status)}`);
  const vendorList = await response.json() as VendorList;
  const fromModules = moduleVendors();
  const vendors = expectedVendors(config);
  const missing = vendors.filter(id => vendorList.vendors[String(id)] === undefined);
  if (missing.length > 0) throw new Error(`Not in GVL v${String(vendorList.vendorListVersion)}: ${missing.join(', ')}`);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  const embedded: Record<string, Encoded | null> = {};
  const summary: string[] = [];
  for (const scenario of config.scenarios) {
    if (!scenario.gdprApplies) {
      embedded[scenario.name] = null;
      summary.push(`//   ${scenario.name}: ${scenario.description}.`);
      continue;
    }
    const model = new TCModel(new GVL(vendorList));
    model.cmpId = 2;
    model.cmpVersion = 1;
    model.consentScreen = 1;
    model.consentLanguage = 'EN';
    model.publisherCountryCode = 'US';
    model.isServiceSpecific = true;
    model.purposeConsents.set(scenario.purposeConsents);
    model.publisherConsents.set(scenario.publisherConsents);
    model.vendorConsents.set(vendors);
    model.created = today;
    model.lastUpdated = today;
    const tcString = TCString.encode(model);
    // Decode it again before writing anything.
    const decoded = TCString.decode(tcString);
    if (!same(setIds(decoded.vendorConsents), vendors) || !same(setIds(decoded.purposeConsents), scenario.purposeConsents) || !same(setIds(decoded.publisherConsents), scenario.publisherConsents)) {
      throw new Error(`${scenario.name}: the encoded TC string doesn't decode to the configured consents`);
    }
    embedded[scenario.name] = { tcString, purposes: scenario.purposeConsents, publisherPurposes: scenario.publisherConsents, vendors };
    summary.push(`//   ${scenario.name}: ${scenario.description}.`, `//     ${tcString}`, `//     purpose consents ${scenario.purposeConsents.join(', ')}; publisher consents ${scenario.publisherConsents.join(', ')}; vendor consents below`);
  }

  const vendorLines = vendors.map(id => {
    const why = fromModules.get(id)?.join(', ') ?? config.extraVendors.get(id) ?? '';
    return `//   ${String(id).padStart(4)}  ${vendorList.vendors[String(id)]?.name ?? ''}: ${fromModules.has(id) ? `module ${why}` : `extra: ${why}`}`;
  });
  const js = `// Generated by e2e/tc-string.ts (npm run tc-string): don't edit by hand. See e2e/AGENTS.md.
//
// The e2e page's consent. The page picks a scenario with ?consent=<name>, "given" by default. Prebid.js gets it through
// static consent data (consentManagement cmpApi 'static'), decoded as a CMP's getTCData would give it. When GDPR
// applies, SharedID Edge reads the TC string from euconsent-v2, written here as CMPs do (sharedIdSystem doesn't send
// consent to pixelUrl). TC strings: GVL v${String(vendorList.vendorListVersion)}, TCF policy version ${String(vendorList.tcfPolicyVersion)}, created ${today.toISOString().slice(0, 10)}.
//
// Scenarios:
${summary.join('\n')}
//
// Vendor consents in every TC string (the bundle's modules, from prebid.js's metadata, and tcf-config.json's extraVendors):
${vendorLines.join('\n')}
window.SID_E2E_TCF = (function () {
  var scenarios = ${JSON.stringify(embedded)};
  var name = new URLSearchParams(location.search).get('consent') || 'given';
  if (!(name in scenarios)) throw new Error('unknown consent scenario: ' + name);
  var scenario = scenarios[name];
  if (scenario === null) return { gdprApplies: false, tcfPolicyVersion: ${String(vendorList.tcfPolicyVersion)}, eventStatus: 'tcloaded', cmpStatus: 'loaded' };
  function flags(ids) {
    var map = {};
    ids.forEach(function (id) { map[id] = true; });
    return map;
  }
  document.cookie = 'euconsent-v2=' + scenario.tcString + '; Path=/; Max-Age=31536000; SameSite=Lax';
  return {
    tcString: scenario.tcString,
    gdprApplies: true,
    tcfPolicyVersion: ${String(vendorList.tcfPolicyVersion)},
    eventStatus: 'tcloaded',
    cmpStatus: 'loaded',
    isServiceSpecific: true,
    purposeOneTreatment: false,
    purpose: { consents: flags(scenario.purposes), legitimateInterests: {} },
    vendor: { consents: flags(scenario.vendors), legitimateInterests: {} },
    specialFeatureOptins: {},
    publisher: { consents: flags(scenario.publisherPurposes), legitimateInterests: {}, customPurpose: { consents: {}, legitimateInterests: {} }, restrictions: {} }
  };
})();
`;
  writeFileSync(OUT, js);
  for (const [name, entry] of Object.entries(embedded)) console.log(`${name}: ${entry === null ? '(GDPR doesn\'t apply)' : entry.tcString}`);
  console.log(`written to ${OUT}; vendors: ${vendors.join(', ')}`);
}

const config = readConfig();
if (process.argv.includes('--check')) check(config);
else await generate(config);
