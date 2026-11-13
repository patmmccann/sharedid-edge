import { dataKey, decodeSnapshot, manifestKey, MAX_SUPERSEDED, parseManifest, readManifest, sha256, sourceName, type Manifest, type SnapshotStore, type Validator } from './snapshot.js';

export interface Download {
  readonly bytes: Uint8Array;
  readonly etag?: string;
  /** Identity of the resource whose ETag is stored; must never contain credentials. */
  readonly url?: string;
}

export interface DownloadContext {
  readonly secrets: Readonly<Record<string, string>>;
  readonly previous: { readonly etag?: string; readonly url?: string } | undefined;
  readonly signal: AbortSignal;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly now: number;
}

/** An explicitly installed source; credentials are consumed only by download, never by decode or validate. */
export interface UpdateSource<T = unknown> {
  readonly name: string;
  /** Change when transformation options or the data schema change, so an old ETag cannot skip reconversion. */
  readonly variant?: string;
  /** undefined means HTTP 304 (valid only when there is a previous validated snapshot). */
  readonly download: (context: DownloadContext) => Promise<Download | undefined>;
  readonly decode: (bytes: Uint8Array) => T | Promise<T>;
  readonly validate: Validator<T>;
}

export interface UpdateOptions {
  readonly store: SnapshotStore;
  readonly secrets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** No URLs, credential values, download contents or raw exception messages may appear in reports. */
export interface UpdateReport {
  readonly name: string;
  readonly status: 'updated' | 'unchanged' | 'failed';
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Validated before any storage or network access, so a bad option fails the whole call clearly. */
function updateTimeout(options: UpdateOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Invalid update timeout');
  return timeoutMs;
}

/** Settles with work or rejects when the signal aborts, so a hung source or store cannot hold the update lock. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new Error('Update timed out')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { if (abort !== undefined) signal.removeEventListener('abort', abort); }
}

/** Best-effort deletion; returns the hashes whose deletion failed, to be retried on the next run. */
async function deleteBodies(store: SnapshotStore, name: string, hashes: readonly string[], bounded: <R>(work: Promise<R>) => Promise<R>): Promise<string[]> {
  const results = await Promise.allSettled(hashes.map(hash => bounded(store.delete(dataKey(name, hash)))));
  const failed = hashes.filter((_hash, index) => results[index]?.status === 'rejected');
  if (failed.length > 0) console.error(`${name}: could not delete superseded snapshot bodies; retrying on the next run`);
  return failed;
}

export async function refreshData<T>(source: UpdateSource<T>, options: UpdateOptions): Promise<UpdateReport> {
  const name = sourceName(source.name);
  const signal = AbortSignal.timeout(updateTimeout(options));
  const now = options.now ?? Date.now;
  const { store } = options;
  const bounded = <R>(work: Promise<R>): Promise<R> => abortable(work, signal);
  try {
    // A storage read failure stops publication. An unreadable manifest (corrupt, partly written or from a newer
    // version) is treated as missing and republished, as is a missing or corrupt body.
    const stored = await bounded(store.get(manifestKey(name)));
    let manifest: Manifest | undefined;
    try { manifest = stored === undefined ? undefined : parseManifest(stored, name); } catch {
      console.error(`${name}: unreadable snapshot manifest; republishing`);
    }
    // The body was validated before it was published: checking its hash is enough, and keeps a large database from
    // being parsed and decoded again inside the download timeout.
    let previousValid = false;
    if (manifest !== undefined) {
      try {
        const body = await bounded(store.get(dataKey(name, manifest.hash)));
        previousValid = body !== undefined && await sha256(body) === manifest.hash;
      } catch { /* Repair unreadable data. */ }
    }
    const sameVariant = (source.variant ?? '1') === (manifest?.variant ?? '1');
    const download = await bounded(source.download({
      secrets: options.secrets?.[name] ?? {}, previous: previousValid && sameVariant ? manifest : undefined,
      signal, fetch: options.fetch ?? fetch, now: now()
    }));
    signal.throwIfAborted();
    if (download === undefined && (!previousValid || !sameVariant || manifest === undefined)) throw new TypeError('No snapshot to revalidate');
    const data = download === undefined ? undefined : await bounded(Promise.resolve(source.decode(download.bytes)));
    if (download !== undefined && data === undefined) throw new TypeError('Snapshot data must be JSON-serializable');
    const raw = data === undefined ? undefined : JSON.stringify({ version: 1, data });
    if (raw !== undefined) decodeSnapshot(raw, source.validate);
    const hash = raw === undefined ? manifest?.hash : await sha256(raw);
    if (hash === undefined) throw new TypeError('No snapshot hash');
    signal.throwIfAborted();
    const changed = !previousValid || hash !== manifest?.hash;
    if (changed && raw !== undefined) await bounded(store.put(dataKey(name, hash), raw));
    // Bodies superseded on an earlier run are no longer referenced; only failed deletions are carried forward.
    const pending = await deleteBodies(store, name, (manifest?.superseded ?? []).filter(old => old !== hash && old !== manifest?.hash), bounded);
    const superseded = [...new Set([...(manifest !== undefined && manifest.hash !== hash ? [manifest.hash] : []), ...pending])].slice(0, MAX_SUPERSEDED);
    signal.throwIfAborted();
    const next: Manifest = {
      version: 1, source: name, hash, checkedAt: now(), variant: source.variant ?? '1',
      ...(download === undefined ? manifest?.etag === undefined ? {} : { etag: manifest.etag } : download.etag === undefined ? {} : { etag: download.etag }),
      ...(download === undefined ? manifest?.url === undefined ? {} : { url: manifest.url } : download.url === undefined ? {} : { url: download.url }),
      ...(superseded.length === 0 ? {} : { superseded })
    };
    await bounded(store.put(manifestKey(name), JSON.stringify(next)));
    // Delete the replaced body only once the new manifest reads back, so a reader never loses its last-good data to
    // this run. If it doesn't read back yet (eventually consistent KV) or the delete fails, the next run retries.
    if (manifest !== undefined && manifest.hash !== hash) {
      try {
        if ((await bounded(readManifest(store, name)))?.hash === hash) await deleteBodies(store, name, [manifest.hash], bounded);
      } catch { /* Published; the next run retries the deletion. */ }
    }
    return { name, status: changed ? 'updated' : 'unchanged' };
  } catch {
    return { name, status: 'failed' };
  }
}

/** Sequential updates avoid downloading several large databases into the same isolate at once. */
export async function runUpdates(sources: readonly UpdateSource[], options: UpdateOptions): Promise<readonly UpdateReport[]> {
  updateTimeout(options);
  const names = sources.map(source => sourceName(source.name));
  if (new Set(names).size !== names.length) throw new TypeError('Duplicate update source');
  const reports: UpdateReport[] = [];
  for (const source of sources) reports.push(await refreshData(source, options));
  return reports;
}
