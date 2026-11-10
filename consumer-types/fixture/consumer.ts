// A strict consumer of @sharedid-edge/core's public API, as a platform adapter or module author would write it.
// Type-checked against the packed package by scripts/consumer-types.mjs.
import {
  createHandler,
  defineModule,
  resolveConfig,
  type EdgeModule,
  type ModuleContext,
  type ModuleResult,
  type PayloadV1,
  type PlatformInfo,
  type SharedIdEdgeConfig,
  type SharedIdEdgeHandler
} from '@sharedid-edge/core';

const geo: EdgeModule = defineModule({
  name: 'geo',
  purposes: [1],
  run(context: ModuleContext): ModuleResult | undefined {
    const country: string | undefined = context.platform.country;
    return country === undefined ? undefined : { ortb2: { device: { geo: { country } } } };
  }
});

const config: SharedIdEdgeConfig = resolveConfig({ SID_MODULES: 'geo' });
const handler: SharedIdEdgeHandler = createHandler({ config, modules: [geo] });
const platform: PlatformInfo = { clientIp: '203.0.113.1', isEU: false };

export async function payload(request: Request): Promise<PayloadV1> {
  const response = await handler(request, platform);
  return await response.json() as PayloadV1;
}

// @ts-expect-error - the handler's platform info is read-only
platform.country = 'US';
