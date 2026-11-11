// Minimal implementations of the web-standard classes core and the modules use (Headers, Request, Response, URL,
// URLSearchParams), for EdgeWorkers, which runs ECMAScript without the web platform's globals. The bundle uses
// these in place of the globals (src/globals.ts, esbuild's `inject`). They cover what SharedID Edge calls, following
// the WHATWG Fetch and URL standards for it; they aren't general-purpose polyfills. Unit tests compare them with
// Node.js's own.

type HeadersInit = Headers | Iterable<readonly [string, string]> | Readonly<Record<string, string>>;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_VALUE = /[\0\r\n]/;

function headerName(name: string): string {
  if (!TOKEN.test(name)) throw new TypeError('Invalid header name');
  return name.toLowerCase();
}

function headerValue(value: string): string {
  const trimmed = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (INVALID_VALUE.test(trimmed)) throw new TypeError('Invalid header value');
  return trimmed;
}

/** The Fetch standard's `Headers`: names are case-insensitive, and each `Set-Cookie` stays separate. */
export class Headers {
  readonly #list: [name: string, value: string][] = [];

  constructor(init?: HeadersInit) {
    if (init === undefined) return;
    // A Headers is iterable too, with each Set-Cookie separate.
    if (Symbol.iterator in init) {
      for (const [name, value] of init) this.append(name, value);
    } else {
      for (const [name, value] of Object.entries(init)) this.append(name, value);
    }
  }

  append(name: string, value: string): void {
    this.#list.push([headerName(name), headerValue(value)]);
  }

  delete(name: string): void {
    const key = headerName(name);
    for (let i = this.#list.length - 1; i >= 0; i--) {
      if (this.#list[i]?.[0] === key) this.#list.splice(i, 1);
    }
  }

  get(name: string): string | null {
    const key = headerName(name);
    const values = this.#list.filter(([n]) => n === key).map(([, value]) => value);
    return values.length === 0 ? null : values.join(', ');
  }

  getSetCookie(): string[] {
    return this.#list.filter(([n]) => n === 'set-cookie').map(([, value]) => value);
  }

  has(name: string): boolean {
    const key = headerName(name);
    return this.#list.some(([n]) => n === key);
  }

  set(name: string, value: string): void {
    const key = headerName(name);
    const normalized = headerValue(value);
    const index = this.#list.findIndex(([n]) => n === key);
    if (index < 0) {
      this.#list.push([key, normalized]);
      return;
    }
    this.#list[index] = [key, normalized];
    for (let i = this.#list.length - 1; i > index; i--) {
      if (this.#list[i]?.[0] === key) this.#list.splice(i, 1);
    }
  }

  /** Sorted by name, with repeated headers combined, except `Set-Cookie`, which is one entry per cookie. */
  *entries(): IterableIterator<[string, string]> {
    const names = [...new Set(this.#list.map(([n]) => n))].sort();
    for (const name of names) {
      if (name === 'set-cookie') {
        for (const cookie of this.getSetCookie()) yield [name, cookie];
      } else {
        yield [name, this.get(name) ?? ''];
      }
    }
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this.entries()) yield name;
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  forEach(callback: (value: string, name: string, headers: Headers) => void): void {
    for (const [name, value] of this.entries()) callback(value, name, this);
  }
}

type BodyInit = string | Uint8Array | ArrayBuffer;

interface ResponseInit {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: HeadersInit;
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** The Fetch standard's `Response`, with the body held in memory. */
export class Response {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly #body: Uint8Array | null;

  constructor(body: BodyInit | null = null, init: ResponseInit = {}) {
    const status = init.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new RangeError('Invalid response status');
    this.status = status;
    this.statusText = init.statusText ?? '';
    this.headers = new Headers(init.headers);
    if (body !== null && NULL_BODY_STATUSES.has(status)) throw new TypeError('Response with a null body status cannot have a body');
    if (typeof body === 'string') {
      this.#body = new TextEncoder().encode(body);
      if (!this.headers.has('content-type')) this.headers.set('content-type', 'text/plain;charset=UTF-8');
    } else if (body instanceof ArrayBuffer) {
      this.#body = new Uint8Array(body.slice(0));
    } else {
      this.#body = body === null ? null : body.slice();
    }
  }

  get ok(): boolean {
    return this.status >= 200 && this.status <= 299;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.#body ?? new Uint8Array();
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return Promise.resolve(copy);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }
}

interface RequestInit {
  readonly method?: string;
  readonly headers?: HeadersInit;
}

const NORMALIZED_METHODS: ReadonlySet<string> = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

/** The Fetch standard's `Request`, without a body: SharedID Edge answers only GET, HEAD and OPTIONS. */
export class Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;

  constructor(input: string | URL, init: RequestInit = {}) {
    this.url = new URL(String(input)).href;
    const method = init.method ?? 'GET';
    if (!TOKEN.test(method)) throw new TypeError('Invalid request method');
    this.method = NORMALIZED_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : method;
    this.headers = new Headers(init.headers);
  }
}

/** Percent-decodes `value` as UTF-8; a `%` that doesn't start a valid sequence stays as it is. */
function percentDecode(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return '�';
    }
  });
}

/** The URL standard's `URLSearchParams` (application/x-www-form-urlencoded), read-only. */
export class URLSearchParams {
  readonly #list: [name: string, value: string][] = [];

