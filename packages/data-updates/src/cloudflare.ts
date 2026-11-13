import { runUpdates, type UpdateOptions, type UpdateSource } from './update.js';
import type { SnapshotStore } from './snapshot.js';

/** Structural types keep Workers runtime declarations out of the platform-neutral API. */
export interface KVBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface R2Binding {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export function kvStore(binding: KVBinding): SnapshotStore {
  return { async get(key) { return await binding.get(key) ?? undefined; }, async put(key, value) { await binding.put(key, value); } };
}

export function r2Store(binding: R2Binding): SnapshotStore {
  return { async get(key) { return (await binding.get(key))?.text(); }, async put(key, value) { await binding.put(key, value); } };
}

/** Return this promise from scheduled, or pass it to ctx.waitUntil: failures must reach the platform's job monitor. */
export async function scheduledUpdate(sources: readonly UpdateSource[], options: UpdateOptions): Promise<void> {
  const reports = await runUpdates(sources, options);
  if (reports.some(report => report.status === 'failed')) throw new Error('Scheduled reference-data update failed');
}
