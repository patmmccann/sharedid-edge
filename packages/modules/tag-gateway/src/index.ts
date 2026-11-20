import { defineModule, preciseLocationDenial, type EdgeModule, type ForwardContext, type PlatformInfo } from '@sharedid-edge/core';

/** One tag served through the gateway: its Google tag or container ID, and the path it's served under. */
export interface GatewayTag {
  /** `G-…`, `GTM-…`, `AW-…`: the gateway's host is `<id, lower case>.fps.goog`. */
  readonly id: string;
  /** The path prefix on the site, such as `/metrics`. */
  readonly path: string;
}

/** What happens with Global Privacy Control: forward nothing (`block`), or forward without client IP or location. */
export type GpcPolicy = 'block' | 'forward-anonymous';

/** The module's parsed settings. */
export interface TagGatewaySettings {
  readonly tags: readonly GatewayTag[];
  readonly gpc: GpcPolicy;
}

/** Google's tag gateway endpoints: `<tag ID>.fps.goog`. */
export const GATEWAY_HOSTS: readonly string[] = ['*.fps.goog'];

const TAG_ID = /^[A-Za-z]{1,4}-[A-Za-z0-9]{1,20}$/;
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const MAX_TAGS = 10;

/**
 * Parses the module's `SID_MODULE_CONFIG` entry: `tags` (1 to 10 of `{ id, path }`, the paths all different and not
 * overlapping) and `gpc` (`block`, the default, or `forward-anonymous`). Throws a `TypeError` naming the setting on
 * anything else, including unknown keys, so a typo can't forward something unintended.
 */
export function tagGatewaySettings(config: Readonly<Record<string, unknown>>): TagGatewaySettings {
  // The Cloudflare Snippet passes the settings it parsed at build time (see packages/modules/AGENTS.md).
  if ((globalThis as { __SID_PREVALIDATED__?: boolean }).__SID_PREVALIDATED__ === true) return config as unknown as TagGatewaySettings;
  for (const key of Object.keys(config)) {
    if (key !== 'tags' && key !== 'gpc') throw new TypeError(`tag-gateway: unknown setting "${key}"`);
  }
  const { tags, gpc = 'block' } = config;
  if (gpc !== 'block' && gpc !== 'forward-anonymous') throw new TypeError('tag-gateway: "gpc" must be "block" or "forward-anonymous"');
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAGS) throw new TypeError(`tag-gateway: "tags" must be a list of 1 to ${String(MAX_TAGS)} tags`);
  const parsed: GatewayTag[] = [];
  for (const tag of tags as readonly unknown[]) {
    if (typeof tag !== 'object' || tag === null || Array.isArray(tag)) throw new TypeError('tag-gateway: each of "tags" must be an object of "id" and "path"');
    const { id, path, ...rest } = tag as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new TypeError('tag-gateway: a tag has only "id" and "path"');
    if (typeof id !== 'string' || !TAG_ID.test(id)) throw new TypeError('tag-gateway: a tag "id" must be a Google tag ID, like G-12345 or GTM-ABCDEF');
    if (typeof path !== 'string' || !PATH.test(path) || path.length > 100) throw new TypeError('tag-gateway: a tag "path" must be a path like /metrics');
    if (parsed.some(other => other.path === path || other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`))) {
      throw new TypeError(`tag-gateway: the path ${path} overlaps another tag's`);
    }
    parsed.push({ id, path });
  }
  return { tags: parsed, gpc };
}

/** Request headers passed on as they are; every other header is dropped. */
const PASSED_ON = /^(?:accept|accept-language|content-type|origin|referer|user-agent|dnt|sec-gpc|if-none-match|if-modified-since|sec-ch-.+|sec-fetch-.+)$/;

/**
 * Google's first-party cookies, the only ones the gateway uses (Google drops the rest): Google Analytics (`_ga`,
 * `_ga_<container>`, `_gid`, `_gat…`, `_gac_…`, `_gaexp…`, `__utm…`), Ads and Floodlight (`_gcl_…`, `_dc_gtm_…`,
 * `__gads`, `__gpi`, `__gpi_optout`, `__gsas`, `__eoi`), Optimize (`_opt_…`) and the first-party mode cookies (`FPID`,
 * `FPLC`, `FPAU`, `FPGSID`, `FPGCL…`). From https://business.safety.google/adscookies/.
 */
const GOOGLE_COOKIE = /^(?:_ga|_ga_[A-Za-z0-9_-]+|_gac_.+|_gat.*|_gaexp.*|_gid|_gcl_.+|_dc_gtm_.+|_opt_.+|__utm.+|__gads|__gpi|__gpi_optout|__gsas|__eoi|FPID|FPLC|FPAU|FPGSID|FPGCL.+)$/;

