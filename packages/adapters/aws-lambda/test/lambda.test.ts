import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModule, resolveConfig } from '@sharedid-edge/core';
import {
  builtInModules,
  createLambdaHandler,
  EU_COUNTRY_CODES,
  handlerFromEnv,
  parseViewerAddress,
  platformInfo
} from '../src/index.js';
import { cloudFrontEvent } from './events.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const OTHER = '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10';

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string } };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

function payload(body: string): Payload {
  return JSON.parse(body) as Payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLambdaHandler', () => {
  it('answers a first-visit sync with the base64 GIF and each Set-Cookie in cookies[]', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const result = await handler(cloudFrontEvent({ query: `id=pubcid%253A${UUID}` }));
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('image/gif');
    expect(result.headers).not.toHaveProperty('set-cookie');
    expect(result.cookies).toHaveLength(2);
    expect(result.cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
    expect(result.cookies[1]).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
    // CloudFront terminates TLS, so the request URL is https and the cookies are Secure.
    for (const cookie of result.cookies) expect(cookie).toContain('; Secure');
    expect(result.isBase64Encoded).toBe(true);
    const gif = Buffer.from(result.body, 'base64');
    expect(gif.byteLength).toBe(43);
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('joins the event cookies[] back into the Cookie header', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const result = await handler(cloudFrontEvent({
      path: '/_sid/v1',
      cookies: ['euconsent-v2=', `_pubcid=${UUID}`, `_pubcid_sv=${UUID}`, 'other=1']
    }));
    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(result.headers['x-sharedid-source']).toBe('cookie');
    expect(payload(result.body).sharedid).toBe(UUID);
  });

  it('restores the recovery copy from cookies[] over a re-minted ID', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const result = await handler(cloudFrontEvent({ query: `id=pubcid%253A${OTHER}`, cookies: [`_pubcid_sv=${UUID}`] }));
    expect(result.headers['x-sharedid-source']).toBe('recovery');
    expect(result.cookies[0]).toMatch(new RegExp(`^_pubcid=${UUID};`));
  });

  it('builds the URL from X-Forwarded-Host or publicOrigin; the scheme decides Secure', async () => {
    const seen: string[] = [];
    const probe = defineModule({ name: 'probe', run: ({ url }) => { seen.push(url.origin); return undefined; } });
    const config = resolveConfig({ SID_MODULES: 'probe' });
    await createLambdaHandler({ config, modules: [probe] })(cloudFrontEvent({ path: '/_sid/v1', headers: { 'x-forwarded-host': 'www.example.com' } }));
    await createLambdaHandler({ config, modules: [probe] })(cloudFrontEvent({ path: '/_sid/v1' }));
    expect(seen).toEqual(['https://www.example.com', 'https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-west-2.on.aws']);

    const plain = await createLambdaHandler({ config: resolveConfig({}), publicOrigin: 'http://localhost:3000' })(cloudFrontEvent());
    expect(plain.cookies[0]).not.toContain('Secure');
  });

  it('answers HEAD without a body, and other methods with 405', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const head = await handler(cloudFrontEvent({ method: 'HEAD' }));
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.isBase64Encoded).toBe(false);
    const post = await handler({ ...cloudFrontEvent({ method: 'POST' }), body: Buffer.from('x=1').toString('base64'), isBase64Encoded: true });
    expect(post.statusCode).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
  });

  it('returns a generic 500 when the request can\'t be built, without request data', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const result = await handler(cloudFrontEvent({ headers: { 'x-forwarded-host': 'bad host/secret' } }));
    expect(result.statusCode).toBe(500);
    expect(result.body).toBe('Internal error');
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
  });
});

describe('the ip module on /v1', () => {
  const handler = createLambdaHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules });

  it('uses an IPv4 CloudFront-Viewer-Address', async () => {
    const result = await handler(cloudFrontEvent({ path: '/_sid/v1', omitHeaders: ['cloudfront-viewer-country', 'cloudfront-viewer-country-region'] }));
    const body = payload(result.body);
    expect(body.ortb2?.device?.ip).toBe('198.51.100.23');
    expect(body.ext.modules['ip']?.status).toBe('ok');
  });

  it.each([
    ['bracketed', '[2001:DB8:0:0:abcd::1]:51234'],
    ['unbracketed', '2001:DB8:0:0:abcd::1:51234']
  ])('uses an IPv6 CloudFront-Viewer-Address, %s', async (_form, address) => {
    const result = await handler(cloudFrontEvent({
      path: '/_sid/v1',
      headers: { 'cloudfront-viewer-address': address },
      omitHeaders: ['cloudfront-viewer-country']
    }));
    expect(payload(result.body).ortb2?.device?.ipv6).toBe('2001:db8::abcd:0:0:1');
  });

  it('ignores X-Forwarded-For and sourceIp behind CloudFront', async () => {
    const result = await handler(cloudFrontEvent({ path: '/_sid/v1', omitHeaders: ['cloudfront-viewer-address', 'cloudfront-viewer-country'] }));
    const body = payload(result.body);
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ip']?.status).toBe('empty');
  });

  it('is built in through handlerFromEnv', async () => {
    const result = await handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ip' })(cloudFrontEvent({ path: '/_sid/v1', omitHeaders: ['cloudfront-viewer-country'] }));
    expect(payload(result.body).ortb2?.device?.ip).toBe('198.51.100.23');
  });
});

