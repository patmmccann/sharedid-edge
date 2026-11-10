import { builtInModules } from '@sharedid-edge/modules/bowser';
import { createWorker } from './worker.js';

// The Bowser build's entry point (`npm run deploy:bowser`, `dev:bowser`, `build:bowser`): the built-in modules with
// Bowser in the ua module, so SID_MODULE_CONFIG={"ua":{"parser":"bowser"}} parses User-Agents fully. It adds about
// 8.5 KB gzipped to the bundle.
export default createWorker(builtInModules);
