import type { Download, DownloadContext } from './update.js';

/** HTTP for update sources: bounded bodies, conditional requests, and redirects that never carry credentials across origins. */

/** Bound response bodies, including chunked downloads. fetch's AbortSignal also covers reading the body. */
export async function bytes(response: Response, limit: number = 64 * 1024 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError('Missing download body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Invalid download stream');
      length += chunk.byteLength;
      if (length > limit) throw new RangeError('Download is too large');
      chunks.push(chunk);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function get(url: string, context: DownloadContext, authorization?: string): Promise<Response> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('Authorization', authorization);
  if (context.previous?.url === url && context.previous.etag !== undefined) headers.set('If-None-Match', context.previous.etag);
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    context.signal.throwIfAborted();
    const response = await context.fetch(current.href, { headers: new Headers(headers), signal: context.signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (location === null) throw new TypeError('Redirect has no location');
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || next.username !== '' || next.password !== '') throw new TypeError('Invalid redirect');
    // Workers and other Fetch implementations differ in automatic header forwarding: enforce the boundary here.
    if (next.origin !== current.origin) headers.delete('Authorization');
    current = next;
  }
  throw new TypeError('Too many redirects');
}

/** Release the connection before failing on an error status, as the redirect and 404 paths do. */
export async function requireOk(response: Response, message: string): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(message);
}

export async function downloaded(response: Response, url: string): Promise<Download> {
  await requireOk(response, 'Download failed');
  const etag = response.headers.get('ETag');
  return { bytes: await bytes(response), url, ...(etag === null ? {} : { etag }) };
}

export function checkNotModified(url: string, context: DownloadContext): void {
  if (context.previous?.url !== url || context.previous.etag === undefined) throw new TypeError('Unexpected conditional response');
}
