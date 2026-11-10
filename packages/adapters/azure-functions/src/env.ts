import { ConfigError, DEFAULT_CONFIG, resolveConfig, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createAzureHandler, internalError, type AzureHandler } from './handler.js';
import { LOCATION_FIELDS, type LocationField, type LocationHeaders } from './platform.js';

/** Environment variables (app settings), as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Parses `SID_LOCATION_HEADERS`: a JSON object from location field (`country`, `regionCode`, `city`, `postalCode`,
 * `metroCode`, `latitude`, `longitude`, `timezone`, `continent`) to the request header a Front Door rule set adds.
 * Throws a `ConfigError` for anything else, so a typo can't silently turn location off.
 */
export function parseLocationHeaders(value: string | undefined): LocationHeaders {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError('SID_LOCATION_HEADERS must be a JSON object, like {"country":"x-sid-country"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('SID_LOCATION_HEADERS must be a JSON object, like {"country":"x-sid-country"}');
  }
  const fields: readonly string[] = LOCATION_FIELDS;
  const headers: Partial<Record<LocationField, string>> = {};
  for (const [field, name] of Object.entries(parsed)) {
    if (!fields.includes(field)) {
      throw new ConfigError(`SID_LOCATION_HEADERS: unknown field "${field}"; use ${LOCATION_FIELDS.join(', ')}`);
    }
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      throw new ConfigError(`SID_LOCATION_HEADERS: the header for "${field}" must be a header name`);
    }
    // Checked to be one of LOCATION_FIELDS above.
    headers[field as LocationField] = name.toLowerCase();
  }
  return headers;
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
  try {
    const config = resolveConfig(env);
    const publicOrigin = env['SID_PUBLIC_ORIGIN'];
    return createAzureHandler({
      config,
      modules,
      behindFrontDoor: !/^(0|false|no|off)$/i.test(env['SID_BEHIND_FRONT_DOOR'] ?? ''),
      frontDoorIds: parseFrontDoorIds(env['SID_FRONT_DOOR_ID']),
      locationHeaders: parseLocationHeaders(env['SID_LOCATION_HEADERS']),
      ...(publicOrigin === undefined || publicOrigin === '' ? {} : { publicOrigin })
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // A deployment mistake: log why (the message names the setting, not request data) and fail every request.
    console.error(`sharedid-edge: ${error.message}`);
    const misconfigured = internalError('SharedID Edge is misconfigured');
    return () => Promise.resolve(misconfigured);
  }
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
