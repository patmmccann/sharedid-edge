import { isRecord, type SharedIdEdgeConfig } from './config.js';
import type { ConsentContext } from './consent.js';
import type { Eid, ModuleReport, PlatformInfo } from './types.js';

/** What a module gets for one request. Modules see the request but must not modify it. */
export interface ModuleContext {
  readonly request: Request;
  readonly url: URL;
  readonly platform: PlatformInfo;
  /** The SharedID for this request, when storage is allowed. */
  readonly sharedId: string | undefined;
  readonly consent: ConsentContext;
  /** This module's entry from `SID_MODULE_CONFIG`, or `{}`. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** What a module adds to the payload. Every field is optional. */
export interface ModuleResult {
  readonly eids?: readonly Eid[];
  /** An OpenRTB 2.x fragment, deep-merged into the payload's `ortb2`. */
  readonly ortb2?: Readonly<Record<string, unknown>>;
}

/**
 * A module adds IDs or signals to the `{basePath}/v1` payload. Modules work only from what the worker already has
 * (the request, platform data, consent, configuration, bundled data); they make no network calls.
 */
export interface EdgeModule {
  /** Unique name; also the key in `SID_MODULES` and `SID_MODULE_CONFIG`. Lowercase letters, digits and `-`. */
  readonly name: string;
  /** IAB GVL vendor ID, for modules acting for a TCF vendor. */
  readonly gvlid?: number;
  /** TCF purposes the module needs when GDPR applies. */
  readonly purposes?: readonly number[];
  run(context: ModuleContext): ModuleResult | undefined | Promise<ModuleResult | undefined>;
}

const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Validates a module definition, so mistakes surface when the worker is built rather than per request. */
export function defineModule(module: EdgeModule): EdgeModule {
  if (!MODULE_NAME.test(module.name)) throw new TypeError(`Invalid module name "${module.name}"`);
  for (const purpose of module.purposes ?? []) {
    if (!Number.isInteger(purpose) || purpose < 1 || purpose > 24) throw new TypeError(`Module ${module.name}: invalid TCF purpose ${String(purpose)}`);
  }
  return Object.freeze({ ...module });
}

/** The registry of modules a worker is built with. */
export class ModuleRegistry {
  readonly #modules = new Map<string, EdgeModule>();

  constructor(modules: Iterable<EdgeModule> = []) {
    for (const module of modules) this.register(module);
  }

  register(module: EdgeModule): this {
    if (this.#modules.has(module.name)) throw new TypeError(`Module "${module.name}" is registered twice`);
    this.#modules.set(module.name, defineModule(module));
    return this;
  }

  get(name: string): EdgeModule | undefined {
    return this.#modules.get(name);
  }

  names(): string[] {
    return [...this.#modules.keys()];
  }
}

export interface ModuleRunOutput {
  readonly eids: Eid[];
  readonly ortb2: Record<string, unknown> | undefined;
  readonly reports: Record<string, ModuleReport>;
}

/**
 * Runs the configured modules in order. A module that's missing, not allowed by consent, throws or runs past
 * `moduleTimeoutMs` is reported and left out; the others still contribute.
 */
export async function runModules(
  registry: ModuleRegistry,
  config: SharedIdEdgeConfig,
  base: Omit<ModuleContext, 'config'>,
  now: () => number
): Promise<ModuleRunOutput> {
  const eids: Eid[] = [];
  let ortb2: Record<string, unknown> | undefined;
  const reports: Record<string, ModuleReport> = {};

  for (const name of config.modules) {
    const module = registry.get(name);
    if (module === undefined) {
      reports[name] = { ms: 0, status: 'skipped', reason: 'not installed' };
      continue;
    }
    const denied = consentDenial(module, base.consent);
    if (denied !== undefined) {
      reports[name] = { ms: 0, status: 'skipped', reason: denied };
      continue;
    }
    const start = now();
    try {
      const result = await withTimeout(
        Promise.resolve(module.run({ ...base, config: config.moduleConfig[name] ?? {} })),
        config.moduleTimeoutMs
      );
      const ms = Math.round(now() - start);
      if (result === TIMED_OUT) {
        reports[name] = { ms, status: 'timeout' };
        continue;
      }
      if (result === undefined || (result.eids === undefined && result.ortb2 === undefined)) {
        reports[name] = { ms, status: 'empty' };
        continue;
      }
      if (result.eids !== undefined) eids.push(...result.eids);
      if (result.ortb2 !== undefined) ortb2 = deepMerge(ortb2 ?? {}, result.ortb2);
      reports[name] = { ms, status: 'ok' };
    } catch {
      // The error isn't reported to the page: it may contain request data.
      reports[name] = { ms: Math.round(now() - start), status: 'error' };
    }
  }
  return { eids, ortb2, reports };
}

/**
 * Why consent doesn't allow a module to run, or undefined if it does. When GDPR applies, a module's declared purposes
 * must all have publisher consent (modules without a `gvlid` act for the publisher). Vendor consent isn't decoded yet,
 * so a module with a `gvlid` doesn't run when GDPR applies.
 */
function consentDenial(module: EdgeModule, consent: ConsentContext): string | undefined {
  if (consent.gdprApplies !== true) return undefined;
  if (module.gvlid !== undefined) return 'tcf: vendor consent is not checked yet';
  const purposes = module.purposes ?? [];
  if (purposes.length === 0) return undefined;
  const publisher = consent.tcf?.publisherPurposeConsents;
  if (publisher === undefined) return 'tcf: no publisher consent in the TC string';
  const missing = purposes.filter(p => !publisher.has(p));
  return missing.length === 0 ? undefined : `tcf: no publisher consent for purpose ${missing.join(', ')}`;
}

const TIMED_OUT: unique symbol = Symbol('timed out');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => { resolve(TIMED_OUT); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Deep-merges plain objects; arrays and other values from `source` replace those in `target`. */
export function deepMerge(target: Record<string, unknown>, source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}
