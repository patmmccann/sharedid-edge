import { describe, expect, it } from 'vitest';
import { ConfigError, createHandler, declaredHost, defineModule, MAX_FORWARD_BODY_BYTES, resolveConfig, type EdgeModule, type ForwardContext, type ForwardFetch, type PayloadV1 } from '../src/index.js';
import { publisherTc, tcString } from './helpers.js';

/** A stubbed upstream: records each request it gets and answers with `answer`. Nothing leaves the test. */
function upstream(answer: (request: Request) => Response = () => new Response('upstream', { headers: { 'Cache-Control': 'private, max-age=60' } })): { readonly sent: Request[]; readonly send: ForwardFetch } {
  const sent: Request[] = [];
  return { sent, send: request => { sent.push(request); return Promise.resolve(answer(request)); } };
}

/** What the test module's `serve` should do: forward to `target` by default. */
type Serve = (context: ForwardContext) => Response | Promise<Response>;

function forwardingModule(serve: Serve, options: { readonly purposes?: number[]; readonly anonymous?: boolean; readonly name?: string } = {}): EdgeModule {
  return defineModule({
    name: options.name ?? 'relay',
    ...(options.purposes === undefined ? {} : { purposes: options.purposes }),
    run: () => undefined,
    forwarding: {
      hosts: ['*.upstream.example', 'exact.example'],
      paths: config => {
        const { path } = config;
        if (typeof path !== 'string') throw new TypeError('relay: path');
        return [path];
      },
      anonymousOnGpc: () => options.anonymous === true,
      serve
    }
  });
}

const relay: Serve = async context => context.forward(`https://a.upstream.example${context.url.pathname}${context.url.search}`, {
  method: context.request.method,
  headers: new Headers({ 'X-Forwarded-For': '192.0.2.1', 'X-Kept': '1' }),
  ...(context.body === undefined ? {} : { body: context.body })
});

const blocked: Serve = context => new Response(context.decision.forward ? 'forwarded' : null, { status: context.decision.forward ? 200 : 204 });

function handler(module: EdgeModule, env: Record<string, string> = {}, send: ForwardFetch | null = upstream().send): ReturnType<typeof createHandler> {
  return createHandler({
    config: resolveConfig({ SID_MODULES: module.name, SID_MODULE_CONFIG: JSON.stringify({ [module.name]: { path: '/metrics' } }), ...env }),
    modules: [module],
    ...(send === null ? {} : { forwardFetch: send })
  });
}

const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}): Request => new Request(`https://www.example.com${path}`, { headers, ...init });

describe('declared hosts', () => {
  it('matches a host name exactly, and *. any host under a name, not the name itself', () => {
    const hosts = ['*.fps.goog', 'exact.example'];
    expect(declaredHost('g-1.fps.goog', hosts)).toBe(true);
    expect(declaredHost('a.b.fps.goog', hosts)).toBe(true);
    expect(declaredHost('fps.goog', hosts)).toBe(false);
    expect(declaredHost('evilfps.goog', hosts)).toBe(false);
    expect(declaredHost('exact.example', hosts)).toBe(true);
    expect(declaredHost('sub.exact.example', hosts)).toBe(false);
  });

  it('refuses a module whose hosts are not host names', () => {
    for (const hosts of [[], ['*'], ['*.goog'], ['UPPER.example'], ['https://a.example'], ['a.example/path']]) {
      expect(() => defineModule({ name: 'bad', run: () => undefined, forwarding: { hosts, paths: () => [], serve: blocked } })).toThrow(TypeError);
    }
  });
});

