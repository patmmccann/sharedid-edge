// The bundle's stand-ins for the web-platform classes (src/web.ts), checked against Node.js's own for what core uses.
import { describe, expect, it } from 'vitest';
import {
  Headers as ShimHeaders,
  Request as ShimRequest,
  Response as ShimResponse,
  URL as ShimURL,
  URLSearchParams as ShimURLSearchParams,
  uuidFromBytes
} from '../src/web.js';

describe('URL', () => {
  const valid = [
    'https://www.example.com/_sid/v1',
    'https://WWW.Example.COM:443/_sid/v1?gdpr=1&gdpr_consent=CQ#top',
    'http://127.0.0.1:8787/_sid/sync?id=pubcid%253Ac29cb2ae-769d-42f6-891a-f53cadee823d',
    'http://[::1]:8080/a/./b/../c',
    'http://localhost:8080',
    'https://example.com',
    'https://example.com/',
    'http://example.com:080/',
    'https://example.com:8443/x/..',
    'https://example.com/_sid/%2e%2e/v1',
    'HTTPS://example.com/%7e',
    'chrome-extension://abcdef/page.html'
  ];

  for (const input of valid) {
    it(`reads ${JSON.stringify(input)} as Node.js does`, () => {
      const ours = new ShimURL(input);
      const theirs = new URL(input);
      expect([ours.protocol, ours.hostname, ours.port, ours.pathname, ours.origin]).toEqual([theirs.protocol, theirs.hostname, theirs.port, theirs.pathname, theirs.origin]);
      for (const name of ['gdpr', 'gdpr_consent', 'id', 'missing']) expect(ours.searchParams.get(name)).toBe(theirs.searchParams.get(name));
    });
  }

  it('throws a TypeError where Node.js does', () => {
    for (const input of ['', 'not a url', 'https://', 'https://exa mple.com/', 'http://example.com:99999/', 'http://example.com:8o/', '//www.example.com/', '/relative', 'https://[::1/', 'https://a<b.example/']) {
      expect(() => new URL(input), input).toThrow(TypeError);
      expect(() => new ShimURL(input), input).toThrow(TypeError);
    }
  });

  it('gives allowed origins the same origin as Node.js', () => {
    for (const origin of ['https://news.example.com', 'https://News.Example.com', 'https://news.example.com:443', 'https://news.example.com/', 'http://localhost:3000', 'https://[2001:db8::1]:8443']) {
      expect(new ShimURL(origin).origin, origin).toBe(new URL(origin).origin);
    }
  });
});

describe('URLSearchParams', () => {
  it('decodes as Node.js does', () => {
    for (const query of ['a=1&b=x+y&c=%E2%82%AC&d=100%&e&=f&a=2', '?gdpr_consent=CQ%2B%2F&gpp_sid=2%2C7', 'bad=%FF&lone=%E2%82', 'x=%zz&&y==1&sp%20ace=1']) {
      const ours = new ShimURLSearchParams(query);
      const theirs = new URLSearchParams(query);
      for (const name of ['a', 'b', 'c', 'd', 'e', '', 'gdpr_consent', 'gpp_sid', 'bad', 'lone', 'x', 'y', 'sp ace', 'missing']) {
        expect(ours.get(name), `${query} ${name}`).toBe(theirs.get(name));
      }
    }
  });
});

describe('Headers', () => {
  function exercise(headers: { append(n: string, v: string): void; set(n: string, v: string): void }): void {
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Vary', 'Origin');
    headers.append('vary', 'Accept');
    headers.append('Set-Cookie', 'b=2, with a comma; Path=/');
    headers.set('Content-Type', 'image/gif');
    headers.set('X-SharedID-Status', ' denied: gpc ');
    headers.append('X-Twice', '1');
    headers.set('x-twice', '2');
  }

  it('behaves as Node.js does, with each Set-Cookie separate', () => {
    const ours = new ShimHeaders({ 'Cache-Control': 'no-store' });
    const theirs = new Headers({ 'Cache-Control': 'no-store' });
    exercise(ours);
    exercise(theirs);
    expect(ours.getSetCookie()).toEqual(theirs.getSetCookie());
    for (const name of ['vary', 'VARY', 'set-cookie', 'x-sharedid-status', 'x-twice', 'cache-control', 'missing']) {
      expect(ours.get(name), name).toBe(theirs.get(name));
      expect(ours.has(name), name).toBe(theirs.has(name));
    }
    const seen: string[] = [];
    ours.forEach((value, name) => { seen.push(`${name}: ${value}`); });
    const expected: string[] = [];
    theirs.forEach((value, name) => { expected.push(`${name}: ${value}`); });
    expect(seen).toEqual(expected);
    const pairs: [string, string][] = [['Cookie', 'a=1'], ['cookie', 'b=2']];
    expect(new ShimHeaders(pairs).get('cookie')).toBe(new Headers(pairs).get('cookie'));
  });
});

describe('Response', () => {
  it('holds bytes and text as Node.js does', async () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const ours = new ShimResponse(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
    const theirs = new Response(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
    expect(new Uint8Array(await ours.arrayBuffer())).toEqual(new Uint8Array(await theirs.arrayBuffer()));
    expect(ours.headers.get('content-type')).toBe('image/gif');
    const text = new ShimResponse('{"v":1} €', { headers: { 'Content-Type': 'application/json' } });
    expect(new TextDecoder().decode(await text.arrayBuffer())).toBe('{"v":1} €');
    const empty = new ShimResponse(null, { status: 204 });
    expect(empty.status).toBe(204);
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('Request', () => {
  it('keeps the URL, method and headers', () => {
    const request = new ShimRequest('https://www.example.com/_sid/v1?a=1', { method: 'HEAD', headers: [['Cookie', '_pubcid=1']] });
    expect([request.url, request.method, request.headers.get('cookie')]).toEqual(['https://www.example.com/_sid/v1?a=1', 'HEAD', '_pubcid=1']);
    expect(new ShimRequest('https://www.example.com/').method).toBe('GET');
  });
});

describe('uuidFromBytes', () => {
  it('formats a version 4 UUID', () => {
    expect(uuidFromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
