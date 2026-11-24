// Forwarding modules: a module that owns paths on the site and answers them by passing requests on to a service it
// names (Google's tag gateway, say). This is the only code in core that sends anything to another host, and it does so
// only through `forward` below, which refuses hosts the module didn't declare and requests the privacy rules rule out.
// Spec: "Forwarding modules" in spec/SPEC.md.
import { ConfigError, type SharedIdEdgeConfig } from './config.js';
import type { ConsentContext, ConsentSignal } from './consent.js';
import type { EdgeModule, ModuleContext } from './modules.js';

/**
 * Whether a request to a forwarding module's path may be passed on: `forward: true` (with `anonymous` when Global
 * Privacy Control is on and the module forwards anonymously then), or `forward: false` with the reason.
 */
export type ForwardDecision = { readonly forward: true; readonly anonymous: boolean } | { readonly forward: false; readonly reason: string };

/** What `ForwardContext.forward` sends: the method (`GET` by default), headers and body. */
export interface ForwardInit {
  readonly method?: string;
  readonly headers?: Headers;
  readonly body?: Uint8Array<ArrayBuffer>;
}

/** What a module's `run` sends with `ModuleContext.fetch`: as `ForwardInit`, plus a shorter time limit of its own. */
export interface ModuleFetchInit extends ForwardInit {
  /** How long to wait, in milliseconds; never longer than core's own limit for the module (`moduleFetchLimitMs`). */
  readonly timeoutMs?: number;
}

/**
 * `ModuleContext.fetch`: sends a request to one of the module's declared hosts, with the checks `ForwardContext.forward`
 * makes, and gives up after the shorter of `init.timeoutMs` and core's limit.
 */
export type ModuleFetch = (url: string | URL, init?: ModuleFetchInit) => Promise<Response>;

/**
 * What lets a module's `run` send requests (`EdgeModule.fetching`): the hosts it may reach, fixed in its code. For vendor
 * modules that look an ID up from the vendor's API (`id5`), under the vendor plugin rules: opt-in, a strict time limit,
 * cached results.
 */
export interface ModuleFetching {
  /** Host names, as for `ModuleForwarding.hosts`. Also listed as `network` and `forwards` in its package metadata. */
  readonly hosts: readonly string[];
}

/** What a forwarding module's `serve` gets for one request under its paths. */
export interface ForwardContext extends Pick<ModuleContext, 'request' | 'url' | 'platform' | 'consent' | 'cookies' | 'optedOut' | 'config' | 'secrets'> {
  /** The path prefix the request is under, one of the module's `paths`. */
  readonly prefix: string;
  /** Whether the request may be passed on. When it may not, `forward` refuses, and the module answers by itself. */
  readonly decision: ForwardDecision;
  /** The body of a `POST`, read by core (at most `MAX_FORWARD_BODY_BYTES`) only when the decision forwards. */
  readonly body: Uint8Array<ArrayBuffer> | undefined;
  /**
   * Sends a request to one of the module's `hosts` and returns the response. It rejects, sending nothing, while the
   * decision is blocked, and for a URL that isn't `https` on the default port, has a user name or password, or whose host
   * the module didn't declare. It doesn't follow redirects and gives up after `FORWARD_TIMEOUT_MS`. Forwarding
   * anonymously, it removes every header that carries the client's address or location first.
   */
  forward(url: string | URL, init?: ForwardInit): Promise<Response>;
}

/** What makes a module a forwarding module (`EdgeModule.forwarding`). */
export interface ModuleForwarding {
  /**
   * The hosts it may send requests to: lower-case host names of two labels or more, or `*.` and such a name for any
   * host under it (`*.fps.goog`). Also listed as `forwards` in its package's `sharedidEdge` metadata.
   */
  readonly hosts: readonly string[];
  /**
   * The path prefixes it owns, from its `SID_MODULE_CONFIG` entry: `/metrics`, say. Called once per configuration. Throw
   * on invalid settings: the module then owns no path, and its `/v1` run should throw too, to report `error`.
   */
  paths(config: Readonly<Record<string, unknown>>): readonly string[];
  /** Whether, with Global Privacy Control, it forwards anonymously rather than not at all. Not at all when omitted. */
  anonymousOnGpc?(config: Readonly<Record<string, unknown>>): boolean;
  /** Answers a request under one of its paths, by forwarding it (`context.forward`) or, when blocked, by itself. */
  serve(context: ForwardContext): Response | Promise<Response>;
}

