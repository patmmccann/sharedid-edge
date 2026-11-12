// Minimal implementations of the web-standard classes core and the built-in modules use (Headers, Request, Response,
// URL), for EdgeWorkers, which runs ECMAScript without the web platform's globals. The bundle uses these in place of
// the globals (src/globals.ts, esbuild's `inject`). They implement only what SharedID Edge calls, as the WHATWG
// Fetch and URL standards define it, to keep the bundle small: they aren't polyfills. Unit tests compare them with
// Node.js's own. A module that needs more of these APIs must add it here, with a test.

type HeadersInit = Iterable<readonly [string, string]> | Readonly<Record<string, string>>;

/** The Fetch standard's `Headers`: names are case-insensitive, and each `Set-Cookie` stays separate. */
export class Headers {
  #list: [name: string, value: string][] = [];

  constructor(init?: HeadersInit) {
    if (init === undefined) return;
    for (const [name, value] of Symbol.iterator in init ? init : Object.entries(init)) this.append(name, value);
  }

  append(name: string, value: string): void {
    this.#list.push([name.toLowerCase(), value.trim()]);
  }

  get(name: string): string | null {
    const values = this.#values(name);
    // Cookie lines join with "; ", as in Node.js (undici) and browsers.
    return values.length === 0 ? null : values.join(name.toLowerCase() === 'cookie' ? '; ' : ', ');
  }

  getSetCookie(): string[] {
    return this.#values('set-cookie');
  }

  has(name: string): boolean {
    return this.#values(name).length > 0;
  }

  set(name: string, value: string): void {
    const key = name.toLowerCase();
    this.#list = this.#list.filter(([n]) => n !== key);
    this.append(key, value);
  }

  /** Sorted by name, with repeated headers combined, except `Set-Cookie`, which is one call per cookie. */
  forEach(callback: (value: string, name: string, headers: Headers) => void): void {
    for (const name of [...new Set(this.#list.map(([n]) => n))].sort()) {
      for (const value of name === 'set-cookie' ? this.getSetCookie() : [this.get(name) ?? '']) callback(value, name, this);
    }
  }

  #values(name: string): string[] {
    const key = name.toLowerCase();
    return this.#list.filter(([n]) => n === key).map(([, value]) => value);
  }
}

/** The Fetch standard's `Response`, with the body held in memory. */
export class Response {
  readonly status: number;
  readonly headers: Headers;
  readonly #body: Uint8Array;

  constructor(body: string | Uint8Array | null = null, init: { readonly status?: number; readonly headers?: HeadersInit } = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.#body = typeof body === 'string' ? new TextEncoder().encode(body) : body ?? new Uint8Array();
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new ArrayBuffer(this.#body.byteLength);
    new Uint8Array(copy).set(this.#body);
    return Promise.resolve(copy);
  }
}

/** The Fetch standard's `Request`, without a body: SharedID Edge answers only GET, HEAD and OPTIONS. */
export class Request {
  readonly method: string;
  readonly headers: Headers;

  constructor(readonly url: string, init: { readonly method?: string; readonly headers?: HeadersInit } = {}) {
    this.method = init.method ?? 'GET';
    this.headers = new Headers(init.headers);
  }
}

/** Percent-decodes `value` as UTF-8; a `%` that doesn't start a valid sequence stays as it is. */
function percentDecode(value: string): string {
  return value.replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return '�';
    }
  });
}

/** The URL standard's `URLSearchParams` (application/x-www-form-urlencoded), as far as core reads it: `get`. */
export class URLSearchParams {
  readonly #query: string;

  constructor(query: string) {
    this.#query = query.replace(/^\?/, '');
  }

  get(name: string): string | null {
    for (const pair of this.#query.split('&')) {
      const equals = pair.indexOf('=');
      if (pair !== '' && percentDecode(equals < 0 ? pair : pair.slice(0, equals)) === name) {
        return equals < 0 ? '' : percentDecode(pair.slice(equals + 1));
      }
    }
    return null;
  }
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
const ABSOLUTE = /^([A-Za-z][A-Za-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/;
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[^\0\t\n\r #/:<>?@[\\\]^|%]+)$/;

/** Resolves `.` and `..` segments in an absolute path. */
function normalizePath(path: string): string {
  const out: string[] = [];
  const segments = path.split('/').slice(1);
  segments.forEach((segment, i) => {
    const dots = segment.replace(/%2e/gi, '.');
    if (dots === '..') out.pop();
    if (dots !== '..' && dots !== '.') out.push(segment);
    else if (i === segments.length - 1) out.push('');
  });
  return `/${out.join('/')}`;
}

/**
 * The URL standard's `URL`, for what core reads: absolute URLs with a host (`https://www.example.com/_sid/v1?gdpr=1`),
 * their `protocol`, `hostname`, `port`, `pathname`, `searchParams` and `origin`. Scheme and host are lowercased, a
 * default port is dropped and dot segments are resolved. Anything else is a `TypeError`, as an invalid URL is:
 * relative URLs, internationalized domain names, credentials.
 */
export class URL {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;

  constructor(url: string) {
    const match = ABSOLUTE.exec(url);
    const [, scheme = '', authority = '', path = '', query = ''] = match ?? [];
    const portAt = authority.lastIndexOf(':');
    const hasPort = portAt > authority.lastIndexOf(']');
    const host = (hasPort ? authority.slice(0, portAt) : authority).toLowerCase();
    const port = hasPort ? authority.slice(portAt + 1) : '';
    if (match === null || !HOST.test(host) || !/^\d{0,5}$/.test(port) || Number(port) > 65_535) throw new TypeError('Invalid URL');
    this.protocol = scheme.toLowerCase();
    this.hostname = host;
    this.port = port === '' || String(Number(port)) === DEFAULT_PORTS[this.protocol] ? '' : String(Number(port));
    this.pathname = normalizePath(path === '' ? '/' : path);
    this.searchParams = new URLSearchParams(query);
  }

  /** Scheme, host and port for http(s), ws(s) and ftp URLs, and `null` for others, as in the standard. */
  get origin(): string {
    return this.protocol in DEFAULT_PORTS ? `${this.protocol}//${this.hostname}${this.port === '' ? '' : `:${this.port}`}` : 'null';
  }
}

/** A version 4 UUID, in `crypto.randomUUID()`'s format, from 16 random bytes. */
export function uuidFromBytes(random: Uint8Array): string {
  const hex = Array.from(random, (byte, i) => (i === 6 ? (byte & 0x0f) | 0x40 : i === 8 ? (byte & 0x3f) | 0x80 : byte).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
