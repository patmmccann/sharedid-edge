import { readFileSync } from 'node:fs';
import { ConfigError } from '@sharedid-edge/core';

/** The secret settings the CLI also reads from a file named by `<setting>_FILE`, as Docker and Kubernetes secrets are mounted. */
export const FILE_SETTINGS: readonly string[] = ['SID_MODULE_SECRETS', 'SID_UPSTREAM_SECRETS'];

/**
 * `env` with each of `FILE_SETTINGS` read from the file its `_FILE` variable names (`SID_MODULE_SECRETS_FILE=/run/secrets/sid`),
 * the trailing newline dropped. Setting both a variable and its `_FILE`, a blank `_FILE`, or a file that can't be read
 * is a configuration error, so a container whose secret isn't mounted stops at start-up.
 */
export function withSecretFiles(env: NodeJS.ProcessEnv, read: (path: string) => string = path => readFileSync(path, 'utf8')): NodeJS.ProcessEnv {
  const fileVariables = new Set(FILE_SETTINGS.map(name => `${name}_FILE`));
  const out: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !fileVariables.has(name)));
  for (const name of FILE_SETTINGS) {
    const path = env[`${name}_FILE`];
    if (path === undefined) continue;
    if (path.trim() === '') throw new ConfigError(`${name}_FILE is empty: set it to the path of the file holding ${name}, or unset it`);
    if (env[name] !== undefined) throw new ConfigError(`Set ${name} or ${name}_FILE, not both`);
    let value: string;
    try {
      value = read(path);
    } catch {
      throw new ConfigError(`${name}_FILE: can't read ${path}`);
    }
    out[name] = value.replace(/\r?\n$/, '');
  }
  return out;
}
