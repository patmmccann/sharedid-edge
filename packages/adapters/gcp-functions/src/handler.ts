import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandler, logRequestFailure, type HandlerOptions } from '@sharedid-edge/core';
import { sendWebResponse, toWebRequest } from '@sharedid-edge/node';
import { platformInfo, type PlatformOptions } from './platform.js';

export interface GcpHandlerOptions extends HandlerOptions, PlatformOptions {
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to `https://` and the `Host` header:
   * the load balancer and Cloud Run only speak https to the function, and the scheme decides whether cookies are
   * `Secure`.
   */
  readonly publicOrigin?: string;
}

/**
 * A Functions Framework HTTP function: Express's `req` and `res`, which are Node.js's `IncomingMessage` and
 * `ServerResponse`.
 */
export type GcpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Builds an HTTP function around the core SharedID Edge handler, with `@sharedid-edge/node`'s conversion. */
export function createGcpHandler(options: GcpHandlerOptions = {}): GcpHandler {
  const handler = createHandler(options);
  return async (req, res) => {
    try {
      const origin = options.publicOrigin ?? `https://${req.headers.host ?? 'localhost'}`;
      const response = await handler(toWebRequest(req, origin), platformInfo(req, options));
      await sendWebResponse(res, response, req.method ?? 'GET');
    } catch (error) {
      logRequestFailure(error);
      sendInternalError(res, 'Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function sendInternalError(res: ServerResponse, message: string): void {
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}
