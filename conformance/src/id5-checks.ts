// Checks of the id5 module's real server-to-server hop that the shared cases can't express, because they need several
// requests in turn and what ID5's stub received: run after the suite against the Node.js server (`npm run conformance`,
// the stub as a process) and its container image behind nginx (`npm run conformance:docker`, the stub as a container
// next to the server's). The runner plays the browser: it only ever calls the server, and reads what the stub got from
// the stub's `GET /__requests` (id5-stub.ts).
//
//   node conformance/dist/id5-checks.js --target node|docker
import { argv } from 'node:process';
import { Checks } from './checks.js';
import { startTarget, type TargetName } from './targets.js';
import { ID5_OPT_OUT_MARKER } from './upstream-stand-in.js';

interface Payload {
  readonly eids?: readonly { readonly source: string; readonly uids: readonly { readonly id: string }[] }[];
}

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
/** Routable, and made local in CI for the docker target's relay (see conformance/AGENTS.md). */
const CLIENT_IP = '203.0.114.7';
const UA = 'Mozilla/5.0 (id5 checks)';
const COOKIE = 'sid_id5_173';
/** Consent for vendor 131 (ID5) and 130, with purposes 1 and 2 and Special Feature 1, as in module-id5.json. */
const TC_ID5 = 'CAAAAAAAAAAAAAAAAAAAAAAIAMAAAAAAAAAABBgAAAAAAAAAAAAAAAAAAAAAgAAAA.eAAAAAAAAA';
const TC_OTHER_VENDOR = 'CAAAAAAAAAAAAAAAAAAAAAAIAMAAAAAAAAAABBAAAAAAAAAAAAAAAAAAAAABAAAAA.eAAAAAAAAA';

const name = argv[argv.indexOf('--target') + 1];
if (name !== 'node' && name !== 'docker') throw new Error('usage: node id5-checks.js --target node|docker');
const targetName: TargetName = name;

const checks = new Checks();
const check = checks.check.bind(checks);

const target = await startTarget(targetName, {
  SID_MODULES: 'id5',
  SID_MODULE_CONFIG: JSON.stringify({ id5: { partner: 173, timeoutMs: 2000 } }),
  SID_MODULE_TIMEOUT_MS: '3000',
  SID_TRUST_PROXY: 'true'
}, ['vendor-modules']);
try {
  const stub = target.id5Stub;
  if (stub === undefined) throw new Error(`the ${targetName} target has no ID5 stub`);
  /** What the stub has received so far. */
  const received = async (): Promise<readonly Record<string, unknown>[]> => await (await fetch(new URL('/__requests', stub))).json() as Record<string, unknown>[];
  /** A `/_sid/v1` call as the browser makes it; the cookies it sends, and the response's `sid_id5_173` value. */
  const v1 = async (query = '', headers: Record<string, string> = {}): Promise<{ readonly payload: Payload; readonly cache: string | undefined }> => {
    const response = await fetch(new URL(`/_sid/v1${query}`, target.baseUrl), { headers: { 'x-forwarded-for': CLIENT_IP, 'cf-connecting-ip': CLIENT_IP, 'user-agent': UA, ...headers } });
    const line = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${COOKIE}=`));
    return { payload: await response.json() as Payload, cache: line?.slice(COOKIE.length + 1).split(';')[0] };
  };
  const id5Eid = (payload: Payload): boolean => (payload.eids ?? []).some(eid => eid.source === 'id5-sync.com');

  console.log(`# id5 on ${targetName}: the server's request to ID5's stub`);
  const first = await v1('', { cookie: `_pubcid=${UUID}` });
  const afterFirst = await received();
  check('returns the stub\'s EID in /_sid/v1', id5Eid(first.payload), JSON.stringify(first.payload));
  check('sets the cache cookie', first.cache !== undefined && first.cache !== '');
  check('the stub got one request', afterFirst.length === 1, JSON.stringify(afterFirst));
  const body = afterFirst[0] ?? {};
  check('it carried the partner, client IP and user agent', body['partner'] === 173 && body['ip'] === CLIENT_IP && body['ua'] === UA, JSON.stringify(body));
  check('it carried the SharedID as puid, with consent', body['puid'] === UUID, JSON.stringify(body));
  check('it carried no signature the first time', !('s' in body), JSON.stringify(body));

  const cached = `${COOKIE}=${first.cache ?? ''}`;
  const second = await v1('', { cookie: `_pubcid=${UUID}; ${cached}` });
  check('the cache answers the next request: the EID again', id5Eid(second.payload), JSON.stringify(second.payload));
  check('and no second request to the stub', (await received()).length === 1);

  console.log(`# id5 on ${targetName}: nothing sent without consent`);
  const before = (await received()).length;
  const gpc = await v1('', { 'sec-gpc': '1', cookie: cached });
  check('GPC: no EID, and the cache is deleted', !id5Eid(gpc.payload) && gpc.cache === '', JSON.stringify(gpc));
  const optedOut = await v1('', { cookie: `_pubcid_optout=1; ${cached}` });
  check('the SharedID opt-out: no EID, and the cache is deleted', !id5Eid(optedOut.payload) && optedOut.cache === '', JSON.stringify(optedOut));
  const denied = await v1(`?gdpr=1&gdpr_consent=${TC_OTHER_VENDOR}`, { cookie: `_pubcid=${UUID}; ${cached}` });
  check('GDPR without ID5\'s vendor consent: no EID, and the cache is deleted', !id5Eid(denied.payload) && denied.cache === '', JSON.stringify(denied));
  const usOptOut = await v1('?us_privacy=1YYN', { cookie: `_pubcid=${UUID}` });
  check('a us_privacy opt-out: no EID', !id5Eid(usOptOut.payload), JSON.stringify(usOptOut));
  check('none of these reached the stub', (await received()).length === before, JSON.stringify(await received()));

  console.log(`# id5 on ${targetName}: consent under GDPR, and ID5's opt-out`);
  const granted = await v1(`?gdpr=1&gdpr_consent=${TC_ID5}`, { cookie: `_pubcid=${UUID}` });
  const grantedBody = (await received()).at(-1) ?? {};
  check('GDPR with ID5\'s consent: the EID, and the TC string and puid were sent', id5Eid(granted.payload) && grantedBody['gdpr'] === 1 && grantedBody['gdpr_consent'] === TC_ID5 && grantedBody['puid'] === UUID, JSON.stringify(grantedBody));
  const optOutUa = `Mozilla/5.0 (${ID5_OPT_OUT_MARKER})`;
  const id5OptOut = await v1('', { cookie: `_pubcid=${UUID}`, 'user-agent': optOutUa });
  check('ID5\'s opt-out: no EID, and an opt-out marker cached', !id5Eid(id5OptOut.payload) && id5OptOut.cache !== undefined && id5OptOut.cache !== '', JSON.stringify(id5OptOut));
  const count = (await received()).length;
  const markerAgain = await v1('', { cookie: `_pubcid=${UUID}; ${COOKIE}=${id5OptOut.cache ?? ''}`, 'user-agent': optOutUa });
  check('with the marker, no EID and no new request to the stub', !id5Eid(markerAgain.payload) && (await received()).length === count);
} finally {
  await target.stop();
}

checks.done(`id5 (${targetName})`);