describe('forwarding paths', () => {
  it('forwards a request under the path to a declared host, and nothing else', async () => {
    const { sent, send } = upstream();
    const response = await handler(forwardingModule(relay), {}, send)(get('/metrics/collect?v=2'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream');
    expect(response.headers.get('X-SharedID-Forwarding')).toBe('forwarded');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(sent.map(request => request.url)).toEqual(['https://a.upstream.example/metrics/collect?v=2']);
    expect(sent[0]?.redirect).toBe('manual');
  });

  it('answers the prefix itself, and leaves paths that only start with it, and other paths, at 404', async () => {
    const { sent, send } = upstream();
    const serve = handler(forwardingModule(relay), {}, send);
    expect((await serve(get('/metrics'))).status).toBe(200);
    expect((await serve(get('/metricsx/collect'))).status).toBe(404);
    expect((await serve(get('/other'))).status).toBe(404);
    expect(sent).toHaveLength(1);
  });

  it('owns no path when the module is installed but not in SID_MODULES', async () => {
    const { sent, send } = upstream();
    const module = forwardingModule(relay);
    const serve = createHandler({ config: resolveConfig({ SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/metrics' } }) }), modules: [module], forwardFetch: send });
    expect((await serve(get('/metrics/collect'))).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('owns no path with invalid settings', async () => {
    const { sent, send } = upstream();
    const module = forwardingModule(relay);
    const serve = createHandler({ config: resolveConfig({ SID_MODULES: 'relay' }), modules: [module], forwardFetch: send });
    expect((await serve(get('/metrics/collect'))).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('refuses a path that overlaps the base path, core\'s routes on the root base path, or another module\'s', () => {
    const module = forwardingModule(relay);
    const other = forwardingModule(relay, { name: 'other' });
    const build = (env: Record<string, string>, modules: EdgeModule[] = [module]): unknown => createHandler({ config: resolveConfig(env), modules, forwardFetch: upstream().send });
    expect(() => build({ SID_MODULES: 'relay', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/_sid/metrics' } }) })).toThrow(ConfigError);
    expect(() => build({ SID_MODULES: 'relay', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/_sid' } }) })).toThrow(ConfigError);
    expect(() => build({ SID_MODULES: 'relay', SID_BASE_PATH: '/', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/sync' } }) })).toThrow(ConfigError);
    expect(() => build({ SID_MODULES: 'relay', SID_BASE_PATH: '/', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/metrics' } }) })).not.toThrow();
    expect(() => build({ SID_MODULES: 'relay,other', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/m' }, other: { path: '/m/x' } }) }, [module, other])).toThrow(ConfigError);
    expect(() => build({ SID_MODULES: 'relay', SID_MODULE_CONFIG: JSON.stringify({ relay: { path: '/metrics/' } }) })).toThrow(ConfigError);
  });

  it('refuses a forwarding module on an adapter that can\'t forward', () => {
    expect(() => handler(forwardingModule(relay), {}, null)).toThrow(ConfigError);
    // Not listed: nothing to refuse.
    expect(() => createHandler({ config: resolveConfig({}), modules: [forwardingModule(relay)] })).not.toThrow();
  });

  it('answers other methods with 405', async () => {
    const response = await handler(forwardingModule(relay))(get('/metrics/collect', {}, { method: 'DELETE' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, POST');
  });

  it('applies the request limits', async () => {
    expect((await handler(forwardingModule(relay))(get(`/metrics/collect?x=${'a'.repeat(9000)}`))).status).toBe(414);
    expect((await handler(forwardingModule(relay))(get('/metrics/collect', { Cookie: `a=${'b'.repeat(17_000)}` }))).status).toBe(431);
  });
});

describe('the outbound request', () => {
  it('refuses a host the module did not declare, another scheme or port, and credentials, sending nothing', async () => {
    for (const target of ['https://elsewhere.example/', 'https://upstream.example/', 'http://a.upstream.example/', 'https://a.upstream.example:8443/', 'https://user@a.upstream.example/']) {
      const { sent, send } = upstream();
      const response = await handler(forwardingModule(context => context.forward(target)), {}, send)(get('/metrics/x'));
      expect(response.status, target).toBe(502);
      expect(response.headers.get('X-SharedID-Forwarding')).toBe('error');
      expect(sent).toHaveLength(0);
    }
  });

  it('refuses to send anything while blocked', async () => {
    const { sent, send } = upstream();
    const response = await handler(forwardingModule(relay), {}, send)(get('/metrics/x', { 'Sec-GPC': '1' }));
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(0);
  });

  it('removes the client address and location headers when forwarding anonymously', async () => {
    const { sent, send } = upstream();
    const response = await handler(forwardingModule(relay, { anonymous: true }), {}, send)(get('/metrics/x', { 'Sec-GPC': '1' }));
    expect(response.headers.get('X-SharedID-Forwarding')).toBe('anonymous');
    expect(sent[0]?.headers.get('X-Forwarded-For')).toBeNull();
    expect(sent[0]?.headers.get('X-Kept')).toBe('1');
  });

  it('gives a 502 with nothing from the request when the upstream fails', async () => {
    const response = await handler(forwardingModule(relay), {}, () => Promise.reject(new Error('secret request data')))(get('/metrics/x'));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Bad gateway');
  });

  it('passes a POST body within the limit, and refuses one without a length or over it', async () => {
    const { sent, send } = upstream();
    const serve = handler(forwardingModule(relay), {}, send);
    const post = (body: string, length?: string): Request => get('/metrics/x', length === undefined ? {} : { 'Content-Length': length }, { method: 'POST', body });
    expect((await serve(post('a=1', '3'))).status).toBe(200);
    expect(await sent[0]?.text()).toBe('a=1');
    expect((await serve(post('a=1'))).status).toBe(411);
    expect((await serve(post('a', String(MAX_FORWARD_BODY_BYTES + 1)))).status).toBe(413);
    expect(sent).toHaveLength(1);
  });

  it('reads no body when blocked', async () => {
    const response = await handler(forwardingModule(blocked))(get('/metrics/x', { 'Sec-GPC': '1' }, { method: 'POST', body: 'a=1' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('X-SharedID-Forwarding')).toBe('blocked: gpc');
  });
});

describe('the response', () => {
  it('drops hop-by-hop, encoding, length and CORS headers, and adds no-store when there is no Cache-Control', async () => {
    const { send } = upstream(() => new Response('x', { headers: { 'Content-Encoding': 'gzip', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true', 'Keep-Alive': 'timeout=5', 'X-Upstream': '1' } }));
    const response = await handler(forwardingModule(relay), {}, send)(get('/metrics/x'));
    for (const name of ['Content-Encoding', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Keep-Alive']) expect(response.headers.get(name), name).toBeNull();
    expect(response.headers.get('X-Upstream')).toBe('1');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps each Set-Cookie the upstream sends', async () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/');
    const response = await handler(forwardingModule(relay), {}, upstream(() => new Response('x', { headers })).send)(get('/metrics/x'));
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('answers HEAD without a body', async () => {
    const response = await handler(forwardingModule(relay))(get('/metrics/x', {}, { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });
});

describe('the forwarding decision', () => {
  const decide = async (path: string, headers: Record<string, string> = {}, options: { readonly purposes?: number[]; readonly anonymous?: boolean } = {}): Promise<string | null> =>
    (await handler(forwardingModule(blocked, options))(get(path, headers))).headers.get('X-SharedID-Forwarding');

  it('blocks on opt-out, COPPA, GPC and GDPR without a TC string, in that order', async () => {
    expect(await decide('/metrics/x', { Cookie: '_pubcid_optout=1', 'Sec-GPC': '1' })).toBe('blocked: opt-out');
    expect(await decide('/metrics/x?coppa=1', { 'Sec-GPC': '1' })).toBe('blocked: coppa');
    expect(await decide('/metrics/x', { 'Sec-GPC': '1' })).toBe('blocked: gpc');
    expect(await decide('/metrics/x?gdpr=1')).toBe('blocked: tcf: GDPR applies and there is no TC string');
    expect(await decide('/metrics/x?gdpr=1&gdpr_consent=invalid')).toBe('blocked: tcf: invalid TC string');
    expect(await decide('/metrics/x')).toBe('forwarded');
  });

  it('needs the module\'s purposes in the publisher TC segment where GDPR applies', async () => {
    const purposes = [1, 7];
    expect(await decide(`/metrics/x?gdpr=1&gdpr_consent=${publisherTc([1])}`, {}, { purposes })).toBe('blocked: tcf: no publisher consent for purpose 7');
    expect(await decide(`/metrics/x?gdpr=1&gdpr_consent=${publisherTc([1, 7])}`, {}, { purposes })).toBe('forwarded');
    // Outside GDPR the purposes aren't checked.
    expect(await decide(`/metrics/x?gdpr=0&gdpr_consent=${publisherTc([1])}`, {}, { purposes })).toBe('forwarded');
  });

  it('forwards anonymously with GPC only when the module says so, and never past COPPA or opt-out', async () => {
    expect(await decide('/metrics/x', { 'Sec-GPC': '1' }, { anonymous: true })).toBe('anonymous');
    expect(await decide('/metrics/x?coppa=1', { 'Sec-GPC': '1' }, { anonymous: true })).toBe('blocked: coppa');
    expect(await decide('/metrics/x', { 'Sec-GPC': '1', Cookie: '_pubcid_optout=1' }, { anonymous: true })).toBe('blocked: opt-out');
  });

  it('reports on /v1 whether the visitor is forwarded, and nothing else', async () => {
    const serve = handler(forwardingModule(blocked));
    const report = async (headers: Record<string, string>): Promise<unknown> => ((await (await serve(get('/_sid/v1', headers))).json()) as PayloadV1).ext.modules['relay'];
    expect(await report({})).toEqual({ ms: expect.any(Number) as number, status: 'empty', forwards: true });
    expect(await report({ 'Sec-GPC': '1' })).toEqual({ ms: expect.any(Number) as number, status: 'empty', forwards: false });
  });

  it('leaves the SharedID routes as they are', async () => {
    const response = await handler(forwardingModule(relay))(get('/_sid/sync?id=pubcid:c29cb2ae-769d-42f6-891a-f53cadee823d'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(response.headers.get('X-SharedID-Forwarding')).toBeNull();
  });
});

describe('module requests (fetching)', () => {
  /** A module that sends one request from `run` when it can, and says in its output whether it could. */
  function fetchingModule(target = 'https://api.lookup.example/id', options: { readonly gvlid?: number; readonly timeoutMs?: number } = {}): EdgeModule {
    return defineModule({
      name: 'lookup',
      routes: ['v1', 'sync'],
      ...(options.gvlid === undefined ? {} : { gvlid: options.gvlid, purposes: [1] }),
      fetching: { hosts: ['api.lookup.example'] },
      run: async ({ fetch }) => {
        if (fetch === undefined) return { ortb2: { fetch: 'blocked' } };
        try {
          const response = await fetch(target, { method: 'POST', body: new TextEncoder().encode('{}'), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
          return { ortb2: { fetch: await response.text() } };
        } catch {
          return { ortb2: { fetch: 'failed' } };
        }
      }
    });
  }
  const build = (module: EdgeModule, env: Record<string, string>, send: ForwardFetch | null): ReturnType<typeof createHandler> =>
    createHandler({ config: resolveConfig({ SID_MODULES: module.name, ...env }), modules: [module], ...(send === null ? {} : { forwardFetch: send }) });
  const fetched = async (h: ReturnType<typeof createHandler>, path: string, headers: Record<string, string> = {}): Promise<unknown> =>
    ((await (await h(get(path, headers))).json()) as PayloadV1).ortb2?.['fetch'];

  it('sends a module\'s request to a declared host, from /v1 and /sync', async () => {
    const stub = upstream(() => new Response('looked up'));
    const h = build(fetchingModule(), { SID_MODULE_TIMEOUT_MS: '500' }, stub.send);
    expect(await fetched(h, '/_sid/v1')).toBe('looked up');
    expect(stub.sent[0]?.url).toBe('https://api.lookup.example/id');
    expect(stub.sent[0]?.method).toBe('POST');
    await h(get('/_sid/sync'));
    expect(stub.sent).toHaveLength(2);
  });

  it('refuses hosts the module didn\'t declare, and http', async () => {
    const stub = upstream();
    expect(await fetched(build(fetchingModule('https://elsewhere.example/id'), {}, stub.send), '/_sid/v1')).toBe('failed');
    expect(await fetched(build(fetchingModule('http://api.lookup.example/id'), {}, stub.send), '/_sid/v1')).toBe('failed');
    expect(stub.sent).toHaveLength(0);
  });

  it('reports on /v1 whether the module may send requests for this visitor, and nothing else', async () => {
    const h = build(fetchingModule(), {}, upstream().send);
    const report = async (headers: Record<string, string> = {}): Promise<unknown> => ((await (await h(get('/_sid/v1', headers))).json()) as PayloadV1).ext.modules['lookup'];
    expect(await report()).toEqual({ ms: expect.any(Number) as number, status: 'ok', forwards: true });
    expect(await report({ 'Sec-GPC': '1' })).toEqual({ ms: expect.any(Number) as number, status: 'ok', forwards: false });
  });

  it('gives no fetch, and sends nothing, on opt-out, GPC, COPPA or GDPR without a TC string', async () => {
    const stub = upstream();
    const h = build(fetchingModule(), {}, stub.send);
    expect(await fetched(h, '/_sid/v1', { Cookie: '_pubcid_optout=1' })).toBe('blocked');
    expect(await fetched(h, '/_sid/v1', { 'Sec-GPC': '1' })).toBe('blocked');
    expect(await fetched(h, '/_sid/v1?coppa=1')).toBe('blocked');
    expect(await fetched(h, '/_sid/v1?gdpr=1')).toBe('blocked');
    expect(stub.sent).toHaveLength(0);
  });

  it('gives a vendor module its fetch under GDPR only with the vendor\'s consent', async () => {
    const stub = upstream(() => new Response('ok'));
    const h = build(fetchingModule(undefined, { gvlid: 131 }), {}, stub.send);
    expect(await fetched(h, `/_sid/v1?gdpr=1&gdpr_consent=${tcString([1], { vendors: [131] })}`)).toBe('ok');
    expect(await fetched(h, `/_sid/v1?gdpr=1&gdpr_consent=${tcString([1], { vendors: [130] })}`)).toBeUndefined();
    expect(stub.sent).toHaveLength(1);
  });

  it('gives up within the module\'s own limit, and never later than four fifths of SID_MODULE_TIMEOUT_MS', async () => {
    // The stub holds each request, as a runtime's fetch does while it waits, so nothing is collected before it aborts.
    const held: Request[] = [];
    const hang: ForwardFetch = request => new Promise((_resolve, reject) => {
      held.push(request);
      request.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
    });
    const started = Date.now();
    expect(await fetched(build(fetchingModule(undefined, { timeoutMs: 20 }), { SID_MODULE_TIMEOUT_MS: '2000' }, hang), '/_sid/v1')).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1500);
    // A module asking for longer than core allows still answers before core stops waiting for it.
    const body = await (await build(fetchingModule(undefined, { timeoutMs: 5000 }), { SID_MODULE_TIMEOUT_MS: '100' }, hang)(get('/_sid/v1'))).json() as PayloadV1;
    expect(body.ortb2?.['fetch']).toBe('failed');
    expect(body.ext.modules['lookup']?.status).toBe('ok');
  });

  it('is a configuration error on an adapter that can\'t send requests', () => {
    expect(() => build(fetchingModule(), {}, null)).toThrow(ConfigError);
    expect(() => createHandler({ config: resolveConfig({}), modules: [fetchingModule()] })).not.toThrow();
  });

  it('checks the declared hosts when the module is defined', () => {
    expect(() => defineModule({ name: 'bad', fetching: { hosts: ['https://x.example'] }, run: () => undefined })).toThrow('fetching.hosts');
  });
});
