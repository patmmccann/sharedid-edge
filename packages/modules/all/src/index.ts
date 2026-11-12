import type { EdgeModule } from '@sharedid-edge/core';
import { botModule } from '@sharedid-edge/module-bot';
import { clickIdModule } from '@sharedid-edge/module-clickid';
import { geoModule } from '@sharedid-edge/module-geo';
import { ipModule } from '@sharedid-edge/module-ip';
import { reflectModule } from '@sharedid-edge/module-reflect';
import { uaModule } from '@sharedid-edge/module-ua';

/**
 * The modules every adapter builds in: the Cloudflare Worker, the Node.js server and the AWS Lambda function all
 * import this list, so they can't drift apart. `SID_MODULES` chooses which of them run, and in what order; a module
 * does nothing until it's listed there.
 *
 * `ua` is `uaModule`, without Bowser, to keep the bundles small; `@sharedid-edge/modules/bowser` is the same list with
 * Bowser, for the adapters' Bowser builds.
 *
 * Only project modules (`packages/modules/`) belong here. Vendor modules aren't built in: a deployer adds one by
 * passing its own list, for example `[...builtInModules, vendorModule]`.
 */
export const builtInModules: readonly EdgeModule[] = Object.freeze([ipModule, geoModule, reflectModule, botModule, uaModule, clickIdModule]);
