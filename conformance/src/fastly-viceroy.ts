// Runs the conformance suite against the real Fastly Compute package (packages/adapters/fastly/deploy/main.wasm) in
// Viceroy, Fastly's local runtime (https://github.com/fastly/Viceroy), with no Fastly account. Viceroy runs the
// WebAssembly as Fastly Compute does: the adapter gets the client address from the connection and the location from
// Viceroy's geolocation data, never from request headers. So a relay in front of Viceroy turns each case's client IP
// and location into a connection:
//
// - The location becomes a `[local_server.geolocation.addresses."<ip>"]` entry in the fastly.toml Viceroy runs with,
//   in Fastly's field names (country_code, region, city, …). An address without a location gets an empty entry, since
//   Viceroy would otherwise give it its default location (San Francisco).
// - The request goes to Viceroy from that address (the socket's local address). A case's own client IP (with
//   SID_TRUST_PROXY, the first X-Forwarded-For entry) is used as it is, so it must be an address of this machine: on
//   Linux, `sudo ip route add local 192.0.2.0/24 dev lo` makes a whole range local, as CI does for the ranges the cases
//   use. Requests that name none come from a loopback address per location (127.0.0.1, 127.0.0.2, …), which works
//   everywhere.
// - IPv6 addresses go to a second Viceroy, listening on [::1].
//
// The entries are seeded from the case file's requests, so Viceroy usually starts once per file; when a request needs
// a location its address's entry doesn't have, Viceroy restarts with it. The case's SID_* settings become the config
// store `sharedid_config`, and SID_MODULE_SECRETS and SID_UPSTREAM_SECRETS the secret store `sharedid_secrets`, as the
// adapter's README sets them up (`stores: false` links neither, for fastly-checks.ts). The Cloudflare location headers the cases send, and the
// first X-Forwarded-For entry, are dropped: they describe the connection, which is real here.
//
// Runs in the runner's process (targets.ts), so stopping the target stops Viceroy too.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseClientIp, caseLocation, freePort, readBody, serve, type CaseLocationHeader } from './emulator.js';

/** The case location headers, as Fastly's geolocation fields. Fastly has no IANA time zone, so `cf-timezone` has none. */
const GEO_FIELDS: Readonly<Partial<Record<CaseLocationHeader, string>>> = {
  'cf-ipcountry': 'country_code',
  'cf-region-code': 'region',
  'cf-ipcity': 'city',
  'cf-postal-code': 'postal_code',
  'cf-metro-code': 'metro_code',
  'cf-iplatitude': 'latitude',
  'cf-iplongitude': 'longitude',
  'cf-ipcontinent': 'continent'
};

/** A geolocation entry, as sorted TOML key-value lines; empty for an address without a location. */
type Geo = readonly string[];

/** A TOML string (TOML's basic strings take JSON's escapes). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Fastly's geolocation for the case's location: strings as they are, but the postal code in lowercase, as Fastly gives
 * it; numbers as TOML numbers, left out when the case's value isn't one (Fastly has numbers, so a case's malformed
 * coordinate is a location Fastly doesn't have).
 */
function geoEntry(location: readonly (readonly [field: string, value: string])[]): Geo {
  const lines: string[] = [];
  for (const [field, value] of location) {
    if (field === 'metro_code') {
      if (/^\d+$/.test(value.trim())) lines.push(`metro_code = ${String(Number(value))}`);
    } else if (field === 'latitude' || field === 'longitude') {
      const n = value.trim() === '' ? Number.NaN : Number(value);
      if (Number.isFinite(n)) lines.push(`${field} = ${Number.isInteger(n) ? n.toFixed(1) : String(n)}`);
    } else {
      lines.push(`${field} = ${tomlString(field === 'postal_code' ? value.toLowerCase() : value)}`);
    }
  }
  return lines.sort();
}

interface Relayed {
  readonly status: number;
  /** Raw headers: name, value, name, value… */
  readonly headers: string[];
  readonly body: Buffer;
}

/** One Viceroy, for IPv4 (on 127.0.0.1) or IPv6 (on [::1]), with its geolocation entries. */
class Viceroy {
  readonly geo = new Map<string, Geo>();
  #child: ChildProcess | undefined;
  #port = 0;
  readonly #host: string;

