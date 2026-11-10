import { ConfigError, resolveConfig, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createGcpHandler, sendInternalError, type GcpHandler } from './handler.js';
import { LOCATION_FIELDS, type LocationField, type LocationHeaders } from './platform.js';

/** Environment variables, as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function headerName(value: unknown, setting: string): string {
  if (typeof value !== 'string' || !HEADER_NAME.test(value)) throw new ConfigError(`${setting} must be a header name`);
  return value.toLowerCase();
}

/**
 * Parses `SID_LOCATION_HEADERS`: a JSON object from location field (`country`, `region`, `city`, `latLong`) to the
 * custom request header the load balancer adds, like
 * `{"country":"x-client-region","region":"x-client-region-subdivision"}`. Throws a `ConfigError` for anything else,
 * so a typo can't silently turn location off.
 */
export function parseLocationHeaders(value: string | undefined): LocationHeaders {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError('SID_LOCATION_HEADERS must be a JSON object, like {"country":"x-client-region"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('SID_LOCATION_HEADERS must be a JSON object, like {"country":"x-client-region"}');
  }
  const fields: readonly string[] = LOCATION_FIELDS;
  const headers: Partial<Record<LocationField, string>> = {};
  for (const [field, name] of Object.entries(parsed)) {
    if (!fields.includes(field)) {
      throw new ConfigError(`SID_LOCATION_HEADERS: unknown field "${field}"; use ${LOCATION_FIELDS.join(', ')}`);
    }
    // Checked to be one of LOCATION_FIELDS above.
    headers[field as LocationField] = headerName(name, `SID_LOCATION_HEADERS.${field}`);
  }
  return headers;
}

/** `SID_TRUSTED_HOPS`: a whole number from 0 to 10; 1 when empty. */
export function parseTrustedHops(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 1;
  if (!/^\d{1,2}$/.test(value.trim()) || Number(value) > 10) throw new ConfigError('SID_TRUSTED_HOPS must be a whole number from 0 to 10');
  return Number(value);
}

/**
 * Builds the HTTP function from environment variables, once per instance: the `SID_*` settings, plus
 * `SID_PUBLIC_ORIGIN`, `SID_BEHIND_LOAD_BALANCER` (`false` when no load balancer is in front), `SID_TRUSTED_HOPS`,
 * `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS`. Invalid settings give a function that answers every request with
 * a 500, like the Worker, rather than one that sets wrong cookies.
 */
export function handlerFromEnv(env: Env, modules: readonly EdgeModule[] = builtInModules): GcpHandler {
  try {
    const config = resolveConfig(env);
    const publicOrigin = env['SID_PUBLIC_ORIGIN'];
    const clientIpHeader = env['SID_CLIENT_IP_HEADER'];
    return createGcpHandler({
      config,
      modules,
      behindLoadBalancer: !/^(0|false|no|off)$/i.test(env['SID_BEHIND_LOAD_BALANCER'] ?? ''),
      trustedHops: parseTrustedHops(env['SID_TRUSTED_HOPS']),
      locationHeaders: parseLocationHeaders(env['SID_LOCATION_HEADERS']),
      ...(clientIpHeader === undefined || clientIpHeader === '' ? {} : { clientIpHeader: headerName(clientIpHeader, 'SID_CLIENT_IP_HEADER') }),
      ...(publicOrigin === undefined || publicOrigin === '' ? {} : { publicOrigin })
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // A deployment mistake: log why (the message names the setting, not request data) and fail every request.
    console.error(`sharedid-edge: ${error.message}`);
    return (_req, res) => {
      sendInternalError(res, 'SharedID Edge is misconfigured');
      return Promise.resolve();
    };
  }
}
