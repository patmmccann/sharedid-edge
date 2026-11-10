// The deployed entry point (bundled to deploy/sharedid-edge.mjs, the function app's `main`). It registers one HTTP
// function with the Azure Functions Node.js v4 programming model. Configuration is read once per instance from the
// app settings; the route follows SID_BASE_PATH.
import { app, type HttpHandler } from '@azure/functions';
import { handlerFromEnv, routeFromEnv } from './env.js';
import type { AzureHandler } from './handler.js';

/** The handler, configured from the app settings. Exported for local stand-ins of the Functions host. */
export const handler: AzureHandler = handlerFromEnv(process.env);

/** The route template, from `SID_BASE_PATH`: `_sid/{*path}` by default. */
export const route: string = routeFromEnv(process.env);

// Checks, at compile time, that the adapter's structural types match @azure/functions' own.
const httpHandler: HttpHandler = handler;

app.http('sharedid-edge', {
  route,
  // Every method reaches the handler, which answers what it doesn't serve with 405.
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // Anonymous: the endpoint is public, like the site. Front Door and the access restrictions keep others out.
  authLevel: 'anonymous',
  handler: httpHandler
});
