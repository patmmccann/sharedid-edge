// The web-platform globals core and the modules use, for the EdgeWorkers bundle. EdgeWorkers runs ECMAScript in V8
// without the web platform's globals (no fetch API, and no documented Request, Response, Headers, URL, TextEncoder,
// atob or crypto globals: https://techdocs.akamai.com/edgeworkers/docs/specifications). Some come as built-in
// modules instead, and the rest from src/web.ts. scripts/bundle.mjs passes this file to esbuild's `inject`, so every
// free reference to one of these names in the bundle uses the export below rather than a global: the bundle runs the
// same whether or not a global exists, and writes none (EdgeWorkers doesn't promise to keep global writes).
import { crypto as platformCrypto } from 'crypto';
import { atob, btoa, TextDecoder, TextEncoder } from 'encoding';
import { logger } from 'log';
import { Headers, Request, Response, URL, uuidFromBytes } from './web.js';

export { atob, btoa, Headers, Request, Response, TextDecoder, TextEncoder, URL };

/**
 * Web Crypto from the `crypto` built-in module, plus `randomUUID`, which EdgeWorkers doesn't document: a version 4
 * UUID from `getRandomValues`, as core mints IDs.
 */
export const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  readonly subtle: SubtleCrypto;
  randomUUID(): string;
} = {
  getRandomValues: array => platformCrypto.getRandomValues(array),
  subtle: platformCrypto.subtle,
  randomUUID: () => uuidFromBytes(platformCrypto.getRandomValues(new Uint8Array(16)))
};

/** Joins what's logged into one string, so it's never read as the logger's format string. */
function line(data: readonly unknown[]): string {
  return data.map(String).join(' ');
}

/**
 * `console`, writing to the `log` built-in module, which is where EdgeWorkers logs go (shown with enhanced debug
 * headers or sent to DataStream 2). Core logs only errors, and never request data.
 */
export const console: Pick<Console, 'error' | 'log' | 'warn'> = {
  error: (...data: unknown[]) => { logger.error('%s', line(data)); },
  log: (...data: unknown[]) => { logger.log('%s', line(data)); },
  warn: (...data: unknown[]) => { logger.warn('%s', line(data)); }
};

type Timer = ReturnType<typeof globalThis.setTimeout>;

/**
 * Timers, for core's module time limit (`SID_MODULE_TIMEOUT_MS`). EdgeWorkers documents no `setTimeout`: where the
 * runtime has one it's used; otherwise the timer never fires, so a module isn't cut off early, and EdgeWorkers' own
 * time limit for the event applies instead.
 */
export function setTimeout(callback: () => void, ms: number): Timer | undefined {
  const platform: unknown = Reflect.get(globalThis, 'setTimeout');
  // Checked to be a function; it's the runtime's setTimeout.
  return typeof platform === 'function' ? (platform as typeof globalThis.setTimeout)(callback, ms) : undefined;
}

export function clearTimeout(timer: Timer | undefined): void {
  const platform: unknown = Reflect.get(globalThis, 'clearTimeout');
  // Checked to be a function; it's the runtime's clearTimeout.
  if (timer !== undefined && typeof platform === 'function') (platform as typeof globalThis.clearTimeout)(timer);
}
