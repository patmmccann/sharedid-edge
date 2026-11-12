// The bundled Lambda handler deployed to AWS Emulator (https://github.com/aws/aws-emulator), AWS's open-source local
// emulator of the AWS APIs, and served through the emulator's Lambda function URL: a check of the real bundle on an
// AWS-built runtime and function URL, where lambda-emulator.ts is this project's own stand-in for both.
//
// Started by targets.ts with the case file's configuration as environment variables, plus PORT, SID_PUBLIC_ORIGIN
// and CONFORMANCE_LAMBDA_BUNDLE (deploy, deploy-bowser or deploy-vendor). It needs an emulator already running on
// 127.0.0.1 (CONFORMANCE_AWS_EMULATOR_PORT, default 9297), and the AWS CLI. It:
//
// 1. zips the bundle's lambda.mjs, unchanged, with aws-emulator-runtime.ts (see there for why) preloaded through
//    NODE_OPTIONS;
// 2. creates a nodejs24.x function with the case file's settings as its environment variables, and
//    SID_BEHIND_CLOUDFRONT=false, as nothing is in front of the function URL; then a function URL with AuthType NONE
//    and the resource policy that makes it public;
// 3. relays plain http on PORT to the function URL, so the runner calls it like the other targets, and deletes the
//    function when it's stopped.
//
// Every AWS CLI call goes to the emulator: the endpoint, credentials and certificate are the files the emulator writes
// to ~/.aws/emulator/<port>/, and any AWS credentials in the environment are removed, so nothing can reach AWS.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { transform } from 'esbuild';
import { emulatorPort, readBody, serve } from './emulator.js';

const ROOT = join(import.meta.dirname, '..', '..');
// deploy, deploy-bowser (Bowser in the ua module) or deploy-vendor (the vendor modules added); anything else is deploy.
const BUNDLE_DIR = ['deploy-bowser', 'deploy-vendor'].find(dir => dir === process.env['CONFORMANCE_LAMBDA_BUNDLE']) ?? 'deploy';
const EMULATOR_PORT = process.env['CONFORMANCE_AWS_EMULATOR_PORT'] ?? '9297';
const EMULATOR_FILES = join(homedir(), '.aws', 'emulator', EMULATOR_PORT);
const ENDPOINT = new URL(`https://127.0.0.1:${EMULATOR_PORT}`);
const REGION = 'us-east-1';
const FUNCTION_NAME = `sharedid-conformance-${String(process.pid)}`;
/** The file the runtime fill (aws-emulator-runtime.ts) is preloaded from, in the function's /var/task. */
const SHIM_FILE = 'aws-emulator-runtime.cjs';

/** The environment for the AWS CLI: the emulator's endpoint, credentials and certificate, and nothing of AWS's. */
function awsEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('SID_')));
  return {
    ...env,
    AWS_ENDPOINT_URL: ENDPOINT.origin,
    AWS_SHARED_CREDENTIALS_FILE: join(EMULATOR_FILES, 'emulator_credentials'),
    AWS_CONFIG_FILE: join(EMULATOR_FILES, 'config'),
    AWS_CA_BUNDLE: join(EMULATOR_FILES, 'ca.pem'),
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_PAGER: ''
  };
}

/** Runs `aws lambda <args>` against the emulator and returns its standard output. */
async function lambda(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aws', ['lambda', ...args, '--output', 'text'], { env: awsEnv(), encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim());
      else reject(new Error(`aws lambda ${args[0] ?? ''} failed: ${stderr.trim() === '' ? error.message : stderr.trim()}`));
    });
  });
}

/** A zip archive of `files`, deflated: the code archive Lambda's CreateFunction takes. */
function zip(files: Readonly<Record<string, Uint8Array>>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const fileName = Buffer.from(name, 'utf8');
    const data = deflateRawSync(content);
    const checksum = crc32(content);
    // The fields both headers share: version needed, flags (UTF-8 names), deflate, time and date (zero), CRC-32 and sizes.
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(20, 0);
    shared.writeUInt16LE(0x0800, 2);
    shared.writeUInt16LE(8, 4);
    shared.writeUInt32LE(checksum, 10);
    shared.writeUInt32LE(data.byteLength, 14);
    shared.writeUInt32LE(content.byteLength, 18);
    shared.writeUInt16LE(fileName.byteLength, 22);
    const header = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, fileName]);
    local.push(header, data);
    // Version made by: Unix, so the mode in the external attributes is read (a regular file, readable by everyone).
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    shared.copy(entry, 6);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += header.byteLength + data.byteLength;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** The runtime fill, as the CommonJS script `--require` loads, for the oldest syntax the emulator's engine needs. */
async function runtimeFill(): Promise<string> {
  const source = await readFile(join(import.meta.dirname, 'aws-emulator-runtime.js'), 'utf8');
  return (await transform(source, { format: 'cjs', target: 'es2020', loader: 'js' })).code;
}