/** A request for the tag script: what the page's `<script>` loads, rather than a measurement hit. */
function isScript(request: Request, rest: string): boolean {
  return request.headers.get('Sec-Fetch-Dest') === 'script' || rest === '' || rest === '/' || rest === '/gtag/js' || rest.endsWith('.js');
}

const REGION = /^(?:[A-Za-z]{2}-)?([A-Za-z0-9]{1,3})$/;
/** A city that can go in a header field as is: printable ASCII without the field's separators. */
const PLAIN_CITY = /^[\x20-\x2B\x2D-\x3A\x3C-\x7E]{1,100}$/;

/**
 * The location and client IP headers for the gateway, from the platform information: the country and region always
 * (when known); the client IP and precise location (`X-Forwarded-Geolocation`) only when `precise`.
 */
export function locationHeaders(platform: PlatformInfo, precise: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const { country, region } = platform;
  if (country !== undefined) {
    headers['X-Forwarded-Country'] = country;
    const subdivision = region === undefined ? undefined : REGION.exec(region.trim())?.[1];
    if (subdivision !== undefined) headers['X-Forwarded-CountryRegion'] = `${country}-${subdivision.toUpperCase()}`;
  }
  if (!precise) return headers;
  if (platform.clientIp !== undefined) headers['X-Forwarded-For'] = platform.clientIp;
  const { latitude, longitude, city } = platform;
  const parts = [
    ...(latitude === undefined || longitude === undefined ? [] : [`latlong=${String(latitude)},${String(longitude)}`]),
    ...(city === undefined || !PLAIN_CITY.test(city) ? [] : [`city=${city}`])
  ];
  if (parts.length > 0) headers['X-Forwarded-Geolocation'] = parts.join(';');
  return headers;
}

/** The gateway's `Cache-Control` for the tag script, kept to the visitor's browser: `public` becomes `private`, no `s-maxage`. */
export function scriptCacheControl(value: string | null): string {
  if (value === null || value.trim() === '') return 'no-store';
  const directives = value.split(',').map(part => part.trim()).filter(part => part !== '' && !/^s-maxage\b/i.test(part));
  const kept = directives.map(part => (/^public$/i.test(part) ? 'private' : part));
  if (!kept.some(part => /^(?:private|no-store)$/i.test(part))) kept.unshift('private');
  return kept.join(', ');
}

const NO_STORE = 'no-store';

async function serve(context: ForwardContext): Promise<Response> {
  const { request, url, prefix, decision, cookies, platform, consent, body } = context;
  const script = isScript(request, url.pathname.slice(prefix.length));
  if (!decision.forward) {
    // Nothing is sent. The page's script element still loads (an empty script); anything else gets no content.
    return script
      ? new Response('', { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': NO_STORE } })
      : new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
  }
  const tag = tagGatewaySettings(context.config).tags.find(entry => entry.path === prefix);
  if (tag === undefined) throw new TypeError('tag-gateway: no tag for this path');

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (PASSED_ON.test(name)) headers.set(name, value);
  });
  const googleCookies = [...cookies].filter(([name]) => GOOGLE_COOKIE.test(name)).map(([name, value]) => `${name}=${value}`);
  if (googleCookies.length > 0) headers.set('Cookie', googleCookies.join('; '));
  // Anonymously (GPC, "forward-anonymous"): no location or client IP at all; core strips any that slipped in too.
  if (!decision.anonymous) {
    for (const [name, value] of Object.entries(locationHeaders(platform, preciseLocationDenial(consent) === undefined))) headers.set(name, value);
  }

  const upstream = await context.forward(`https://${tag.id.toLowerCase()}.fps.goog${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body })
  });
  const out = new Headers(upstream.headers);
  out.set('Cache-Control', script ? scriptCacheControl(upstream.headers.get('Cache-Control')) : NO_STORE);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/**
 * The `tag-gateway` module: serves Google's tag gateway for advertisers (formerly "first-party mode") from paths on the
 * site, such as `/metrics`, by forwarding each request to the tag's gateway endpoint, `<tag ID>.fps.goog`. A forwarding
 * module: it does nothing until it's in `SID_MODULES` and configured, sends only to `*.fps.goog`, and sends nothing on
 * opt-out, COPPA, GPC (unless `"gpc": "forward-anonymous"`) or without TCF purposes 1 and 7 where GDPR applies. The
 * client IP and precise location go only when the precise-location rules allow them. On `/v1` it adds nothing.
 */
export const tagGatewayModule: EdgeModule = defineModule({
  name: 'tag-gateway',
  purposes: [1, 7],
  run({ config }) {
    // Invalid settings make the module an `error` here, as they leave it owning no path.
    tagGatewaySettings(config);
    return undefined;
  },
  forwarding: {
    hosts: GATEWAY_HOSTS,
    paths: config => tagGatewaySettings(config).tags.map(tag => tag.path),
    anonymousOnGpc: config => tagGatewaySettings(config).gpc === 'forward-anonymous',
    serve
  }
});
