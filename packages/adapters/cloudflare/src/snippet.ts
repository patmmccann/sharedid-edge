import { createHandler, type EdgeModule, type EnvSettings } from '@sharedid-edge/core';
import { platformInfo, type CloudflareRequestLike } from './platform.js';

/** A Cloudflare Snippet's handler: like a Worker's, without `env` (Snippets have no environment variables). */
export interface Snippet {
  fetch(request: Request & CloudflareRequestLike): Promise<Response>;
}

/**
 * SharedID Edge as a Cloudflare Snippet: the same handler and `request.cf` mapping as the Worker, with the settings
 * (`settingsFromEnv`: the configuration, and with `SID_HOSTS` one per hostname) and the modules fixed at build time,
 * since Snippets have no environment variables or secrets. `scripts/build-snippet.mjs` (`npm run build:snippet`)
 * validates a configuration file, bundles this with the validated settings (the modules' entries already parsed) and
 * only the modules it lists, and checks the result against the Snippet size limit.
 */
export function createSnippet(settings: EnvSettings, modules: readonly EdgeModule[]): Snippet {
  const handler = createHandler({ ...settings, modules });
  return { fetch: request => handler(request, platformInfo(request)) };
}
