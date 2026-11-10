import { builtInModules } from '@sharedid-edge/modules';
import { createWorker } from './worker.js';

// The default Worker: the built-in modules, with the ua module's Client Hints and bot check (no Bowser).
export default createWorker(builtInModules);
