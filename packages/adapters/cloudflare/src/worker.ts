import { ConfigError, configForHost, createHandler, handlerOrMisconfigured, hostOverrides, settingsFromEnv, type EdgeModule, type SharedIdEdgeConfig, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { platformInfo } from './platform.js';

const misconfigured: SharedIdEdgeHandler = () =>
  Promise.resolve(new Response('SharedID Edge is misconfigured', { status: 500, headers: { 'Cache-Control': 'no-store' } }));

/** The custom hostname metadata key whose object holds a site's `SID_*` settings (Cloudflare for SaaS). */
export const HOST_METADATA_KEY = 'sharedid';

/** At most this many metadata configurations are kept per isolate; past it, the cache starts again. */
const MAX_CACHED_HOSTS = 1000;

/**
 * The settings in a Cloudflare for SaaS custom hostname's metadata (`request.cf.hostMetadata.sharedid`), on top of the
 * deployment's, or undefined when it has none. Cached by their value, so each site's configuration is resolved once.
 *
 * @throws ConfigError when they're invalid.
 */
function metadataConfig(env: Readonly<Record<string, unknown>>, request: Request, cache: Map<string, SharedIdEdgeConfig>): SharedIdEdgeConfig | undefined {
  const metadata: unknown = request.cf?.hostMetadata;
  if (typeof metadata !== 'object' || metadata === null || !(HOST_METADATA_KEY in metadata)) return undefined;
  const where = `custom hostname metadata "${HOST_METADATA_KEY}"`;
  const overrides = hostOverrides((metadata as Record<string, unknown>)[HOST_METADATA_KEY], where);
  const key = JSON.stringify(overrides);
  let config = cache.get(key);
  if (config === undefined) {
    config = configForHost(env, overrides, where, { requireCookieDomain: true });
    if (cache.size >= MAX_CACHED_HOSTS) cache.clear();
    cache.set(key, config);
  }
  return config;
}

/**
 * The Worker, with `modules` built in. `src/index.ts` (the default entry point) passes the built-in list;
 * `src/bowser.ts` (the entry point of the Bowser build, `npm run deploy:bowser`) passes the same list with Bowser in
 * the `ua` module.
 *
 * Several sites can share it: `SID_HOSTS` lists settings per hostname, and on a Cloudflare for SaaS zone a custom
 * hostname's metadata can carry them (`{"sharedid": {"SID_COOKIE_DOMAIN": "example.com"}}`).
 */
export function createWorker(modules: readonly EdgeModule[]): ExportedHandler<Env> {
  // One handler per environment object: Cloudflare reuses `env` across requests to the same isolate.
  const handlers = new WeakMap<Env, SharedIdEdgeHandler>();

  function handlerFor(env: Env): SharedIdEdgeHandler {
    let handler = handlers.get(env);
    if (handler === undefined) {
      const settings: Readonly<Record<string, unknown>> = { ...env };
      const cache = new Map<string, SharedIdEdgeConfig>();
      handler = createHandler({
        ...settingsFromEnv(settings, { requireCookieDomain: true }),
        hostConfig: request => metadataConfig(settings, request, cache),
        modules
      });
      handlers.set(env, handler);
    }
    return handler;
  }

  return {
    async fetch(request, env): Promise<Response> {
      // A deployment mistake (invalid settings) fails every request clearly rather than set wrong cookies. Not cached,
      // so it's logged on each request until the settings are fixed.
      const handler = handlerOrMisconfigured(() => handlerFor(env), () => misconfigured);
      try {
        return await handler(request, platformInfo(request));
      } catch (error) {
        // Invalid settings in one custom hostname's metadata fail that site's requests, not the others'.
        if (!(error instanceof ConfigError)) throw error;
        console.error(`sharedid-edge: ${error.message}`);
        return misconfigured(request);
      }
    }
  };
}
