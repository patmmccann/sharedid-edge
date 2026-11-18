// A local stand-in for CloudFront running a Lambda@Edge function, for running the conformance suite against the
// Lambda@Edge bundle (packages/adapters/aws-lambda/deploy-edge*/edge.mjs, built with --unbaked) without an AWS account.
// Each HTTP request becomes a CloudFront origin-request or viewer-request event, as CloudFront would build it for a
// /_sid/* behaviour with the managed AllViewerAndCloudFrontHeaders-2022-06 origin request policy, and the response the
// function generates is checked against what CloudFront accepts and written back, as CloudFront would answer.
//
// Started by targets.ts with the case file's configuration as environment variables, plus PORT,
// CONFORMANCE_LAMBDA_EDGE_BUNDLE (the bundle's directory) and CONFORMANCE_LAMBDA_EDGE_EVENT (origin-request or
// viewer-request). Lambda@Edge has no environment variables: a deployed bundle has its settings baked in, and this one
// reads them from globalThis.__SID_EDGE__, set here before the bundle is loaded, with GDPR for a visitor without a
// location left to the client (the cases send their location only when they need one).
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { CloudFrontRequestEvent, CloudFrontResultResponse, EdgeHandler } from '@sharedid-edge/aws-lambda/edge';
import { CLOUDFRONT_LOCATION_HEADERS, caseClientIp, caseLocation, emulatorPort, loadBundleExport, serve, trustProxyFromEnv } from './emulator.js';

const BUNDLE_DIR = ['deploy-edge-bowser', 'deploy-edge-vendor', 'deploy-edge-no-tcf'].find(dir => dir === process.env['CONFORMANCE_LAMBDA_EDGE_BUNDLE']) ?? 'deploy-edge';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/aws-lambda', BUNDLE_DIR, 'edge.mjs');
const EVENT_TYPE = process.env['CONFORMANCE_LAMBDA_EDGE_EVENT'] === 'viewer-request' ? 'viewer-request' : 'origin-request';


/**
 * Headers a function's generated response can't have, and the largest response it may generate (headers and body),
 * by event: CloudFront answers 502 otherwise ([restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html),
 * [quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-lambda-at-edge)).
 */
const DISALLOWED = /^(connection|expect|keep-alive|proxy-authenticate|proxy-authorization|proxy-connection|trailer|upgrade|x-accel-.*|x-amz-cf-.*|x-amzn-.*|x-cache|x-edge-.*|x-forwarded-proto|x-real-ip|content-length|transfer-encoding|via)$/;
const RESPONSE_LIMIT = EVENT_TYPE === 'viewer-request' ? 40 * 1024 : 1024 * 1024;

async function loadHandler(): Promise<EdgeHandler> {
  const settings = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith('SID_') && entry[1] !== undefined));
  (globalThis as { __SID_EDGE__?: string }).__SID_EDGE__ = JSON.stringify({ settings, eventType: EVENT_TYPE, gdprWithoutLocation: 'client' });
  // A function, checked by loadBundleExport; the bundle is built from src/edge-lambda.ts, whose `handler` is an EdgeHandler.
  return (await loadBundleExport(BUNDLE, 'handler', 'npm run conformance:lambda-edge')) as EdgeHandler;
}

/**
 * The event CloudFront would send. The client IP is the connection's (or, with SID_TRUST_PROXY, as the cases set it,
 * the first X-Forwarded-For entry), as `clientIp`. For origin-request, CloudFront replaces any CloudFront-* headers
 * the visitor sent with its own: CloudFront-Viewer-Address, the location from the case, and CloudFront-Forwarded-Proto
 * (http, as the suite calls). A viewer-request function runs before CloudFront adds them, so it gets the visitor's
 * headers as sent, forged ones included, and no location.
 */
function toEvent(req: IncomingMessage, trustProxy: boolean): CloudFrontRequestEvent {
  const headers: Record<string, { key: string; value: string }[]> = {};
  const add = (name: string, value: string): void => { (headers[name.toLowerCase()] ??= []).push({ key: name, value }); };
  for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
    const name = req.rawHeaders[i] ?? '';
    if (EVENT_TYPE === 'viewer-request' || !name.toLowerCase().startsWith('cloudfront-')) add(name, req.rawHeaders[i + 1] ?? '');
  }
  const clientIp = caseClientIp(req, trustProxy) ?? '127.0.0.1';
  if (EVENT_TYPE === 'origin-request') {
    add('CloudFront-Viewer-Address', `${clientIp}:${String(req.socket.remotePort ?? 0)}`);
    add('CloudFront-Forwarded-Proto', 'http');
    for (const [name, value] of caseLocation(req, trustProxy, CLOUDFRONT_LOCATION_HEADERS)) add(name, value);
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return {
    Records: [{
      cf: {
        config: { distributionDomainName: 'd111111abcdef8.cloudfront.net', eventType: EVENT_TYPE },
        request: { clientIp, method: req.method ?? 'GET', uri: url.pathname, querystring: url.search.replace(/^\?/, ''), headers }
      }
    }]
  };
}

/** Checks a generated response as CloudFront would, throwing (a 502) where CloudFront would refuse it. */
function check(response: CloudFrontResultResponse): void {
  const status = Number(response.status);
  if (typeof response.status !== 'string' || !Number.isInteger(status) || status < 200 || status > 599) throw new TypeError(`status must be a string from 200 to 599, not ${JSON.stringify(response.status)}`);
  for (const [name, entries] of Object.entries(response.headers)) {
    if (name !== name.toLowerCase()) throw new TypeError(`header names must be lowercase: ${name}`);
    if (DISALLOWED.test(name)) throw new TypeError(`a function can't set ${name}`);
    for (const entry of entries) {
      if (entry.key.toLowerCase() !== name || typeof entry.value !== 'string') throw new TypeError(`header ${name} has an entry for ${entry.key}`);
    }
  }
  // Typed as text or base64, but a bundle is JavaScript: check what it returned.
  if (!['text', 'base64'].includes(response.bodyEncoding)) throw new TypeError('bodyEncoding must be text or base64');
  if (Buffer.byteLength(JSON.stringify(response)) > RESPONSE_LIMIT) throw new TypeError(`the response is over the ${EVENT_TYPE} limit`);
}

const handler = await loadHandler();
const trustProxy = trustProxyFromEnv();
serve(emulatorPort(), 'Lambda@Edge function failed', async (req, res) => {
  const response = await handler(toEvent(req, trustProxy));
  check(response);
  const headers: Record<string, string[]> = {};
  for (const [name, entries] of Object.entries(response.headers)) headers[name] = entries.map(entry => entry.value);
  res.writeHead(Number(response.status), headers);
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(response.body, response.bodyEncoding === 'base64' ? 'base64' : 'utf8'));
});
