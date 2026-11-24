// Checks a live site's /_sid/* from outside, for this project's upstream-operator and Cloudflare for SaaS live tests
// (.github/workflows/e2e-upstream.yml; packages/adapters/cloudflare/README.md, The upstream-operator and Cloudflare for
// SaaS setups) and the Vercel live tests (.github/workflows/e2e-vercel.yml; packages/adapters/vercel/README.md, Live
// tests), not for deployers.
//
//   npx tsx scripts/check-live-site.ts --site https://pub.example --cookie-domain example
//                                      [--endpoint https://sid.upstream.example] [--unlisted https://other.example]
//                                      [--base-path /node-upstream/_sid] [--wait 150]
//
// The site runs SharedID Edge with SID_MODULES including ip and geo (the live tests' e2e settings), on its own
// hostname or forwarded to an upstream operator's endpoint by the publisher's CDN. It checks:
//
//   - /_sid/v1 answers with the address this machine's requests come from and a country;
//   - forged X-SID-*, X-Forwarded-*, X-Real-IP and Vercel's X-Vercel-* headers change nothing: the same address and
//     location, the cookies still on the site's cookie domain (a forwarded host would pick another site's settings or
//     a 404), and a forged EU country doesn't decide GDPR;
//   - /_sid/sync sets _pubcid with Domain=<cookie domain>;
//   - with --endpoint, the upstream operator's endpoint called directly answers 403 and sets no cookie, also with a
//     forged secret, forwarded host, client IP and country;
//   - with --unlisted, a hostname on the same deployment that isn't in SID_HOSTS answers 404 and sets no cookie.
//
// --wait retries the first request for up to that many seconds, for a deployment that has just been made.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { checkClientIp, clientIp, runChecks, type CheckFn, type Payload, v1 as getV1 } from './live-checks.js';

const USAGE = 'Usage: check-live-site --site https://<site> --cookie-domain <domain> [--base-path /_sid] [--endpoint https://<upstream endpoint>] [--unlisted https://<unlisted hostname>] [--wait <seconds>]';
const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    'cookie-domain': { type: 'string' },
    'base-path': { type: 'string', default: '/_sid' },
    endpoint: { type: 'string' },
    unlisted: { type: 'string' },
    wait: { type: 'string', default: '0' },
    help: { type: 'boolean', default: false }
  }
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.site === undefined || values['cookie-domain'] === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const origin = (url: string): string => new URL(url).origin;
const site = origin(values.site);
const cookieDomain = values['cookie-domain'].toLowerCase();
// The deployment's SID_BASE_PATH, the same on the site and the endpoint: /_sid, or a prefixed one for a setup that
// shares its hostname (/node-upstream/_sid).
const sid = values['base-path'].replace(/\/+$/, '');
const waitSeconds = Number(values.wait);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
  console.error(USAGE);
  process.exit(2);
}

// What a visitor (or a misconfigured CDN) could send, hoping to be taken for someone else, somewhere else, on another
// site, or the publisher's CDN itself. DE: an EU country, so a forged one deciding GDPR would deny the sync below.
// The X-Vercel-* headers are the ones the Vercel adapter reads, which Vercel's proxy sets; elsewhere nothing reads them.
const FORGED = {
  'X-SID-Client-IP': '192.0.2.1',
  'X-SID-Country': 'DE',
  'X-SID-Region': 'BE',
  'X-SID-Upstream-Auth': 'forged-forged-forged-forged-forged-forged',
  'X-Forwarded-Host': 'other.example',
  'X-Forwarded-For': '192.0.2.1',
  'X-Real-IP': '192.0.2.1',
  'X-Vercel-Forwarded-For': '192.0.2.1',
  'X-Vercel-IP-Country': 'DE',
  'X-Vercel-IP-Country-Region': 'BE',
  'X-Vercel-IP-City': 'Berlin'
};

async function v1(base: string, headers: Record<string, string> = {}): Promise<{ response: Response; payload: Payload | undefined }> {
  return getV1(`${base}${sid}/v1`, headers);
}

