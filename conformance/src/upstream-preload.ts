// Installs the upstream stand-in (upstream-stand-in.ts): forwarding modules' requests get its answer, and any other
// request that would leave the machine fails. Preloaded (`node --import`) by every target the runner starts with
// Node.js, and imported first by the Worker entry point targets.ts writes for `wrangler dev` (whose esbuild finds the
// TypeScript source for `./upstream-stand-in.js`).
import { installUpstreamStandIn } from './upstream-stand-in.js';

installUpstreamStandIn();
