// A local stand-in for Akamai EdgeWorkers, for running the conformance suite against the bundled EdgeWorker
// (packages/adapters/akamai/deploy/main.js) without an Akamai account. The bundle runs as EdgeWorkers runs it: an
// ECMAScript module in a V8 context of its own (node:vm, so it needs --experimental-vm-modules), with ECMAScript's
// globals and none of the web platform's or Node.js's (no URL, Request, TextEncoder, crypto, setTimeout or fetch),
// and its imports of EdgeWorkers' built-in modules (create-response, streams, encoding, crypto, log) answered by the
// stand-ins below. Each HTTP request becomes an EdgeWorkers request object for its `responseProvider`: the method,
// scheme, host, URL and headers, `clientIp`, EdgeScape's `userLocation`, and `getVariable`, which reads the property's
// PMUSER_SID_* variables from the case's SID_* settings. The value it resolves to (from createResponse) is written back.
//
// Started by targets.ts with the case file's configuration as environment variables, plus PORT, SID_PUBLIC_ORIGIN
// and CONFORMANCE_AKAMAI_BUNDLE (the bundle's directory: deploy, deploy-bowser or deploy-vendor).
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import { formatWithOptions } from 'node:util';
import { SourceTextModule, SyntheticModule, createContext, type Context, type Module } from 'node:vm';
import type { EdgeWorkerRequest, EdgeWorkerUserLocation } from '@sharedid-edge/akamai';
import { caseClientIp, caseLocation, emulatorPort, serve, trustProxyFromEnv, type CaseLocationHeader } from './emulator.js';

const BUNDLE_DIR = ['deploy-bowser', 'deploy-vendor'].find(dir => dir === process.env['CONFORMANCE_AKAMAI_BUNDLE']) ?? 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/akamai', BUNDLE_DIR, 'main.js');

/** A string body passed to createResponse is limited to 16 KB. */
const MAX_STRING_BODY = 16 * 1024;

/** What createResponse returned: opaque to the EdgeWorker, read back here. */
interface CreatedResponse {
  readonly status: number;
  readonly headers: readonly [name: string, value: string][];
  readonly body: string | ReadableStream<unknown>;
}

const created = new WeakMap<object, CreatedResponse>();

/**
 * The create-response built-in module's createResponse(status, headers, body), checking its arguments as the
 * documentation describes (it throws on invalid ones): a status of 100 to 599, header values that are strings or
 * arrays of strings (one per header line), and a body that is a string of at most 16 KB or a ReadableStream.
 */
function createResponse(status: unknown, headers: unknown, body: unknown): object {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) throw new TypeError('createResponse: invalid status');
  if (typeof headers !== 'object' || headers === null) throw new TypeError('createResponse: headers must be an object');
  const lines: [string, string][] = [];
  for (const [name, value] of Object.entries(headers)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const line of values) {
      if (typeof line !== 'string') throw new TypeError(`createResponse: header ${name} must be a string or an array of strings`);
      lines.push([name, line]);
    }
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_STRING_BODY) throw new TypeError('createResponse: a string body is limited to 16 KB');
  } else if (!(body instanceof ReadableStream)) {
    throw new TypeError('createResponse: the body must be a string or a ReadableStream');
  }
  const opaque = Object.freeze({});
  created.set(opaque, { status, headers: lines, body });
  return opaque;
}

/** The log built-in module's logger, whose methods take a format string and values: to stderr. */
function log(level: string): (format: string, ...values: unknown[]) => void {
  return (format, ...values) => { console.error(`edgeworker ${level}: ${formatWithOptions({ colors: false }, format, ...values)}`); };
}

/** The built-in modules the EdgeWorker may import, by name, with the exports the documentation describes. */
const BUILT_IN_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'create-response': { createResponse },
  streams: { ReadableStream },
  encoding: { TextEncoder, TextDecoder, atob, btoa },
  // Web Crypto's getRandomValues and subtle; EdgeWorkers documents no randomUUID, so there is none.
  crypto: { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: webcrypto.subtle } },
  log: { logger: { log: log('log'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), trace: log('trace') } }
};

function builtInModule(specifier: string, context: Context): Module {
  const exports = BUILT_IN_MODULES[specifier];
  if (exports === undefined) throw new Error(`the EdgeWorker imports ${specifier}, which isn't an EdgeWorkers built-in module`);
  const names = Object.keys(exports);
  return new SyntheticModule(names, function (this: SyntheticModule) {
    for (const name of names) this.setExport(name, exports[name]);
  }, { context, identifier: specifier });
}

type ResponseProvider = (request: EdgeWorkerRequest) => Promise<unknown>;

