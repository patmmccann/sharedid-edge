// The Fastly Compute entry point, bundled to deploy/main.js, which the JavaScript SDK compiles to deploy/main.wasm. It
// registers the fetch listener; every request the service gets is answered here and never forwarded: the service has
// no backends, and enforceExplicitBackends() keeps fetch() from creating dynamic ones. Settings come from the config
// store and module secrets from the secret store, with each request: stores can't be read during the build-time
// initialization that runs this file's top level.
// https://www.fastly.com/documentation/guides/compute/developer-guides/javascript/
import { logRequestFailure } from '@sharedid-edge/core';
import { enforceExplicitBackends } from 'fastly:backend';
import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import { CONFIG_STORE, createStoresHandler, SECRET_STORE } from './env.js';
import type { FastlyFetchEvent } from './fastly.js';
import { internalError } from './handler.js';

/** Fastly's global `addEventListener`, for the one event the entry point handles. */
declare function addEventListener(type: 'fetch', listener: (event: FastlyFetchEvent) => void): void;

enforceExplicitBackends();

const handle = createStoresHandler({
  config: () => new ConfigStore(CONFIG_STORE),
  secrets: () => {
    try {
      return new SecretStore(SECRET_STORE);
    } catch {
      // No secret store linked to the service: no module secrets.
      return undefined;
    }
  }
});

/** Answers a request. It never rejects: anything that fails is a generic 500. */
async function respond(event: FastlyFetchEvent): Promise<Response> {
  try {
    return await handle(event.request, event.client);
  } catch (error) {
    logRequestFailure(error);
    return internalError('Internal error');
  }
}

addEventListener('fetch', event => { event.respondWith(respond(event)); });