describe('platformInfo', () => {
  it('reads the viewer address, country, region and EU flag', () => {
    expect(platformInfo(cloudFrontEvent())).toEqual({ clientIp: '198.51.100.23', country: 'US', region: 'WA', isEU: false });
    expect(platformInfo(cloudFrontEvent({ headers: { 'cloudfront-viewer-country': 'fr', 'cloudfront-viewer-country-region': 'IDF' } })))
      .toEqual({ clientIp: '198.51.100.23', country: 'FR', region: 'IDF', isEU: true });
  });

  it('reads the rest of CloudFront\'s geolocation headers for the geo module, validated by core', () => {
    const geo = {
      'cloudfront-viewer-city': 'Seattle',
      'cloudfront-viewer-postal-code': '98101',
      'cloudfront-viewer-metro-code': '819',
      'cloudfront-viewer-latitude': '47.61000',
      'cloudfront-viewer-longitude': '-122.33000',
      'cloudfront-viewer-time-zone': 'America/Los_Angeles'
    };
    expect(platformInfo(cloudFrontEvent({ headers: geo }))).toEqual({
      clientIp: '198.51.100.23', country: 'US', region: 'WA', isEU: false,
      city: 'Seattle', postalCode: '98101', metroCode: '819', latitude: 47.61, longitude: -122.33, timezone: 'America/Los_Angeles'
    });
    // out-of-range coordinates are dropped, as on every adapter
    expect(platformInfo(cloudFrontEvent({ headers: { ...geo, 'cloudfront-viewer-latitude': '123' } }))).not.toHaveProperty('latitude');
  });

  it('runs the geo module from CloudFront\'s headers', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({ SID_MODULES: 'geo' }), modules: builtInModules });
    const result = await handler(cloudFrontEvent({ path: '/_sid/v1', headers: { 'cloudfront-viewer-city': 'Seattle', 'cloudfront-viewer-time-zone': 'America/Los_Angeles' } }));
    const body = JSON.parse(result.body) as { ortb2?: { device?: { geo?: Record<string, unknown> } } };
    expect(body.ortb2?.device?.geo).toMatchObject({ type: 2, country: 'USA', region: 'WA', city: 'Seattle' });
  });

  it('leaves location and isEU undefined when the geo headers are missing', () => {
    const info = platformInfo(cloudFrontEvent({ omitHeaders: ['cloudfront-viewer-country', 'cloudfront-viewer-country-region'] }));
    expect(info).toEqual({ clientIp: '198.51.100.23' });
    expect(info.isEU).toBeUndefined();
  });

  it('applies GDPR from the EU flag, and not when the geo headers are missing', async () => {
    const handler = createLambdaHandler({ config: resolveConfig({}) });
    const eu = await handler(cloudFrontEvent({ headers: { 'cloudfront-viewer-country': 'FR' } }));
    expect(eu.headers['x-sharedid-status']).toBe('denied: tcf: GDPR applies and there is no TC string');
    expect(eu.cookies).toEqual([]);
    const unknown = await handler(cloudFrontEvent({ omitHeaders: ['cloudfront-viewer-country'] }));
    expect(unknown.cookies).toHaveLength(2);
  });

  it('uses sourceIp, and ignores CloudFront headers, only when CloudFront is not in front', () => {
    expect(platformInfo(cloudFrontEvent(), { behindCloudFront: false })).toEqual({ clientIp: '64.252.0.10' });
    expect(platformInfo(cloudFrontEvent({ omitHeaders: ['cloudfront-viewer-address'] }))).not.toHaveProperty('clientIp');
  });

  it('parses viewer addresses', () => {
    expect(parseViewerAddress('192.0.2.1:443')).toBe('192.0.2.1');
    expect(parseViewerAddress(' [2001:db8::1]:46532 ')).toBe('2001:db8::1');
    expect(parseViewerAddress('2001:db8::1:46532')).toBe('2001:db8::1');
    expect(parseViewerAddress('::1:80')).toBe('::1');
    expect(parseViewerAddress('::ffff:192.0.2.1:80')).toBe('::ffff:192.0.2.1');
    for (const bad of [undefined, '', '192.0.2.1', '[2001:db8::1', 'host.example:443', '192.0.2.1:port', ':443', '<x>:1']) {
      expect(parseViewerAddress(bad)).toBeUndefined();
    }
  });

  it('lists the 27 EU member states', () => {
    expect(EU_COUNTRY_CODES.size).toBe(27);
    for (const code of ['DE', 'FR', 'IE', 'HR', 'CY']) expect(EU_COUNTRY_CODES.has(code)).toBe(true);
    for (const code of ['GB', 'NO', 'IS', 'LI', 'CH', 'US']) expect(EU_COUNTRY_CODES.has(code)).toBe(false);
  });
});

