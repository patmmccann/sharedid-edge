import { dataKey, decodeSnapshot, manifestKey, readManifest, readSnapshot, sha256, sourceName, type Manifest, type SnapshotStore, type Validator } from './snapshot.js';

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

export async function refreshData<T>(source: UpdateSource<T>, options: UpdateOptions): Promise<UpdateReport> {
  const name = sourceName(source.name);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Invalid update timeout');
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // Read failures stop publication; missing or corrupt data are repaired by an unconditional download.
    const manifest = await readManifest(options.store, name);
    let previousValid = false;
    try { previousValid = await readSnapshot(options.store, name, source.validate) !== undefined; } catch { /* Repair corrupted data. */ }
    const sameVariant = (source.variant ?? '1') === (manifest?.variant ?? '1');
    const download = await abortable(source.download({
      secrets: options.secrets?.[name] ?? {}, previous: previousValid && sameVariant ? manifest : undefined,
      signal, fetch: options.fetch ?? fetch, now: now()
    }), signal);
    signal.throwIfAborted();
    if (download === undefined && (!previousValid || !sameVariant || manifest === undefined)) throw new TypeError('No snapshot to revalidate');
    const data = download === undefined ? undefined : await abortable(Promise.resolve(source.decode(download.bytes)), signal);
    if (download !== undefined && data === undefined) throw new TypeError('Snapshot data must be JSON-serializable');
    const raw = data === undefined ? undefined : JSON.stringify({ version: 1, data });
    if (raw !== undefined) decodeSnapshot(raw, source.validate);
    const hash = raw === undefined ? manifest?.hash : await sha256(raw);
    if (hash === undefined) throw new TypeError('No snapshot hash');
    signal.throwIfAborted();
    const changed = !previousValid || hash !== manifest?.hash;
    if (changed && raw !== undefined) await options.store.put(dataKey(name, hash), raw);
    signal.throwIfAborted();
    const next: Manifest = {
      version: 1, source: name, hash, checkedAt: now(), variant: source.variant ?? '1',
      ...(download === undefined ? manifest?.etag === undefined ? {} : { etag: manifest.etag } : download.etag === undefined ? {} : { etag: download.etag }),
      ...(download === undefined ? manifest?.url === undefined ? {} : { url: manifest.url } : download.url === undefined ? {} : { url: download.url })
    };
    await options.store.put(manifestKey(name), JSON.stringify(next));
    return { name, status: changed ? 'updated' : 'unchanged' };
  } catch {
    return { name, status: 'failed' };
  }
}

/** Sequential updates avoid downloading several large databases into the same isolate at once. */
export async function runUpdates(sources: readonly UpdateSource[], options: UpdateOptions): Promise<readonly UpdateReport[]> {
  const names = sources.map(source => sourceName(source.name));
  if (new Set(names).size !== names.length) throw new TypeError('Duplicate update source');
  const reports: UpdateReport[] = [];
  for (const source of sources) reports.push(await refreshData(source, options));
  return reports;
}
