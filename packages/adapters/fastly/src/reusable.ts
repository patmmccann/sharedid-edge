// The entry point of the --reusable-sandbox build (scripts/bundle.mjs): src/main.ts, plus Fastly's reusable sandboxes,
// so one sandbox answers several requests in turn and the handler cachedByEnv keeps in src/env.ts is built once per
// sandbox rather than once per request. Off by default: the default build doesn't import `fastly:experimental`.
//
// `setReusableSandboxOptions` is experimental in Fastly's SDK and may only be called during build-time initialization,
// which is when this top level runs. With reuse, module-level state lives from one visitor's request to the next, so
// nothing request-derived may be kept outside a request (AGENTS.md).
import { setReusableSandboxOptions } from 'fastly:experimental';
import './main.js';
import { reusableSandboxOptions, type ReusableSandboxOptions } from './sandbox.js';

/** The build's --reusable-sandbox-option values, which scripts/bundle.mjs defines; undefined outside that build. */
declare const SHAREDID_REUSABLE_SANDBOX_OPTIONS: ReusableSandboxOptions | undefined;

setReusableSandboxOptions(reusableSandboxOptions(typeof SHAREDID_REUSABLE_SANDBOX_OPTIONS === 'undefined' ? {} : SHAREDID_REUSABLE_SANDBOX_OPTIONS));
