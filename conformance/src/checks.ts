// What the platform-specific checks (akamai-checks.ts, fastly-checks.ts) share: TAP output and its tally, and the
// check that no response may be shared by caches.

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';

/** A tally of checks, printed as TAP. */
export class Checks {
  #count = 0;
  #failures = 0;

  check(name: string, ok: boolean, detail = ''): void {
    this.#count++;
    if (!ok) this.#failures++;
    console.log(`${ok ? 'ok' : 'not ok'} - ${name}${ok || detail === '' ? '' : `\n  # ${detail}`}`);
  }

  /** Prints the summary, and sets a failing exit code when a check failed. */
  done(label: string): void {
    console.log(`\n${String(this.#count - this.#failures)}/${String(this.#count)} ${label} checks passed`);
    if (this.#failures > 0) process.exitCode = 1;
  }
}

/**
 * Every response tells caches not to share it: `Cache-Control` has `no-store` or `private`. A CDN that caches a
 * response carrying one visitor's cookies would hand them to others. `headers` go with every request.
 */
export async function checkCacheControl(checks: Checks, baseUrl: string, headers: Readonly<Record<string, string>>): Promise<void> {
  for (const [method, path] of [['GET', `/_sid/sync?id=pubcid%3A${UUID}`], ['GET', '/_sid/v1'], ['HEAD', '/_sid/sync'], ['GET', '/_sid/optout'], ['GET', '/_sid/nothing'], ['POST', '/_sid/v1']] as const) {
    const response = await fetch(new URL(path, baseUrl), { method, headers });
    const cacheControl = response.headers.get('cache-control') ?? '';
    checks.check(`${method} ${path.split('?')[0] ?? path} (${String(response.status)}) has Cache-Control no-store or private`, /\b(no-store|private)\b/.test(cacheControl), `Cache-Control: ${cacheControl}`);
  }
}
