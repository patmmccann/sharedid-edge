// The entry point of the single-file bundle, deploy/sharedid-edge.mjs, that a site copies into its Vercel project
// (scripts/bundle.mjs). Its types are written out here, without imports, so the bundle's declaration file
// (deploy/sharedid-edge.d.mts, copied from this file's) stands alone.
import { handlerFromEnv as fromEnv, middlewareFromEnv as middlewareFrom } from './env.js';

/** Environment variables, as `process.env` has them. */
export type SharedIdEdgeEnv = Readonly<Record<string, string | undefined>>;

/** Answers every request it gets: a Next.js route handler's `GET`, `HEAD` and `OPTIONS`. */
export type SharedIdEdgeHandler = (request: Request) => Promise<Response>;

/** Answers requests under `SID_BASE_PATH` (`/_sid`); `undefined` for any other, which should continue to the site. */
export type SharedIdEdgeMiddleware = (request: Request) => Promise<Response | undefined>;

/** The handler, configured from `SID_*` environment variables (pass `process.env`), with the built-in modules. */
export function handlerFromEnv(env: SharedIdEdgeEnv): SharedIdEdgeHandler {
  return fromEnv(env);
}

/** Middleware, configured from `SID_*` environment variables (pass `process.env`), with the built-in modules. */
export function middlewareFromEnv(env: SharedIdEdgeEnv): SharedIdEdgeMiddleware {
  return middlewareFrom(env);
}