  constructor(
    ipv6: boolean,
    private readonly binary: string,
    private readonly wasm: string,
    private readonly dir: string,
    private readonly stores: readonly string[]
  ) {
    this.#host = ipv6 ? '::1' : '127.0.0.1';
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** (Re)starts Viceroy with the current entries, and waits until it answers. */
  async start(): Promise<void> {
    await this.stop();
    this.#port = await freePort(this.#host);
    const config = join(this.dir, `fastly-${this.#host === '::1' ? 'v6' : 'v4'}.toml`);
    const lines = ['manifest_version = 3', 'name = "sharedid-edge-conformance"', 'language = "javascript"', ...this.stores, '[local_server.geolocation]', 'format = "inline-toml"'];
    for (const [address, entry] of this.geo) lines.push(`[local_server.geolocation.addresses.${tomlString(address)}]`, ...entry);
    writeFileSync(config, `${lines.join('\n')}\n`);
    const addr = this.#host === '::1' ? `[::1]:${String(this.#port)}` : `127.0.0.1:${String(this.#port)}`;
    const child = spawn(this.binary, ['serve', '-C', config, '--addr', addr, this.wasm], { stdio: ['ignore', 'ignore', 'inherit'] });
    this.#child = child;
    const failed = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', code => { reject(new Error(`viceroy exited (${String(code)}) before it was ready`)); });
    });
    failed.catch(() => undefined);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await Promise.race([this.#ping(), failed]);
        return;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child?.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
    });
  }

  /** Any answer means Viceroy is up. */
  #ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: this.#host, port: this.#port, path: '/__conformance_ready' }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Sends a request to Viceroy from the address `from`. */
  forward(method: string, path: string, from: string, headers: readonly string[], body: Buffer): Promise<Relayed> {
    return new Promise((resolve, reject) => {
      const upstream = httpRequest({ host: this.#host, port: this.#port, localAddress: from, method, path, headers: [...headers] }, res => {
        readBody(res).then(bytes => {
          const out: string[] = [];
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i] ?? '';
            if (!/^(transfer-encoding|connection|keep-alive)$/i.test(name)) out.push(name, res.rawHeaders[i + 1] ?? '');
          }
          resolve({ status: res.statusCode ?? 502, headers: out, body: bytes });
        }, reject);
      });
      upstream.on('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'EADDRNOTAVAIL'
          ? new Error(`the case's client IP ${from} isn't an address of this machine (on Linux: sudo ip route add local ${from} dev lo)`)
          : error);
      });
      upstream.end(body);
    });
  }
}

export interface FastlyTargetOptions {
  /** The port the relay listens on, on 127.0.0.1. */
  readonly port: number;
  /** The case file's settings: SID_* (and SID_TRUST_PROXY, the cases' convention for the client IP and location). */
  readonly config: Readonly<Record<string, string>>;
  /** The Viceroy binary. */
  readonly viceroy: string;
  /** The Compute package's WebAssembly. */
  readonly wasm: string;
  /** The case file's request headers, to seed the geolocation entries. */
  readonly requests: readonly Readonly<Record<string, string>>[];
  /** Link the config and secret stores (default true); false checks a service without them. */
  readonly stores?: boolean;
}

/** The settings the adapter reads from the secret store, as its README sets them. */
const SECRET_SETTINGS: readonly string[] = ['SID_MODULE_SECRETS', 'SID_UPSTREAM_SECRETS'];

/** The fastly.toml lines for the stores: the settings in the config store, SECRET_SETTINGS in the secret store. */
function storeLines(config: Readonly<Record<string, string>>): string[] {
  const lines = ['[local_server.config_stores.sharedid_config]', 'format = "inline-toml"', '[local_server.config_stores.sharedid_config.contents]'];
  for (const [name, value] of Object.entries(config)) {
    if (name.startsWith('SID_') && !SECRET_SETTINGS.includes(name) && name !== 'SID_TRUST_PROXY') lines.push(`${name} = ${tomlString(value)}`);
  }
  const secrets = SECRET_SETTINGS.flatMap(name => {
    const value = config[name];
    return value === undefined ? [] : ['[[local_server.secret_stores.sharedid_secrets]]', `key = "${name}"`, `data = ${tomlString(value)}`];
  });
  return secrets.length === 0 ? [...lines, '[local_server.secret_stores]', 'sharedid_secrets = []'] : [...lines, ...secrets];
}

