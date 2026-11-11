import { createHandler, handlerOrMisconfigured, resolveConfig, type EdgeModule, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { platformInfo } from './platform.js';

const misconfigured: SharedIdEdgeHandler = () =>
  Promise.resolve(new Response('SharedID Edge is misconfigured', { status: 500, headers: { 'Cache-Control': 'no-store' } }));

/**
 * The Worker, with `modules` built in. `src/index.ts` (the default entry point) passes the built-in list;
 * `src/bowser.ts` (the entry point of the Bowser build, `npm run deploy:bowser`) passes the same list with Bowser in
 * the `ua` module.
 */
export function createWorker(modules: readonly EdgeModule[]): ExportedHandler<Env> {
  // One handler per environment object: Cloudflare reuses `env` across requests to the same isolate.
  const handlers = new WeakMap<Env, SharedIdEdgeHandler>();

  function handlerFor(env: Env): SharedIdEdgeHandler {
    let handler = handlers.get(env);
    if (handler === undefined) {
      handler = createHandler({ config: resolveConfig({ ...env }, { requireCookieDomain: true }), modules });
      handlers.set(env, handler);
    }
    return handler;
  }

  return {
    async fetch(request, env): Promise<Response> {
      // A deployment mistake (invalid settings) fails every request clearly rather than set wrong cookies. Not cached,
      // so it's logged on each request until the settings are fixed.
      const handler = handlerOrMisconfigured(() => handlerFor(env), () => misconfigured);
      return handler(request, platformInfo(request));
    }
  };
}
