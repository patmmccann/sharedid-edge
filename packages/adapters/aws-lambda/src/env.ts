import { handlerOrMisconfigured, resolveConfig, type EdgeModule } from '@sharedid-edge/core';
import { createLambdaHandler, internalError, type LambdaHandler } from './handler.js';
import { builtInModules } from '@sharedid-edge/modules';

/**
 * Builds the handler from environment variables, once per cold start: the `SID_*` settings, plus
 * `SID_PUBLIC_ORIGIN` (see `publicOrigin`) and `SID_BEHIND_CLOUDFRONT` (`false` when nothing is in front of the
 * function; see `behindCloudFront`). Invalid settings give a handler that answers every request with a 500, like
 * the Worker, rather than one that sets wrong cookies.
 */
export function handlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  modules: readonly EdgeModule[] = builtInModules
): LambdaHandler {
  const publicOrigin = env['SID_PUBLIC_ORIGIN'];
  return handlerOrMisconfigured(
    () => createLambdaHandler({
      config: resolveConfig(env),
      modules,
      behindCloudFront: !/^(0|false|no|off)$/i.test(env['SID_BEHIND_CLOUDFRONT'] ?? ''),
      ...(publicOrigin === undefined || publicOrigin === '' ? {} : { publicOrigin })
    }),
    () => {
      const misconfigured = internalError('SharedID Edge is misconfigured');
      return () => Promise.resolve(misconfigured);
    }
  );
}
