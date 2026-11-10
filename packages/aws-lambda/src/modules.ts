import type { EdgeModule } from '@sharedid-edge/core';
import { ecModule } from '@sharedid-edge/module-ec';
import { geoModule } from '@sharedid-edge/module-geo';
import { ipModule } from '@sharedid-edge/module-ip';

/**
 * The modules built into the Lambda bundle: the same as the Cloudflare Worker's and the Node.js CLI's.
 * `SID_MODULES` chooses which of them run, and in what order. A module does nothing until it's listed there.
 */
export const builtInModules: readonly EdgeModule[] = [ipModule, ecModule, geoModule];
