import { ConfigError, createHandler, resolveConfig, type EdgeModule, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { platformInfo } from './platform.js';

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
      handler = createHandler({ config: resolveConfig({ ...env }), modules });
      handlers.set(env, handler);
    }
    return handler;
  }

  return {
    async fetch(request, env): Promise<Response> {
      let handler: SharedIdEdgeHandler;
      try {
        handler = handlerFor(env);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        // A deployment mistake: fail every request clearly rather than set wrong cookies.
        console.error(`sharedid-edge: ${error.message}`);
        return new Response('SharedID Edge is misconfigured', { status: 500, headers: { 'Cache-Control': 'no-store' } });
      }
      return handler(request, platformInfo(request));
    }
  };
}
