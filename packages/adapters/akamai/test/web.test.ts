// The bundle's stand-ins for the web-platform classes (src/web.ts), checked against Node.js's own.
import { describe, expect, it } from 'vitest';
import {
  Headers as ShimHeaders,
  Request as ShimRequest,
  Response as ShimResponse,
  URL as ShimURL,
  URLSearchParams as ShimURLSearchParams,
  uuidFromBytes
} from '../src/web.js';

function urlParts(url: { href: string; origin: string; protocol: string; host: string; hostname: string; port: string; pathname: string; search: string; hash: string }): Record<string, string> {
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = url;
  return { href, origin, protocol, host, hostname, port, pathname, search, hash };
}

describe('URL', () => {
  const valid = [
    'https://www.example.com/_sid/v1',
    'https://WWW.Example.COM:443/_sid/v1?gdpr=1&gdpr_consent=CQ#top',
    'http://127.0.0.1:8787/_sid/sync?id=pubcid%253Ac29cb2ae-769d-42f6-891a-f53cadee823d',
    'http://[::1]:8080/a/./b/../c',
    'http://localhost:8080',
    'https://example.com',
    'https://example.com/',
    'https://example.com/path with space/ü?q=ü v&x="1"',
    'http://example.com:080/',
    'https://example.com:8443/x/..',
    'https://user:pass@example.com/',
    '  https://example.com/\t',
    'HTTPS://example.com/%7e',
    'chrome-extension://abcdef/page.html'
  ];

  for (const input of valid) {
    it(`parses ${JSON.stringify(input)} as Node.js does`, () => {
      const ours = urlParts(new ShimURL(input));
      const theirs = urlParts(new URL(input));
      // Credentials are dropped; nothing in SharedID Edge reads them, and they're never in an origin.
      if (input.includes('@')) {
        expect({ ...ours, href: '' }).toEqual({ ...theirs, href: '' });
        expect(ours['href']).toBe('https://example.com/');
      } else {
        expect(ours).toEqual(theirs);
      }
    });
  }

  it('reads the query as URLSearchParams', () => {
    const url = new ShimURL('https://www.example.com/_sid/sync?id=pubcid%253Aabc&gdpr=1&us_privacy=1YNN');
    expect(url.searchParams.get('id')).toBe('pubcid%3Aabc');
    expect(url.searchParams.get('gdpr')).toBe('1');
    expect(url.searchParams.get('gpp')).toBeNull();
  });

  it('resolves /path, ?query and #fragment against a base', () => {
    for (const [input, base] of [['/x/y?z=1', 'https://a.example/b/c'], ['?q=2', 'https://a.example/b/c?d'], ['#f', 'https://a.example/b?c']] as const) {
      expect(new ShimURL(input, base).href).toBe(new URL(input, base).href);
    }
  });

  it('throws a TypeError where Node.js does', () => {
    for (const input of ['', 'not a url', 'https://', 'https://exa mple.com/', 'http://example.com:99999/', 'http://example.com:8o/', '//www.example.com/', '/relative', 'https://[::1/', 'https://a<b.example/']) {
      expect(() => new URL(input), input).toThrow(TypeError);
      expect(() => new ShimURL(input), input).toThrow(TypeError);
    }
  });

  it('gives allowed origins the same origin as Node.js', () => {
    for (const origin of ['https://news.example.com', 'https://News.Example.com', 'https://news.example.com:443', 'https://news.example.com/', 'http://localhost:3000', 'file:///tmp']) {
      const ours = (() => { try { return new ShimURL(origin).origin; } catch { return 'error'; } })();
      const theirs = (() => { try { return new URL(origin).origin; } catch { return 'error'; } })();
      if (origin.startsWith('file:')) {
        // file URLs aren't supported (no host); either way it isn't a valid allowed origin.
        expect(ours).not.toBe(origin);
      } else {
        expect(ours, origin).toBe(theirs);
      }
    }
  });
});

