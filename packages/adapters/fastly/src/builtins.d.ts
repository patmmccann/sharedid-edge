// Types for the Fastly Compute modules the entry point (src/main.ts) imports, as far as it uses them. The JavaScript
// SDK provides them when it compiles the bundle; the bundle leaves them as imports (scripts/bundle.mjs).
// https://js-compute-reference-docs.edgecompute.app/docs/

/** https://js-compute-reference-docs.edgecompute.app/docs/fastly:config-store/ConfigStore/ */
declare module 'fastly:config-store' {
  export class ConfigStore {
    /** Throws when no config store is linked to the service under `name`. */
    constructor(name: string);
    /** The value, or `null` when the key isn't there. */
    get(key: string): string | null;
  }
}

/** https://js-compute-reference-docs.edgecompute.app/docs/fastly:secret-store/SecretStore/ */
declare module 'fastly:secret-store' {
  export class SecretStoreEntry {
    plaintext(): string;
  }
  export class SecretStore {
    /** Throws when no secret store is linked to the service under `name`. */
    constructor(name: string);
    /** The entry, or `null` when the key isn't there. */
    get(key: string): Promise<SecretStoreEntry | null>;
  }
}

/** https://js-compute-reference-docs.edgecompute.app/docs/fastly:backend/enforceExplicitBackends */
declare module 'fastly:backend' {
  export function enforceExplicitBackends(defaultBackend?: string): void;
}
