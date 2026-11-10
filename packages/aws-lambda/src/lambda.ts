// The deployed entry point (bundled to deploy/lambda.mjs; the function's handler is `lambda.handler`).
// Configuration is read once per cold start from the function's environment variables.
import { handlerFromEnv } from './env.js';
import type { LambdaHandler } from './handler.js';

export const handler: LambdaHandler = handlerFromEnv(process.env);
