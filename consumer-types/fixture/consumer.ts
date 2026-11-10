// A strict consumer of @sharedid-edge/core's public API, as a platform adapter or module author would write it.
// Type-checked against the packed package by scripts/consumer-types.mjs.
import {
  createHandler,
  defineModule,
  locationInfo,
  preciseLocationDenial,
  resolveConfig,
  type EdgeModule,
  type LocationSource,
  type ModuleContext,
  type ModuleResult,
  type PayloadV1,
  type PlatformInfo,
  type PlatformLocation,
  type PreciseLocationDenial,
  type SharedIdEdgeConfig,
  type SharedIdEdgeHandler,
  type StorageDecision
} from '@sharedid-edge/core';

const geo: EdgeModule = defineModule({
  name: 'geo',
  purposes: [1],
  run(context: ModuleContext): ModuleResult | undefined {
    const country: string | undefined = context.platform.country;
    const storage: StorageDecision = context.storage;
    if (!storage.allowed) {
      const reason: string = storage.reason;
      if (reason === '') return undefined;
    }
    const denial: PreciseLocationDenial | undefined = preciseLocationDenial(context.consent);
    const lat: number | undefined = denial === undefined ? context.platform.latitude : undefined;
    return country === undefined ? undefined : { ortb2: { device: { geo: { country, ...(lat === undefined ? {} : { lat }) } } } };
  }
});

// An adapter checking its CDN's location data.
const source: LocationSource = { country: 'US', latitude: '30.2713', longitude: -97.7426, timezone: 'America/Chicago' };
const location: PlatformLocation = locationInfo(source);
export const located: PlatformInfo = { clientIp: '203.0.113.1', ...location };

const config: SharedIdEdgeConfig = resolveConfig({ SID_MODULES: 'geo' });
const handler: SharedIdEdgeHandler = createHandler({ config, modules: [geo] });
const platform: PlatformInfo = { clientIp: '203.0.113.1', isEU: false };

export async function payload(request: Request): Promise<PayloadV1> {
  const response = await handler(request, platform);
  return await response.json() as PayloadV1;
}

// @ts-expect-error - the handler's platform info is read-only
platform.country = 'US';
