// Builds the TC string the e2e page runs with, and writes site/public/tcf.js, which the page loads: the string, its
// decoded consents for Prebid.js's static consent data, and the euconsent-v2 cookie SharedID Edge reads.
//
//   npm run tc-string              fetch the current Global Vendor List, encode, verify, write site/public/tcf.js
//   npm run tc-string -- --check   offline: fail if tcf.js doesn't match the bundle's modules and tcf-config.json
//
// What it consents to comes from two files, so it stays in step with the bundle:
//   - tcf-config.json: purpose consents, publisher consents, and extraVendors (vendors with no module in the bundle);
//   - prebid-modules.json: the bundle's modules. Every GVL ID they declare in prebid.js's metadata gets vendor consent.
// Encoded and checked with the IAB Tech Lab's @iabtechlabtcf/core; https://iabgpp.com decodes the result too.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GVL, TCModel, TCString, type VendorList } from '@iabtechlabtcf/core';

const ROOT = import.meta.dirname;
const OUT = join(ROOT, 'site', 'public', 'tcf.js');
const GVL_URL = 'https://vendor-list.consensu.org/v3/vendor-list.json';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function numberList(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || !value.every((n): n is number => Number.isInteger(n) && n > 0)) throw new Error(`${what} must be a list of positive whole numbers`);
  return [...value].sort((a, b) => a - b);
}

interface Config {
  readonly purposeConsents: number[];
  readonly publisherConsents: number[];
  readonly extraVendors: ReadonlyMap<number, string>;
}

