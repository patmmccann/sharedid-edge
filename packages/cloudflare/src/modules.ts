import type { EdgeModule } from '@sharedid-edge/core';

/**
 * The modules built into this worker. `SID_MODULES` chooses which of them run, and in what order.
 * Add a module here by importing it; it does nothing until it's listed in `SID_MODULES`.
 */
export const modules: readonly EdgeModule[] = [];
