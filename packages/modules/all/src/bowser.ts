import type { EdgeModule } from '@sharedid-edge/core';
import { uaModuleWithBowser } from '@sharedid-edge/module-ua/bowser';
import { builtInModules as defaultModules } from './index.js';

/**
 * The built-in list with Bowser in the `ua` module (`uaModuleWithBowser`), so `SID_MODULE_CONFIG={"ua":{"parser":
 * "bowser"}}` can parse User-Agents fully. Same names and order as `@sharedid-edge/modules`, and the same export name,
 * so a bundler alias from `@sharedid-edge/modules` to `@sharedid-edge/modules/bowser` swaps it in without code
 * changes: that's how the Worker's and Lambda's Bowser builds work. The Node.js server always uses this list.
 *
 * Bowser adds about 8.5 KB gzipped to a minified bundle, which is why it isn't in the default list.
 */
export const builtInModules: readonly EdgeModule[] = Object.freeze(defaultModules.map(module => (module.name === 'ua' ? uaModuleWithBowser : module)));
