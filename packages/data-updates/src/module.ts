import { defineModule, type EdgeModule, type ModuleContext, type ModuleResult } from '@sharedid-edge/core';
import type { Snapshot } from './snapshot.js';

export interface SnapshotModuleOptions<T> {
  readonly definition: Omit<EdgeModule, 'run'>;
  readonly snapshot: () => Snapshot<T> | undefined;
  readonly create: (data: T) => EdgeModule['run'];
  readonly maxAgeMs: number;
  /** Optional hard stop for a licence or accuracy requirement; must be at least maxAgeMs. */
  readonly expireAfterMs?: number;
  readonly now?: () => number;
}

/** A module's run reads no storage and makes no network calls. Only reference data and its compiled lookup are kept. */
export function snapshotModule<T>(options: SnapshotModuleOptions<T>): EdgeModule {
  const { maxAgeMs, expireAfterMs } = options;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || (expireAfterMs !== undefined && (!Number.isFinite(expireAfterMs) || expireAfterMs < maxAgeMs))) {
    throw new TypeError('Invalid snapshot maximum age');
  }
  let hash: string | undefined;
  let run: EdgeModule['run'] | undefined;
  const now = options.now ?? Date.now;
  return defineModule({
    ...options.definition,
    async run(context: ModuleContext): Promise<ModuleResult | undefined> {
      const snapshot = options.snapshot();
      if (snapshot === undefined) return { stale: true };
      const age = now() - snapshot.checkedAt;
      if (age < 0 || (expireAfterMs !== undefined && age > expireAfterMs)) return { stale: true };
      if (hash !== snapshot.hash || run === undefined) { run = options.create(snapshot.data); hash = snapshot.hash; }
      const result = await run(context);
      return age > maxAgeMs ? { ...result, stale: true } : result;
    }
  });
}
