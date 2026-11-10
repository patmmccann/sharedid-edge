import { ConfigError, handlerOrMisconfigured, isHeaderName, parseHeaderMap, publicOriginFromEnv, resolveConfig, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createGcpHandler, sendInternalError, type GcpHandler } from './handler.js';
import { LOCATION_FIELDS, type LocationHeaders } from './platform.js';

/** Environment variables, as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>;

function headerName(value: string, setting: string): string {
  if (!isHeaderName(value)) throw new ConfigError(`${setting} must be a header name`);
  return value.toLowerCase();
}

/**
 * Parses `SID_LOCATION_HEADERS`: a JSON object from location field (`country`, `region`, `city`, `latLong`) to the
 * custom request header the load balancer adds, like
 * `{"country":"x-client-region","region":"x-client-region-subdivision"}`. Throws a `ConfigError` for anything else,
 * so a typo can't silently turn location off.
 */
export function parseLocationHeaders(value: string | undefined): LocationHeaders {
  return parseHeaderMap(value, 'SID_LOCATION_HEADERS', LOCATION_FIELDS, '{"country":"x-client-region"}');
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
  const clientIpHeader = env['SID_CLIENT_IP_HEADER'];
  return handlerOrMisconfigured<GcpHandler>(
    () => createGcpHandler({
      config: resolveConfig(env),
      modules,
      behindLoadBalancer: !/^(0|false|no|off)$/i.test(env['SID_BEHIND_LOAD_BALANCER'] ?? ''),
      trustedHops: parseTrustedHops(env['SID_TRUSTED_HOPS']),
      locationHeaders: parseLocationHeaders(env['SID_LOCATION_HEADERS']),
      ...(clientIpHeader === undefined || clientIpHeader === '' ? {} : { clientIpHeader: headerName(clientIpHeader, 'SID_CLIENT_IP_HEADER') }),
      ...publicOriginFromEnv(env)
    }),
    () => (_req, res) => {
      sendInternalError(res, 'SharedID Edge is misconfigured');
      return Promise.resolve();
    }
  );
}
