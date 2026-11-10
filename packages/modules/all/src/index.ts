import type { EdgeModule } from '@sharedid-edge/core';
import { ecModule } from '@sharedid-edge/module-ec';
import { geoModule } from '@sharedid-edge/module-geo';
import { ipModule } from '@sharedid-edge/module-ip';
import { reflectModule } from '@sharedid-edge/module-reflect';
import { uaModuleWithBowser } from '@sharedid-edge/module-ua/bowser';

/**
 * The modules every adapter builds in: the Cloudflare Worker, the Node.js server and the AWS Lambda function all
 * import this list, so they can't drift apart. `SID_MODULES` chooses which of them run, and in what order; a module
 * does nothing until it's listed there.
 *
 * `ua` is the variant with Bowser built in (`uaModuleWithBowser`), so `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}`
 * can turn on full User-Agent parsing on every adapter; without that setting it behaves like `uaModule`.
 *
 * Only project modules (`packages/modules/`) belong here. Vendor modules aren't built in: a deployer adds one by
 * passing its own list, for example `[...builtInModules, vendorModule]`.
 */
export const builtInModules: readonly EdgeModule[] = Object.freeze([ipModule, ecModule, geoModule, reflectModule, uaModuleWithBowser]);