describe('URLSearchParams', () => {
  it('decodes as Node.js does', () => {
    for (const query of ['a=1&b=x+y&c=%E2%82%AC&d=100%&e&=f&a=2', '?gdpr_consent=CQ%2B%2F&gpp_sid=2%2C7', 'bad=%FF&lone=%E2%82', 'x=%zz&&y==1']) {
      const ours = new ShimURLSearchParams(query);
      const theirs = new URLSearchParams(query);
      expect([...ours], query).toEqual([...theirs]);
      expect(ours.size).toBe(theirs.size);
      expect(ours.get('a')).toBe(theirs.get('a'));
      expect(ours.getAll('a')).toEqual(theirs.getAll('a'));
      expect(ours.has('e')).toBe(theirs.has('e'));
      const seen: string[] = [];
      ours.forEach((value, name) => { seen.push(`${name}=${value}`); });
      expect(seen).toEqual([...theirs].map(([name, value]) => `${name}=${value}`));
    }
  });
});

describe('Headers', () => {
  function exercise(headers: { append(n: string, v: string): void; set(n: string, v: string): void; delete(n: string): void }): void {
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Vary', 'Origin');
    headers.append('vary', 'Accept');
    headers.append('Set-Cookie', 'b=2, with a comma; Path=/');
    headers.set('Content-Type', 'image/gif');
    headers.set('X-SharedID-Status', ' denied: gpc ');
    headers.append('X-Gone', '1');
    headers.delete('x-gone');
  }

  it('behaves as Node.js does, with each Set-Cookie separate', () => {
    const ours = new ShimHeaders({ 'Cache-Control': 'no-store' });
    const theirs = new Headers({ 'Cache-Control': 'no-store' });
    exercise(ours);
    exercise(theirs);
    expect([...ours]).toEqual([...theirs]);
    expect(ours.getSetCookie()).toEqual(theirs.getSetCookie());
    for (const name of ['vary', 'VARY', 'set-cookie', 'x-sharedid-status', 'x-gone', 'cache-control']) {
      expect(ours.get(name), name).toBe(theirs.get(name));
      expect(ours.has(name), name).toBe(theirs.has(name));
    }
    const seen: string[] = [];
    ours.forEach((value, name) => { seen.push(`${name}: ${value}`); });
    const expected: string[] = [];
    theirs.forEach((value, name) => { expected.push(`${name}: ${value}`); });
    expect(seen).toEqual(expected);
    expect([...new ShimHeaders(ours)]).toEqual([...ours]);
    expect([...new ShimHeaders(theirs)]).toEqual([...theirs]);
  });

  it('rejects invalid names and values', () => {
    expect(() => new ShimHeaders({ 'bad name': '1' })).toThrow(TypeError);
    expect(() => new ShimHeaders({ ok: 'a\r\nb' })).toThrow(TypeError);
  });
});

describe('Response', () => {
  it('holds bytes and text as Node.js does', async () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const ours = new ShimResponse(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
    const theirs = new Response(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
    expect(new Uint8Array(await ours.arrayBuffer())).toEqual(new Uint8Array(await theirs.arrayBuffer()));
    expect(ours.headers.get('content-type')).toBe('image/gif');
    const text = new ShimResponse('{"v":1} €');
    expect(await text.text()).toBe(await new Response('{"v":1} €').text());
    expect(text.headers.get('content-type')).toBe(new Response('x').headers.get('content-type'));
    const empty = new ShimResponse(null, { status: 204 });
    expect(empty.status).toBe(204);
    expect(empty.ok).toBe(true);
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
  });

  it('rejects what Node.js rejects', () => {
    expect(() => new ShimResponse('x', { status: 204 })).toThrow(TypeError);
    expect(() => new Response('x', { status: 204 })).toThrow(TypeError);
    expect(() => new ShimResponse(null, { status: 600 })).toThrow(RangeError);
    expect(() => new Response(null, { status: 600 })).toThrow(RangeError);
  });
});

describe('Request', () => {
  it('normalizes the URL and method as Node.js does', () => {
    for (const [url, method] of [['HTTPS://WWW.Example.com:443/_sid/v1?a=1', 'get'], ['http://127.0.0.1:8787/_sid/sync', 'HEAD'], ['https://www.example.com/', 'patch']] as const) {
      const ours = new ShimRequest(url, { method, headers: [['Cookie', '_pubcid=1']] });
      const theirs = new Request(url, { method, headers: [['Cookie', '_pubcid=1']] });
      expect([ours.url, ours.method, ours.headers.get('cookie')]).toEqual([theirs.url, theirs.method, theirs.headers.get('cookie')]);
    }
  });
});

describe('uuidFromBytes', () => {
  it('formats a version 4 UUID', () => {
    expect(uuidFromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() => uuidFromBytes(new Uint8Array(15))).toThrow(RangeError);
  });
});
