// SharedID's adoption among Prebid.js sites with the User ID module, from OpenSincera's mapping_modules endpoint
// (https://open.thetradedesk.com/seller/docsApp/GuidesSeller/opensincera/doc/OpenSinceraQueries): how often each
// Prebid.js module was detected over the previous 90 days.
//
// Runs at build time. With SINCERA_API_KEY (the deploy workflow on main, from a repository secret) it fetches the
// current numbers; without it (pull requests, local builds), or if the request fails, it uses adoption-snapshot.json.
// Only the counts and a date reach the page; the key never does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineLoader } from 'vitepress';

export interface Adoption {
  /** Detections of sharedIdSystem. */
  readonly sharedIdSystem: number;
  /** Detections of the User ID module, which every ID submodule needs. */
  readonly userId: number;
  /** When the numbers were fetched (YYYY-MM-DD). */
  readonly date: string;
  /** Whether they came from the API in this build, rather than the committed snapshot. */
  readonly live: boolean;
}

declare const data: Adoption;
export { data };

const SNAPSHOT = join(import.meta.dirname, '..', '..', 'adoption-snapshot.json');
const ENDPOINT = 'https://open.sincera.io/api/mapping_modules';

interface MappingModule {
  readonly module_name?: unknown;
  readonly detected_count?: unknown;
}

function count(modules: readonly MappingModule[], name: string): number | undefined {
  const value = modules.find(m => m.module_name === name)?.detected_count;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function snapshot(): Adoption {
  const saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Omit<Adoption, 'live'>;
  return { ...saved, live: false };
}

export default defineLoader({
  async load(): Promise<Adoption> {
    const key = process.env['SINCERA_API_KEY'];
    if (key === undefined || key === '') return snapshot();
    try {
      const response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      const modules = (Array.isArray(body) ? body : []) as MappingModule[];
      const sharedIdSystem = count(modules, 'sharedIdSystem');
      const userId = count(modules, 'userId');
      if (sharedIdSystem === undefined || userId === undefined || sharedIdSystem > userId) throw new Error('unexpected data');
      return { sharedIdSystem, userId, date: new Date().toISOString().slice(0, 10), live: true };
    } catch (error) {
      // The build goes on with the last good numbers, dated, rather than failing the site.
      console.warn(`adoption: using adoption-snapshot.json (${error instanceof Error ? error.message : 'request failed'})`);
      return snapshot();
    }
  }
});
