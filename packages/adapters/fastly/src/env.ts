import { cachedByEnv, ConfigError, handlerOrMisconfigured, logRequestFailure, publicOriginFromEnv, SETTING_NAMES, settingsFromEnv, trustedUpstreamFromEnv, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createFastlyHandler, internalError, type FastlyHandler } from './handler.js';

/** The config store, linked to the service under this name, that holds the `SID_*` settings, one key each. */
export const CONFIG_STORE = 'sharedid_config';

/** The secret store, linked to the service under this name, that holds `SID_MODULE_SECRETS` and `SID_UPSTREAM_SECRETS` (optional). */
export const SECRET_STORE = 'sharedid_secrets';

/** The module secrets, the first of `SECRET_SETTINGS`. */
export const SECRET_SETTING = 'SID_MODULE_SECRETS';

/** The settings read from the secret store rather than the config store. */
export const SECRET_SETTINGS: readonly string[] = [SECRET_SETTING, 'SID_UPSTREAM_SECRETS'];

/** What the adapter reads of a config store: `ConfigStore` from `fastly:config-store`. */
export interface ConfigStoreLike {
  get(key: string): string | null;
}

/** What the adapter reads of a secret store: `SecretStore` from `fastly:secret-store`. */
export interface SecretStoreLike {
  get(key: string): Promise<{ plaintext(): string } | null>;
}

/**
 * Opens the stores for a request. `config` throws when no config store is linked under `CONFIG_STORE`, as Fastly's
 * `new ConfigStore(name)` does; `secrets` returns `undefined` when no secret store is linked under `SECRET_STORE`.
 */
export interface Stores {
  config(): ConfigStoreLike;
  secrets(): SecretStoreLike | undefined;
}

/**
 * The settings from the stores: every `SID_*` setting (core's `SETTING_NAMES`) from the config store's key of the same
 * name, except `SID_MODULE_SECRETS` and `SID_UPSTREAM_SECRETS`, which come from the secret store when one is linked.
 * A missing key is unset.
 *
 * @throws ConfigError when no config store is linked, or when the config store holds one of those: secrets belong in
 *   the secret store.
 */
export async function envFromStores(stores: Stores): Promise<Record<string, string | undefined>> {
  let config: ConfigStoreLike;
  try {
    config = stores.config();
  } catch {
    throw new ConfigError(`no config store is linked to the service as ${CONFIG_STORE}`);
  }
  const env: Record<string, string | undefined> = {};
  for (const name of SETTING_NAMES) {
    if (!SECRET_SETTINGS.includes(name)) env[name] = config.get(name) ?? undefined;
  }
  const secrets = stores.secrets();
  for (const name of SECRET_SETTINGS) {
    if (config.get(name) !== null) throw new ConfigError(`${name} must be in the secret store ${SECRET_STORE}, not the config store`);
    const secret = await secrets?.get(name);
    if (secret !== undefined && secret !== null) env[name] = secret.plaintext();
  }
  return env;
}

/** A handler that answers every request with a 500. */
function misconfigured(): FastlyHandler {
  return () => Promise.resolve(internalError('SharedID Edge is misconfigured'));
}

/**
 * Builds the handler from `SID_*` settings, plus `SID_PUBLIC_ORIGIN` (see `publicOrigin`), with trusted-upstream mode
 * when `SID_UPSTREAM_SECRETS` is set (see `upstream`). Invalid settings give a
 * handler that answers every request with a 500, like the other adapters, rather than one that sets wrong cookies.
 */
export function handlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  modules: readonly EdgeModule[] = builtInModules
): FastlyHandler {
  return handlerOrMisconfigured(
    () => createFastlyHandler({
      // The configuration, and with SID_HOSTS one per hostname.
      ...settingsFromEnv(env, { requireCookieDomain: true }),
      upstream: trustedUpstreamFromEnv(env),
      modules,
      ...publicOriginFromEnv(env)
    }),
    misconfigured
  );
}

/**
 * The handler the deployed service uses. Config and secret stores can be read only while handling a request, not
 * while the package is built (Fastly pre-initializes the code at build time), so the settings are read per request.
 * The handler is rebuilt only when they change: the last one is kept while the instance lives, keyed by the
 * settings' values (core's `cachedByEnv`). A missing config store or invalid settings answer 500; it never throws.
 */
export function createStoresHandler(stores: Stores, modules: readonly EdgeModule[] = builtInModules): FastlyHandler {
  const handlerFor = cachedByEnv(env => handlerFromEnv(env, modules));
  return async (request, client) => {
    let env: Record<string, string | undefined>;
    try {
      env = await envFromStores(stores);
    } catch (error) {
      if (error instanceof ConfigError) console.error(`sharedid-edge: ${error.message}`);
      else logRequestFailure(error);
      return error instanceof ConfigError ? internalError('SharedID Edge is misconfigured') : internalError('Internal error');
    }
    return handlerFor(env)(request, client);
  };
}
