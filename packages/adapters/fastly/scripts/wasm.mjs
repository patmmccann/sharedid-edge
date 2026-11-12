// Compiles deploy/main.js (from `npm run bundle`) to deploy/main.wasm with Fastly's JavaScript SDK
// (@fastly/js-compute, pinned in toolchain/package.json): the WebAssembly a Fastly Compute package runs, with the
// JavaScript engine (SpiderMonkey, in Fastly's StarlingMonkey runtime) and the bundle, pre-initialized at build time.
//
// The SDK is a separate install in toolchain/ (about 500 MB: Wizer, weval and Wasmtime), kept out of the workspace so
// `npm ci` at the root doesn't download it. This script installs it from toolchain/package-lock.json on first use, or
// when the installed version isn't the pinned one.
//
// Fastly's limit for a compiled package is 100 MB; the build fails above it. The size is reported: almost all of it
// is the engine, not the bundle, whose own budget scripts/bundle.mjs checks.
//
// Options: --outdir <deploy* dir> (default deploy), the directory holding main.js.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

/** Fastly's limit for a compiled package. https://docs.fastly.com/products/compute-resource-limits */
const PACKAGE_LIMIT = 100 * 1024 * 1024;

const root = dirname(import.meta.dirname);
const toolchain = join(root, 'toolchain');
const { values: args } = parseArgs({ options: { outdir: { type: 'string', default: 'deploy' } } });
const outdir = resolve(root, args.outdir);
if (dirname(outdir) !== root || !basename(outdir).startsWith('deploy')) throw new Error(`--outdir must be a deploy* directory of ${root}`);
const input = join(outdir, 'main.js');
const output = join(outdir, 'main.wasm');
if (!existsSync(input)) throw new Error(`${basename(outdir)}/main.js is missing; run npm run bundle -w @sharedid-edge/fastly first`);

/** The SDK version toolchain/package.json pins. */
const pinned = JSON.parse(readFileSync(join(toolchain, 'package.json'), 'utf8')).dependencies['@fastly/js-compute'];
const sdk = join(toolchain, 'node_modules/@fastly/js-compute');
const installed = existsSync(join(sdk, 'package.json')) ? JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version : undefined;
if (installed !== pinned) {
  console.log(`Installing @fastly/js-compute ${pinned} in ${basename(root)}/toolchain (npm ci)`);
  const npm = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: toolchain, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm.status !== 0) throw new Error('npm ci in toolchain/ failed');
}

const started = Date.now();
const cli = join(sdk, 'dist/cli/js-compute-runtime-cli.js');
const compile = spawnSync(process.execPath, [cli, input, output], { cwd: root, stdio: 'inherit' });
if (compile.status !== 0) throw new Error(`js-compute-runtime failed (exit ${String(compile.status)})`);

const size = statSync(output).size;
const gzipped = gzipSync(readFileSync(output)).length;
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`Fastly Compute package: ${basename(outdir)}/main.wasm, ${mb(size)} (${mb(gzipped)} gzipped), built with @fastly/js-compute ${pinned} in ${String(Math.round((Date.now() - started) / 1000))} s (limit ${mb(PACKAGE_LIMIT)})`);
if (size > PACKAGE_LIMIT) {
  console.error("Over Fastly's 100 MB package limit");
  process.exitCode = 1;
}