  constructor(init = '') {
    const query = init.startsWith('?') ? init.slice(1) : init;
    for (const pair of query.split('&')) {
      if (pair === '') continue;
      const equals = pair.indexOf('=');
      const name = equals < 0 ? pair : pair.slice(0, equals);
      const value = equals < 0 ? '' : pair.slice(equals + 1);
      this.#list.push([percentDecode(name.replace(/\+/g, ' ')), percentDecode(value.replace(/\+/g, ' '))]);
    }
  }

  get size(): number {
    return this.#list.length;
  }

  get(name: string): string | null {
    return this.#list.find(([n]) => n === name)?.[1] ?? null;
  }

  getAll(name: string): string[] {
    return this.#list.filter(([n]) => n === name).map(([, value]) => value);
  }

  has(name: string): boolean {
    return this.#list.some(([n]) => n === name);
  }

  /** In order, as in the query. */
  entries(): IterableIterator<[string, string]> {
    return this.#list.map(([name, value]): [string, string] => [name, value]).values();
  }

  forEach(callback: (value: string, name: string, params: URLSearchParams) => void): void {
    this.#list.forEach(([name, value]) => { callback(value, name, this); });
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
}

const SPECIAL_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const FORBIDDEN_HOST = /[\0\t\n\r #/:<>?@[\\\]^|%]/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

/** Percent-encodes what the URL standard encodes in a path, query or fragment: controls, space, `"<>` and non-ASCII. */
function encodeSet(value: string, extra: RegExp): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code <= 0x20 || code >= 0x7f || char === '"' || char === '<' || char === '>' || extra.test(char) ? encodeURIComponent(char) : char;
  }
  return out;
}

/** Resolves `.` and `..` segments in an absolute path. */
function normalizePath(path: string): string {
  const out: string[] = [];
  const segments = path.split('/').slice(1);
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    const lower = segment.toLowerCase();
    if (segment === '..' || lower === '%2e%2e' || lower === '.%2e' || lower === '%2e.') {
      out.pop();
      if (last) out.push('');
    } else if (segment === '.' || lower === '%2e') {
      if (last) out.push('');
    } else {
      out.push(segment);
    }
  });
  return `/${out.join('/')}`;
}

/**
 * The URL standard's `URL`, for absolute URLs with a host (`https://www.example.com/_sid/v1?gdpr=1`) and paths
 * relative to one. Scheme and host are lowercased, a default port is dropped, dot segments are resolved, and what the
 * standard percent-encodes is encoded. Read-only. Not supported (a `TypeError`, like an invalid URL): internationalized
 * domain names, and relative references other than `/path`, `?query` and `#fragment`.
 */
