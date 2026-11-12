// A local stand-in for CloudFront and a Lambda function URL, for running the conformance suite against the bundled
// Lambda handler (packages/adapters/aws-lambda/deploy/lambda.mjs) without an AWS account. Each HTTP request becomes a payload
// format 2.0 event, as a function URL would send it, with the CloudFront-Viewer-Address header CloudFront adds and,
// as CloudFront sends with origin access control, the function URL's own Host rather than the site's (so the handler
// sees the site's host only through SID_PUBLIC_ORIGIN, as on AWS); the handler's result is written back the way the
// function URL would.
//
// Started by targets.ts with the case file's configuration as environment variables (read by the handler at
// "cold start", when the bundle is imported), plus PORT, SID_PUBLIC_ORIGIN and CONFORMANCE_LAMBDA_BUNDLE (the bundle's
// directory: deploy, or deploy-bowser for case files that need Bowser).
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { LambdaEventV2, LambdaHandler } from '@sharedid-edge/aws-lambda';
import { caseClientIp, caseLocation, emulatorPort, loadBundleExport, readBody, serve, trustProxyFromEnv, type CaseLocationHeader } from './emulator.js';

// deploy, deploy-bowser (Bowser in the ua module) or deploy-vendor (the vendor modules added); anything else is deploy.
const BUNDLE_DIR = ['deploy-bowser', 'deploy-vendor'].find(dir => dir === process.env['CONFORMANCE_LAMBDA_BUNDLE']) ?? 'deploy';
const BUNDLE = join(import.meta.dirname, '..', '..', 'packages/adapters/aws-lambda', BUNDLE_DIR, 'lambda.mjs');

async function loadHandler(): Promise<LambdaHandler> {
  // A function, checked by loadBundleExport; the bundle is built from src/lambda.ts, whose `handler` is a LambdaHandler.
  return (await loadBundleExport(BUNDLE, 'handler', 'npm run conformance:lambda')) as LambdaHandler;
}

/**
 * The viewer address CloudFront would send: the connecting address and port, or (with SID_TRUST_PROXY, as the
 * conformance cases use it to set the client IP) the first X-Forwarded-For entry. IPv6 is written without
 * brackets (`2001:db8::1:443`), the harder form to parse.
 */
function viewerAddress(req: IncomingMessage, trustProxy: boolean): string | undefined {
  const ip = caseClientIp(req, trustProxy);
  return ip === undefined ? undefined : `${ip}:${String(req.socket.remotePort ?? 0)}`;
}

/**
 * The conformance cases describe the visitor's location with Cloudflare's visitor location headers. Like the
 * workerd runner, which passes them as request.cf, this stand-in passes them the way CloudFront would: as its
 * CloudFront-Viewer-* geolocation headers (CloudFront has no continent header). Only with SID_TRUST_PROXY, as in the
 * cases.
 */
const LOCATION_HEADERS: Readonly<Partial<Record<CaseLocationHeader, string>>> = {
  'cf-ipcountry': 'cloudfront-viewer-country',
  'cf-region-code': 'cloudfront-viewer-country-region',
  'cf-ipcity': 'cloudfront-viewer-city',
  'cf-postal-code': 'cloudfront-viewer-postal-code',
  'cf-metro-code': 'cloudfront-viewer-metro-code',
  'cf-iplatitude': 'cloudfront-viewer-latitude',
  'cf-iplongitude': 'cloudfront-viewer-longitude',
  'cf-timezone': 'cloudfront-viewer-time-zone'
};

/** The function URL's host, which CloudFront sends as Host (the managed AllViewerExceptHostHeader policy). */
const FUNCTION_URL_HOST = 'conformance.lambda-url.us-east-1.on.aws';

async function toEvent(req: IncomingMessage, trustProxy: boolean): Promise<LambdaEventV2> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (name === 'cookie') {
      cookies.push(...values.flatMap(v => v.split(';')).map(c => c.trim()).filter(c => c !== ''));
    } else if (name !== 'host' && !name.startsWith('cloudfront-viewer-')) {
      // CloudFront replaces any CloudFront-Viewer-* headers the visitor sends; drop them the same way.
      headers[name] = values.join(',');
    }
  }
  headers['host'] = FUNCTION_URL_HOST;
  const address = viewerAddress(req, trustProxy);
  if (address !== undefined) headers['cloudfront-viewer-address'] = address;
  for (const [name, value] of caseLocation(req, trustProxy, LOCATION_HEADERS)) headers[name] = value;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = await readBody(req);
  return {
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    ...(body.byteLength > 0 ? { body: body.toString('base64'), isBase64Encoded: true } : { isBase64Encoded: false }),
    requestContext: {
      domainName: FUNCTION_URL_HOST,
      http: { method: req.method ?? 'GET', sourceIp: '127.0.0.1' }
    }
  };
}

const handler = await loadHandler();
const trustProxy = trustProxyFromEnv();
serve(emulatorPort(), 'Lambda invocation failed', async (req, res) => {
  const result = await handler(await toEvent(req, trustProxy));
  const headers: Record<string, string | string[]> = { ...result.headers };
  if (result.cookies.length > 0) headers['set-cookie'] = [...result.cookies];
  res.writeHead(result.statusCode, headers);
  res.end(Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8'));
});
