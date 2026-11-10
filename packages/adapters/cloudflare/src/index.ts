import { createHandler, handlerOrMisconfigured, resolveConfig, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { builtInModules as modules } from '@sharedid-edge/modules';
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

const misconfigured: SharedIdEdgeHandler = () =>
  Promise.resolve(new Response('SharedID Edge is misconfigured', { status: 500, headers: { 'Cache-Control': 'no-store' } }));

export default {
  async fetch(request, env): Promise<Response> {
    // A deployment mistake (invalid settings) fails every request clearly rather than set wrong cookies. Not cached,
    // so it's logged on each request until the settings are fixed.
    const handler = handlerOrMisconfigured(() => handlerFor(env), () => misconfigured);
    return handler(request, platformInfo(request));
  }
} satisfies ExportedHandler<Env>;
