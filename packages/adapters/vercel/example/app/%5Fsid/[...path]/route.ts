// SharedID Edge on /_sid/*. The folder is %5Fsid because a folder starting with `_` is private in the App Router
// (not routed); %5F is the URL-encoded underscore, so this answers /_sid/sync, /_sid/v1, /_sid/optout, /_sid/optin.
import { handlerFromEnv } from '../../../lib/sharedid-edge.mjs';

// The Node.js runtime (Node.js 24, from "engines" in package.json). The handler is web-standard, so it runs on the
// Edge runtime ('edge') unchanged too, but Next.js 16 deprecates that runtime.
export const runtime = 'nodejs';

// Configured once per instance from the SID_* environment variables.
const handler = handlerFromEnv(process.env);

export const GET = handler;
export const HEAD = handler;
// CORS preflights for /_sid/v1, when SID_ALLOWED_ORIGINS is set.
export const OPTIONS = handler;