/** Starts Viceroy with the package and the relay in front of it; resolves once both answer, to a function that stops them. */
export async function startFastlyTarget(options: FastlyTargetOptions): Promise<() => Promise<void>> {
  const trustProxy = /^(1|true|yes|on)$/i.test(options.config['SID_TRUST_PROXY'] ?? '');
  const dir = mkdtempSync(join(tmpdir(), 'sharedid-viceroy-'));
  const stores = options.stores === false ? [] : storeLines(options.config);
  const viceroys = {
    v4: new Viceroy(false, options.viceroy, options.wasm, dir, stores),
    v6: new Viceroy(true, options.viceroy, options.wasm, dir, stores)
  };
  const viceroyFor = (address: string): Viceroy => (isIPv6(address) ? viceroys.v6 : viceroys.v4);

  /** Loopback addresses for requests without a client IP of their own, by location. */
  const loopback = new Map<string, string>();
  /** Where a request comes from: its own client IP, or a loopback address for its location. */
  const source = (headers: IncomingHttpHeaders): { readonly address: string; readonly geo: Geo } => {
    const geo = geoEntry(caseLocation({ headers }, trustProxy, GEO_FIELDS));
    // Without a remote address, undefined means the case names no client IP of its own.
    const ip = caseClientIp({ headers, socket: {} }, trustProxy);
    if (ip !== undefined) return { address: ip, geo };
    const key = geo.join('\n');
    let address = loopback.get(key);
    if (address === undefined) {
      address = `127.0.0.${String(loopback.size + 1)}`;
      loopback.set(key, address);
    }
    return { address, geo };
  };

  // Seed the entries: the first location each address has in the case file.
  for (const request of options.requests) {
    const headers: IncomingHttpHeaders = {};
    for (const [name, value] of Object.entries(request)) headers[name.toLowerCase()] = value;
    const { address, geo } = source(headers);
    const viceroy = viceroyFor(address);
    if (!viceroy.geo.has(address)) viceroy.geo.set(address, geo);
  }
  // The readiness check comes from 127.0.0.1; without an entry of its own, it has no location.
  if (!viceroys.v4.geo.has('127.0.0.1')) viceroys.v4.geo.set('127.0.0.1', []);

  const stopAll = async (): Promise<void> => {
    await Promise.all([viceroys.v4.stop(), viceroys.v6.stop()]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await Promise.all([viceroys.v4.start(), ...(viceroys.v6.geo.size > 0 ? [viceroys.v6.start()] : [])]);
  } catch (error) {
    await stopAll();
    throw error;
  }

  const relay = async (req: IncomingMessage): Promise<Relayed> => {
    const { address, geo } = source(req.headers);
    const viceroy = viceroyFor(address);
    if (viceroy.geo.get(address)?.join('\n') !== geo.join('\n') || !viceroy.running) {
      viceroy.geo.set(address, geo);
      await viceroy.start();
    }
    const headers: string[] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? '';
      const value = req.rawHeaders[i + 1] ?? '';
      // The cases' Cloudflare location headers describe the connection, which is real here.
      if (/^cf-/i.test(name)) continue;
      if (trustProxy && name.toLowerCase() === 'x-forwarded-for') {
        // The first entry is the connection; later ones are what the visitor sent.
        const rest = value.split(',').slice(1).map(entry => entry.trim()).filter(entry => entry !== '');
        if (rest.length > 0) headers.push(name, rest.join(', '));
        continue;
      }
      headers.push(name, value);
    }
    return viceroy.forward(req.method ?? 'GET', req.url ?? '/', address, headers, await readBody(req));
  };

  // One request at a time, since one may restart Viceroy.
  let queue: Promise<unknown> = Promise.resolve();
  const server = serve(options.port, 'Viceroy relay failed', async (req, res) => {
    const result = queue.then(() => relay(req));
    queue = result.catch(() => undefined);
    const { status, headers, body } = await result;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  return async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await stopAll();
  };
}
