import { ConfigError, resolveConfig, type ResolveConfigOptions, type SharedIdEdgeConfig } from './config.js';

type Env = Readonly<Record<string, unknown>>;

/**
 * Settings that can't vary by host: secrets stay in the platform's secret store, `SID_HOSTS` doesn't nest, and the base
 * path is what the platform routes by (a Worker route, a CloudFront behaviour, a Front Door route, Vercel's middleware
 * predicate, a Snippet rule), which is the deployment's. Trusted upstream's settings can't vary by host either; core's
 * `upstream.ts` checks that, outside this file, so the Snippet doesn't carry it.
 */
const NOT_PER_HOST: ReadonlySet<string> = new Set(['SID_HOSTS', 'SID_MODULE_SECRETS', 'SID_BASE_PATH']);

/** A DNS hostname (or IPv4 address), lower case, without a trailing dot. */
// The type is spelled out for isolatedDeclarations (the regex is shared with upstream.ts).
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const HOSTNAME: RegExp = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;


/** The host a request's settings are chosen by: the URL's hostname, lower case, without a port or a trailing dot. */
export function hostKey(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * One host's settings, as `SID_*` strings: from a JSON object (an entry of `SID_HOSTS`, or a platform's per-host
 * metadata). `SID_MODULE_CONFIG` may be an object. `where` names the source in errors.
 *
 * @throws ConfigError for anything else.
 */
export function hostOverrides(value: unknown, where: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(`${where} must be an object of SID_* settings`);
  const overrides: Record<string, string> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!key.startsWith('SID_')) throw new ConfigError(`${where}: "${key}" isn't a SID_* setting`);
    if (NOT_PER_HOST.has(key)) throw new ConfigError(`${where}: ${key} can't be set per host`);
    if (typeof setting === 'string') overrides[key] = setting;
    else if (key === 'SID_MODULE_CONFIG' && typeof setting === 'object' && setting !== null) overrides[key] = JSON.stringify(setting);
    else throw new ConfigError(`${where}: ${key} must be a string`);
  }
  return overrides;
}

/** The configuration for one host: the deployment's settings, with the host's on top. */
export function configForHost(env: Env, overrides: Readonly<Record<string, string>>, where: string, options: ResolveConfigOptions = {}): SharedIdEdgeConfig {
  try {
    return resolveConfig({ ...env, ...overrides }, options);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${where}: ${error.message}`);
    throw error;
  }
}

/**
 * Parses `SID_HOSTS`: a JSON object from hostname to that site's settings, which go on top of the deployment's own,
 * for serving several sites from one deployment. Every host's configuration is resolved here, so a mistake in any of
 * them fails at start-up. Returns undefined when `SID_HOSTS` is unset.
 *
 * @throws ConfigError when it, or any host's settings, is invalid.
 */
export function resolveHosts(env: Env, options: ResolveConfigOptions = {}): ReadonlyMap<string, SharedIdEdgeConfig> | undefined {
  const value = env['SID_HOSTS'];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const example = '{"www.example.com":{"SID_COOKIE_DOMAIN":"example.com"}}';
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConfigError(`SID_HOSTS must be a JSON object from hostname to settings, like ${example}`);
  const hosts = new Map<string, SharedIdEdgeConfig>();
  for (const [name, settings] of Object.entries(parsed)) {
    const host = name.toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(host)) throw new ConfigError(`SID_HOSTS: "${name}" isn't a hostname`);
    if (hosts.has(host)) throw new ConfigError(`SID_HOSTS lists ${host} twice`);
    const where = `SID_HOSTS["${name}"]`;
    hosts.set(host, configForHost(env, hostOverrides(settings, where), where, options));
  }
  return hosts;
}

/** What an adapter passes to `createHandler` from its environment: the configuration, and the hosts with `SID_HOSTS`. */
export interface EnvSettings {
  readonly config: SharedIdEdgeConfig;
  readonly hosts?: ReadonlyMap<string, SharedIdEdgeConfig>;
}

/**
 * The deployment's settings from its environment, for `createHandler({ ...settingsFromEnv(env, options), modules })`.
 * With `SID_HOSTS`, the deployment's own settings only fill in what each host leaves out, so they needn't name a
 * cookie domain themselves (`requireCookieDomain` applies to each host instead).
 *
 * @throws ConfigError when a setting is invalid.
 */
export function settingsFromEnv(env: Env, options: ResolveConfigOptions = {}): EnvSettings {
  const hosts = resolveHosts(env, options);
  if (hosts === undefined) return { config: resolveConfig(env, options) };
  return { config: resolveConfig(env, { ...options, requireCookieDomain: false }), hosts };
}
