// A preload for vendor modules' tests (node --import): records every network attempt to a host the module didn't
// declare, makes it fail, and fails the process at exit, so a module that catches the error still fails its tests.
// scripts/test-vendor-modules.mjs loads it for every vendor module, with SID_TEST_NETWORK set from the module's
// `network` declaration: "none", or a comma-separated list of hosts. Loopback (localhost, 127.0.0.0/8, ::1) is always
// allowed, so tests can stand up a local mock of an API.
//
// It covers fetch, WebSocket, EventSource and XMLHttpRequest (when defined), every DNS query (module functions and
// Resolver instances), UDP sends and connects (node:dgram), and every TCP or TLS connection made through node:net
// (node:http, node:https and node:tls connect through it). Loopback means localhost names and loopback addresses only.
import dgram from 'node:dgram';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { URL } from 'node:url';

/**
 * Where each attempt is appended as it happens (set by the runner). Test runners run tests in worker processes and
 * ignore their exit codes, so the runner reads this file after the tests rather than relying on the exit code.
 */
const LOG = process.env['SID_TEST_NETWORK_LOG'];

const setting = process.env['SID_TEST_NETWORK'] ?? 'none';
const allowed = new Set(setting === 'none' ? [] : setting.split(',').map(host => host.trim().toLowerCase()).filter(host => host !== ''));
const attempts = [];

function isLoopback(host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  // Only real addresses: a DNS name like 127.vendor.example can resolve anywhere.
  // 0.0.0.0 and :: are the unspecified addresses a socket binds to locally (node:dgram looks them up before a send).
  if (net.isIPv4(name)) return name.startsWith('127.') || name === '0.0.0.0';
  return net.isIPv6(name) && (name === '::1' || name === '0:0:0:0:0:0:0:1' || name === '::');
}

/** Throws (and records) unless `host` is loopback or declared. */
function guard(host, how) {
  if (host === undefined || host === '' || isLoopback(host) || allowed.has(host.toLowerCase())) return;
  attempts.push(`${how} ${host}`);
  if (LOG !== undefined && LOG !== '') appendFileSync(LOG, `${how} ${host}\n`);
  throw new Error(`Network access to ${host} (${how}) isn't allowed: the module declares network ${setting === 'none' ? '"none"' : `[${[...allowed].join(', ')}]`}. See packages/vendor-modules/AGENTS.md.`);
}

const hostOf = input => {
  try {
    return new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
  } catch {
    return String(input);
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = function fetch(input, init) {
  guard(hostOf(input), 'fetch');
  return realFetch(input, init);
};
for (const name of ['WebSocket', 'EventSource']) {
  const Real = globalThis[name];
  if (typeof Real !== 'function') continue;
  globalThis[name] = class extends Real {
    constructor(url, ...rest) {
      guard(hostOf(url), name);
      super(url, ...rest);
    }
  };
}
if (typeof globalThis.XMLHttpRequest === 'function') {
  const open = globalThis.XMLHttpRequest.prototype.open;
  globalThis.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    guard(hostOf(url), 'XMLHttpRequest');
    return open.call(this, method, url, ...rest);
  };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [first, second] = args;
  const options = Array.isArray(first) ? first[0] : first;
  if (typeof options === 'object' && options !== null) {
    // An IPC path (a named pipe or Unix socket: a string) isn't the network. node:http passes its URL's `path`, null
    // for a bare host, through these options too, so anything but a string means a TCP connection.
    if (typeof options.path !== 'string') guard(options.host ?? 'localhost', 'socket');
  } else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) {
    guard(typeof second === 'string' ? second : 'localhost', 'socket');
  }
  return connect.apply(this, args);
};

// Every DNS query, on the module functions and on Resolver instances: lookup and lookupService, reverse, and every
// resolve* (resolveTxt, resolveSrv, …, and any added later). DNS has its own transport, so the socket guard doesn't
// see it.
const isQuery = name => name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve');
function guardQueries(target, label) {
  for (const name of Object.getOwnPropertyNames(target)) {
    const real = target[name];
    if (typeof real !== 'function' || !isQuery(name) || name === 'Resolver') continue;
    target[name] = function (host, ...rest) {
      guard(String(host), `${label}.${name}`);
      return real.call(this, host, ...rest);
    };
  }
}
guardQueries(dns, 'dns');
guardQueries(dns.promises, 'dns');
guardQueries(dns.Resolver.prototype, 'dns.Resolver');
guardQueries(dns.promises.Resolver.prototype, 'dns.Resolver');

// UDP (node:dgram): sending to, or connecting to, an address.
const dgramSocket = dgram.Socket.prototype;
const send = dgramSocket.send;
dgramSocket.send = function (...args) {
  // send(msg, [offset, length,] port, [address], [callback]); without an address it goes to the connected peer (guarded
  // in connect) or to localhost.
  const at = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number' ? 4 : 2;
  if (typeof args[at] === 'string') guard(args[at], 'udp');
  return send.apply(this, args);
};
const udpConnect = dgramSocket.connect;
dgramSocket.connect = function (port, address, ...rest) {
  if (typeof address === 'string') guard(address, 'udp');
  return udpConnect.call(this, port, address, ...rest);
};
// ESM named imports of built-ins (`import { lookup } from 'node:dns'`) are copies taken at load: update them.
syncBuiltinESMExports();

process.on('exit', () => {
  if (attempts.length === 0) return;
  console.error(`\nThe module tried to reach the network ${String(attempts.length)} time(s), outside its declaration (network ${setting === 'none' ? '"none"' : `[${[...allowed].join(', ')}]`}):\n${[...new Set(attempts)].map(a => `  - ${a}`).join('\n')}`);
  process.exitCode = 1;
});
