import { ConfigError, handlerOrMisconfigured, publicOriginFromEnv, resolveConfig, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createVercelHandler, internalError, middleware, type VercelHandler, type VercelMiddleware } from './handler.js';

/** Environment variables, as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Builds the handler from environment variables, once per instance: the `SID_*` settings, plus `SID_PUBLIC_ORIGIN`
 * (see `publicOrigin`) and `SID_BEHIND_VERCEL` (`false` when not running on Vercel; see `behindVercel`). Pass
 * `process.env`. Invalid settings give a handler that answers every request with a 500, like the Worker, rather than
 * one that sets wrong cookies.
 */
export function handlerFromEnv(env: Env, modules: readonly EdgeModule[] = builtInModules): VercelHandler {
  return handlerOrMisconfigured(
    () => createVercelHandler({
      config: resolveConfig(env),
      modules,
      behindVercel: !/^(0|false|no|off)$/i.test(env['SID_BEHIND_VERCEL'] ?? ''),
      ...publicOriginFromEnv(env)
    }),
    () => () => Promise.resolve(internalError('SharedID Edge is misconfigured'))
  );
}

/**
 * Builds middleware from environment variables, like `handlerFromEnv`: requests under `SID_BASE_PATH` (`/_sid`)
 * get the handler's response, any other request `undefined`. A misconfiguration answers the base path with a 500
 * and leaves the rest of the site alone.
 */
export function middlewareFromEnv(env: Env, modules: readonly EdgeModule[] = builtInModules): VercelMiddleware {
  const basePath = env['SID_BASE_PATH'];
  let path = '/_sid';
  if (basePath !== undefined && basePath !== '') {
    try {
      path = resolveConfig({ SID_BASE_PATH: basePath }).basePath;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // handlerFromEnv logs it; keep the default path so the 500 shows up where the endpoint is expected.
    }
  }
  return middleware(handlerFromEnv(env, modules), path);
}