/** Creates the function and its public function URL, and returns the function URL's host. */
async function deploy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sharedid-aws-emulator-'));
  try {
    const archive = join(dir, 'function.zip');
    await writeFile(archive, zip({
      'lambda.mjs': await readFile(join(ROOT, 'packages/adapters/aws-lambda', BUNDLE_DIR, 'lambda.mjs')),
      [SHIM_FILE]: Buffer.from(await runtimeFill(), 'utf8')
    }));
    const variables: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith('SID_') && entry[1] !== undefined)),
      // Nothing is in front of the function URL, so the handler mustn't trust CloudFront-Viewer-* headers.
      SID_BEHIND_CLOUDFRONT: 'false',
      NODE_OPTIONS: `--require /var/task/${SHIM_FILE}`
    };
    await lambda('create-function', '--function-name', FUNCTION_NAME, '--runtime', 'nodejs24.x', '--handler', 'lambda.handler',
      '--role', 'arn:aws:iam::000000000000:role/sharedid-conformance', '--timeout', '5', '--memory-size', '256',
      '--zip-file', `fileb://${archive}`, '--environment', JSON.stringify({ Variables: variables }), '--query', 'FunctionArn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // A public function URL needs both grants to everyone (AuthType NONE), as on AWS.
  await Promise.all([
    lambda('add-permission', '--function-name', FUNCTION_NAME, '--statement-id', 'url', '--action', 'lambda:InvokeFunctionUrl',
      '--principal', '*', '--function-url-auth-type', 'NONE'),
    lambda('add-permission', '--function-name', FUNCTION_NAME, '--statement-id', 'invoke', '--action', 'lambda:InvokeFunction',
      '--principal', '*', '--invoked-via-function-url')
  ]);
  const url = await lambda('create-function-url-config', '--function-name', FUNCTION_NAME, '--auth-type', 'NONE', '--query', 'FunctionUrl');
  return new URL(url).host;
}

/**
 * Request headers the relay doesn't pass on: Host (the function URL's instead), Connection (hop by hop), and
 * X-Forwarded-For. Lambda sets `requestContext.http.sourceIp` from the connection; AWS Emulator takes the client's
 * X-Forwarded-For instead, which would let the cases choose the client IP through a function URL, as no one can on AWS.
 * Dropped, the function sees the relay's address, as on AWS.
 */
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'x-forwarded-for']);
/** Hop-by-hop response headers, which belong to the relay's own connection. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

/** Pairs of raw header names and values, without those in `dropped`. */
function rawHeadersWithout(raw: readonly string[], dropped: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? '';
    if (!dropped.has(name.toLowerCase())) kept.push(name, raw[i + 1] ?? '');
  }
  return kept;
}

const host = await deploy();
const ca = readFileSync(join(EMULATOR_FILES, 'ca.pem'));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await lambda('delete-function', '--function-name', FUNCTION_NAME).catch((error: unknown) => { console.error(error); });
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });

// The function URL's own host, addressed at the emulator's endpoint: the request reaches the function as it would on
// AWS, with Host and requestContext.domainName the function URL's.
serve(emulatorPort(), 'AWS Emulator relay failed', async (req, res) => {
  const body = await readBody(req);
  const headers = [...rawHeadersWithout(req.rawHeaders, DROPPED_REQUEST_HEADERS), 'Host', host];
  await new Promise<void>((resolve, reject) => {
    const upstream = request({ host: ENDPOINT.hostname, port: ENDPOINT.port, method: req.method ?? 'GET', path: req.url ?? '/', headers, ca,
      // The certificate is the emulator's own, for its address; the Host header names the function URL.
      checkServerIdentity: (_name, cert) => checkServerIdentity(ENDPOINT.hostname, cert) }, response => {
      res.writeHead(response.statusCode ?? 502, rawHeadersWithout(response.rawHeaders, DROPPED_RESPONSE_HEADERS));
      response.pipe(res);
      response.on('end', resolve);
      response.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.end(body);
  });
});
