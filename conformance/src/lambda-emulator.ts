// A local stand-in for CloudFront and a Lambda function URL, for running the conformance suite against the bundled
// Lambda handler (packages/adapters/aws-lambda/deploy/lambda.mjs) without an AWS account. Each HTTP request becomes a payload
// format 2.0 event, as a function URL would send it, with the CloudFront-Viewer-Address header CloudFront adds; the
// handler's result is written back the way the function URL would.
//
// Started by targets.ts with the case file's configuration as environment variables (read by the handler at
// "cold start", when the bundle is imported), plus PORT, SID_PUBLIC_ORIGIN and CONFORMANCE_LAMBDA_BUNDLE (the bundle's
// directory: deploy, or deploy-bowser for case files that need Bowser).
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LambdaEventV2, LambdaHandler } from '@sharedid-edge/aws-lambda';

const BUNDLE_DIR = process.env['CONFORMANCE_LAMBDA_BUNDLE'] === 'deploy-bowser' ? 'deploy-bowser' : 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/aws-lambda', BUNDLE_DIR, 'lambda.mjs');

async function loadHandler(): Promise<LambdaHandler> {
  const loaded: unknown = await import(pathToFileURL(BUNDLE).href);
  const handler = typeof loaded === 'object' && loaded !== null && 'handler' in loaded ? loaded.handler : undefined;
  if (typeof handler !== 'function') throw new Error(`${BUNDLE} doesn't export a handler; run npm run conformance:lambda from the repository root`);
  // Checked to be a function above; the bundle is built from src/lambda.ts, whose `handler` is a LambdaHandler.
  return handler as LambdaHandler;
}

/**
 * The viewer address CloudFront would send: the connecting address and port, or (with SID_TRUST_PROXY, as the
 * conformance cases use it to set the client IP) the first X-Forwarded-For entry. IPv6 is written without
 * brackets (`2001:db8::1:443`), the harder form to parse.
 */
function viewerAddress(req: IncomingMessage, trustProxy: boolean): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const ip = trustProxy && first !== undefined && first !== '' ? first : req.socket.remoteAddress;
  return ip === undefined ? undefined : `${ip}:${String(req.socket.remotePort ?? 0)}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

/**
 * The conformance cases describe the visitor's location with Cloudflare's visitor location headers. Like the
 * workerd runner, which passes them as request.cf, this stand-in passes them the way CloudFront would: as its
 * CloudFront-Viewer-* geolocation headers (CloudFront has no continent header). Only with SID_TRUST_PROXY, as in the
 * cases.
 */
const LOCATION_HEADERS: Readonly<Record<string, string>> = {
  'cf-ipcountry': 'cloudfront-viewer-country',
  'cf-region-code': 'cloudfront-viewer-country-region',
  'cf-ipcity': 'cloudfront-viewer-city',
  'cf-postal-code': 'cloudfront-viewer-postal-code',
  'cf-metro-code': 'cloudfront-viewer-metro-code',
  'cf-iplatitude': 'cloudfront-viewer-latitude',
  'cf-iplongitude': 'cloudfront-viewer-longitude',
  'cf-timezone': 'cloudfront-viewer-time-zone'
};

async function toEvent(req: IncomingMessage, trustProxy: boolean): Promise<LambdaEventV2> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (name === 'cookie') {
      cookies.push(...values.flatMap(v => v.split(';')).map(c => c.trim()).filter(c => c !== ''));
    } else if (!name.startsWith('cloudfront-viewer-')) {
      // CloudFront replaces any CloudFront-Viewer-* headers the visitor sends; drop them the same way.
      headers[name] = values.join(',');
    }
  }
  const address = viewerAddress(req, trustProxy);
  if (address !== undefined) headers['cloudfront-viewer-address'] = address;
  if (trustProxy) {
    for (const [from, to] of Object.entries(LOCATION_HEADERS)) {
      const value = headers[from];
      if (value === undefined) continue;
      // Node reads header bytes as Latin-1; city names arrive as UTF-8, so decode them back, as the Node.js adapter does.
      headers[to] = from === 'cf-ipcity' ? Buffer.from(value, 'latin1').toString('utf8') : value;
    }
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = await readBody(req);
  return {
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    ...(body.byteLength > 0 ? { body: body.toString('base64'), isBase64Encoded: true } : { isBase64Encoded: false }),
    requestContext: {
      domainName: 'conformance.lambda-url.us-east-1.on.aws',
      http: { method: req.method ?? 'GET', sourceIp: '127.0.0.1' }
    }
  };
}

const handler = await loadHandler();
const trustProxy = /^(1|true|yes|on)$/i.test(process.env['SID_TRUST_PROXY'] ?? '');
const server = createServer((req, res) => {
  toEvent(req, trustProxy)
    .then(handler)
    .then(result => {
      const headers: Record<string, string | string[]> = { ...result.headers };
      if (result.cookies.length > 0) headers['set-cookie'] = [...result.cookies];
      res.writeHead(result.statusCode, headers);
      res.end(Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8'));
    })
    .catch((error: unknown) => {
      console.error('lambda emulator: invocation failed', error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Lambda invocation failed');
    });
});
server.listen(Number(process.env['PORT'] ?? 8787), '127.0.0.1');
