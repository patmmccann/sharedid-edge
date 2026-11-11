import { ConfigError, type EdgeModule } from '@sharedid-edge/core';

const SPEC = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)#([A-Za-z_$][\w$]*)$/;

function isEdgeModule(value: unknown): value is EdgeModule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['run'] === 'function';
}

/**
 * Loads `SID_MODULE_PACKAGES`: opt-in modules (`ec`, vendor modules) to add to the built-in ones, comma-separated, each
 * `<package>#<export>`, like `@sharedid-edge/module-ec#ecModule`. The server isn't bundled, so it imports them at
 * start-up; each package must be installed next to it. A missing package or export, or an export that isn't a
 * module, is a configuration error.
 */
export async function loadModulePackages(value: string | undefined, load: (specifier: string) => Promise<unknown> = specifier => import(specifier)): Promise<EdgeModule[]> {
  const specs = (value ?? '').split(',').map(spec => spec.trim()).filter(spec => spec !== '');
  const modules: EdgeModule[] = [];
  for (const spec of specs) {
    const match = SPEC.exec(spec);
    const pkg = match?.[1];
    const name = match?.[2];
    if (pkg === undefined || name === undefined) throw new ConfigError(`SID_MODULE_PACKAGES: "${spec}" must be <package>#<export>, like @sharedid-edge/module-ec#ecModule`);
    let exports: unknown;
    try {
      exports = await load(pkg);
    } catch {
      throw new ConfigError(`SID_MODULE_PACKAGES: can't load ${pkg}; install it next to the server`);
    }
    const module: unknown = typeof exports === 'object' && exports !== null ? (exports as Record<string, unknown>)[name] : undefined;
    if (!isEdgeModule(module)) throw new ConfigError(`SID_MODULE_PACKAGES: ${pkg} has no module export "${name}"`);
    modules.push(module);
  }
  return modules;
}
