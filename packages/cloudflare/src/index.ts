import { ConfigError, createHandler, resolveConfig, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { modules } from './modules.js';
import { platformInfo } from './platform.js';

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

export default {
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
} satisfies ExportedHandler<Env>;
