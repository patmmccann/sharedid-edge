import { handlerOrMisconfigured, publicOriginFromEnv, SETTINGS, settingsFromEnv, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import type { EdgeWorkerRequest } from './edgeworkers.js';
import { createEdgeWorkerHandler, internalError, type EdgeWorkerHandler } from './handler.js';

/** Property Manager user-defined variables an EdgeWorker can read start with this: `SID_BASE_PATH` is `PMUSER_SID_BASE_PATH`. */
export const VARIABLE_PREFIX = 'PMUSER_';

/** The settings the adapter reads: core's `SID_*` settings, and `SID_PUBLIC_ORIGIN`. */
export const SETTING_NAMES: readonly string[] = [...SETTINGS.map(setting => setting.name), 'SID_PUBLIC_ORIGIN'];

/**
 * The `SID_*` settings from the request's Property Manager variables: each `SID_*` name is read from the variable
 * `PMUSER_` + the name. A variable that doesn't exist is unset.
 */
export function envFromVariables(request: Pick<EdgeWorkerRequest, 'getVariable'>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of SETTING_NAMES) env[name] = request.getVariable(`${VARIABLE_PREFIX}${name}`);
  return env;
}

/**
 * Builds the handler from `SID_*` settings, plus `SID_PUBLIC_ORIGIN` (see `publicOrigin`). Invalid settings give a
 * handler that answers every request with a 500, like the other adapters, rather than one that sets wrong cookies.
 */
export function handlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  modules: readonly EdgeModule[] = builtInModules
): EdgeWorkerHandler {
  return handlerOrMisconfigured(
    () => createEdgeWorkerHandler({
      // The configuration, and with SID_HOSTS one per hostname.
      ...settingsFromEnv(env, { requireCookieDomain: true }),
      modules,
      ...publicOriginFromEnv(env)
    }),
    () => () => Promise.resolve(internalError('SharedID Edge is misconfigured'))
  );
}

/**
 * The handler the deployed EdgeWorker uses. EdgeWorkers hands the property's variables over with each request, not at
 * start-up, so the settings are read per request. The handler is rebuilt only when they change: the last one is kept
 * (while the EdgeWorker instance lives), keyed by the settings' values.
 */
export function createVariablesHandler(modules: readonly EdgeModule[] = builtInModules): EdgeWorkerHandler {
  let cached: { readonly key: string; readonly handler: EdgeWorkerHandler } | undefined;
  return request => {
    const env = envFromVariables(request);
    const key = JSON.stringify(SETTING_NAMES.map(name => env[name] ?? null));
    if (cached?.key !== key) cached = { key, handler: handlerFromEnv(env, modules) };
    return cached.handler(request);
  };
}