/** Loads the bundle in a context of its own and returns its responseProvider. */
async function loadResponseProvider(): Promise<ResponseProvider> {
  const context = createContext({});
  const module = new SourceTextModule(readFileSync(BUNDLE, 'utf8'), { context, identifier: pathToFileURL(BUNDLE).href });
  await module.link(specifier => builtInModule(specifier, context));
  await module.evaluate();
  const provider: unknown = Reflect.get(module.namespace, 'responseProvider');
  if (typeof provider !== 'function') throw new Error(`${BUNDLE} doesn't export responseProvider; run npm run conformance:akamai from the repository root`);
  // Checked to be a function; the bundle's responseProvider takes the request object and resolves to a response.
  return provider as ResponseProvider;
}

/**
 * The conformance cases describe the visitor's location with Cloudflare's visitor location headers. This stand-in
 * passes them the way EdgeWorkers would: as EdgeScape's `userLocation` fields. Only with SID_TRUST_PROXY, as in the
 * cases.
 */
const LOCATION_FIELDS: Readonly<Partial<Record<CaseLocationHeader, keyof EdgeWorkerUserLocation>>> = {
  'cf-ipcountry': 'country',
  'cf-region-code': 'region',
  'cf-ipcity': 'city',
  'cf-postal-code': 'zipCode',
  'cf-metro-code': 'dma',
  'cf-iplatitude': 'latitude',
  'cf-iplongitude': 'longitude',
  'cf-timezone': 'timezone',
  'cf-ipcontinent': 'continent'
};

/**
 * The request object EdgeWorkers passes to responseProvider.
 *
 * With SID_TRUST_PROXY, the first X-Forwarded-For entry is the connecting address, as for every target, and is
 * removed; any further entries reach the EdgeWorker as the X-Forwarded-For header the visitor sent. For such a
 * request this stand-in does what Akamai documents or allows: `userLocation` describes the forwarded address
 * (here, the case's location stands for it), and `clientIp` is the forwarded address too (Akamai lets
 * X-Forwarded-For override its client IP, AK_CLIENT_IP, and doesn't say whether `clientIp` follows). The property
 * rule in the adapter's README sets PMUSER_SID_CLIENT_IP to the connecting address (AK_CLIENT_REAL_IP), so
 * getVariable returns it; the other PMUSER_SID_* variables are the case's SID_* settings.
 */
function toRequest(req: IncomingMessage, trustProxy: boolean): EdgeWorkerRequest {
  const headers: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (values !== undefined) headers[name] = [...values];
  }
  const connecting = caseClientIp(req, trustProxy);
  let forwarded: string | undefined;
  if (trustProxy) {
    const rest = (headers['x-forwarded-for'] ?? []).join(',').split(',').slice(1).map(entry => entry.trim()).filter(entry => entry !== '');
    forwarded = rest[0];
    if (rest.length > 0) headers['x-forwarded-for'] = [rest.join(', ')];
    else Reflect.deleteProperty(headers, 'x-forwarded-for');
  }
  const userLocation: Record<string, string> = {};
  for (const [field, value] of caseLocation(req, trustProxy, LOCATION_FIELDS)) userLocation[field] = value;
  const clientIp = forwarded ?? connecting;
  return {
    method: req.method ?? 'GET',
    scheme: 'http',
    host: req.headers.host ?? '',
    url: req.url ?? '/',
    ...(clientIp === undefined ? {} : { clientIp }),
    userLocation,
    getHeaders: () => headers,
    getVariable: name => {
      if (name === 'PMUSER_SID_CLIENT_IP') return connecting;
      // PMUSER_SID_BASE_PATH reads SID_BASE_PATH, and so on. Variables that don't exist are undefined.
      return name.startsWith('PMUSER_SID_') ? process.env[name.slice('PMUSER_'.length)] : undefined;
    }
  };
}

/** The bytes of a stream body: chunks must be bytes (Uint8Arrays, from the EdgeWorker's own context). */
async function streamBytes(stream: ReadableStream<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!ArrayBuffer.isView(chunk)) throw new TypeError('createResponse: the body stream must be bytes');
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks);
}

const responseProvider = await loadResponseProvider();
const trustProxy = trustProxyFromEnv();
serve(emulatorPort(), 'EdgeWorker failed', async (req, res) => {
  const value = await responseProvider(toRequest(req, trustProxy));
  const result = typeof value === 'object' && value !== null ? created.get(value) : undefined;
  if (result === undefined) throw new Error('responseProvider must resolve to a createResponse result');
  const headers: Record<string, string[]> = {};
  for (const [name, value] of result.headers) (headers[name.toLowerCase()] ??= []).push(value);
  const body = typeof result.body === 'string' ? Buffer.from(result.body) : await streamBytes(result.body);
  res.writeHead(result.status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
});
