# Abuse protection and cost control

Every `/_sid/*` request runs SharedID Edge, and most platforms bill per request: a Worker request on Cloudflare, an invocation on Lambda, a request on Fastly, Vercel or Azure. A bot that hammers `/_sid/sync` or `/_sid/v1` runs up that bill, and each request without cookies mints a new SharedID (which stores nothing anywhere, so it costs the request and nothing more). This page covers what SharedID Edge does about it itself, the rule to add on each platform, and how to keep an eye on the cost. It matters most for an endpoint that serves many sites: a [hosting company's](hosting-companies.md) or an [upstream operator's](upstream-operators.md).

## Contents

- [What SharedID Edge does itself](#what-sharedid-edge-does-itself)
- [What a rule should look like](#what-a-rule-should-look-like)
- [Per platform](#per-platform)
  - [Cloudflare](#cloudflare)
  - [AWS (CloudFront and Lambda)](#aws-cloudfront-and-lambda)
  - [Fastly](#fastly)
  - [Akamai](#akamai)
  - [Azure Front Door](#azure-front-door)
  - [Google Cloud](#google-cloud)
  - [Vercel](#vercel)
  - [Node.js behind nginx](#nodejs-behind-nginx)
- [Upstream operators](#upstream-operators)
- [Cost control](#cost-control)

## What SharedID Edge does itself

SharedID Edge keeps no state between requests, so it can't count them: counting needs storage, and per-instance counters on an edge platform see only a sliver of the traffic. What it does is make each request it doesn't want as cheap as possible, and never cacheable by anyone else ([Request limits](../spec/SPEC.md#request-limits) in the specification):

| Request | Response | Before |
| --- | --- | --- |
| A path outside `SID_BASE_PATH`, or an unknown route under it | `404` | Anything else is read. The worker answers only its own routes and never forwards a request to the origin. |
| A method other than `GET` and `HEAD` (and `OPTIONS` on `/v1`) | `405` | Its body is read: no route reads a body, and the adapters never copy one. |
| `/sync` or `/v1` with a path and query over 8192 bytes | `414` | Consent is read, an ID chosen or a module run. Prebid.js's requests are a few hundred bytes. |
| `/sync` or `/v1` with a `Cookie` header over 16384 bytes | `431` | The same. |
| In [trusted-upstream mode](configuration.md#trusted-upstream-behind-a-publishers-cdn), a request without one of the secrets | `403` | Anything is parsed but the auth header. |
| Refused by an opt-in [rate limiting binding](../packages/adapters/cloudflare/README.md#rate-limiting) (the Cloudflare Worker) | `429` | The same as the `414`. |

Each has `Cache-Control: no-store` and a plain-text body or none, sets no cookies and repeats nothing from the request. `/_sid/optout` and `/_sid/optin` are never refused for size or rate, so opting out always works. Other things that already keep the volume down: a successful sync is cached in the browser for `SID_SYNC_CACHE_SECONDS` (a day), `SID_SKIP_BOTS` sets no ID for bots, and each module has a time limit (`SID_MODULE_TIMEOUT_MS`). See [Request volume](hosting-companies.md#request-volume) for how often real browsers call each route.

**A CDN or proxy in front may answer first,** with its own limits and its own response, which may not carry `no-store`. CloudFront, for one, answers a URL over 8 KB with its own `414` (on every route, opt-out included) and the 16 KB `Cookie` header in the conformance suite with a `400`, before the function runs; nginx refuses a header line over 8 KB by default. Prebid.js's requests are far below all of these, and a request the CDN refuses never reaches the worker, so it costs no invocation.

These checks run inside the worker, so a refused request is still a request you pay for. Only a rule in front of it, on the CDN or WAF, stops the request before it's billed. That's the rest of this page.

## What a rule should look like

- **Scope it to `/_sid/*`,** so it never touches the site's own pages. Where the same platform serves the site, keep the site's own rules as they are.
- **Key it by client IP,** and generously: a corporate network, a mobile carrier's NAT or a school shares one address among thousands of visitors. A browser makes a handful of `/_sid/*` requests per page view at most (the sync, `/v1` if the page fetches it), so start around **300 requests per 10 seconds per IP** (or 1,800 a minute), watch what gets caught, then lower it. Where the platform can key by a fingerprint such as JA4 as well, it separates visitors behind one address.
- **Block, don't challenge.** `/_sid/sync` is an image and `/_sid/v1` a `fetch`: no browser can solve a CAPTCHA or JavaScript challenge there, so a challenge is a block that also costs a challenge page. Answer with a `429` where the platform lets you choose.
- **Don't exempt anything by `User-Agent`** (anyone can send any `User-Agent`). Your own monitoring (`verify-deployment` on a schedule) makes a few requests a run, far below any sensible limit.
- **Check it with your traffic first:** most platforms have a log-only or count mode. Use it for a day, then turn on blocking.

## Per platform

### Cloudflare

- **A WAF rate limiting rule** (Security, WAF, Rate limiting rules), on the zone that serves `/_sid/*`: expression `starts_with(http.request.uri.path, "/_sid/")` (or URI Path starts with `/_sid/` in the builder), counting by IP, action Block with a `429`. Requests a rule blocks never reach the Worker, so they aren't Worker requests. Every plan has rate limiting rules; Free and Pro count by IP over a short period, Business adds longer ones, and Enterprise's Advanced Rate Limiting can count by JA4 fingerprint or by a header (useful for [upstream operators](#upstream-operators)). See [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).
- **The Worker's rate limiting bindings** (opt-in): `SID_RATE_LIMIT_CLIENT` counts per client IP, `SID_RATE_LIMIT_HOST` per site, inside the Worker. They still bill a Worker request, but a refused one runs no module and mints no ID, and they work where a WAF rule can't: in trusted-upstream mode, on the visitor's forwarded IP and the publisher's hostname. See the Worker's [Rate limiting](../packages/adapters/cloudflare/README.md#rate-limiting).
- **Bots:** Bot Fight Mode and Super Bot Fight Mode challenge some requests, which breaks the pixel for them (a crawler's, usually: no loss). If they catch real visitors on `/_sid/*`, skip Super Bot Fight Mode there with a WAF custom rule (Pro and up; Bot Fight Mode on Free can't be skipped per path). With Bot Management (Enterprise), `SID_SKIP_BOTS_SCORE` sets no ID for low scores rather than blocking.
- **On Workers Free**, the daily request limit is a hard cost cap. Set the route's request limit failure mode to **fail closed**, so that past the limit `/_sid/*` gets an error rather than going to the origin.

### AWS (CloudFront and Lambda)

- **An AWS WAF rate-based rule** in the web ACL of the CloudFront distribution: aggregate on IP, with a scope-down statement for URI path starts with `/_sid/`, and an evaluation window of 1 minute; start at the per-IP limit above (1,800 per minute) and Count before you Block. Give it a custom `429` response. AWS WAF bills per web ACL, per rule and per million requests inspected; see [Rate-based rules](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html).
- **Reserved concurrency on the function** caps how many requests run at once, and so the Lambda bill: past it, requests are throttled. Size it from your peak (requests per second times the function's duration, about 20 ms, with room to spare): it's a ceiling on cost, not a rate limit, and it's shared by every site on the function.
- **AWS Budgets** alerts on the account's spend, and CloudWatch alarms on the function's invocations and throttles.
- **On Lambda@Edge**, the same AWS WAF rule on the distribution applies before the function runs. The function's replicas run in many regions, each within that region's Lambda concurrency, so reserved concurrency isn't a single cap there: rely on the WAF rule and AWS Budgets.

### Fastly

- **Edge Rate Limiting** (an add-on): in VCL, a `ratecounter` and `penaltybox` checked with `ratelimit.check_rate()` in `vcl_recv` for `req.url.path ~ "^/_sid/"`, keyed by `client.ip`; on Compute, the same from the JavaScript SDK (`fastly:edge-rate-limiter`). Counts are per POP. See [Edge Rate Limiting](https://docs.fastly.com/products/edge-rate-limiting).
- **Fastly Next-Gen WAF** rate limit rules, where you have it.

### Akamai

- **Rate controls** in App & API Protector's security configuration: a rate policy matching the path `/_sid/*`, per client IP, with average and burst thresholds, action Deny. Run it in Alert first.
- **Bot Manager** (where you have it): don't let it serve a challenge on `/_sid/*`; use Deny or Monitor there.

### Azure Front Door

- **A WAF policy custom rule of type rate limit** on the Front Door profile: match condition RequestUri begins with `/_sid/`, group by client address (socket address), duration 1 minute, action Block. See [Rate limiting for Azure Front Door](https://learn.microsoft.com/azure/web-application-firewall/afds/waf-front-door-rate-limit).
- **The function app's scale-out limit** caps instances, and so cost. **Cost Management budgets** alert on spend.

### Google Cloud

- **A Cloud Armor rate-based rule** on the load balancer's backend service: `request.path.startsWith('/_sid/')`, throttle or rate-based ban, enforced on IP, exceeding action `deny(429)`. Preview mode first. See [Rate limiting overview](https://cloud.google.com/armor/docs/rate-limiting-overview).
- **The function's maximum instances** caps cost. **Billing budgets** alert on spend.

### Vercel

- **A Vercel Firewall custom rule** with the Rate Limit action: path starts with `/_sid/`, keyed by IP (or JA4), action `429`. See [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
- **Spend Management** sets alerts and a cap on usage-based spend.

### Node.js behind nginx

```nginx
# One counter per client address, 10 MB of state (about 160,000 addresses).
limit_req_zone $binary_remote_addr zone=sid:10m rate=30r/s;

location /_sid/ {
    limit_req zone=sid burst=100 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:8787;
    access_log off;
}
```

Behind a CDN, `$binary_remote_addr` is the CDN's address: set the visitor's with the [real IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) from the CDN's own header, or limit on the CDN instead. nginx's default header limits (`large_client_header_buffers`, 8 KB a header line) are lower than SharedID Edge's own. HAProxy does the same with a stick table and `http-request deny deny_status 429 if { sc_http_req_rate(0) gt 300 }`.

## Upstream operators

An [upstream operator's endpoint](upstream-operators.md#model-b-the-publishers-cdn-forwards-to-your-endpoint) sees each publisher's CDN, not the visitor: the connecting address is the CDN's edge, carrying many visitors. So limits come in three places:

- **Direct floods, at your endpoint:** a rule keyed by the connecting IP stops someone calling the endpoint directly (who gets `403`s without a secret, but still costs requests). Keep it generous, well above what one CDN edge sends you for your busiest publisher, or it throttles that publisher.
- **Per visitor, on the publisher's CDN** (its WAF, the recipes above), where the visitor's address is known; or at your endpoint on a Cloudflare Worker with `SID_RATE_LIMIT_CLIENT`, which counts the forwarded client IP of authenticated requests (`SID_CLIENT_IP_HEADER`). A WAF rule at your endpoint that counts the forwarded header would trust it before the secret is checked, so only do that with Enterprise rules that also require the secret header.
- **Per publisher, so one publisher's flood can't crowd out the others:** `SID_RATE_LIMIT_HOST` on a Cloudflare Worker counts per forwarded hostname. On AWS, a rate-based rule with a custom aggregation key on the forwarded host header does the same, and matters more there: reserved concurrency is shared, so without it one publisher's flood throttles every publisher's requests. Set each limit from that publisher's peak, with room for growth.

## Cost control

- **Estimate first:** [Request volume](hosting-companies.md#request-volume) has how often each route is called, and the upstream-operator guide's [Cost](upstream-operators.md#cost) a worked estimate per platform. Most of the volume is page views of visitors whose storage is denied (their syncs aren't cached), `/_sid/v1` on every page if your pages fetch it, and the `clickid` module on `/sync`.
- **Alert on spend:** Cloudflare's billing notifications on Workers usage, AWS Budgets, Azure Cost Management budgets, Google Cloud billing budgets, Vercel Spend Management. Alert on request counts too (the platform's metrics), which move before the bill does.
- **Cap it:** reserved concurrency on Lambda, the scale-out limit on Azure, maximum instances on Google Cloud, a spend cap on Vercel. A cap fails requests past it, so set it well above your peak.
- **Lower the cost per request:** keep `SID_SYNC_CACHE_SECONDS` at its default, run only the modules you use (`SID_MODULES`, `SID_SYNC_MODULES`), and set `SID_SKIP_BOTS` to set no ID for bots.
- **Privacy:** none of this logs anything about requests in SharedID Edge. A platform's WAF and rate limiting keep their own counters and security event logs, keyed by IP address; those are the platform's, under your agreement with it, so include them in what you disclose.
