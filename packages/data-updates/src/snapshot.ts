/** A private deployment store. put replaces one key atomically; a failed write must not remove its previous value. */
export interface SnapshotStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

/** Checks and returns a snapshot's data, throwing on anything unsupported or malformed. */
export type Validator<T> = (value: unknown) => T;

export interface Snapshot<T> {
  readonly data: T;
  readonly hash: string;
  /** Last successful source check, including an unchanged download or HTTP 304, in epoch milliseconds. */
  readonly checkedAt: number;
}

export interface Manifest {
  readonly version: 1;
  readonly source: string;
  readonly hash: string;
  readonly checkedAt: number;
  readonly variant?: string;
  readonly etag?: string;
  readonly url?: string;
}

/** Hash exactly the UTF-8 bytes stored, so snapshots can be checked without executing downloaded JavaScript. */
export async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sourceName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError('Invalid update source name');
  return name;
}

export function manifestKey(name: string): string {
  return `${sourceName(name)}/current.json`;
}

export function dataKey(name: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError('Invalid snapshot hash');
  return `${sourceName(name)}/${hash}.json`;
}

export async function readManifest(store: SnapshotStore, name: string): Promise<Manifest | undefined> {
  const raw = await store.get(manifestKey(name));
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('source' in value) || value.source !== name || !('hash' in value) || typeof value.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.hash) || !('checkedAt' in value) || typeof value.checkedAt !== 'number' ||
      !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 ||
      ('variant' in value && typeof value.variant !== 'string') ||
      ('etag' in value && typeof value.etag !== 'string') || ('url' in value && typeof value.url !== 'string')) {
    throw new TypeError('Invalid snapshot manifest');
  }
  return {
    version: 1, source: name, hash: value.hash, checkedAt: value.checkedAt,
    ...('variant' in value && typeof value.variant === 'string' ? { variant: value.variant } : {}),
    ...('etag' in value && typeof value.etag === 'string' ? { etag: value.etag } : {}),
    ...('url' in value && typeof value.url === 'string' ? { url: value.url } : {})
  };
}

export async function readSnapshot<T>(store: SnapshotStore, name: string, validate: Validator<T>, previous?: Snapshot<T>): Promise<Snapshot<T> | undefined> {
  const manifest = await readManifest(store, name);
  if (manifest === undefined) return undefined;
  if (previous?.hash === manifest.hash) return { ...previous, checkedAt: manifest.checkedAt };
  const raw = await store.get(dataKey(name, manifest.hash));
  if (raw === undefined || await sha256(raw) !== manifest.hash) throw new TypeError('Invalid snapshot content');
  return { data: decodeSnapshot(raw, validate), hash: manifest.hash, checkedAt: manifest.checkedAt };
}

/** Validate the serialized representation that a reader will actually receive. */
export function decodeSnapshot<T>(raw: string, validate: Validator<T>): T {
  const envelope: unknown = JSON.parse(raw);
  if (typeof envelope !== 'object' || envelope === null || !('version' in envelope) || envelope.version !== 1 || !('data' in envelope)) {
    throw new TypeError('Invalid snapshot format');
  }
  return validate(envelope.data);
}

/** Only shared reference data is cached. Call reload from adapter setup or background work, never a module's run. */
export class SnapshotCache<T> {
  #current: Snapshot<T> | undefined;
  #pending: Promise<boolean> | undefined;
  #nextCheck = 0;
  readonly #now: () => number;

  constructor(
    readonly store: SnapshotStore,
    readonly name: string,
    readonly validate: Validator<T>,
    readonly pollMs = 60_000,
    now: () => number = Date.now
  ) {
    sourceName(name);
    if (!Number.isFinite(pollMs) || pollMs < 0) throw new TypeError('Invalid snapshot polling interval');
    this.#now = now;
  }

  get current(): Snapshot<T> | undefined { return this.#current; }

  reload(): Promise<boolean> {
    if (this.#pending !== undefined) return this.#pending;
    if (this.#now() < this.#nextCheck) return Promise.resolve(this.#current !== undefined);
    this.#nextCheck = this.#now() + this.pollMs;
    this.#pending = this.#load().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #load(): Promise<boolean> {
    try {
      const next = await readSnapshot(this.store, this.name, this.validate, this.#current);
      if (next === undefined || next.checkedAt > this.#now() || (this.#current !== undefined && next.checkedAt < this.#current.checkedAt)) return false;
      this.#current = next;
      return true;
    } catch {
      return false; // Keep the last good copy, without exposing storage errors or deployment secrets.
    }
  }
}