function readConfig(): Config {
  const parsed = readJson(join(ROOT, 'tcf-config.json'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('tcf-config.json must be an object');
  const record = parsed as Record<string, unknown>;
  const extra = record['extraVendors'];
  if (typeof extra !== 'object' || extra === null) throw new Error('tcf-config.json: extraVendors must be an object of GVL ID to name');
  const extraVendors = new Map(Object.entries(extra).map(([id, name]) => [Number(id), String(name)]));
  numberList([...extraVendors.keys()], 'tcf-config.json: extraVendors keys');
  return {
    purposeConsents: numberList(record['purposeConsents'], 'tcf-config.json: purposeConsents'),
    publisherConsents: numberList(record['publisherConsents'], 'tcf-config.json: publisherConsents'),
    extraVendors
  };
}

/** GVL ID -> the bundle's modules (with their component names) that declare it, from prebid.js's metadata. */
function moduleVendors(): Map<number, string[]> {
  const parsed = readJson(join(ROOT, 'prebid-modules.json'));
  const modules = typeof parsed === 'object' && parsed !== null && 'modules' in parsed ? parsed.modules : undefined;
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
    const components = typeof metadata === 'object' && metadata !== null && 'components' in metadata ? metadata.components : [];
    for (const component of Array.isArray(components) ? components as unknown[] : []) {
      if (typeof component !== 'object' || component === null) continue;
      const { gvlid, componentName } = component as { gvlid?: unknown; componentName?: unknown };
      if (typeof gvlid !== 'number' || !Number.isInteger(gvlid) || gvlid <= 0) continue;
      const name = `${module}${typeof componentName === 'string' && componentName !== '' ? ` (${componentName})` : ''}`;
      vendors.set(gvlid, [...(vendors.get(gvlid) ?? []), name]);
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

function check(config: Config): void {
  const vendors = expectedVendors(config);
  const file = readFileSync(OUT, 'utf8');
  const tcString = /var tcString = '([^']+)';/.exec(file)?.[1];
  const listed = (name: string): number[] => {
    const list = new RegExp(`var ${name} = (\\[[^\\]]*\\]);`).exec(file)?.[1];
    if (list === undefined) throw new Error(`tcf.js has no ${name} list`);
    return numberList(JSON.parse(list), `tcf.js ${name}`);
  };
  if (tcString === undefined) throw new Error('tcf.js has no tcString');
  const decoded = TCString.decode(tcString);
  const problems: string[] = [];
  const compare = (what: string, want: number[], inFile: number[], inString: number[]): void => {
    if (!same(want, inFile)) problems.push(`${what}: tcf.js lists ${inFile.join(',')}, expected ${want.join(',')}`);
    if (!same(want, inString)) problems.push(`${what}: the TC string has ${inString.join(',')}, expected ${want.join(',')}`);
  };
  compare('vendor consents', vendors, listed('vendors'), setIds(decoded.vendorConsents));
  compare('purpose consents', config.purposeConsents, listed('purposes'), setIds(decoded.purposeConsents));
  compare('publisher consents', config.publisherConsents, listed('publisherPurposes'), setIds(decoded.publisherConsents));
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('Run `npm run tc-string` in e2e/ to rebuild site/public/tcf.js (see e2e/AGENTS.md).');
    process.exit(1);
  }
  console.log(`ok - the TC string matches the bundle's modules and tcf-config.json (vendors ${vendors.join(', ')})`);
}

async function generate(config: Config): Promise<void> {
  const response = await fetch(GVL_URL);
  if (!response.ok) throw new Error(`Global Vendor List: HTTP ${String(response.status)}`);
  const vendorList = await response.json() as VendorList;
  const gvl = new GVL(vendorList);
  const fromModules = moduleVendors();
  const vendors = expectedVendors(config);
  const missing = vendors.filter(id => vendorList.vendors[String(id)] === undefined);
  if (missing.length > 0) throw new Error(`Not in GVL v${String(vendorList.vendorListVersion)}: ${missing.join(', ')}`);

  const model = new TCModel(gvl);
  model.cmpId = 2;
  model.cmpVersion = 1;
  model.consentScreen = 1;
  model.consentLanguage = 'EN';
  model.publisherCountryCode = 'US';
  model.isServiceSpecific = true;
  model.purposeConsents.set(config.purposeConsents);
  model.publisherConsents.set(config.publisherConsents);
  model.vendorConsents.set(vendors);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  model.created = today;
  model.lastUpdated = today;
  const tcString = TCString.encode(model);

  // Decode it again before writing anything.
  const decoded = TCString.decode(tcString);
  if (!same(setIds(decoded.vendorConsents), vendors) || !same(setIds(decoded.purposeConsents), config.purposeConsents) || !same(setIds(decoded.publisherConsents), config.publisherConsents)) {
    throw new Error('The encoded TC string doesn\'t decode to the configured consents');
  }

  const vendorLines = vendors.map(id => {
    const why = fromModules.get(id)?.join(', ') ?? config.extraVendors.get(id) ?? '';
    return `//   ${String(id).padStart(4)}  ${vendorList.vendors[String(id)]?.name ?? ''}: ${fromModules.has(id) ? `module ${why}` : `extra: ${why}`}`;
  });
  const js = `// Generated by e2e/tc-string.ts (npm run tc-string): don't edit by hand. See e2e/AGENTS.md.
//
// The e2e page's consent: GDPR applies, with this TC string (GVL v${String(vendorList.vendorListVersion)}, TCF policy version ${String(vendorList.tcfPolicyVersion)},
// created ${today.toISOString().slice(0, 10)}). Prebid.js gets it through static consent data (consentManagement cmpApi 'static'),
// decoded as a CMP's getTCData would give it; SharedID Edge reads it from euconsent-v2, written here as CMPs do
// (sharedIdSystem doesn't send consent to pixelUrl).
//
// Purpose consents: ${config.purposeConsents.join(', ')}. Publisher consents: ${config.publisherConsents.join(', ')}.
// Vendor consents (the bundle's modules, from prebid.js's metadata, and tcf-config.json's extraVendors):
${vendorLines.join('\n')}
window.SID_E2E_TCF = (function () {
  var tcString = '${tcString}';
  var purposes = ${JSON.stringify(config.purposeConsents)};
  var publisherPurposes = ${JSON.stringify(config.publisherConsents)};
  var vendors = ${JSON.stringify(vendors)};
  function flags(ids) {
    var map = {};
    ids.forEach(function (id) { map[id] = true; });
    return map;
  }
  document.cookie = 'euconsent-v2=' + tcString + '; Path=/; Max-Age=31536000; SameSite=Lax';
  return {
    tcString: tcString,
    gdprApplies: true,
    tcfPolicyVersion: ${String(vendorList.tcfPolicyVersion)},
    eventStatus: 'tcloaded',
    cmpStatus: 'loaded',
    isServiceSpecific: true,
    purposeOneTreatment: false,
    purpose: { consents: flags(purposes), legitimateInterests: {} },
    vendor: { consents: flags(vendors), legitimateInterests: {} },
    specialFeatureOptins: {},
    publisher: { consents: flags(publisherPurposes), legitimateInterests: {}, customPurpose: { consents: {}, legitimateInterests: {} }, restrictions: {} }
  };
})();
`;
  writeFileSync(OUT, js);
  console.log(`${tcString}\nwritten to ${OUT}\nvendors: ${vendors.join(', ')}`);
}

const config = readConfig();
if (process.argv.includes('--check')) check(config);
else await generate(config);
