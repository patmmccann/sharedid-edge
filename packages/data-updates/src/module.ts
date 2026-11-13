import { defineModule, type EdgeModule, type ModuleContext, type ModuleResult } from '@sharedid-edge/core';
import { CLOCK_SKEW_MS, type Snapshot } from './snapshot.js';

export interface SnapshotModuleOptions<T> {
  readonly definition: Omit<EdgeModule, 'run'>;
  readonly snapshot: () => Snapshot<T> | undefined;
  /** Compiles validated data into a lookup; called once per content hash. A throw keeps the last good lookup. */
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
  // The last good lookup, the hash it was compiled from and that data's latest check time.
  let hash: string | undefined;
  let run: EdgeModule['run'] | undefined;
  let checkedAt = 0;
  // A hash whose create threw: not retried on every request; a new published hash is tried once.
  let failed: string | undefined;
  const now = options.now ?? Date.now;
  return defineModule({
    ...options.definition,
    async run(context: ModuleContext): Promise<ModuleResult | undefined> {
      const snapshot = options.snapshot();
      if (snapshot === undefined) return { stale: true };
      const time = now();
      // Clock skew between the updater and this host may put checkedAt slightly ahead; that counts as age 0.
      const usable = (at: number): boolean => time - at >= -CLOCK_SKEW_MS && (expireAfterMs === undefined || time - at <= expireAfterMs);
      if (snapshot.hash !== hash && snapshot.hash !== failed && usable(snapshot.checkedAt)) {
        try {
          run = options.create(snapshot.data);
          hash = snapshot.hash;
          failed = undefined;
        } catch { failed = snapshot.hash; }
      }
      if (snapshot.hash === hash) checkedAt = snapshot.checkedAt;
      if (run === undefined) {
        if (failed === snapshot.hash) throw new TypeError('Unusable snapshot data'); // Reported as `error`.
        return { stale: true };
      }
      if (!usable(checkedAt)) return { stale: true };
      const result = await run(context);
      // Serving the previous lookup because the current data failed is reported as stale too.
      return hash !== snapshot.hash || Math.max(0, time - checkedAt) > maxAgeMs ? { ...result, stale: true } : result;
    }
  });
}
