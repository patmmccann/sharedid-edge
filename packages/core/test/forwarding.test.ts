import { describe, expect, it } from 'vitest';
import { ConfigError, createHandler, declaredHost, defineModule, MAX_FORWARD_BODY_BYTES, resolveConfig, type EdgeModule, type ForwardContext, type ForwardFetch, type PayloadV1 } from '../src/index.js';
import { publisherTc } from './helpers.js';

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
