import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SnapshotStore } from './snapshot.js';

/** Private files with atomic replacement. A crash before rename leaves the published snapshot unchanged. */
export function fileStore(directory: string): SnapshotStore {
  function path(key: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}\/(?:current|[a-f0-9]{64})\.json$/.test(key)) throw new TypeError('Invalid snapshot key');
    return join(directory, key);
  }
  return {
    async get(key) {
      try { return await readFile(path(key), 'utf8'); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async put(key, value) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(value, 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
  };
}
