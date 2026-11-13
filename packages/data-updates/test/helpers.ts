import { vi } from 'vitest';
import type { SnapshotStore, UpdateSource } from '../src/index.js';

export class MemoryStore implements SnapshotStore {
  readonly values = new Map<string, string>();
  readonly get = vi.fn((key: string): Promise<string | undefined> => Promise.resolve(this.values.get(key)));
  readonly put = vi.fn((key: string, value: string): Promise<void> => { this.values.set(key, value); return Promise.resolve(); });
}

export function numbers(value: unknown): readonly number[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'number' && Number.isFinite(item))) throw new TypeError('Invalid list');
  return value as number[]; // Every element was checked above.
}

export function listSource(): UpdateSource<readonly number[]> {
  return {
    name: 'list', validate: numbers,
    download: vi.fn(() => Promise.resolve({ bytes: new TextEncoder().encode('[1,2]'), etag: 'first', url: 'https://data.example/list' })),
    decode: bytes => numbers(JSON.parse(new TextDecoder().decode(bytes)))
  };
}
