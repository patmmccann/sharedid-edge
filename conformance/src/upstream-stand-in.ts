// A local stand-in for the services forwarding modules pass requests on to (Google's tag gateway, `*.fps.goog`), and
// that modules send requests to from `run` (ID5's API, `id5-sync.com` and `api.id5-sync.com`, for the `id5` module), so
// conformance runs never reach the internet. `installUpstreamStandIn` replaces `globalThis.fetch` in the process (or
// the Worker isolate) that runs the implementation: a request to a stood-in host is answered here, in memory; a request
// to a loopback address goes through as before (the emulators talk to their functions that way); any other request
// throws, so a case can't call out by mistake. The adapters call `fetch` when they forward, at call time, so they get
// this one.
//
// Loaded by `upstream-preload.ts` (`node --import`) in every target process run with Node.js, and imported first by the
// Worker entry point `targets.ts` writes for `wrangler dev`. Web-standard APIs only: workerd runs it too.
//
// **The ID5 stub over the network.** With `CONFORMANCE_ID5_STUB` in the process's environment (a loopback http URL),
// requests to ID5's hosts aren't answered in memory: they're sent, same path and body, to that URL, where `id5-stub.ts`
// runs as its own process (the Node.js target) or container (the `docker` target), so the server's request to ID5
// really leaves it. This is the only way to point the `id5` module at anything but ID5: it lives here, in a test
// preload that no build or image includes, so the module's own rule (https on ID5's hosts) stays as it is.

/** The hosts answered here: Google's tag gateway endpoints, and ID5's. */
function stoodIn(hostname: string): boolean {
  return hostname === 'fps.goog' || hostname.endsWith('.fps.goog') || isId5(hostname);
}

function isId5(hostname: string): boolean {
  return hostname === 'id5-sync.com' || hostname === 'api.id5-sync.com';
}

/** A `ua` containing this gets ID5's opt-out from the stand-in (`universal_uid` `"0"`), for the opt-out cases. */
export const ID5_OPT_OUT_MARKER = 'id5-stub-optout';

/**
 * ID5's stand-in: a fetch answer with one EID (`ID5*conformance`, `linkType` 2) whose UID `ext.sent` echoes what the
 * request carried (`partner`, `ip`, `ipv6`, `ua`, `puid`, `s`; `null` when absent), so cases check what was sent
 * through the payload, and `signature` `conformance-signature`. A `ua` containing `ID5_OPT_OUT_MARKER` gets ID5's
 * opt-out instead. Also what `id5-stub.ts` answers.
 */
export async function id5StandIn(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (typeof body['ua'] === 'string' && body['ua'].includes(ID5_OPT_OUT_MARKER)) return Response.json({ universal_uid: '0', signature: 'conformance-signature' });
  const sent = Object.fromEntries(['partner', 'ip', 'ipv6', 'ua', 'puid', 's'].map(key => [key, body[key] ?? null]));
  const eid = { source: 'id5-sync.com', uids: [{ id: 'ID5*conformance', atype: 1, ext: { linkType: 2, sent } }] };
  return Response.json({ ids: { id5id: { eid } }, signature: 'conformance-signature', cache_control: { max_age_sec: 7200 } });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The stand-in's answer: ID5's for ID5's hosts (`id5StandIn`); otherwise, by the request's path:
 *
 * - `…/healthy`: `ok`, as the gateway's health check;
 * - `…/redirect`: a `302` to another host, which the implementation must return rather than follow;
 * - a path ending in `/` or `.js`, or `…/gtag/js`: a script, cacheable by anyone for 15 minutes (`public`), which the
 *   module makes private;
 * - anything else (a measurement hit): the request it received, as JSON (`method`, `host`, `path`, `query`, `headers`
 *   with lower-case names, `body`), marked cacheable, compressed and readable from any origin, all of which the
 *   implementation must undo. The body isn't actually compressed: the Fetch API hands over decoded bodies, so the
 *   header is all an implementation sees.
 */
export async function upstreamStandIn(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (isId5(url.hostname)) return id5StandIn(request);
  if (url.pathname.endsWith('/healthy')) return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  if (url.pathname.endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.js') || url.pathname.endsWith('/gtag/js')) {
    return new Response('/* stand-in tag */', { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=900, s-maxage=900' } });
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  const echo = { method: request.method, host: url.host, path: url.pathname, query: url.search, headers, body: await request.text() };
  return new Response(JSON.stringify(echo), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'content-encoding': 'gzip',
      'access-control-allow-origin': '*',
      'x-stand-in': '1'
    }
  });
}

/** The URL a `fetch` call goes to, without reading its body. */
function target(input: string | URL | Request): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

/** `CONFORMANCE_ID5_STUB`, when the process has it and it's a loopback http URL (see the top of this file). */
function id5StubUrl(): URL | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['CONFORMANCE_ID5_STUB'];
  if (value === undefined || value === '') return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) throw new TypeError('conformance: CONFORMANCE_ID5_STUB must be a loopback http URL');
  return url;
}

/** Sends a request for ID5 to the stub process at `stub`, with the same path, query, headers and body. */
async function toId5Stub(stub: URL, request: Request, original: typeof fetch): Promise<Response> {
  const from = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return original(new URL(`${from.pathname}${from.search}`, stub), { method: request.method, headers: request.headers, signal: request.signal, ...(body === undefined ? {} : { body }) });
}

/**
 * Replaces `globalThis.fetch` with one that answers stood-in hosts here (or, for ID5 with `CONFORMANCE_ID5_STUB`, sends
 * them to the stub process) and refuses anything but loopback.
 */
export function installUpstreamStandIn(): void {
  const original = globalThis.fetch.bind(globalThis);
  const stub = id5StubUrl();
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = target(input);
    if (stub !== undefined && isId5(url.hostname)) return toId5Stub(stub, new Request(input, init), original);
    if (stoodIn(url.hostname)) return upstreamStandIn(new Request(input, init));
    if (!LOOPBACK.has(url.hostname)) return Promise.reject(new TypeError('conformance: requests may not leave this machine'));
    return original(input, init);
  };
}