/** /_sid/sync as Prebid.js calls it on a first visit, with a fresh ID; whether it set that ID, and on which domain. */
async function sync(base: string, headers: Record<string, string> = {}): Promise<{ status: number; cookies: string[]; domain: string | undefined; setsId: boolean }> {
  const id = randomUUID();
  const response = await fetch(`${base}${sid}/sync?id=${encodeURIComponent(encodeURIComponent(`pubcid:${id}`))}`, { headers });
  await response.arrayBuffer();
  const cookies = response.headers.getSetCookie();
  const pubcid = cookies.find(c => c.startsWith(`_pubcid=${id}`));
  const domain = pubcid === undefined ? undefined : /;\s*domain=\.?([^;]+)/i.exec(pubcid)?.[1]?.trim().toLowerCase();
  return { status: response.status, cookies, domain, setsId: pubcid !== undefined };
}

async function firstAnswer(): Promise<{ response: Response; payload: Payload | undefined }> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const answer = await v1(site).catch((error: unknown) => {
      if (Date.now() >= deadline) throw error;
      return undefined;
    });
    if (answer !== undefined && (answer.payload !== undefined || Date.now() >= deadline)) return answer;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function run(check: CheckFn): Promise<void> {
  const first = await firstAnswer();
  check(`${site}${sid}/v1 answers 200 with payload version 1`, first.response.status === 200 && first.payload !== undefined, String(first.response.status));

  const ip = await checkClientIp(check, 'the visitor\'s real address arrives (ip module)', first.payload);
  const geo = first.payload?.ortb2?.device?.geo;
  check('the visitor\'s country arrives (geo module)', geo?.country !== undefined && /^[A-Z]{3}$/.test(geo.country), `device.geo: ${JSON.stringify(geo ?? null)}`);

  const forged = await v1(site, FORGED);
  const forgedGeo = forged.payload?.ortb2?.device?.geo;
  check(`forged X-SID-*, X-Forwarded-*, X-Real-IP and X-Vercel-* headers change nothing in ${sid}/v1`,
    forged.response.status === 200 && clientIp(forged.payload) === ip && forgedGeo?.country === geo?.country && forgedGeo?.region === geo?.region && forgedGeo?.city === geo?.city,
    `${String(forged.response.status)}, device.ip(v6): ${clientIp(forged.payload) ?? 'none'}, device.geo: ${JSON.stringify(forgedGeo ?? null)}`);

  const plain = await sync(site);
  check(`${sid}/sync sets _pubcid with Domain=${cookieDomain}`, plain.status === 200 && plain.setsId && plain.domain === cookieDomain,
    `${String(plain.status)}, _pubcid domain: ${plain.domain ?? (plain.setsId ? 'host-only' : 'not set')}`);
  const forgedSync = await sync(site, FORGED);
  check(`forged headers change nothing in ${sid}/sync (same site settings, GDPR not decided by a forged country)`,
    forgedSync.status === plain.status && forgedSync.setsId === plain.setsId && forgedSync.domain === plain.domain,
    `${String(forgedSync.status)}, _pubcid domain: ${forgedSync.domain ?? (forgedSync.setsId ? 'host-only' : 'not set')}`);

  if (values.endpoint !== undefined) {
    const endpoint = origin(values.endpoint);
    const forwarded = { ...FORGED, 'X-Forwarded-Host': new URL(site).hostname };
    for (const [name, headers] of [['no headers', {}], ['forged secret, forwarded host, client IP and country', forwarded]] as const) {
      const direct = await sync(endpoint, headers);
      check(`${endpoint}${sid}/sync called directly (${name}) answers 403 with no cookie`, direct.status === 403 && direct.cookies.length === 0,
        `${String(direct.status)}, ${String(direct.cookies.length)} Set-Cookie`);
      const directV1 = await v1(endpoint, headers);
      check(`${endpoint}${sid}/v1 called directly (${name}) answers 403`, directV1.response.status === 403 && directV1.response.headers.getSetCookie().length === 0,
        String(directV1.response.status));
    }
  }

  if (values.unlisted !== undefined) {
    const unlisted = origin(values.unlisted);
    for (const path of ['v1', 'sync']) {
      const response = await fetch(`${unlisted}${sid}/${path}`);
      await response.arrayBuffer();
      const cookies = response.headers.getSetCookie();
      check(`${unlisted}${sid}/${path}, not in SID_HOSTS, answers 404 with no cookie`, response.status === 404 && cookies.length === 0,
        `${String(response.status)}, ${String(cookies.length)} Set-Cookie`);
    }
  }
}

await runChecks(site, run, `${site}: every check passed.`);
