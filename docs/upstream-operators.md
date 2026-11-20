# SharedID Edge for upstream operators

This guide is for an upstream operator: an ad-tech vendor, network or agency that runs SharedID Edge for many publishers, usually as one endpoint that their CDNs forward `/_sid/*` to, when each publisher serves its site from its own CDN. It's the implementation guide: the architecture, a worked example with real settings, the configuration each publisher's CDN needs, secrets, onboarding, consent, operations, failure modes and the security model.

If you host the publishers' sites yourself (Cloudflare for SaaS, Workers for Platforms, a CDN account that serves their hostnames), read [SharedID Edge for hosting companies](hosting-companies.md) first: you don't need a second host at all. If you do both, see that guide's [FAQ](hosting-companies.md#faq).

## Contents

- [The two hosts](#the-two-hosts)
- [Two models](#two-models)
  - [Model A: it runs on the publisher's own CDN](#model-a-it-runs-on-the-publishers-own-cdn)
  - [Model B: the publisher's CDN forwards to your endpoint](#model-b-the-publishers-cdn-forwards-to-your-endpoint)
  - [Where to run the upstream operator's endpoint](#where-to-run-the-upstream-operators-endpoint)
  - [Choosing](#choosing)
- [Architecture of model B](#architecture-of-model-b)
- [Worked example](#worked-example)
  - [1. The endpoint](#1-the-endpoint)
  - [2. Each publisher's CDN](#2-each-publishers-cdn)
  - [3. Verify](#3-verify)
  - [4. Prebid.js on the publisher's pages](#4-prebidjs-on-the-publishers-pages)
- [Publisher CDN recipes](#publisher-cdn-recipes)
- [Secrets](#secrets)
- [Onboarding and offboarding a publisher](#onboarding-and-offboarding-a-publisher)
- [Consent: who is responsible for what](#consent-who-is-responsible-for-what)
- [Operations at scale](#operations-at-scale)
- [Failure modes and troubleshooting](#failure-modes-and-troubleshooting)
- [Security model](#security-model)
- [What's been verified live](#whats-been-verified-live)
- [FAQ](#faq)

## The two hosts

SharedID Edge keeps the Prebid.js SharedID cookie (`_pubcid`) for up to 400 days by setting it from a server instead of from script, which Safari and other browsers cap at 7 days. Safari grants the long lifetime only to a **first-party server-set cookie**: a response from the site's own hostname, from a server whose IP address matches the site's (since Safari 16.4). That gives an upstream operator two hosts to think about:

| | Host | Who runs it | Role |
| --- | --- | --- | --- |
| **1** | The **publisher's site hostname**, `www.pub-a.example` | The publisher, on their own CDN | Answers `/_sid/*` for the browser, on the site's own hostname and IP addresses, so the cookies are first-party |
| **2** | **Your endpoint's hostname**, `sid.upstream.example` | You, on a Cloudflare Worker, AWS Lambda, Fastly Compute or the Node.js server | Does the work for every publisher: authenticates the publisher's CDN, picks the publisher's settings, decides consent, sets the cookies |

The browser only ever talks to host 1. The publisher's CDN passes `/_sid/*` on to host 2 and passes the response, with its `Set-Cookie` headers, back unchanged. So the cookies are set by `www.pub-a.example`, from the publisher CDN's IP addresses, the same ones that serve the pages.

**Why not just a CNAME** from `sid.pub-a.example` to `sid.upstream.example`? The browser would then talk to your servers, on IP addresses that aren't the site's, and Safari caps the cookies at 7 days: its IP-address rule since 16.4, and its CNAME-cloaking defence before that. `verify-deployment` reports it. Workers for Platforms or any other multi-tenant product on your side doesn't change this: what matters is which servers the browser reaches.

**Why not your own domain?** A cookie from `sid.upstream.example` is a third-party cookie on the publisher's site, which is what SharedID Edge replaces.

## Two models

### Model A: it runs on the publisher's own CDN

SharedID Edge is deployed on the publisher's CDN, in the publisher's account, the way a publisher deploying it themselves would ([Pick your platform](../README.md#pick-your-platform)). You operate it with access they delegate:

- **On Cloudflare:** a Worker on `www.pub-a.example/_sid/*`, or a Snippet on Pro or higher, deployed with an API token the publisher scopes to their zone. The steps, token permissions and costs are in the Cloudflare adapter's [Upstream operators](../packages/adapters/cloudflare/README.md#upstream-operators) section.
- **On CloudFront:** the [Lambda function](../packages/adapters/aws-lambda/README.md) and a `/_sid/*` behaviour on their distribution, through a role they let you assume.
- **On Fastly, Akamai, Vercel, Azure or Google Cloud:** that adapter, in their service, property, project, subscription or project.

If the publisher's site is on Cloudflare and so is your endpoint (orange-to-orange through Cloudflare for SaaS), see [Orange-to-orange with a Worker on one side and a Snippet on the other](hosting-companies.md#orange-to-orange-with-a-worker-on-one-side-and-a-snippet-on-the-other) before planning a Snippet on your side: it's untested and has limits a Worker doesn't.

Each deployment uses that platform's own client IP and location, so there are no headers to forward and no secrets to share. But it's one deployment per publisher to roll out, update and watch, in accounts you don't own, and only on platforms SharedID Edge has an adapter for.

### Model B: the publisher's CDN forwards to your endpoint

You run **one endpoint** for all your publishers. Each publisher's CDN sends `/_sid/*` to it, adding a shared secret and the visitor's IP address, country and site hostname in headers. The endpoint runs in **trusted-upstream mode** ([what the settings do](configuration.md#trusted-upstream-behind-a-publishers-cdn)): it trusts those headers only on requests with one of its secrets, and answers anything else with a `403` and no cookies.

The endpoint is an edge deployment by default, a Cloudflare Worker or a Fastly Compute service, or else AWS Lambda or the Node.js server ([Where to run the upstream operator's endpoint](#where-to-run-the-upstream-operators-endpoint)):

| Endpoint | Its hostname, for the publishers' CDNs | Where its secrets live | Guide |
| --- | --- | --- | --- |
| **Cloudflare Worker** | A [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), `sid.upstream.example` | A Worker secret | [Cloudflare: Upstream operators](../packages/adapters/cloudflare/README.md#upstream-operators) |
| **Fastly Compute** | The service's domain | The `sharedid_secrets` secret store | [Service chaining](../packages/adapters/fastly/README.md#b-service-chaining-from-your-vcl-service) |
| **AWS Lambda**, behind your own CloudFront distribution | The distribution's domain, or your alias on it | The `SidUpstreamSecrets` template parameter (`NoEcho`) | [Behind a publisher's CDN](../packages/adapters/aws-lambda/README.md#behind-a-publishers-cdn-trusted-upstream) |
| **Node.js server** | Your own, behind TLS | Its environment, from your secret manager | [Trusted upstream](../packages/adapters/node/README.md#trusted-upstream) |

Not the Cloudflare Snippet (it has no secrets), and not the Vercel, Azure Functions, Google Cloud or Akamai adapters, which refuse trusted-upstream settings with a 500: each already trusts its own platform's front end, and can't tell a publisher's CDN apart from it.

### Where to run the upstream operator's endpoint

Every `/_sid/*` request makes one more trip in model B: from the publisher's CDN edge to your endpoint and back. `/_sid/v1` is on the page's path to its first auction when the page waits for the modules' output, so each extra round trip is latency every visitor feels. (The sync pixel is asynchronous and cached for a day, so it matters less.) Where the endpoint's code runs decides how long that trip is:

| Endpoint | Where its code runs | The publisher CDN → endpoint hop |
| --- | --- | --- |
| **Cloudflare Worker** | In every Cloudflare location | Short everywhere: the publisher's CDN edge reaches a nearby Cloudflare location, and the Worker runs there |
| **Fastly Compute** | In every Fastly POP | Short everywhere, as for a Worker |
| **AWS Lambda** | In the one AWS region you deploy it to. Your CloudFront distribution in front shortens the network path to AWS, but the function still runs in that region | Short near that region, a continent away elsewhere. For publishers worldwide, a stack per region with latency-based DNS |
| **AWS Lambda@Edge** | At CloudFront's edge: the regional edge caches (`origin-request`) or every edge location (`viewer-request`) ([Lambda@Edge](../packages/adapters/aws-lambda/README.md#lambdaedge)). Trusted-upstream mode isn't available on it yet ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)), so as an upstream operator's endpoint use the regional function for now; on a publisher's own CloudFront distribution (model A) it answers near each visitor | Short everywhere, once trusted-upstream mode is supported |
| **Node.js server** | Wherever you host it | One region, unless you run it in several behind a global load balancer or latency-based DNS |

So for an upstream operator with publishers in many countries, **an edge endpoint, a Worker or a Fastly Compute service, is the natural default**. Lambda (regional) or the Node.js server make sense when your infrastructure already lives there (your secrets, deploys and monitoring are on AWS or in your own data centres), and your publishers are mostly near one region, or you run it in several.

### Choosing

| | Model A: on the publisher's CDN | Model B: your endpoint |
| --- | --- | --- |
| The publisher's CDN must | Be a platform with an adapter, and give you deploy access | Route `/_sid/*` by path to another origin and set request headers: almost any CDN or proxy |
| Deployments to run | One per publisher | One (or one per region or platform) |
| Updating SharedID Edge | Per publisher, in their accounts | Once |
| Adding a publisher | A new deployment | An `SID_HOSTS` entry, a secret, and their CDN rule |
| Visitor IP and location | The publisher's platform's own | The publisher's CDN's, forwarded in headers |
| Secrets to manage | None shared | One per publisher, and rotation |
| Latency | None added | One more round trip, publisher CDN to your endpoint: short from an edge endpoint ([Where to run](#where-to-run-the-upstream-operators-endpoint)) |
| Compute bill | The publisher's | Yours; the publisher's CDN still bills its `/_sid/*` requests |
| A bad release or setting affects | One publisher | Every publisher, unless you stage it ([Deploys and rollbacks](#deploys-and-rollbacks)) |
| The `ec` module's passphrase | Per publisher | One, yours, for every publisher |

**Model B** scales with one deployment, so it suits most of a large upstream operator's publishers; model A suits publishers on Cloudflare who'd rather keep everything in their own account. The rest of this guide is model B.

## Architecture of model B

```text
                 Browser (sees only www.pub-a.example and the publisher CDN's IP addresses)
                    │  GET https://www.pub-a.example/_sid/sync?id=pubcid:…
                    │  Cookie: _pubcid=…; _pubcid_sv=…; euconsent-v2=…
                    │  (perhaps also forged X-SID-Country, X-SID-Client-IP, X-Forwarded-Host …)
                    ▼
 ┌──────────── Publisher's CDN: www.pub-a.example (host 1) ─────────────────────────────┐
 │  /_sid/*, not cached:                                                                │
 │   • SETS (overwriting anything the visitor sent):                                    │
 │       X-SID-Upstream-Auth: <pub-a's secret>                                          │
 │       X-Forwarded-Host:    www.pub-a.example        (the Host the visitor asked for) │
 │       X-SID-Client-IP:     203.0.113.7              (the connection's own address)   │
 │       X-SID-Country:       DE                       (the CDN's own geolocation)      │
 │       X-SID-Region:        BE                       (optional, or removed)           │
 │   • passes Cookie, query string, User-Agent, Sec-GPC, Origin unchanged               │
 │   • origin: https://sid.upstream.example, Host: sid.upstream.example             │
 │  everything else → the publisher's site, as before                                   │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                    │  HTTPS
                    ▼
 ┌── Your endpoint: sid.upstream.example (host 2): a Worker or Fastly, at the edge ───┐
 │  1. X-SID-Upstream-Auth is one of SID_UPSTREAM_SECRETS? No → 403, no cookies         │
 │  2. remove it; host := X-Forwarded-Host (one hostname, else 400)                     │
 │  3. client IP and location := the X-SID-* headers (the platform's own are the CDN's) │
 │  4. settings := SID_HOSTS["www.pub-a.example"] (not listed → 404)                    │
 │  5. consent: opt-out, GPC, COPPA, TC string, GDPR from X-SID-Country                 │
 │  6. Set-Cookie: _pubcid=…; Domain=pub-a.example; Secure; SameSite=Lax; Max-Age=…     │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                    │  200 image/gif (or /_sid/v1's JSON), Set-Cookie ×2, Cache-Control: private
                    ▼
            Publisher's CDN passes the response back unchanged (no caching)
                    ▼
            Browser stores first-party, server-set cookies for pub-a.example
```

What exists on each hop:

| Header | Browser → publisher CDN | Publisher CDN → endpoint | Endpoint's handler and modules |
| --- | --- | --- | --- |
| `Host` | `www.pub-a.example` | `sid.upstream.example` | Replaced by `X-Forwarded-Host`: the request is `https://www.pub-a.example/_sid/…` |
| `Cookie`, `User-Agent`, `Sec-GPC`, `Origin`, Client Hints | The visitor's | Passed on | Used for the ID, consent, CORS and the `ua` module |
| `X-SID-Upstream-Auth` | Ignored if sent (the CDN overwrites it) | The publisher's secret | Checked, then removed: modules never see it |
| `X-Forwarded-Host` | Ignored if sent | The site's hostname | The request's host |
| `X-SID-Client-IP`, `X-SID-Country`, `X-SID-Region` | Ignored if sent | Set from the CDN's own data | The client IP (the `ip` module, IP-based vendor modules) and location (GDPR, the `geo` module) |
| `CF-Connecting-IP`, `request.cf`, `CloudFront-Viewer-*`, Fastly's client data | | Describe the publisher's CDN | Ignored in trusted-upstream mode, with the platform's bot verdict |

The visitor's cookies travel with the request, so the TC string cookie (`euconsent-v2`), the opt-out cookie and the recovery copy reach the endpoint, and its `Set-Cookie` headers come back on the publisher's hostname.

## Worked example

An upstream operator with three publishers:

| Publisher | Site hostnames | Domain Prebid.js writes `_pubcid` on | Their CDN | Notes |
| --- | --- | --- | --- | --- |
| A | `www.pub-a.example`, `pub-a.example` | `pub-a.example` | Amazon CloudFront | `ip` and `geo` |
| B | `www.pub-b.example` | `pub-b.example` | Fastly (VCL) | `/_sid/v1` read from `https://m.pub-b.example` too |
| C | `news.pub-c.example` | `pub-c.example` | Akamai | Only the SharedID, no modules; Prebid.js writes host-only cookies |

### 1. The endpoint

The settings are the same `SID_*` variables on every endpoint platform:

| Setting | Value | Why |
| --- | --- | --- |
| `SID_UPSTREAM_SECRETS` (a **secret**) | `["<A's secret>","<B's secret>","<C's secret>"]` | One per publisher, `openssl rand -hex 32` each ([Secrets](#secrets)) |
| `SID_CLIENT_IP_HEADER` | `x-sid-client-ip` | The header the publishers' CDNs put the visitor's address in |
| `SID_LOCATION_HEADERS` | `{"country":"x-sid-country","regionCode":"x-sid-region"}` | `country` is required: it decides GDPR without a TC string |
| `SID_UPSTREAM_AUTH_HEADER`, `SID_UPSTREAM_HOST_HEADER` | unset (`x-sid-upstream-auth`, `x-forwarded-host`) | The defaults |
| `SID_MODULES` | `ip,geo` | The modules publishers may use; each site can narrow it |
| `SID_HOSTS` | below | Each publisher's hostnames and settings |
| `SID_COOKIE_DOMAIN` | unset | Every site sets its own in `SID_HOSTS` |

`SID_HOSTS`, keyed by the hostname each publisher's CDN sends in `X-Forwarded-Host`:

```json
{
  "www.pub-a.example": { "SID_COOKIE_DOMAIN": "pub-a.example" },
  "pub-a.example": { "SID_COOKIE_DOMAIN": "pub-a.example" },
  "www.pub-b.example": { "SID_COOKIE_DOMAIN": "pub-b.example", "SID_ALLOWED_ORIGINS": "https://m.pub-b.example" },
  "news.pub-c.example": { "SID_COOKIE_DOMAIN": "host-only", "SID_MODULES": "" }
}
```

A hostname that isn't listed gets a 404 and no cookies, and so does a request without `X-Forwarded-Host` (it keeps the endpoint's own hostname). Every site's settings are validated when the endpoint starts: one mistake fails every request, naming the hostname, so check changes first ([Deploys and rollbacks](#deploys-and-rollbacks)). Settings that can't vary per site: `SID_BASE_PATH`, `SID_MODULE_SECRETS`, and all the trusted-upstream settings above.

#### On a Cloudflare Worker (the example)

The Worker runs at the edge, near every publisher CDN ([Where to run](#where-to-run-the-upstream-operators-endpoint)). In [`packages/adapters/cloudflare/wrangler.jsonc`](../packages/adapters/cloudflare/wrangler.jsonc), with `sid.upstream.example` a hostname of a zone in your account:

```jsonc
{
  "name": "sharedid-edge-upstream",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "routes": [{ "pattern": "sid.upstream.example", "custom_domain": true }],
  "workers_dev": false,
  "vars": {
    "SID_MODULES": "ip,geo",
    "SID_CLIENT_IP_HEADER": "x-sid-client-ip",
    "SID_LOCATION_HEADERS": "{\"country\":\"x-sid-country\",\"regionCode\":\"x-sid-region\"}",
    "SID_HOSTS": "{\"www.pub-a.example\":{\"SID_COOKIE_DOMAIN\":\"pub-a.example\"},\"pub-a.example\":{\"SID_COOKIE_DOMAIN\":\"pub-a.example\"},\"www.pub-b.example\":{\"SID_COOKIE_DOMAIN\":\"pub-b.example\",\"SID_ALLOWED_ORIGINS\":\"https://m.pub-b.example\"},\"news.pub-c.example\":{\"SID_COOKIE_DOMAIN\":\"host-only\",\"SID_MODULES\":\"\"}}"
    // … the other settings as in the file
  }
}
```

```sh
npm exec -w @sharedid-edge/cloudflare -- wrangler secret put SID_UPSTREAM_SECRETS
# paste: ["<A's secret>","<B's secret>","<C's secret>"]
npm run deploy -w @sharedid-edge/cloudflare
```

#### Variant: Fastly Compute

An edge endpoint like the Worker. The settings are keys of the `sharedid_config` config store, and `SID_UPSTREAM_SECRETS` a key of the `sharedid_secrets` secret store (never the config store, where the service refuses it) ([Configuration](../packages/adapters/fastly/README.md#configuration), [Secrets](../packages/adapters/fastly/README.md#secrets)). A config store value holds 8,000 characters.

#### Variant: AWS Lambda

The template with its own distribution (`CreateDistribution=true`), as in the adapter's [Behind a publisher's CDN](../packages/adapters/aws-lambda/README.md#behind-a-publishers-cdn-trusted-upstream):

```sh
sam deploy --parameter-overrides CreateDistribution=true \
  'SidUpstreamSecrets=["<A secret>","<B secret>","<C secret>"]' \
  SidClientIpHeader=x-sid-client-ip \
  'SidLocationHeaders={"country":"x-sid-country","regionCode":"x-sid-region"}' \
  SidModules=ip,geo \
  'SidHosts={"www.pub-a.example":{"SID_COOKIE_DOMAIN":"pub-a.example"}, …}' \
  Aliases=sid.upstream.example AcmCertificateArn=<us-east-1 certificate>
```

Lambda's environment holds 4 KB in all, which caps `SID_HOSTS` at a few dozen sites; past that, run more than one stack, each with its own hostname, and give each publisher the hostname of theirs.

#### Variant: the Node.js server

Behind your own TLS-terminating load balancer:

```sh
SID_UPSTREAM_SECRETS="$(your-secret-manager get sharedid-upstream)" \
SID_CLIENT_IP_HEADER=x-sid-client-ip \
SID_LOCATION_HEADERS='{"country":"x-sid-country","regionCode":"x-sid-region"}' \
SID_MODULES=ip,geo \
SID_HOSTS="$(cat sid-hosts.json)" \
HOST=0.0.0.0 PORT=8787 node packages/adapters/node/dist/cli.js
```

`SID_TRUST_PROXY` isn't needed. The load balancer must pass the publisher CDN's headers through unchanged ([Trusted upstream](../packages/adapters/node/README.md#trusted-upstream)).

#### Check the endpoint refuses direct calls

On any platform, before any publisher points at it:

```sh
curl -sI https://sid.upstream.example/_sid/v1                                  # 403
curl -sI -H 'X-SID-Upstream-Auth: wrong' -H 'X-SID-Country: US' \
  https://sid.upstream.example/_sid/sync                                        # 403, no set-cookie
curl -s -H "X-SID-Upstream-Auth: $A_SECRET" -H 'X-Forwarded-Host: www.pub-a.example' \
  -H 'X-SID-Client-IP: 192.0.2.1' -H 'X-SID-Country: US' \
  https://sid.upstream.example/_sid/v1 | jq .ortb2.device                       # ip 192.0.2.1, geo USA
curl -sI -H "X-SID-Upstream-Auth: $A_SECRET" -H 'X-Forwarded-Host: www.pub-a.example' \
  -H 'X-SID-Client-IP: 192.0.2.1' -H 'X-SID-Country: DE' \
  'https://sid.upstream.example/_sid/sync?id=pubcid:test-id'                     # no set-cookie: GDPR, no TC string
```

The forwarded country decides consent like a visitor's own: with `DE` and no TC string, GDPR applies, so there's no SharedID, and the `ip` module leaves the address out (`X-SharedID-Status: denied: tcf: …` on `/sync`).

### 2. Each publisher's CDN

Send each publisher its secret (over a channel you'd trust with a password) and the recipe for their CDN from [Publisher CDN recipes](#publisher-cdn-recipes): publisher A the CloudFront one, B the Fastly one, C the Akamai one. Whatever the CDN, on `/_sid/*` requests only, it must:

1. **Route** them to `https://sid.upstream.example`, with that `Host` (or TLS SNI) and HTTPS;
2. **not cache** them, and pass the response back as it is, `Set-Cookie` included;
3. **set**, overwriting any copy the visitor sent: `X-SID-Upstream-Auth` (the secret), `X-Forwarded-Host` (the site's hostname, the `Host` the visitor asked for), `X-SID-Client-IP` (the address of the visitor's own connection to the CDN, never `X-Forwarded-For`) and `X-SID-Country` (ISO 3166-1 alpha-2, from the CDN's own geolocation);
4. set `X-SID-Region` if it has it, and otherwise **remove** it, since the endpoint trusts every header named in `SID_LOCATION_HEADERS`;
5. pass `Cookie`, the query string, `User-Agent`, `Sec-GPC`, `Origin` and the Client Hints through.

### 3. Verify

Through each publisher's site, before their pages use it:

```sh
npm run verify-deployment -- --site https://www.pub-a.example
```

It checks that `/_sid/*` answers from the same IP addresses as the site (the publisher's CDN, not your endpoint), that `/_sid/sync` sets `Secure`, long-lived, script-readable `_pubcid` and its `HttpOnly` recovery copy, that nothing was served from a shared cache, and that `/_sid/v1` answers. Then:

```sh
# The publisher's settings: the cookies' Domain is pub-a.example
curl -sI 'https://www.pub-a.example/_sid/sync?id=pubcid:test-id' | grep -i set-cookie
# The visitor's real address and country, not forged ones (with the ip and geo modules)
curl -s -H 'X-SID-Client-IP: 192.0.2.1' -H 'X-SID-Country: US' -H 'X-Forwarded-Host: www.pub-b.example' \
  https://www.pub-a.example/_sid/v1 | jq '.ortb2.device'
```

The second must show your own IP address and country: if it shows `192.0.2.1` or `USA`, the publisher's CDN appends to or passes the visitor's headers instead of setting its own. From a location where GDPR applies (the EU, the rest of the EEA, the UK or Turkey; a VPN will do) without a TC string, `/_sid/sync` must set no cookie, with `X-SharedID-Status` saying why.

### 4. Prebid.js on the publisher's pages

Nothing about the two hosts reaches the page. Prebid.js calls the sync route **on the publisher's own hostname**, as for any SharedID Edge deployment ([Configure Prebid.js](prebid.md)):

```js
pbjs.setConfig({
  userSync: {
    userIds: [{
      name: 'sharedId',
      params: { pixelUrl: '/_sid/sync', extend: true, pixelConsent: true },   // the publisher's host, never sid.upstream.example; pixelConsent: Prebid.js 11.53+
      storage: { type: 'cookie', name: '_pubcid', expires: 365 }
    }]
  }
});
```

`storage.name` must match `SID_COOKIE_NAME` (`_pubcid` by default), and the domain Prebid.js writes it on must be the site's `SID_COOKIE_DOMAIN`. To pass the modules' output (`ip`, `geo`) to the auction, the page fetches `/_sid/v1`, also on its own host ([Module output](prebid.md#module-output-_sidv1)). If you manage the publishers' Prebid.js builds or wrappers, this is one configuration for all of them.

## Publisher CDN recipes

This is the canonical copy of these recipes; the adapter READMEs link here. They follow each CDN's documentation, and use the header names of the [worked example](#worked-example). Replace `sid.upstream.example` with your endpoint's hostname. The Cloudflare and CloudFront ones have been run live, as written, in front of a Worker endpoint; the others haven't yet ([What's been verified live](#whats-been-verified-live), [How SharedID Edge is verified](verification.md#publisher-cdn-recipes)), so check each publisher with [Verify](#3-verify).

### Amazon CloudFront

1. **Origin:** `sid.upstream.example`, HTTPS only, and an [origin custom header](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html) `X-SID-Upstream-Auth` with the publisher's secret. CloudFront replaces a viewer's header of the same name with it.
2. **Behaviour** `/_sid/*`, above any broader pattern: that origin, *Redirect HTTP to HTTPS*, methods *GET, HEAD, OPTIONS*, cache policy **CachingDisabled**, origin request policy **AllViewerExceptHostHeader** (so the origin gets its own `Host`, and the cookies, query string and viewer headers, the function's included). The policy also includes `CloudFront-Viewer-Country` and `CloudFront-Viewer-Country-Region`, which the function below reads.
3. **A CloudFront Function** on viewer request for the behaviour:

```js
function handler(event) {
  var request = event.request;
  var headers = request.headers;
  // The visitor's own connection address, never X-Forwarded-For (which the visitor can send).
  headers['x-sid-client-ip'] = { value: event.viewer.ip };
  headers['x-forwarded-host'] = { value: headers.host.value };
  var country = headers['cloudfront-viewer-country'];
  var region = headers['cloudfront-viewer-country-region'];
  if (country) headers['x-sid-country'] = { value: country.value }; else delete headers['x-sid-country'];
  if (region) headers['x-sid-region'] = { value: region.value }; else delete headers['x-sid-region'];
  return request;
}
```

CloudFront Functions bill per invocation, on the publisher's account. The function can't be left out: origin custom headers are fixed values, and the endpoint reads only `x-` header names it's configured with, never `CloudFront-Viewer-*`, so only a function can copy the visitor's address and country into them. An IAM policy that allows editing the distribution doesn't cover functions: deploying this also needs the function actions (`cloudfront:CreateFunction`, `PublishFunction` and the rest).

### Fastly (VCL)

1. **Backend** `sharedid_endpoint`: address `sid.upstream.example`, port 443, TLS on, *Override host* and SNI hostname `sid.upstream.example`, certificate check on.
2. **A private edge dictionary** `sharedid_secrets` with the key `upstream` holding the publisher's secret (private dictionaries are write-only: the value isn't shown again).
3. **In `vcl_recv`,** before `#FASTLY recv`:

```text
if (req.url.path ~ "^/_sid/") {
  # On the first Fastly hop only: with shielding, client.ip on a later hop is a Fastly POP.
  if (fastly.ff.visits_this_service == 0) {
    set req.http.X-SID-Upstream-Auth = table.lookup(sharedid_secrets, "upstream");
    set req.http.X-SID-Client-IP = client.ip;           # not Fastly-Client-IP or X-Forwarded-For: a visitor can send those
    set req.http.X-SID-Country = client.geo.country_code;
    set req.http.X-SID-Region = client.geo.region;
    set req.http.X-Forwarded-Host = req.http.host;
  }
  set req.backend = F_sharedid_endpoint;
  return(pass);
}
```

`set` replaces a header the visitor sent. Fastly's placeholders for unknown values (`**`, `?`) are treated as no country. A publisher already on Fastly Compute can instead run SharedID Edge there (model A, [Fastly](../packages/adapters/fastly/README.md)); with your endpoint on Fastly Compute, this is [service chaining](../packages/adapters/fastly/README.md#b-service-chaining-from-your-vcl-service) across accounts.

### Akamai

In the property that serves the site, a rule matching path `/_sid/*`:

- **Origin Server:** `sid.upstream.example`, *Forward Host Header*: *Origin Hostname*, HTTPS, certificate verification on.
- **Caching:** *No store*; **Downstream Cacheability:** *Pass cacheability headers from origin*.
- **A user-defined variable** `PMUSER_SID_UPSTREAM_AUTH` holding the publisher's secret, with *Security settings*: *Sensitive*, so it isn't shown in logs or debug headers.
- **Modify Outgoing Request Header** behaviours (*Modify*/*Add*, so they replace a visitor's copy):
  - `X-SID-Upstream-Auth`: `{{user.PMUSER_SID_UPSTREAM_AUTH}}`;
  - `X-SID-Client-IP`: `{{builtin.AK_CLIENT_REAL_IP}}`. **Never `AK_CLIENT_IP`**, which a visitor's `X-Forwarded-For` or `Akamai-Client-IP` header overrides; `AK_CLIENT_REAL_IP` ignores request headers;
  - `X-Forwarded-Host`: `{{builtin.AK_HOST}}`;
  - `X-SID-Country`: EdgeScape's country code, in a child rule that matches only requests **without** an `X-Forwarded-For` header. EdgeScape locates that header's address when it's present, and the visitor chooses it ([Location and X-Forwarded-For](../packages/adapters/akamai/README.md#location-and-x-forwarded-for)). Without the country, GDPR follows the page's own signal for those requests;
  - remove `X-SID-Country` and `X-SID-Region` in a rule before these, so a visitor's copies never pass.

Which Property Manager variable carries EdgeScape's country depends on the contract's products; ask your Akamai account team. A publisher on Akamai can instead run the [EdgeWorker](../packages/adapters/akamai/README.md) (model A).

### Cloudflare (the publisher's zone, your endpoint elsewhere)

Running SharedID Edge in the publisher's own Cloudflare account (model A, [Cloudflare: Upstream operators](../packages/adapters/cloudflare/README.md#upstream-operators)) is simpler and needs no secret. To forward instead, a small Worker on the publisher's zone, route `www.pub-a.example/_sid/*`, with the secret as a Worker secret (`wrangler secret put SID_UPSTREAM_SECRET`):

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-sid-upstream-auth', env.SID_UPSTREAM_SECRET);
    headers.set('x-forwarded-host', url.hostname);
    // CF-Connecting-IP and request.cf are Cloudflare's own; never X-Forwarded-For.
    headers.set('x-sid-client-ip', request.headers.get('cf-connecting-ip') ?? '');
    for (const [name, value] of [['x-sid-country', request.cf?.country], ['x-sid-region', request.cf?.regionCode]]) {
      if (typeof value === 'string' && value !== '') headers.set(name, value); else headers.delete(name);
    }
    const upstream = new URL(url.pathname + url.search, 'https://sid.upstream.example');
    return fetch(upstream, { method: request.method, headers, redirect: 'manual' });
  }
};
```

Without a Worker: a *Request Header Transform Rule* for `/_sid/*` setting `X-SID-Client-IP` to `ip.src`, `X-SID-Country` to `ip.src.country`, `X-Forwarded-Host` to `http.host` and `X-SID-Upstream-Auth` to the secret (a static value, visible to the zone's admins), an *Origin Rule* sending `/_sid/*` to your endpoint, and a *Cache Rule* that bypasses the cache. An Origin Rule's host header override needs an Enterprise plan.

### nginx

```nginx
location /_sid/ {
    proxy_pass https://sid.upstream.example;
    proxy_ssl_server_name on;
    proxy_ssl_verify on;                                         # the secret travels in a header: check the certificate
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_set_header Host sid.upstream.example;
    proxy_set_header X-SID-Upstream-Auth "<this publisher's secret>";
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-SID-Client-IP $remote_addr;               # never $http_x_forwarded_for or $proxy_add_x_forwarded_for
    proxy_set_header X-SID-Country $geoip2_data_country_code;    # the GeoIP2 module, or your own source
    proxy_set_header X-SID-Region "";                            # an empty value removes the header
    proxy_cache off;
}
```

`proxy_set_header` replaces a header the visitor sent. If nginx itself sits behind another CDN, `$remote_addr` and the country are that CDN's edge: take them from that CDN's own headers, with nginx's `realip` module trusting only that CDN's addresses.

### HAProxy

```text
backend sharedid
    # rules run in order: copy the publisher's Host before rewriting it
    http-request set-header X-Forwarded-Host %[req.hdr(host)]
    http-request set-header Host sid.upstream.example
    http-request set-header X-SID-Upstream-Auth "<this publisher's secret>"
    http-request set-header X-SID-Client-IP %[src]
    http-request set-header X-SID-Country %[src,map_ip(/etc/haproxy/country.map,)]
    http-request del-header X-SID-Region
    server endpoint sid.upstream.example:443 ssl verify required ca-file @system-ca sni str(sid.upstream.example)
```

with a `use_backend sharedid if { path_beg /_sid/ }` in the frontend. `set-header` replaces the visitor's copy. HAProxy doesn't cache unless you configure it to.

### Azure Front Door

A route for `/_sid/*` to an origin group with your endpoint (origin host header `sid.upstream.example`, caching off), and a rule set on it with *Modify request header* actions (*Overwrite*): `X-SID-Upstream-Auth` to the secret, `X-SID-Client-IP` to `{socket_ip}` (the connection's address; not `{client_ip}`, which comes from `X-Forwarded-For` when the visitor sends one), `X-SID-Country` to `{geo_country}`, `X-Forwarded-Host` to `{hostname}` (the host name the browser asked for), and *Delete* `X-SID-Region`.

### Any other CDN or proxy

It works if the CDN can do the five things in [Each publisher's CDN](#2-each-publishers-cdn). Check, in its documentation:

- which value is the visitor's own connection address, which **no request header can change** (each CDN above has one, and a look-alike that headers override);
- that its header action **replaces** rather than appends;
- where it keeps a secret that its logs and debug output don't show;
- that a path rule can turn caching off;
- that the country comes from the connection's address, not from `X-Forwarded-For`.

## Secrets

**One secret per publisher.** `SID_UPSTREAM_SECRETS` is a JSON array, and any entry is accepted for any site. Giving each publisher its own lets you rotate or revoke one without touching the others; one shared secret means every publisher's CDN changes at once. Each is 32 to 256 characters from letters, digits and `-._~+/=`; `openssl rand -hex 32` makes one. Keep a mapping of which secret belongs to which publisher, outside the endpoint (the endpoint only has the list).

**Where they live:** on the endpoint, in the platform's secret store only (a Worker secret, the `NoEcho` Lambda parameter, Fastly's secret store, your secret manager for the Node.js server). They're never shown in responses, errors or logs. On the publisher's side, in the CDN's most private place: CloudFront's origin custom header (visible to the distribution's admins), Fastly's private edge dictionary, Akamai's sensitive variable, a Cloudflare Worker secret.

**Rotating a publisher's secret, with no downtime:**

1. Generate a new secret for the publisher.
2. Add it to `SID_UPSTREAM_SECRETS` next to the old one, and deploy. Both are accepted now.
3. The publisher replaces the old secret with the new one in their CDN, and deploys or activates it (CloudFront deploys in minutes; Akamai activations and Fastly versions take their usual time).
4. Once they confirm it's live everywhere, remove the old secret and deploy.
5. Run `verify-deployment` against their site straight away. A `403` means their CDN still sends the old one: add it back, and find out why.

While a CDN sends a secret the endpoint doesn't accept, `/_sid/*` answers `403` and sets no cookies: Prebid.js carries on with the cookie it has, so the failure is a missed refresh, not a broken page. Rotate on a schedule (yearly, say), and whenever someone with access to a secret leaves.

**If a secret leaks:** rotate it as above, at once. What a holder can do: call your endpoint directly with a made-up IP address, country and site. The responses go only to their own client, so they can't set or read cookies in anyone else's browser, or change what another visitor gets; but they can make the endpoint skip GDPR for their own requests, mint IDs and run up your bill. So treat it like any credential, without panic.

## Onboarding and offboarding a publisher

**Onboarding checklist:**

1. **Collect:** every hostname the site answers on; the domain Prebid.js writes `_pubcid` on (the cookie's Domain in the browser's developer tools, normally the registrable domain, or `host-only`); their CDN; other origins that read `/_sid/v1` from script, if any; which modules they want; whether their CMP stores the TC string in the `euconsent-v2` cookie.
2. **Add their `SID_HOSTS` entries** (every hostname, with `SID_COOKIE_DOMAIN`, and any per-site `SID_MODULES` or `SID_ALLOWED_ORIGINS`), check the change ([Deploys and rollbacks](#deploys-and-rollbacks)).
3. **Issue a secret:** `openssl rand -hex 32`, add it to `SID_UPSTREAM_SECRETS`, record which publisher has it, and deploy.
4. **Send the publisher** their secret, the [recipe](#publisher-cdn-recipes) for their CDN with your endpoint's hostname filled in, and the five requirements in [Each publisher's CDN](#2-each-publishers-cdn).
5. **They deploy the CDN rule,** on a staging hostname first if they have one (add it to `SID_HOSTS` too).
6. **Verify** from their host: `npm run verify-deployment -- --site https://www.pub-a.example`, the forged-header check and the GDPR-country check ([Verify](#3-verify)).
7. **Turn on Prebid.js** on their pages: `pixelUrl: '/_sid/sync'` ([Prebid.js](#4-prebidjs-on-the-publishers-pages)).
8. **Give them** the opt-out URL for their privacy page (`https://www.pub-a.example/_sid/optout`) and the debugging headers ([Troubleshooting](troubleshooting.md)).

**Offboarding:** ask the publisher to remove `pixelUrl` and their CDN rule, then remove their secret from `SID_UPSTREAM_SECRETS` and their entries from `SID_HOSTS`, and deploy. In the other order, their `/_sid/*` answers `403` (or `404`) until they remove the rule, which is harmless. Their visitors' `_pubcid` cookies stay and keep working with Prebid.js alone.

## Consent: who is responsible for what

The endpoint decides consent on every request, the same way for every publisher ([Consent and opt-out](consent.md)):

1. **Opt-out** (`_pubcid_optout`), **Global Privacy Control** (`Sec-GPC: 1`) and **COPPA** (`coppa=1`): no ID, and existing ID cookies deleted.
2. **A TC string** (the `euconsent-v2` cookie, or `gdpr_consent`): by default, the **publisher's** consent, from the TC string's publisher segment: Purpose 1, and consent or legitimate interest for one of Purposes 2 to 10.
3. **No TC string:** if GDPR applies (the page says `gdpr=1`, or the visitor's country, from `X-SID-Country`, is one where GDPR applies: the EU, Iceland, Liechtenstein, Norway, the UK or Turkey, see [Consent](consent.md)), no ID; otherwise an ID.

| Who | Responsible for |
| --- | --- |
| **The publisher** | Their CMP: asking for **publisher** consent for Purpose 1 and at least one of Purposes 2 to 10, and either `pixelConsent: true` in Prebid.js (11.53.0 and later), which sends it with the sync, or the TC string stored in the `euconsent-v2` cookie, the only place the sync route sees it otherwise. Their privacy policy and the opt-out link (`/_sid/optout` on their host). Their CDN rule, kept as your recipe says. |
| **You, the upstream operator** | The endpoint: its settings per publisher, its secrets, and keeping it current. That the recipes you give send the visitor's real country: a missing country means GDPR's scope is unknown, and a visitor from a GDPR country without a TC string would get an ID. Not logging request data on your platform beyond what you've disclosed. |
| **Both** | Agreeing, in your contract, who controls the SharedID (it's the publisher's first-party ID) and how it's used in bid requests. |

**Per-publisher consent settings** in `SID_HOSTS`:

- **`SID_VENDOR_ID`:** the TCF vendor mode, with your own vendor ID, for a publisher whose SharedID is collected under your consent as a vendor rather than the publisher's own. Leave it unset (publisher mode) unless your legal team says otherwise.
- **`SID_MODULES`:** narrow the modules per publisher: the `ip` module returns the visitor's IP address and `geo` their location, which a publisher may not want in its bid requests; `ec` derives an ID from the IP address and has its own disclosures ([`ec`](../packages/vendor-modules/ec/README.md)).
- **`SID_SKIP_BOTS`:** set no ID for bots, from the `ua` and `bot` modules' signals. The endpoint platform's own bot verdict (Cloudflare Bot Management, and `SID_SKIP_BOTS_SCORE`) describes the publisher's CDN in trusted-upstream mode, so it isn't used.

## Operations at scale

### Monitoring

SharedID Edge logs nothing about requests, on purpose. What you have:

- **Status codes** from the platform's metrics. Steady `200`s; `403`s are direct calls, scanners, or a publisher whose CDN sends a wrong secret; `404`s are hostnames not in `SID_HOSTS`, or CDNs not sending `X-Forwarded-Host`; `400`s, a CDN appending to `X-Forwarded-Host`; `500`s, a configuration error, named in the platform's log.
- **Per publisher:** the endpoint can't tell you, since it logs no hostnames. Use the publishers' CDN logs, or your platform's analytics if it records the `X-Forwarded-Host` (that's your logging, to disclose as such).
- **The debugging headers,** `X-SharedID-Source` and `X-SharedID-Status`, on every response, for support ([Troubleshooting](troubleshooting.md)).
- **`verify-deployment` on a schedule** against one site per publisher CDN type: it catches a CDN change that broke the route, the caching or the IP match.

### Deploys and rollbacks

The endpoint is shared, so a bad deploy affects every publisher. A setting change is a deploy too: one invalid `SID_HOSTS` entry makes every request a `500`.

- **Keep the settings in version control,** with `SID_HOSTS` generated from your publisher list, so every change is reviewed and a rollback is a revert.
- **Check a change before deploying it:** after `npm run build`, `SID_HOSTS="$(cat sid-hosts.json)" node packages/adapters/node/dist/cli.js` refuses to start if any entry is invalid, naming it.
- **Stage it:** a second endpoint (a Wrangler environment, a second stack, a second Fastly service) that one test publisher hostname points at; deploy there first, run `verify-deployment`, then production.
- **Roll back** with the platform's own: `wrangler rollback` on Workers, redeploying the previous template version on AWS, activating the previous version on Fastly, the previous image for Node.js.
- **Updates:** releases are this repository's tags; read the changes, deploy to staging, verify, deploy.

### Rate limiting and abuse

`403`s are cheap, but they're still requests you pay for. Limit in three places ([Abuse protection: upstream operators](abuse-protection.md#upstream-operators) has the details for each platform):

- **At the endpoint, by connecting address,** with the platform's rate limiting (a Cloudflare WAF rate limiting rule, AWS WAF on your distribution, nginx `limit_req` in front of the Node.js server). That address is the publisher CDN's edge, so limit generously: one edge carries many visitors. This stops direct floods without the secret.
- **Per visitor,** on the publisher's CDN, where the visitor's address is known, or on a Cloudflare Worker with the `SID_RATE_LIMIT_CLIENT` [binding](../packages/adapters/cloudflare/README.md#rate-limiting), which counts the forwarded client IP of authenticated requests.
- **Per publisher,** so one publisher's flood can't crowd out the others: the `SID_RATE_LIMIT_HOST` binding on a Worker, or on AWS a rate-based rule keyed on the forwarded host header (reserved concurrency is shared by every publisher).

Requests over the size limits get a `414` or `431` and the rate limiting bindings' a `429`, cheaply, before any module runs; opt-out is never refused.

### Cost

Requests are at most about page views plus daily visitors: Prebid.js calls `/_sid/sync` at most about once a day per browser (`SID_SYNC_CACHE_SECONDS`), and `/_sid/v1` once per page view if the pages fetch the modules' output. A rough estimate for **100 million page views a month**, `/_sid/v1` on each, and 20 million daily syncs, so 120 million requests, at list prices when this was written, before free tiers:

| Endpoint | Estimate per month | From |
| --- | --- | --- |
| Cloudflare Workers (Standard) | About $40: $5 including 10 million requests, then $0.30 a million; CPU a few dollars at 1 to 2 ms a request | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| AWS Lambda behind CloudFront | About $150: Lambda about $25 in requests ($0.20 a million) and $5 in duration (128 MB, about 20 ms); CloudFront about $120 in HTTPS requests (about $0.01 per 10,000 in the US and Europe) | [Lambda](https://aws.amazon.com/lambda/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/) |
| Fastly Compute | By contract | [Fastly pricing](https://www.fastly.com/pricing) |
| Node.js server | Your servers: a few small instances per region behind a load balancer; measure with your traffic | |

What isn't cached (visitors whose storage is denied, the `clickid` module, `/_sid/v1` on every page) can multiply that count; the breakdown is in the hosting-company guide's [Request volume](hosting-companies.md#request-volume). These are estimates, not quotes: check the pricing pages, and your own CPU times. The publishers' CDNs also bill their `/_sid/*` requests (and a CloudFront Function, if used) on their accounts. Set budget alerts and caps before launch: [Cost control](abuse-protection.md#cost-control).

### Regions

A Worker or Fastly Compute service needs nothing more: it runs everywhere. A Lambda stack or the Node.js server runs where you put it; for publishers worldwide, run one per region with the same secrets and `SID_HOSTS`, behind latency-based DNS on `sid.upstream.example`, so each publisher CDN edge reaches the nearest one. Deploy every region together, so they never disagree about a publisher. See [Where to run the upstream operator's endpoint](#where-to-run-the-upstream-operators-endpoint).

## Failure modes and troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `403 Forbidden` (plain text) on every request through a publisher's site | Their CDN doesn't send the secret, sends an old or wrong one, or sends two (a repeated header never matches) | Check the CDN rule and that the secret is in `SID_UPSTREAM_SECRETS`; `curl` the endpoint with the secret to rule out the endpoint |
| `400 Bad Request` | `X-Forwarded-Host` is a list (`www.pub-a.example, …`) or not a hostname: the CDN appends rather than sets it, or a proxy in front added one | Set, not append |
| `404` with no cookies | `X-Forwarded-Host` is missing (the endpoint's own host is used), or names a hostname that isn't in `SID_HOSTS` | Add the header, or the hostname (every one the site answers on) |
| `500 SharedID Edge is misconfigured` | An invalid setting; one bad `SID_HOSTS` entry fails every publisher | The platform's log names it; roll back, fix, check before deploying |
| Two `_pubcid` cookies, or the ID changes between page and server | The site's `SID_COOKIE_DOMAIN` isn't the domain Prebid.js writes `_pubcid` on | Fix it in `SID_HOSTS` ([Configure Prebid.js](prebid.md)) |
| Cookies set but gone after 7 days in Safari; `verify-deployment` says the IPs differ | The publisher used a CNAME or a subdomain pointing at your endpoint, not a path on their own CDN | Route `/_sid/*` on the site's own hostname through their CDN |
| Visitors share an ID, or get each other's cookies | The publisher's CDN caches `/_sid/*` | Caching off for `/_sid/*` (the responses are `private` or `no-store`, but some CDNs cache regardless) |
| `ortb2.device.ip` is a CDN address, or `geo` shows a CDN location | The CDN puts its own upstream's or a proxy's address in `X-SID-Client-IP`: shielding (Fastly's later hop), or the publisher's CDN sits behind another CDN | Take the address on the first edge hop, from the outermost CDN ([Security model](#security-model)) |
| The forged-header check shows the forged address or country | The CDN passes or appends the visitor's headers, or reads `X-Forwarded-For` | Use the CDN's connection address, and set (overwrite) the headers |
| Visitors from GDPR countries without a TC string get cookies | No `X-SID-Country` (unknown country means storage is allowed), or the CMP doesn't write `euconsent-v2` | Send the country; check the CMP ([Consent](consent.md)) |
| Visitors from GDPR countries with consent get no cookie | The CMP doesn't ask for **publisher** consent (no publisher segment), in publisher mode | Configure the CMP, or decide on vendor mode (`SID_VENDOR_ID`) |
| Cookies without `Secure` | The site isn't served over HTTPS, or `X-Forwarded-Host` is a local name | Serve the site over HTTPS ([Secure cookies](configuration.md#secure-cookies)) |
| `/_sid/v1` from another of the publisher's origins fails CORS | That origin isn't in the site's `SID_ALLOWED_ORIGINS` | Add it in `SID_HOSTS` |

`X-SharedID-Status` on the response says why a request got no cookie ([Troubleshooting](troubleshooting.md)).

## Security model

Trusted-upstream mode trusts a request's forwarded IP address, country and site only when it carries one of the endpoint's secrets. Without one, the endpoint answers `403` with `Cache-Control: no-store` and no cookies, on every path, `/optout` included, and puts nothing from the request in the body or logs. The secret is compared in time that doesn't depend on where it differs, against every accepted secret.

| Threat | What stops it |
| --- | --- |
| Someone calls your endpoint directly with a made-up country (to skip GDPR), IP address or site | No secret: `403`, no cookies |
| A visitor sends `X-SID-Country`, `X-SID-Client-IP`, `X-Forwarded-Host` or `X-SID-Upstream-Auth` through the publisher's site | The publisher's CDN **sets** each one, overwriting the visitor's, and removes those it can't set. The [forged-header check](#3-verify) proves it per publisher. A CDN that appends instead is the main risk; that's why every recipe uses its CDN's replacing action |
| A visitor fakes their address with `X-Forwarded-For`, `Fastly-Client-IP`, `True-Client-IP` or `Akamai-Client-IP` | The recipes take the connection's own address (`event.viewer.ip`, `client.ip`, `AK_CLIENT_REAL_IP`, `ip.src`, `$remote_addr`, `{socket_ip}`), which no header changes. The endpoint never reads `X-Forwarded-For`: its header names must start with `x-`, differ, and not be `x-forwarded-for` |
| The endpoint trusts its own platform's data, which here describes the publisher's CDN | Ignored in this mode: `CF-Connecting-IP`, `request.cf`, `CloudFront-Viewer-*`, Fastly's client data, the platform's bot verdict |
| A module, or anything it calls, sees the secret | It's removed from the request before modules run |
| A leaked secret | Its holder can only affect its own requests' responses; rotate it ([Secrets](#secrets)) |
| One publisher's CDN sends another's hostname in `X-Forwarded-Host` (secrets aren't tied to hosts) | It gets that site's settings, for its own visitors: browsers on `pub-a.example` reject cookies with `Domain=pub-b.example`. No access to the other site's visitors or cookies |
| The secret is intercepted between the publisher's CDN and you | HTTPS to your endpoint, with the CDN checking your certificate (on in every recipe) |
| A publisher's CDN caches one visitor's response for others | Caching off in every recipe; the endpoint's responses are `private` or `no-store` |
| Request data in logs | SharedID Edge logs nothing about requests; the secrets never appear in errors or logs |

**Authenticated but wrong.** The endpoint trusts whatever an authenticated CDN says. When the publisher's CDN is itself behind another CDN or proxy (a reader on one CDN, a site's own front proxy, then the CDN that forwards to you, say), the forwarding CDN's "client" is the proxy in front of it: it passes on, with a valid secret, that proxy's address and country. IAB Tech Lab's [Trusted Server](https://github.com/IABTechLab/trusted-server), which takes the client IP from a trusted header the same way, warns about the same topology. The fix is on the publisher's side: take the address and country from the **outermost** CDN, the one the browser connects to, and pass them through each hop as trusted headers (each hop checking the previous one, as with nginx's `realip` limited to that CDN's addresses). The forged-header and GDPR-country checks in [Verify](#3-verify) catch it: they show the inner CDN's location rather than yours.

## What's been verified live

The results of each live run are below. [How SharedID Edge is verified](verification.md) has the overall picture: every endpoint and recipe, and whether it's been run live, emulated, simulated, or only written from the CDN's documentation.

- **Tested, not live:** trusted-upstream mode itself, by the conformance suite's `trusted-upstream.json` (a missing, wrong, repeated or rotated secret, a forged country, GDPR from the forwarded country, forwarded IPv4 and IPv6, per-publisher settings and cookie domain by forwarded host, an unlisted or missing host, a host list) on the Cloudflare Worker in `wrangler dev`, the Lambda handler, Fastly Compute in Viceroy and the Node.js server, plus each adapter's unit tests. `forwarded-headers-untrusted.json` checks that, without the mode, forged headers change nothing, on every adapter.
- **Verified live (November 2026), the Cloudflare Worker as the endpoint,** on a hostname of a separate upstream-operator zone, with the project's [upstream-operator live setup](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-cloudflare-for-saas-setups):
  - Without the secret, or with a wrong one, every path answers `403` and sets no cookie, `/optout` included, even with a forged country and site. With a secret, an unlisted `X-Forwarded-Host` or none gets a `404`, and a host list a `400`.
  - With the secret, the forwarded host picks the publisher's settings (two publishers with different cookie domains), the forwarded country decides GDPR (`DE` without a TC string: no cookie), and forwarded IPv4 and IPv6 addresses reach the `ip` module.
  - **The [Cloudflare recipe](#cloudflare-the-publishers-zone-your-endpoint-elsewhere)'s forwarding Worker, as written,** on a publisher hostname of another zone: `/_sid/v1` shows the visitor's real address and region, and forged `X-SID-Client-IP`, `X-SID-Country`, `X-SID-Region`, `X-Forwarded-Host`, `X-SID-Upstream-Auth` and `X-Forwarded-For` change nothing. `verify-deployment` passes (the site's own IP addresses, `Secure` server-set cookies with the publisher's `Domain`, no shared cache), as do the conformance suite's default-configuration cases (26 of 26, with that publisher on default settings) and unmodified Prebid.js in Chromium, Firefox and WebKit (42 of 42).
  - **Now on every merge, nightly and on demand:** the project's [upstream-operator live tests](verification.md#live-tests-upstream-operator) redeploy the endpoint and the Cloudflare recipe's publisher from `main` and repeat these checks (the endpoint's `403`s, the real address and region, forged headers, `verify-deployment`, conformance and the browser tests); the first green run was on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)). The per-publisher, forwarded `DE` and IPv6 checks above were by hand.
  - **The [CloudFront recipe](#amazon-cloudfront), as written,** on a publisher on its own domain with DNS on Route 53, served by CloudFront (the project's [`publisher-cloudfront.yaml`](../packages/adapters/cloudflare/live/publisher-cloudfront.yaml): the recipe's function, origin header, `CachingDisabled` and `AllViewerExceptHostHeader`). `/_sid/v1` shows the visitor's real address and region from CloudFront's viewer headers, and forged `X-SID-Client-IP`, `X-SID-Country`, `X-Forwarded-For`, `X-Forwarded-Host` and `X-SID-Upstream-Auth` change nothing. `verify-deployment` passes (the endpoint on the site's own CloudFront addresses, `Secure` server-set cookies with the publisher's `Domain`, not served from CloudFront's cache), as does unmodified Prebid.js in Chromium, Firefox and WebKit (42 of 42). First by hand (16 November 2026); since 17 November 2026, the same [live tests](verification.md#live-tests-upstream-operator) update its stack and repeat these checks on every merge, nightly and on demand ([first green run](https://github.com/patmmccann/sharedid-edge/actions/runs/44019340421)).
- **Not yet verified live:** the Lambda function and Fastly Compute as endpoints, the other recipes, and GDPR from a visitor in the EU through a publisher's CDN (the runs so far came from the US; the forwarded `DE` above is set by hand). [#150](https://github.com/patmmccann/sharedid-edge/issues/150) tracks them.
- **Model A** is each adapter's own deployment; the Cloudflare Worker's is tested live on every merge ([Live tests](../packages/adapters/cloudflare/README.md#live-tests)).

Verify each publisher before going live ([Verify](#3-verify)), and tell us what you find in [an issue](https://github.com/patmmccann/sharedid-edge/issues).

## FAQ

**Do publishers need to change their DNS?** No. Only a path rule on the CDN they already use, and their Prebid.js configuration.

**Can the endpoint serve publishers on Cloudflare too?** Yes, with the forwarding Worker or Transform Rules in [the Cloudflare recipe](#cloudflare-the-publishers-zone-your-endpoint-elsewhere). Running it in their account (model A) is usually simpler there.

**Can we mix models?** Yes: model A for some publishers, model B for the rest. They don't interact; a model A deployment is just a normal SharedID Edge deployment on the publisher's platform.

**We also host some publishers' sites.** Your hosted sites don't need a second host: see [SharedID Edge for hosting companies](hosting-companies.md). Run them on a separate deployment, since an endpoint in trusted-upstream mode refuses every request without a secret.

**Why one secret per publisher, rather than one per host?** The array is the endpoint's, not the site's: secrets can't live in `SID_HOSTS`, a plain setting. One per publisher gives you revocation per publisher; binding them to hosts would add a second map for little gain ([Security model](#security-model)).

**Why does the endpoint need the country at all?** Without a TC string, GDPR applies when the visitor is in the EU, the rest of the EEA, the UK or Turkey, and only the publisher's CDN knows where the visitor is. Your endpoint's platform sees the CDN's edge.

**Can the IP address be left out?** Yes: leave `SID_CLIENT_IP_HEADER` unset, and the endpoint has no client IP (the `ip` module and IP-based vendor modules return nothing). Consent doesn't need it; it needs the country.

**What does it cost a publisher?** Their CDN's per-request charge on `/_sid/*`, and a CloudFront Function's on CloudFront. The compute is yours.

**Can we use Workers for Platforms for this?** It helps you manage many Workers in your account, but they'd still have to be reached on each publisher's hostname, which is the same forwarding as model B, or model A in the publisher's account. One endpoint is simpler.
