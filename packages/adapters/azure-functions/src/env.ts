import { ConfigError, DEFAULT_CONFIG, booleanFromEnv, handlerOrMisconfigured, parseHeaderMap, publicOriginFromEnv, resolveConfig, settingsFromEnv, ROUTES, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createAzureHandler, internalError, type AzureHandler } from './handler.js';
import { LOCATION_FIELDS, type LocationHeaders } from './platform.js';

/** Environment variables (app settings), as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Parses `SID_LOCATION_HEADERS`: a JSON object from location field (`country`, `regionCode`, `city`, `postalCode`,
 * `metroCode`, `latitude`, `longitude`, `timezone`, `continent`) to the request header a Front Door rule set adds.
 * Throws a `ConfigError` for anything else, so a typo can't silently turn location off.
 */
export function parseLocationHeaders(value: string | undefined): LocationHeaders {
  return parseHeaderMap(value, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"x-sid-country"}');
}

/** `SID_FRONT_DOOR_ID`: comma-separated Front Door profile IDs, or none. */
export function parseFrontDoorIds(value: string | undefined): readonly string[] {
  const ids = (value ?? '').split(',').map(id => id.trim()).filter(id => id !== '');
  for (const id of ids) {
    if (!/^[0-9A-Fa-f-]{36}$/.test(id)) throw new ConfigError('SID_FRONT_DOOR_ID must be Front Door profile IDs (GUIDs), comma-separated');
  }
  return ids;
}

/**
 * Builds the handler from app settings, once per instance: the `SID_*` settings, plus `SID_PUBLIC_ORIGIN`,
 * `SID_BEHIND_FRONT_DOOR` (`false` when Front Door isn't in front), `SID_FRONT_DOOR_ID` and `SID_LOCATION_HEADERS`.
 * Invalid settings give a handler that answers every request with a 500, like the Worker, rather than one that sets
 * wrong cookies.
 */
export function handlerFromEnv(env: Env, modules: readonly EdgeModule[] = builtInModules): AzureHandler {
  return handlerOrMisconfigured(
    () => createAzureHandler({
      // The configuration, and with SID_HOSTS one per hostname.
      ...settingsFromEnv(env, { requireCookieDomain: true }),
      modules,
      behindFrontDoor: booleanFromEnv(env['SID_BEHIND_FRONT_DOOR'], true),
      frontDoorIds: parseFrontDoorIds(env['SID_FRONT_DOOR_ID']),
      locationHeaders: parseLocationHeaders(env['SID_LOCATION_HEADERS']),
      ...publicOriginFromEnv(env)
    }),
    () => () => Promise.resolve(internalError('SharedID Edge is misconfigured'))
  );
}

/**
 * The HTTP trigger's route template for a base path: `_sid/{*path}` for `/_sid`, `{*path}` for `/`. The host's route
 * prefix must be empty (`host.json`), so the route is the URL path. The catch-all also matches the base path itself.
 */
export function routeFor(basePath: string): string {
  // Leading and trailing slashes off, without a regular expression (a `\/+$` backtracks on long runs of slashes).
  let start = 0;
  let end = basePath.length;
  while (start < end && basePath[start] === '/') start++;
  while (end > start && basePath[end - 1] === '/') end--;
  const trimmed = basePath.slice(start, end);
  return trimmed === '' ? '{*path}' : `${trimmed}/{*path}`;
}

/**
 * The Front Door route patterns for `SID_BASE_PATH`, as `infra/basepath.bicep` builds them: the base path as core
 * normalizes it (`/identity/` is `/identity`) and everything under it, or for the root path `/` only core's own routes
 * (`/sync`, `/v1`, `/optout`, `/optin`, each with and without a trailing slash), so the rest of the site stays on its
 * origin. For your own infrastructure templates. Throws a `ConfigError` for a base path core rejects.
 */
export function frontDoorPatterns(basePath: string): readonly string[] {
  const normalized = resolveConfig({ SID_BASE_PATH: basePath }).basePath;
  if (normalized === '/') return Object.values(ROUTES).flatMap(route => [route, `${route}/`]);
  return [normalized, `${normalized}/*`];
}

/** The route template for `SID_BASE_PATH`; the default's when it's invalid (the handler then answers with a 500). */
export function routeFromEnv(env: Env): string {
  const basePath = env['SID_BASE_PATH'];
  if (basePath === undefined || basePath === '') return routeFor(DEFAULT_CONFIG.basePath);
  try {
    return routeFor(resolveConfig({ SID_BASE_PATH: basePath }).basePath);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return routeFor(DEFAULT_CONFIG.basePath);
  }
}
