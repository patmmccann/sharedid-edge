// The options for Fastly's reusable sandboxes, which the --reusable-sandbox build (src/reusable.ts) turns on. Kept
// apart from the entry point so they're unit-tested in Node.js: this module imports nothing from `fastly:*`.

/**
 * `setReusableSandboxOptions`'s options (`fastly:experimental`, @fastly/js-compute 3.40 and later): when a sandbox that
 * has answered a request is recycled rather than given the next one.
 * https://js-compute-reference-docs.edgecompute.app/docs/fastly:experimental/setReusableSandboxOptions
 */
export interface ReusableSandboxOptions {
  /** Requests a sandbox answers before it's recycled; 0 for no limit. Fastly's default is 1: no reuse. */
  readonly maxRequests?: number;
  /** How long a sandbox waits for its next request, in milliseconds, before it's recycled. */
  readonly betweenRequestTimeoutMs?: number;
  /** The memory a sandbox may use, in MiB; above it, it's recycled before the next request. */
  readonly maxMemoryMiB?: number;
  /** How long a sandbox may live, in milliseconds; after it, it's recycled once the current request is answered. */
  readonly sandboxTimeoutMs?: number;
}

/**
 * The defaults: reuse, but bounded, so a sandbox lives for at most 50 requests or a minute, and goes when it's idle for
 * 2 seconds or uses more than 64 MiB. The handler is built once per sandbox, so 50 requests make that cost about 2% of
 * what it is without reuse; more would save little and keep a sandbox (and anything that went wrong in it) longer.
 * The time limits follow IAB Tech Lab's Trusted Server, whose Fastly adapter has the same opt-in. 64 MiB is half of
 * Fastly's per-sandbox heap limit and far above what the handler uses.
 */
export const REUSABLE_SANDBOX_DEFAULTS: Required<ReusableSandboxOptions> = Object.freeze({
  maxRequests: 50,
  betweenRequestTimeoutMs: 2000,
  maxMemoryMiB: 64,
  sandboxTimeoutMs: 60_000
});

/** The defaults with `overrides` (the build's --reusable-sandbox-option values) over them. */
export function reusableSandboxOptions(overrides: ReusableSandboxOptions = {}): Required<ReusableSandboxOptions> {
  return { ...REUSABLE_SANDBOX_DEFAULTS, ...overrides };
}
