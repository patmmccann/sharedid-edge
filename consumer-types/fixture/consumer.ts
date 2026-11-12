// A strict consumer of @sharedid-edge/core's public API, as a platform adapter or module author would write it.
// Type-checked against the packed package by scripts/consumer-types.mjs.
import {
  booleanFromEnv,
  cachedByEnv,
  clientIpFromHeader,
  DEFAULT_UPSTREAM_AUTH_HEADER,
  DEFAULT_UPSTREAM_HOST_HEADER,
  forwardedPlatformInfo,
  parseForwardedHost,
  refuseTrustedUpstream,
  trustedUpstreamFromEnv,
  utf8Header,
  withTrustedUpstream,
  type ForwardedHeaders,
  type TrustedUpstream,
  type TrustedUpstreamOptions,
  createHandler,
  defineModule,
  EU_COUNTRY_CODES,
  GDPR_COUNTRY_CODES,
  gdprFromLocation,
  handlerOrMisconfigured,
  headerValue,
  isHeaderName,
  locationInfo,
  locationWithEU,
  logRequestFailure,
  parseHeaderMap,
  parseIp,
  parseViewerAddress,
  type ParsedIp,
  mergeTraffic,
  preciseLocationDenial,
  publicOriginFromEnv,
  resolveConfig,
  cookieValues,
  configForHost,
  hostKey,
  hostOverrides,
  resolveHosts,
  SETTING_NAMES,
  settingsFromEnv,
  type EnvSettings,
  type ResolveConfigOptions,
  skipsBot,
  splitHeaders,
  withPublicOrigin,
  type BotKind,
  type EdgeModule,
  type LocationSource,
  type ModuleContext,
  type ModuleResult,
  type ModuleRoute,
  type PayloadV1,
  type PlatformInfo,
  type PlatformLocation,
  type PreciseLocationDenial,
  type SharedIdEdgeConfig,
  type SharedIdEdgeHandler,
  type SplitHeaders,
  type StorageDecision,
  type TrafficReport,
  type TrafficSignal
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
export const located: PlatformInfo = {
  clientIp: '203.0.113.1',
  ...location,
  ...(location.country === undefined ? {} : { isEU: EU_COUNTRY_CODES.has(location.country) })
};
// GDPR applies by country (EU, EEA, UK, Turkey) or the EU flag; EU membership alone is isEU.
export const gdprByCountry: boolean = GDPR_COUNTRY_CODES.has('GB');
export const gdprHere: boolean | undefined = gdprFromLocation(located);

// A module that only maintains a cookie, so it also runs on Prebid.js's pixelUrl calls (/sync).
const routes: readonly ModuleRoute[] = ['v1', 'sync'];
const keeper: EdgeModule = defineModule({
  name: 'keeper',
  routes,
  run: context => (context.storage.allowed ? { cookies: [{ name: 'kept', value: '1', maxAgeSeconds: 86_400, httpOnly: true }] } : undefined)
});

const config: SharedIdEdgeConfig = resolveConfig({ SID_MODULES: 'geo,keeper', SID_SYNC_MODULES: 'keeper' });
// A deployment requires SID_COOKIE_DOMAIN; host-only is an explicit value.
const deployment: ResolveConfigOptions = { requireCookieDomain: true };
const deployed: SharedIdEdgeConfig = resolveConfig({ SID_COOKIE_DOMAIN: 'host-only' }, deployment);
void deployed;
export const syncModules: readonly string[] | undefined = config.syncModules;
const handler: SharedIdEdgeHandler = createHandler({ config, modules: [geo, keeper] });
const platform: PlatformInfo = { clientIp: '203.0.113.1', isEU: false };

// Several sites from one deployment: SID_HOSTS, and a platform's settings for a host (as Cloudflare custom metadata).
const sites: EnvSettings = settingsFromEnv({ SID_HOSTS: '{"www.example.com":{"SID_COOKIE_DOMAIN":"example.com"}}' }, deployment);
export const siteHosts: ReadonlyMap<string, SharedIdEdgeConfig> | undefined = resolveHosts({}, deployment) ?? sites.hosts;
export const multiSite: SharedIdEdgeHandler = createHandler({
  ...sites,
  hostConfig: request => (hostKey(new URL(request.url)) === 'saas.example.com' ? configForHost({}, hostOverrides({ SID_COOKIE_DOMAIN: 'example.com' }, 'metadata'), 'metadata', deployment) : undefined),
  modules: [geo]
});

export async function payload(request: Request): Promise<PayloadV1> {
  const response = await handler(request, platform);
  return await response.json() as PayloadV1;
}

// A module reporting to the shared traffic signal, and an adapter passing the platform's verdict.
const kind: BotKind = 'declared';
const report: TrafficReport = { bot: true, botKind: kind, proxy: 'relay', score: 12, internal: false };
export const crawler: EdgeModule = defineModule({ name: 'crawler', run: () => ({ traffic: report }) });
export const verified: PlatformInfo = { traffic: { bot: true, botKind: 'verified', score: 1 } };
const merged: TrafficSignal | undefined = mergeTraffic([{ source: 'platform', report }]);
export const skipped: boolean = skipsBot(config, merged);
const sources: readonly string[] = merged?.sources ?? [];
// @ts-expect-error - the merged signal's sources are read-only
sources.push('forged');

// @ts-expect-error - the handler's platform info is read-only
platform.country = 'US';

// An adapter's plumbing: a handler that answers with a 500 on invalid settings, and a response for a platform that
// keeps one value per header name.
export const guarded: SharedIdEdgeHandler = handlerOrMisconfigured<SharedIdEdgeHandler>(
  () => createHandler({ config: resolveConfig({}) }),
  () => () => Promise.resolve(new Response('misconfigured', { status: 500 }))
);
export async function platformResponse(request: Request): Promise<{ status: number; headers: Record<string, string>; cookies: readonly string[] }> {
  try {
    const response = await guarded(request);
    const split: SplitHeaders = splitHeaders(response.headers);
    return { status: response.status, headers: split.headers, cookies: split.cookies };
  } catch (error) {
    logRequestFailure(error);
    return { status: 500, headers: {}, cookies: [] };
  }
}
export function platformFromHeaders(headers: Headers, env: Readonly<Record<string, string | undefined>>): PlatformInfo {
  const origin: { readonly publicOrigin?: string } = publicOriginFromEnv(env);
  const ip: string | undefined = headerValue(headers, 'x-client-ip');
  return { ...(ip === undefined || origin.publicOrigin === '' ? {} : { clientIp: ip }), ...locationWithEU({ country: headerValue(headers, 'x-country') }) };
}
export const geoHeaders: Partial<Record<'country' | 'city', string>> = parseHeaderMap('{"country":"x-geo"}', 'SID_LOCATION_HEADERS', ['country', 'city'], '{"country":"x-geo"}');
export const validName: boolean = isHeaderName('x-geo');
export const viewerIp: string | undefined = parseViewerAddress('2001:db8::1:443');
const parsedIp: ParsedIp | undefined = parseIp('192.0.2.1');
export const ipVersion: 4 | 6 | undefined = parsedIp?.version;

export const booleanSetting: boolean = booleanFromEnv('true', false);

// A platform that hands the settings over with each request: the handler, rebuilt only when a setting changes, for a
// request moved onto the public origin.
export const settingNames: readonly string[] = SETTING_NAMES;
// @ts-expect-error - the setting names are read-only
SETTING_NAMES.push('SID_EXTRA');
const handlerFor: (env: Readonly<Record<string, string | undefined>>) => SharedIdEdgeHandler = cachedByEnv(
  (env: Readonly<Record<string, string | undefined>>): SharedIdEdgeHandler => createHandler({ config: resolveConfig(env) })
);
export async function perRequestSettings(request: Request, env: Readonly<Record<string, string | undefined>>): Promise<Response> {
  const publicRequest: Request = await withPublicOrigin(request, env['SID_PUBLIC_ORIGIN']);
  return handlerFor(env)(publicRequest);
}

// Every value of a duplicated cookie, in header order.
const duplicates: string[] = cookieValues('_pubcid=a; _pubcid=b', '_pubcid');
void duplicates;

// Trusted-upstream mode: an adapter that supports it opts in, and wraps its handler.
const unsupported: Readonly<Record<string, string | undefined>> = refuseTrustedUpstream({ SID_COOKIE_DOMAIN: 'host-only' });
const proxyTrust: TrustedUpstreamOptions = { trustProxy: false };
const upstream: TrustedUpstream | undefined = trustedUpstreamFromEnv({ SID_UPSTREAM_SECRETS: '["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]', SID_LOCATION_HEADERS: '{"country":"x-sid-country"}' }, proxyTrust);
export const upstreamHandler: SharedIdEdgeHandler = withTrustedUpstream(createHandler(settingsFromEnv(unsupported, { requireCookieDomain: true })), upstream);
const forwarded: ForwardedHeaders = { clientIp: 'x-sid-client-ip', location: { country: 'x-sid-country' } };
export const forwardedInfo: PlatformInfo = forwardedPlatformInfo(new Headers({ 'x-sid-client-ip': '192.0.2.1' }), forwarded);
export const upstreamDefaults: readonly string[] = [DEFAULT_UPSTREAM_AUTH_HEADER, DEFAULT_UPSTREAM_HOST_HEADER];
export const forwardedIp: string | undefined = clientIpFromHeader('x-forwarded-for', '192.0.2.1, 192.0.2.2');
export const forwardedHost: string | undefined = parseForwardedHost('www.example.com:443');
export const city: string = utf8Header('MÃ¼nchen');
// @ts-expect-error - the secrets are read-only
upstream?.secrets.push('x');