/**
 * How an adapter sends a forwarding module's requests: normally `request => fetch(request)`. An adapter whose platform
 * can't send requests to other hosts passes none, and a forwarding module in `SID_MODULES` is then a configuration error.
 */
export type ForwardFetch = (request: Request) => Promise<Response>;

/** The largest `POST` body core reads for a forwarding module: 64 KiB, the browsers' limit for `sendBeacon`. */
export const MAX_FORWARD_BODY_BYTES = 65_536;
/** How long `forward` waits for the other host. */
export const FORWARD_TIMEOUT_MS = 10_000;

const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A forwarding path prefix: `/` and segments of unreserved characters, without a trailing slash. */
const PATH_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)+$/;
/** Headers that carry the client's address or location, removed when forwarding anonymously. */
const CLIENT_ADDRESS = /^(?:forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-connecting-ip|x-client-ip|client-ip|x-cluster-client-ip)$/;
/** Response headers that describe one connection, or a body the runtime has already decoded. */
const HOP_BY_HOP = /^(?:connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|content-encoding|content-length|access-control-.*)$/;

/** Checks a module's `forwarding` or `fetching` hosts when they're defined; throws a `TypeError` naming the module. */
export function checkForwarding(name: string, declared: Pick<ModuleForwarding, 'hosts'>, field = 'forwarding'): void {
  const hosts: readonly unknown[] = declared.hosts;
  if (hosts.length === 0 || !hosts.every(host => typeof host === 'string' && HOST_PATTERN.test(host))) {
    throw new TypeError(`Module ${name}: ${field}.hosts must be host names, or *. and a host name`);
  }
}

/**
 * The longest `ModuleContext.fetch` waits: four fifths of `SID_MODULE_TIMEOUT_MS` (at least 1 ms), so a module whose
 * request runs out of time still has time to answer from its cache before core stops waiting for it.
 */
export function moduleFetchLimitMs(moduleTimeoutMs: number): number {
  return Math.max(1, Math.floor(moduleTimeoutMs * 0.8));
}

/**
 * @throws ConfigError when `modules` (those in `SID_MODULES`) has one that sends requests from `run` (`fetching`) and
 *   the adapter can't send requests to other hosts, as for a forwarding module.
 */
export function checkFetching(modules: readonly EdgeModule[], canForward: boolean): void {
  const fetching = modules.find(module => module.fetching !== undefined);
  if (fetching !== undefined && !canForward) throw new ConfigError(`SID_MODULES lists ${fetching.name}, which sends requests to another host; this platform's adapter can't`);
}

/** Whether `hostname` (lower case, as `URL` gives it) is one of `hosts`. */
export function declaredHost(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some(host => (host.startsWith('*.') ? hostname.endsWith(host.slice(1)) && hostname.length > host.length - 1 : hostname === host));
}

/** A forwarding module's path prefix, owned for one configuration. */
export interface OwnedPath {
  readonly prefix: string;
  readonly module: EdgeModule & { readonly forwarding: ModuleForwarding };
}

/** Whether two paths overlap: one is the other, or under it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The paths the forwarding modules in `config.modules` own, checked against `reserved` (the base path, or core's routes
 * with the root base path) and each other. A module whose `paths` throws (invalid settings) owns none.
 *
 * @throws ConfigError when a forwarding module is listed and the adapter can't forward (`canForward` false), or a path
 *   is invalid or overlaps another.
 */
export function ownedPaths(modules: readonly EdgeModule[], config: SharedIdEdgeConfig, reserved: readonly string[], canForward: boolean): OwnedPath[] {
  const owned: OwnedPath[] = [];
  for (const module of modules) {
    const { forwarding } = module;
    if (forwarding === undefined) continue;
    if (!canForward) throw new ConfigError(`SID_MODULES lists ${module.name}, which forwards requests to another host; this platform's adapter can't`);
    let prefixes: readonly string[];
    try {
      prefixes = forwarding.paths(config.moduleConfig[module.name] ?? {});
    } catch {
      continue;
    }
    for (const prefix of prefixes) {
      if (!PATH_PATTERN.test(prefix) || prefix.length > 100) throw new ConfigError(`${module.name}: "${prefix}" isn't a path like /metrics`);
      const taken = [...reserved, ...owned.map(path => path.prefix)].find(other => overlaps(other, prefix));
      if (taken !== undefined) throw new ConfigError(`${module.name}: the path ${prefix} overlaps ${taken}`);
      owned.push({ prefix, module: { ...module, forwarding } });
    }
  }
  return owned;
}