describe('handlerFromEnv', () => {
  it('answers every request with a 500 when the configuration is invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MAX_AGE_DAYS: '0' });
    expect(error).toHaveBeenCalledOnce();
    for (const path of ['/_sid/sync', '/_sid/v1']) {
      const result = await handler(cloudFrontEvent({ path }));
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('SharedID Edge is misconfigured');
      expect(result.cookies).toEqual([]);
      expect(result.headers['cache-control']).toBe('no-store');
    }
  });

  it('answers every request with a 500 without SID_COOKIE_DOMAIN, naming the setting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFromEnv({});
    expect(String(error.mock.calls[0]?.[0])).toContain('SID_COOKIE_DOMAIN');
    expect((await handler(cloudFrontEvent({ path: '/_sid/sync' }))).statusCode).toBe(500);
    error.mockRestore();
  });

  it("doesn't build in ec: listed in SID_MODULES without being added, it's skipped as not installed", async () => {
    const handler = handlerFromEnv({
      SID_COOKIE_DOMAIN: 'host-only',
      SID_MODULES: 'ec',
      SID_MODULE_CONFIG: '{"ec":{"domain":"example.com"}}',
      SID_MODULE_SECRETS: '{"ec":{"passphrase":"conformance-passphrase-0123456789abcdef"}}'
    });
    const result = await handler(cloudFrontEvent({ path: '/_sid/v1', headers: { 'cloudfront-viewer-address': '192.0.2.77:443' } }));
    // ec is a vendor module: a deployer adds it at build time (conformance/cases/module-ec.json covers that build).
    expect(payload(result.body).ext.modules['ec']).toEqual({ ms: 0, status: 'skipped', reason: 'not installed' });
    expect(result.cookies.find(c => c.startsWith('ts-ec='))).toBeUndefined();
  });

  it('reads SID_PUBLIC_ORIGIN and SID_BEHIND_CLOUDFRONT', async () => {
    const handler = handlerFromEnv({ SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: 'ip', SID_PUBLIC_ORIGIN: 'http://localhost:3000', SID_BEHIND_CLOUDFRONT: 'false' });
    const result = await handler(cloudFrontEvent({ path: '/_sid/v1', omitHeaders: ['cloudfront-viewer-country'] }));
    expect(payload(result.body).ortb2?.device?.ip).toBe('64.252.0.10');
    expect(result.cookies[0]).not.toContain('Secure');
  });
});

describe('template.yaml', () => {
  it('sends /_sid/* through the managed CachingDisabled and AllViewerExceptHostHeader policies', () => {
    const template = readFileSync(join(import.meta.dirname, '..', 'template.yaml'), 'utf8');
    const behaviour = template.slice(template.indexOf('CacheBehaviors:'), template.indexOf('\nOutputs:'));
    // AllViewerExceptHostHeader forwards User-Agent, the Client Hints, Origin, Sec-GPC and CloudFront's viewer
    // address and location headers, but not Host, which origin access control needs to be the function URL's.
    expect(behaviour).toContain('CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(behaviour).toContain('OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac');
    expect(template).not.toContain('AWS::CloudFront::OriginRequestPolicy');
    expect(template).not.toContain('AWS::CloudFront::CachePolicy');
  });

  it('passes every SID_* setting core reads to the function', () => {
    const root = join(import.meta.dirname, '..');
    const coreDir = dirname(createRequire(import.meta.url).resolve('@sharedid-edge/core/package.json'));
    const core = readFileSync(join(coreDir, 'dist/config.js'), 'utf8');
    const settings = new Set(Array.from(core.matchAll(/'(SID_[A-Z_]+)'/g), m => m[1]));
    const template = readFileSync(join(root, 'template.yaml'), 'utf8');
    const passed = new Set(Array.from(template.matchAll(/^ {10}(SID_[A-Z_]+): !Ref /gm), m => m[1]));
    expect(settings.size).toBeGreaterThan(10);
    expect([...passed].sort()).toEqual([...settings].sort());
  });
  it('uploads only the bundle directory, never dist/ with its unbundled lambda.js', () => {
    // Lambda's loader tries lambda.js before lambda.mjs, so uploading dist/ would load the unbundled entry.
    const template = readFileSync(join(import.meta.dirname, '..', 'template.yaml'), 'utf8');
    expect(template).toMatch(/^ {6}CodeUri: deploy\/$/m);
    expect(template).toMatch(/^ {6}Handler: lambda\.handler$/m);
  });
});
