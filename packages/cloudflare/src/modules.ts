import type { EdgeModule } from '@sharedid-edge/core';
import { ecModule } from '@sharedid-edge/module-ec';
import { geoModule } from '@sharedid-edge/module-geo';
import { ipModule } from '@sharedid-edge/module-ip';

/**
 * The modules built into this worker. `SID_MODULES` chooses which of them run, and in what order.
 * Add a module here by importing it; it does nothing until it's listed in `SID_MODULES`.
 */
export const modules: readonly EdgeModule[] = [ipModule, ecModule, geoModule];
