# SharedID Edge for hosting companies

This guide is for a company that serves many publishers' sites from its own platform: a managed WordPress or news-site host on [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/), a platform built on Workers for Platforms, or a host with its own CDN account (CloudFront, Fastly, Akamai, Vercel, your own nginx). You already answer on each publisher's hostname, so you can run SharedID Edge for every hosted site, with nothing for the publisher to change but their Prebid.js configuration.

If you sell the sites' ad inventory but don't host them, read [SharedID Edge for sales houses](sales-houses.md) instead. If you do both, host some publishers and sell for others on their own CDNs, you'll use both guides: this one for the sites you serve, that one for the rest. One deployment can be both (see [FAQ](#faq)).

## Contents

- [Why it has to be the site's own hostname](#why-it-has-to-be-the-sites-own-hostname)
- [Choosing a deployment](#choosing-a-deployment)
- [One deployment for many sites](#one-deployment-for-many-sites)
- [Per-publisher settings and consent](#per-publisher-settings-and-consent)
- [Onboarding a publisher](#onboarding-a-publisher)
- [Verifying](#verifying)
- [Operations](#operations)
- [What's been verified live](#whats-been-verified-live)
- [FAQ](#faq)

## Why it has to be the site's own hostname

SharedID Edge sets the Prebid.js SharedID cookie (`_pubcid`) from the server, so Safari and other browsers keep it for up to 400 days instead of the 7 days they allow cookies written by script. Safari grants that only to a **first-party server-set cookie**:

- **Same hostname family:** the response must come from the site's own domain (`www.publisher.example/_sid/sync`), not yours. A third-party domain's cookies aren't the site's at all.
- **Same IP addresses:** since Safari 16.4, a cookie set by a server whose IP address doesn't match the site's is capped at 7 days. So a CNAME from `sid.publisher.example` to a server of yours doesn't work either (Safari's CNAME-cloaking defence caps those too).

A hosting company is in the best position to meet both: the `/_sid/*` path on the publisher's hostname, answered by the same edge that serves the pages. That's a route, a behaviour or a rule on the platform you already run, not a new hostname. `verify-deployment` checks both conditions ([Verifying](#verifying)).

## Choosing a deployment

| You serve sites with | Deploy | Per-site settings | Sees the site's hostname? | Notes |
| --- | --- | --- | --- | --- |
| **Cloudflare for SaaS** (custom hostnames on your zone) | One Worker on your SaaS zone's `*/_sid/*` route | Custom hostname metadata (no redeploy per site) or `SID_HOSTS` | Yes | **Recommended.** [Cloudflare: Hosting companies](../packages/adapters/cloudflare/README.md#hosting-companies) |
| **Cloudflare for SaaS + Workers for Platforms** | One Worker per publisher in a **trusted** dispatch namespace, picked by a dispatch Worker | Each Worker's own `vars` | Yes | Per-publisher isolation and versions; a paid add-on; more to deploy. Same section. |
| Cloudflare, with publishers on their own zones | A Worker in each publisher's account | Each Worker's `vars` | Yes | That's the sales-house model A: [Sales houses](sales-houses.md#model-a-it-runs-on-the-publishers-own-cdn) |
| **Amazon CloudFront** (one distribution with many alternate domain names) | The Lambda function as a `/_sid/*` behaviour | `SID_HOSTS` (Lambda's 4 KB environment limit applies) | Only if a CloudFront Function sets `X-Forwarded-Host` from `Host` ([below](#amazon-cloudfront-and-lambda)) | [AWS Lambda](../packages/adapters/aws-lambda/README.md) |
| **Fastly** (one service, many domains) | The Compute service, by Request Routing | `SID_HOSTS` in the config store (8,000 characters a value) | Yes, with Request Routing (not yet confirmed on a live service) | [Fastly](../packages/adapters/fastly/README.md#routing) |
| **Akamai** (one property, many hostnames) | The EdgeWorker on a `/_sid/*` rule | `PMUSER_SID_HOSTS`, or a child rule per hostname | Yes | [Akamai: per site](../packages/adapters/akamai/README.md#the-property-rule) |
| **Vercel** (a multi-tenant project with many domains) | The route handler or middleware | `SID_HOSTS` | Yes | [Vercel](../packages/adapters/vercel/README.md) |
| **Google Cloud** (an external Application Load Balancer) | The Cloud Run function, by a URL map path rule | `SID_HOSTS` | The `Host` the load balancer passes; check per hostname | [Google Cloud](../packages/adapters/gcp-functions/README.md) |
| **Azure Front Door** | The function app, by a Front Door route | One function app per site | No: the function sees its own `*.azurewebsites.net` host | [Azure](../packages/adapters/azure-functions/README.md); see [FAQ](#faq) |
| **Your own nginx, HAProxy or ingress** | The Node.js server behind it | `SID_HOSTS` | Yes, from the `Host` your proxy passes | [Node.js](../packages/adapters/node/README.md#deploy-behind-your-proxy) |

How to choose:

- **On Cloudflare for SaaS, use one shared Worker with custom hostname metadata.** Adding a site is an API call on the custom hostname you create anyway. Use `SID_HOSTS` in the Worker's `vars` instead until your Cloudflare account team enables metadata, or if you have few sites. Use Workers for Platforms if you already run it, or need per-publisher versions, modules or rollouts.
- **Not a Cloudflare Snippet:** Snippets are per zone and limited in number, their configuration is fixed at build time, they can't read custom hostname metadata, and whether snippet rules run for SaaS custom hostnames is untested ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)).
- **Elsewhere,** put SharedID Edge on the platform that serves the pages, with `SID_HOSTS`. Where that platform's configuration is too small for your list of sites (the table in [How many sites fit](#how-many-sites-fit)), split the sites over several deployments, by hostname.
- **Never** a deployment on a hostname of your own that the publisher CNAMEs to, or a `workers.dev`, `cloudfront.net` or `vercel.app` URL: those aren't the site's hostname and IP addresses.

## One deployment for many sites

`SID_HOSTS` gives each site the settings that differ, on top of the deployment's own ([Several sites from one deployment](configuration.md#several-sites-from-one-deployment)):

```json
{
  "www.pub-a.example": { "SID_COOKIE_DOMAIN": "pub-a.example" },
  "pub-a.example": { "SID_COOKIE_DOMAIN": "pub-a.example" },
  "www.pub-b.example": { "SID_COOKIE_DOMAIN": "pub-b.example", "SID_MODULES": "geo" }
}
```

The essentials:

- **The request's hostname picks the site,** lower-cased, without the port. List every hostname a site answers on (`www.` and the bare domain).
- **A hostname that isn't listed gets a 404 and no cookies,** as if SharedID Edge weren't there. So the deployment can sit on a wildcard route (`*/_sid/*`) for all your hosted sites, and only those you've onboarded get SharedID Edge. `"SID_HOSTS": "{}"` gives that with no sites listed, for a Cloudflare deployment whose sites all come from custom hostname metadata.
- **Validated at start-up:** a mistake in one site's settings fails the whole deployment (every site gets a 500), naming the hostname. Check a change before deploying it ([Deploying changes](#deploying-changes)). Custom hostname metadata is the exception: invalid metadata fails only that site's requests.
- **What can't vary per site:** `SID_BASE_PATH`, `SID_MODULE_SECRETS` (the `ec` passphrase, say) and the modules built into the deployment. `SID_MODULES` per site chooses among those built in.
- **The deployment must see the site's hostname.** The Cloudflare Worker, Vercel, Akamai, Fastly with Request Routing and the Node.js server behind a proxy that passes `Host` do. Check any other with a request to `/_sid/v1` on each hostname: a 404 means the deployment sees another host.

### Cloudflare for SaaS custom hostname metadata

With metadata (enabled by your Cloudflare account team, on subdomain-style custom hostnames), each site's settings live on its custom hostname under a `sharedid` key, and the Worker's `vars` have `"SID_HOSTS": "{}"`:

```sh
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/custom_hostnames/$HOSTNAME_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"custom_metadata": {"sharedid": {"SID_COOKIE_DOMAIN": "pub-a.example"}}}'
```

It reaches the Worker within about 30 seconds. An entry in `SID_HOSTS` takes precedence over a hostname's metadata. Workers for Platforms, the dispatch Worker, and why the dispatch namespace must be trusted (or the Worker gets no `request.cf`, and so no visitor country for GDPR) are in the Cloudflare adapter's [Hosting companies](../packages/adapters/cloudflare/README.md#hosting-companies) section, with every command.

**If a publisher's own zone is on Cloudflare too** (their proxied hostname is a CNAME to yours, "orange-to-orange"), their zone handles the request first: a `/_sid/*` route of theirs answers instead of yours. Agree with them who runs it.

#### Orange-to-orange with a Worker on one side and a Snippet on the other

A tempting split is the publisher keeping their own Worker for their site while your zone answers `/_sid/*` with a Snippet, which costs nothing extra on a paid plan. Treat it with scepticism:

- **Only one side can answer `/_sid/*`.** SharedID Edge answers its routes itself and never forwards them, so if the publisher's Worker covers `/_sid/*` (a `*/*` route, say), your zone never sees those requests. The split only works if the publisher's routes leave `/_sid/*` alone.
- **Whether a Snippet runs for custom-hostname traffic at all is untested.** Cloudflare's Snippets documentation doesn't cover Cloudflare for SaaS custom hostnames, let alone traffic that has already passed through the publisher's zone. Until it's been checked on a live zone ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)), don't plan on it.
- **A Snippet can't read custom hostname metadata,** so every site has to be in `SID_HOSTS` in the Snippet's 32 KB. That caps it at a few hundred sites before any code, so a large host is back to a Worker anyway ([How many sites fit](#how-many-sites-fit)).
- **Two accounts' rules, caching and firewall settings apply** to the same request, which is harder to reason about and to debug, and a Snippet has no logs or versions to help.
- **The visitor's location:** in orange-to-orange your zone should see the visitor, not the publisher's zone, in `request.cf`. That's what GDPR by country needs, but it hasn't been verified live either ([#135](https://github.com/patmmccann/sharedid-edge/issues/135)).

If the publisher wants to keep their own Worker, the simplest arrangement is a Worker on your side too, or SharedID Edge running in the publisher's zone ([Model A in the sales-house guide](sales-houses.md#model-a-it-runs-on-the-publishers-own-cdn)). Orange-to-orange is best avoided where the publisher's DNS can simply point at you without being proxied.

### Amazon CloudFront and Lambda

Behind CloudFront, the function is called on its function URL's hostname, signed with origin access control, so it can't see the visitor's `Host`. It takes the site from `X-Forwarded-Host`, which CloudFront doesn't add itself, and which the `AllViewerExceptHostHeader` policy passes on as the visitor sent it. So with `SID_HOSTS`, associate a CloudFront Function with the `/_sid/*` behaviour, on viewer request, that **sets** it from the `Host` the visitor connected to:

```js
function handler(event) {
  var request = event.request;
  request.headers['x-forwarded-host'] = { value: request.headers.host.value };
  return request;
}
```

The rest of the behaviour is as in [Add the behaviour to an existing distribution](../packages/adapters/aws-lambda/README.md#add-the-behaviour-to-an-existing-distribution). This follows CloudFront's documentation and hasn't been run on a live distribution yet. Check each hostname with `/_sid/v1` (a 404 means `X-Forwarded-Host` is missing or not listed) and `verify-deployment`.

### How many sites fit

`SID_HOSTS` is one setting, so its size is limited by where the platform keeps settings. An entry like `"www.pub-a.example":{"SID_COOKIE_DOMAIN":"pub-a.example"},` is about 55 characters; two hostnames per site make about 110.

| Platform | Limit | About how many sites (two hostnames each) |
| --- | --- | --- |
| Cloudflare Worker | Each variable's size ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); custom hostname metadata has no shared limit | Use metadata beyond a few dozen |
| AWS Lambda | 4 KB for all of a function's environment variables together ([Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)) | 30 |
| Fastly Compute | 8,000 characters per config store value | 70 |
| Akamai EdgeWorkers | 1,024 characters for all `PMUSER_` variables (4,000 on some tiers) | Use a child rule per hostname instead |
| Vercel, Google Cloud, the Node.js server | Large (tens of kilobytes, or none) | Hundreds |

These are estimates from the platforms' published limits. Past them, split the sites over several deployments (by hostname, each with its own route or rule), or on Akamai use child rules that set `PMUSER_SID_COOKIE_DOMAIN` per hostname ([The property rule](../packages/adapters/akamai/README.md#the-property-rule)).

## Per-publisher settings and consent

Each site needs, at least:

- **`SID_COOKIE_DOMAIN`:** the domain Prebid.js writes `_pubcid` on, normally the registrable domain (`pub-a.example` for `www.pub-a.example`). Get it wrong and the browser ends up with two `_pubcid` cookies ([Configure Prebid.js](prebid.md)). `host-only` for a site whose Prebid.js writes host-only cookies.

and may set any other core setting: `SID_MODULES` (among those built in), `SID_MODULE_CONFIG`, `SID_ALLOWED_ORIGINS` (if another of the publisher's origins reads `/_sid/v1` from script), `SID_VENDOR_ID`, `SID_SKIP_BOTS`, `SID_SYNC_CACHE_SECONDS`. The [Configuration reference](configuration.md) lists them.

**Consent** is decided per request, the same on every site, and needs no per-site work beyond the publisher's CMP ([Consent and opt-out](consent.md)):

- **Opt-out, Global Privacy Control (`Sec-GPC: 1`) and COPPA** always delete the ID cookies and set none.
- **TCF:** with a TC string, the publisher's own consent (the TC string's publisher segment) decides, by default. The publisher's CMP must ask for publisher consent for Purpose 1 and one of Purposes 2 to 10, and store the TC string in the `euconsent-v2` cookie, which is all the sync route sees. Set `SID_VENDOR_ID` for a site only if its SharedID is collected under a TCF vendor's consent instead.
- **GDPR without a TC string** follows the visitor's country, from your platform's own location data (Cloudflare's `request.cf`, CloudFront's viewer country, and so on). That's why a Workers for Platforms namespace must be trusted, and why a deployment must not read location from headers a visitor can send.
- **The publisher's privacy page** links to `https://www.pub-a.example/_sid/optout` (and `/_sid/optin`), on their own hostname.

Who does what: you run the deployment and keep it on the site's hostname; the publisher runs the CMP, the privacy disclosures and the Prebid.js configuration. Agree in your terms that SharedID Edge sets a first-party ID cookie on their domain, and what for.

## Onboarding a publisher

1. **Collect:** every hostname the site answers on, the domain Prebid.js writes `_pubcid` on (check the cookie's Domain in the browser's developer tools on a page with Prebid.js), whether they use a CMP with TCF, and which modules they want (`ip`, `geo`, `ua` and the rest: [Modules](modules.md)).
2. **Add the site's settings:**
   - Cloudflare with metadata: `PATCH` the custom hostname's `custom_metadata` with `{"sharedid": {"SID_COOKIE_DOMAIN": "…"}}` ([above](#cloudflare-for-saas-custom-hostname-metadata)); no deploy.
   - Workers for Platforms: deploy a Worker for them into the namespace, and map their hostname to it ([Cloudflare](../packages/adapters/cloudflare/README.md#hosting-companies)).
   - Everywhere else: add their hostnames to `SID_HOSTS`, check the change ([Deploying changes](#deploying-changes)) and deploy.
3. **Make sure `/_sid/*` reaches the deployment** on their hostnames: a wildcard route or behaviour already covers new sites on most platforms; add a route, domain or Request Routing rule where it doesn't.
4. **Verify** from outside: `npm run verify-deployment -- --site https://www.pub-a.example` ([Verifying](#verifying)).
5. **Turn it on in Prebid.js** on the publisher's pages, or have them do it: `sharedIdSystem` with `pixelUrl: '/_sid/sync'` and `extend: true`, and cookie storage named `_pubcid` ([Configure Prebid.js](prebid.md)). Until then, nothing changes on their pages.
6. **Tell the publisher** the opt-out URL, the debugging headers ([Troubleshooting](troubleshooting.md)) and what the `/_sid/v1` modules return, if they use them.

**Offboarding:** remove the site's metadata, `SID_HOSTS` entries or Worker, and deploy. Its `/_sid/*` then gets a 404 and no cookies. Existing `_pubcid` cookies stay in browsers and keep working with Prebid.js on its own; ask the publisher to remove `pixelUrl`, or each page view makes a request that only gets a 404.

## Verifying

From a checkout of this repository (`npm ci` once):

```sh
npm run verify-deployment -- --site https://www.pub-a.example
```

It checks, from outside, that `/_sid/*` answers from the same IP addresses as the site, that `/_sid/sync` sets `_pubcid` (`Secure`, `SameSite=Lax`, a long lifetime, readable by script) and the `HttpOnly` recovery copy, that nothing came from a shared cache, and that `/_sid/v1` returns its JSON. Then, by hand:

- **The right site's settings:** `curl -sI 'https://www.pub-a.example/_sid/sync?id=pubcid:test-id'` shows `Domain=pub-a.example` on the cookies.
- **An unlisted hostname gets nothing:** `/_sid/v1` on a hosted site you haven't onboarded returns 404.
- **The visitor's location reaches it** (it decides GDPR): with the `geo` module on, `/_sid/v1` shows your own country in `ortb2.device.geo`; from a location where GDPR applies (the EU, the rest of the EEA, the UK or Turkey; a VPN will do) without a TC string, `/_sid/sync` sets no cookie and `X-SharedID-Status` says why.

Run `verify-deployment` for every site after onboarding, and for a sample after each update.

## Operations

### Updating SharedID Edge

Releases are this repository's tags; read the changes before updating, especially anything about settings. Rebuild and redeploy the one shared deployment. With Workers for Platforms, redeploy each publisher's Worker into the namespace, with a script over your list of publishers, a few first. Then run `verify-deployment` on a sample of sites.

### Deploying changes

Because one invalid site fails the deployment, check every `SID_HOSTS` change before it goes out. Two quick ways:

- Run the Node.js server locally with the same settings: after `npm run build`, `SID_HOSTS="$(cat sid-hosts.json)" node packages/adapters/node/dist/cli.js` refuses to start if anything is wrong, naming the hostname and the setting (`Configuration error: SID_HOSTS["www.pub-b.example"]: …`).
- Or deploy to a staging environment first (a Wrangler environment, a second stack or service) and request `/_sid/v1` there.

Keep `SID_HOSTS` in version control, generated from your list of sites, so a change is reviewable and a rollback is a revert.

### Monitoring

SharedID Edge logs nothing about requests. What you have:

- **The platform's metrics:** request counts and status codes for the Worker, function or service. A burst of 500s is a configuration error (the platform's log names the setting and, for `SID_HOSTS`, the hostname); 404s on `/_sid/*` are unlisted hostnames, or routes that don't match.
- **The debugging headers** on every response: `X-SharedID-Source` (where the ID came from) and `X-SharedID-Status` (why no cookie was set), for support requests ([Troubleshooting](troubleshooting.md)).
- **`verify-deployment` on a schedule** against a few sites, as the project's own live tests do.

### Cost and abuse

Each `/_sid/*` request is one invocation. With Prebid.js, a browser calls `/_sid/sync` at most about once a day (the response is cached privately for `SID_SYNC_CACHE_SECONDS`), plus `/_sid/v1` on each page view if your pages fetch the modules' output. So requests are at most about page views plus daily visitors. The platforms' pricing pages give the cost per million requests ([Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/), [AWS Lambda](https://aws.amazon.com/lambda/pricing/), [Fastly](https://www.fastly.com/pricing), [Vercel](https://vercel.com/pricing)); the [sales-house guide](sales-houses.md#cost) has a worked estimate.

Rate limiting belongs to the platform, not SharedID Edge (which keeps no state): a WAF rate-limiting rule on `/_sid/*` on Cloudflare, an AWS WAF rate-based rule on the CloudFront behaviour and reserved concurrency on the function, `limit_req` in nginx. Leave room for real traffic: every page view of a busy site may call `/_sid/v1`. [#29](https://github.com/patmmccann/sharedid-edge/issues/29) tracks guidance and controls for this.

## What's been verified live

- **Verified:** the Cloudflare Worker on an ordinary route, by the project's [live tests](../packages/adapters/cloudflare/README.md#live-tests) on every merge (`verify-deployment`, the conformance suite and unmodified Prebid.js in three browsers).
- **Tested locally, not yet live:** `SID_HOSTS` and custom hostname metadata (unit tests, the Worker in workerd, and the conformance suite on every adapter), and every adapter against local stand-ins for its platform.
- **Not yet verified live:** a Worker route on a Cloudflare for SaaS zone matching custom-hostname traffic, `request.cf` there, Workers for Platforms with a trusted namespace, custom hostname metadata reaching the Worker, and orange-to-orange. They need a second domain; [#135](https://github.com/patmmccann/sharedid-edge/issues/135) has the test plan ([#110](https://github.com/patmmccann/sharedid-edge/issues/110) the background). Snippets on SaaS zones: [#105](https://github.com/patmmccann/sharedid-edge/issues/105). The CloudFront Function above and Fastly's Request Routing follow those platforms' documentation.

Run `verify-deployment` on your first sites before rolling out widely, and tell us what you find in [#135](https://github.com/patmmccann/sharedid-edge/issues/135).

## FAQ

**Do publishers need to change anything?** Only their Prebid.js configuration (`pixelUrl: '/_sid/sync'`), and their privacy page's opt-out link. Their DNS and site stay as they are.

**Can we serve it from our own domain, to keep it simple?** No: the cookie must come from the publisher's hostname and IP addresses ([why](#why-it-has-to-be-the-sites-own-hostname)). Safari would cap it at 7 days, the problem SharedID Edge exists to solve.

**We host some publishers and sell ads for others on their own CDNs.** Use this guide for the sites you host and the [sales-house guide](sales-houses.md) for the rest. One Cloudflare Worker, AWS Lambda function, Fastly service or Node.js server can't do both at once, though: with trusted-upstream mode on, every request must carry the upstream secret, including those from your own SaaS zone. Run two deployments: one on your SaaS zone's route for hosted sites, and one on a hostname of its own, in trusted-upstream mode, for the sales-house endpoint.

**Do we need a TCF vendor ID?** Not usually. SharedID is the publisher's first-party ID, so the default publisher mode reads the publisher's own consent. See [Consent and opt-out](consent.md).

**Azure Front Door: why one function app per site?** Behind Front Door, the function app sees its own `*.azurewebsites.net` hostname, not the site's, so `SID_HOSTS` can't tell the sites apart; the adapter doesn't read Front Door's `X-Forwarded-Host`. Give each site its own function app and route, or run the Node.js server behind Front Door instead.

**Does it work with the WordPress or Drupal plugin our sites use?** SharedID Edge replaces the plugins' server-set cookie; see [Migrate from the WordPress or Drupal plugin](migrating.md).

**What about IP-derived IDs?** None by default. Vendor modules such as `ec` derive one from the client IP, are opt-in at build time, and are disclosed in their READMEs ([Modules](modules.md)). If you build one in, decide per site with `SID_MODULES`.
