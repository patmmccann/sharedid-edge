// What AWS Emulator's Lambda runtime lacks of Node.js 24's globals, and the bundle uses: the Fetch API classes
// (Headers, Request, Response) and WebCrypto's HMAC (crypto.subtle.importKey and sign, which the ec module uses).
//
// Lambda's nodejs24.x runtime is Node.js 24, which has both. AWS Emulator runs a nodejs* function's code in an embedded
// JavaScript engine with Node.js's core modules, but no Fetch API and only digest() in crypto.subtle, so the unmodified
// bundle would fail on its first `new Headers()`. aws-emulator.ts puts this file in the function's archive and preloads
// it through NODE_OPTIONS (`--require`), which the emulator applies as Node.js does, so the bundle under test stays
// byte for byte the one deployed to AWS. It installs nothing the runtime already has, so on real Lambda (or a future
// emulator release that adds them) it does nothing.
//
// Only what core, the modules and the Lambda adapter use is implemented. Headers follow the Fetch standard's rules:
// lowercase names, values trimmed, repeated values joined with ", " by get(), iteration in sorted name order with each
// Set-Cookie separate, and getSetCookie(). HMAC uses node:crypto's createHmac, which the emulator has.
import { createHmac } from 'node:crypto';

type HeadersInput = Iterable<readonly [string, string]> | Readonly<Record<string, string>> | ShimHeaders;
type BodyInput = string | Uint8Array | ArrayBuffer | null | undefined;

function normalizeValue(value: string): string {
  return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
}

class ShimHeaders {
  readonly #entries: [name: string, value: string][] = [];

  constructor(init?: HeadersInput) {
    if (init === undefined) return;
    const pairs: Iterable<readonly [string, string]> = init instanceof ShimHeaders
      ? init.#entries
      : Symbol.iterator in init ? init : Object.entries(init);
    for (const [name, value] of pairs) this.append(name, value);
  }

  append(name: string, value: string): void {
    this.#entries.push([name.toLowerCase(), normalizeValue(value)]);
  }

  set(name: string, value: string): void {
    this.delete(name);
    this.append(name, value);
  }

  delete(name: string): void {
    const key = name.toLowerCase();
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]?.[0] === key) this.#entries.splice(i, 1);
    }
  }

  get(name: string): string | null {
    const key = name.toLowerCase();
    const values = this.#entries.filter(([entry]) => entry === key).map(([, value]) => value);
    return values.length === 0 ? null : values.join(', ');
  }

  has(name: string): boolean {
    const key = name.toLowerCase();
    return this.#entries.some(([entry]) => entry === key);
  }

  getSetCookie(): string[] {
    return this.#entries.filter(([name]) => name === 'set-cookie').map(([, value]) => value);
  }

  /** Sorted by name, repeated names combined, except Set-Cookie: each one is its own entry. */
  *entries(): IterableIterator<[string, string]> {
    const names = [...new Set(this.#entries.map(([name]) => name))].sort();
    for (const name of names) {
      if (name === 'set-cookie') {
        for (const value of this.getSetCookie()) yield [name, value];
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

  forEach(callback: (value: string, name: string, headers: ShimHeaders) => void): void {
    for (const [name, value] of this.entries()) callback(value, name, this);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
}

function toBytes(body: BodyInput): Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/** The body methods Request and Response share. */
class ShimBody {
  readonly #bytes: Uint8Array | null;

  constructor(body: BodyInput) {
    this.#bytes = toBytes(body);
  }

  /** Not a stream, as nothing here reads it as one; only whether there is a body (`null` when there's none). */
  get body(): Uint8Array | null {
    return this.#bytes;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.#bytes ?? new Uint8Array();
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return Promise.resolve(copy);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: HeadersInput;
  readonly body?: BodyInput;
}

class ShimRequest extends ShimBody {
  readonly url: string;
  readonly method: string;
  readonly headers: ShimHeaders;

  constructor(input: string | URL, init: RequestOptions = {}) {
    super(init.body);
    this.url = new URL(String(input)).href;
    this.method = (init.method ?? 'GET').toUpperCase();
    this.headers = new ShimHeaders(init.headers);
  }
}

interface ResponseOptions {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: HeadersInput;
}

class ShimResponse extends ShimBody {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ShimHeaders;

  constructor(body?: BodyInput, init: ResponseOptions = {}) {
    super(body);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = new ShimHeaders(init.headers);
    if (typeof body === 'string' && !this.headers.has('content-type')) this.headers.set('content-type', 'text/plain;charset=UTF-8');
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
}

const classes: Readonly<Record<string, unknown>> = { Headers: ShimHeaders, Request: ShimRequest, Response: ShimResponse };
for (const [name, value] of Object.entries(classes)) {
  if (!(name in globalThis)) Reflect.set(globalThis, name, value);
}

/** An HMAC key from importKey: the raw key bytes and the hash, which sign() reads back. */
interface HmacKey {
  readonly type: 'secret';
  readonly algorithm: { readonly name: 'HMAC'; readonly hash: { readonly name: string } };
  readonly raw: Uint8Array;
}

function hashName(algorithm: unknown): string {
  const hash: unknown = typeof algorithm === 'object' && algorithm !== null ? Reflect.get(algorithm, 'hash') : undefined;
  const name: unknown = typeof hash === 'object' && hash !== null ? Reflect.get(hash, 'name') : hash;
  if (typeof name !== 'string') throw new TypeError('HMAC needs a hash');
  return name;
}

function bytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const hmac = {
  importKey(format: string, keyData: ArrayBuffer | ArrayBufferView, algorithm: unknown): Promise<HmacKey> {
    if (format !== 'raw') return Promise.reject(new TypeError('only raw HMAC keys are supported here'));
    return Promise.resolve({ type: 'secret', algorithm: { name: 'HMAC', hash: { name: hashName(algorithm) } }, raw: bytes(keyData).slice() });
  },
  sign(_algorithm: unknown, key: HmacKey, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    // node:crypto names SHA-256 "sha256".
    const mac = createHmac(key.algorithm.hash.name.replace('-', '').toLowerCase(), key.raw).update(bytes(data)).digest();
    const copy = new ArrayBuffer(mac.byteLength);
    new Uint8Array(copy).set(mac);
    return Promise.resolve(copy);
  }
};
const subtle: unknown = Reflect.get(globalThis.crypto, 'subtle');
if (typeof subtle === 'object' && subtle !== null) {
  for (const [name, value] of Object.entries(hmac)) {
    if (!(name in subtle)) Reflect.set(subtle, name, value);
  }
}
