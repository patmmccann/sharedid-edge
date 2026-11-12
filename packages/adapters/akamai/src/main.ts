// The EdgeWorker's event handlers (bundled to deploy/main.js). Only `responseProvider` is exported: it answers the
// request at the edge in place of the origin, so the property rule that runs this EdgeWorker for the base path never
// reaches the origin while it succeeds. Settings come from the property's PMUSER_SID_* variables, with each request.
// https://techdocs.akamai.com/edgeworkers/docs/event-handler-functions
import { logRequestFailure } from '@sharedid-edge/core';
import { createResponse } from 'create-response';
import { ReadableStream } from 'streams';
import type { EdgeWorkerRequest } from './edgeworkers.js';
import { createVariablesHandler } from './env.js';

const handle = createVariablesHandler();

/** The body for `createResponse`: bytes as a stream (a string body would be text), or `''` for none. */
function body(bytes: Uint8Array): string | ReadableStream<Uint8Array> {
  if (bytes.byteLength === 0) return '';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * Answers a request for the base path. It never throws: EdgeWorkers sends the request on to the origin when
 * `responseProvider` fails, so any error becomes a 500 here instead.
 */
export async function responseProvider(request: EdgeWorkerRequest): Promise<object> {
  try {
    const result = await handle(request);
    return createResponse(result.status, result.headers, body(result.body));
  } catch (error) {
    logRequestFailure(error);
    return createResponse(500, { 'content-type': ['text/plain; charset=utf-8'], 'cache-control': ['no-store'] }, 'Internal error');
  }
}
