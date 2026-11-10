/**
 * IDs are adopted when they look like what Prebid.js and the older PubCID scripts write, and are safe to put in a
 * cookie: a letter or digit, then letters, digits, `.`, `_` or `-`, up to 128 characters. Prebid.js writes UUID v4s.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidId(value: string | undefined): value is string {
  return value !== undefined && ID_PATTERN.test(value);
}

/** A new random ID, in the same format Prebid.js generates (UUID v4). */
export function mintId(): string {
  return crypto.randomUUID();
}

const ID_PARAM_PREFIX = 'pubcid:';

/**
 * The ID from the `id` query parameter Prebid.js's `sharedIdSystem` adds to `pixelUrl`: `pubcid:<id>`.
 * Prebid.js percent-encodes the value before building the URL, so after the URL parser's own decoding it can
 * still arrive as `pubcid%3A<id>`; this decodes up to twice more.
 */
export function idFromSyncParam(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  let value = raw;
  for (let i = 0; i < 2 && value.includes('%'); i++) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  if (!value.startsWith(ID_PARAM_PREFIX)) return undefined;
  const id = value.slice(ID_PARAM_PREFIX.length);
  return isValidId(id) ? id : undefined;
}