export class URL {
  readonly protocol: string;
  readonly username: string = '';
  readonly password: string = '';
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: URLSearchParams;

  constructor(url: string | URL, base?: string | URL) {
    // Leading and trailing controls and spaces are dropped, and tabs and newlines removed, as the standard says.
    let input = String(url).replace(/^[\0- ]+|[\0- ]+$/g, '').replace(/[\t\n\r]/g, '');
    if (!SCHEME.test(input)) {
      if (base === undefined) throw new TypeError('Invalid URL');
      const parent = base instanceof URL ? base : new URL(base);
      if (input.startsWith('/') && !input.startsWith('//')) input = `${parent.origin}${input}`;
      else if (input.startsWith('?')) input = `${parent.origin}${parent.pathname}${input}`;
      else if (input.startsWith('#')) input = `${parent.origin}${parent.pathname}${parent.search}${input}`;
      else throw new TypeError('Invalid URL');
    }
    const scheme = SCHEME.exec(input)?.[1]?.toLowerCase() ?? '';
    this.protocol = `${scheme}:`;
    let rest = input.slice(scheme.length + 1);
    const special = this.protocol in SPECIAL_PORTS;
    if (special) rest = rest.replace(/\\/g, '/');
    if (!rest.startsWith('//')) throw new TypeError('Invalid URL');
    rest = rest.slice(2);
    const hashAt = rest.indexOf('#');
    const fragment = hashAt < 0 ? undefined : rest.slice(hashAt + 1);
    if (hashAt >= 0) rest = rest.slice(0, hashAt);
    const queryAt = rest.indexOf('?');
    const query = queryAt < 0 ? undefined : rest.slice(queryAt + 1);
    if (queryAt >= 0) rest = rest.slice(0, queryAt);
    const slash = rest.indexOf('/');
    let authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash);
    // Credentials aren't kept: SharedID Edge never uses them, and they're never part of an origin.
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1);
    const portAt = authority.startsWith('[') ? authority.indexOf(':', authority.indexOf(']')) : authority.lastIndexOf(':');
    const host = (portAt < 0 ? authority : authority.slice(0, portAt)).toLowerCase();
    const port = portAt < 0 ? '' : authority.slice(portAt + 1);
    if (host.startsWith('[') ? !IPV6.test(host) : FORBIDDEN_HOST.test(host)) throw new TypeError('Invalid URL');
    if (special && host === '') throw new TypeError('Invalid URL');
    if (port !== '' && (!/^\d+$/.test(port) || Number(port) > 65_535)) throw new TypeError('Invalid URL');
    this.hostname = host;
    this.port = port === '' || String(Number(port)) === SPECIAL_PORTS[this.protocol] ? '' : String(Number(port));
    this.pathname = path === '' ? (special ? '/' : '') : normalizePath(encodeSet(path, /[#?{}`]/));
    this.search = query === undefined || query === '' ? '' : `?${encodeSet(query, special ? /[#']/ : /#/)}`;
    this.hash = fragment === undefined || fragment === '' ? '' : `#${encodeSet(fragment, /`/)}`;
    this.searchParams = new URLSearchParams(this.search);
  }

  get host(): string {
    return this.port === '' ? this.hostname : `${this.hostname}:${this.port}`;
  }

  /** The origin: scheme, host and port for http(s), ws(s) and ftp URLs, and `null` for others, as in the standard. */
  get origin(): string {
    return this.protocol in SPECIAL_PORTS ? `${this.protocol}//${this.host}` : 'null';
  }

  get href(): string {
    return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`;
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }
}

/** A version 4 UUID, in `crypto.randomUUID()`'s format, from 16 random bytes. */
export function uuidFromBytes(random: Uint8Array): string {
  if (random.byteLength !== 16) throw new RangeError('A UUID needs 16 random bytes');
  const bytes = random.slice();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
