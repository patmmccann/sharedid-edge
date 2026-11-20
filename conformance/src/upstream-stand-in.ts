// A local stand-in for the services forwarding modules pass requests on to (Google's tag gateway, `*.fps.goog`), so
// conformance runs never reach the internet. `installUpstreamStandIn` replaces `globalThis.fetch` in the process (or
// the Worker isolate) that runs the implementation: a request to a stood-in host is answered here, in memory; a request
// to a loopback address goes through as before (the emulators talk to their functions that way); any other request
// throws, so a case can't call out by mistake. The adapters call `fetch` when they forward, at call time, so they get
// this one.
//
// Loaded by `upstream-preload.ts` (`node --import`) in every target process run with Node.js, and imported first by the
// Worker entry point `targets.ts` writes for `wrangler dev`. Web-standard APIs only: workerd runs it too.

/** The hosts answered here: Google's tag gateway endpoints. */
function stoodIn(hostname: string): boolean {
  return hostname === 'fps.goog' || hostname.endsWith('.fps.goog');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The stand-in's answer, by the request's path:
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

/** Replaces `globalThis.fetch` with one that answers stood-in hosts here and refuses anything but loopback. */
export function installUpstreamStandIn(): void {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = target(input);
    if (stoodIn(url.hostname)) return upstreamStandIn(new Request(input, init));
    if (!LOOPBACK.has(url.hostname)) return Promise.reject(new TypeError('conformance: requests may not leave this machine'));
    return original(input, init);
  };
}