/**
 * The path prefixes the forwarding modules in `config.modules` own (from `modules`, the worker's list), for an adapter
 * that decides which requests reach the handler (the Vercel middleware). None when the configuration is invalid: the
 * handler reports that on its own routes.
 */
export function forwardingPaths(config: SharedIdEdgeConfig, modules: Iterable<EdgeModule>): string[] {
  const listed = [...modules].filter(module => config.modules.includes(module.name));
  try {
    return ownedPaths(listed, config, [], true).map(path => path.prefix);
  } catch {
    return [];
  }
}

/** The owned path a request's path is under, if any. */
export function ownerOf(pathname: string, owned: readonly OwnedPath[]): OwnedPath | undefined {
  return owned.find(path => pathname === path.prefix || pathname.startsWith(`${path.prefix}/`));
}

/**
 * The forwarding decision (spec: "Forwarding modules"): blocked on opt-out, COPPA, a consent provider's denial, an
 * unreadable TC string, GDPR without a TC string (a provider's grant doesn't lift it: the request goes to another
 * party), or GDPR without the module's purposes (`purposeDenial`); with GPC, blocked unless the module forwards
 * anonymously then.
 */
export function forwardDecision(
  forwarding: Pick<ModuleForwarding, 'anonymousOnGpc'>,
  config: Readonly<Record<string, unknown>>,
  consent: ConsentContext,
  optedOut: boolean,
  signal: ConsentSignal | undefined,
  purposeDenial: string | undefined,
  unreadableTcString: string
): ForwardDecision {
  const blocked = (reason: string): ForwardDecision => ({ forward: false, reason });
  if (optedOut) return blocked('opt-out');
  if (consent.coppa) return blocked('coppa');
  if (signal?.consent === 'denied') return blocked(signal.reason);
  if (consent.tcString !== undefined && consent.tcf === undefined) return blocked(unreadableTcString);
  if (consent.gdprApplies === true && consent.tcString === undefined) return blocked('tcf: GDPR applies and there is no TC string');
  if (purposeDenial !== undefined) return blocked(purposeDenial);
  if (consent.gpc) return forwarding.anonymousOnGpc?.(config) === true ? { forward: true, anonymous: true } : blocked('gpc');
  return { forward: true, anonymous: false };
}

/**
 * `ForwardContext.forward`, for one request: see there. Also `ModuleContext.fetch`, with `limitMs` the longest it waits
 * (`init.timeoutMs` can only shorten it).
 */
export function forwarder(hosts: readonly string[], decision: ForwardDecision, send: ForwardFetch, limitMs: number = FORWARD_TIMEOUT_MS): ModuleFetch {
  return (target, init = {}) => {
    if (!decision.forward) return Promise.reject(new TypeError('forwarding is blocked for this request'));
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || !declaredHost(url.hostname, hosts)) {
      return Promise.reject(new TypeError('not one of the module\'s declared hosts'));
    }
    const headers = new Headers(init.headers);
    if (decision.anonymous) {
      const names: string[] = [];
      headers.forEach((_value, name) => { names.push(name); });
      for (const name of names) if (CLIENT_ADDRESS.test(name)) headers.delete(name);
    }
    // A timer that holds the controller, rather than AbortSignal.timeout: a runtime may collect a timeout signal that only
    // the Request's own signal follows, and then never abort. It covers reading the response body too, so it isn't cleared.
    const controller = new AbortController();
    const wait = Math.max(1, Math.floor(init.timeoutMs !== undefined && Number.isFinite(init.timeoutMs) ? Math.min(limitMs, init.timeoutMs) : limitMs));
    setTimeout(() => { controller.abort(new DOMException('The request timed out', 'TimeoutError')); }, wait);
    return send(new Request(url, {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: init.body })
    }));
  };
}

/**
 * The module's response as the worker returns it: hop-by-hop headers, `Content-Encoding` and `Content-Length` (the
 * body is decoded) and `Access-Control-*` removed, `Cache-Control: no-store` when it has none, and
 * `X-SharedID-Forwarding`.
 */
export function forwardedResponse(response: Response, decision: ForwardDecision, head: boolean): Response {
  const headers = new Headers(response.headers);
  const names: string[] = [];
  headers.forEach((_value, name) => { names.push(name); });
  for (const name of names) if (HOP_BY_HOP.test(name)) headers.delete(name);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  headers.set('X-SharedID-Forwarding', !decision.forward ? `blocked: ${decision.reason}` : decision.anonymous ? 'anonymous' : 'forwarded');
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
