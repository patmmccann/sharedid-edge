// The deployed entry point (bundled to deploy/sharedid-edge.mjs, the function's `main`). It registers the HTTP
// function `sharedidEdge` with the Functions Framework; Cloud Run functions run it with `--entry-point=sharedidEdge`.
// Configuration is read once per instance from the environment.
import { http, type HttpFunction } from '@google-cloud/functions-framework';
import { handlerFromEnv } from './env.js';
import type { GcpHandler } from './handler.js';

/** The function, configured from the environment. */
export const sharedidEdge: GcpHandler = handlerFromEnv(process.env);

// Checks, at compile time, that the handler fits the Functions Framework's own type.
const httpFunction: HttpFunction = sharedidEdge;

http('sharedidEdge', httpFunction);
