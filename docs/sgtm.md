# Using SharedID Edge with server-side GTM

Many publishers run a server-side Google Tag Manager container (sGTM) as well: Google's tagging server, on their own domain, receiving GA4 and other events from the page and setting durable cookies for Google Analytics and Google Ads. SharedID Edge and sGTM overlap: both set first-party cookies from a server to get around Safari's cap on cookies written by script, and SharedID Edge's [`reflect`](../packages/modules/reflect/README.md) keeper can restore `_ga`, `_gcl_aw` and `_gcl_au` much as sGTM's own cookies replace them. This page is about running them together:

- **sGTM handles Google's identifiers** (the GA4 client ID, ad click IDs), with Google's own building blocks.
- **SharedID Edge handles the publisher's own** (`_pubcid`, and with `reflect`, non-Google cookies such as `uid1`), and gives sGTM the SharedID for tags that send a publisher-provided ID.

Google's documentation is quoted where it says something; where it doesn't, this page says so. Everything here is **documented only** ([How it's verified](verification.md#alongside-server-side-gtm)): check it on your own setup. This project's [sGTM tests](../e2e/sgtm/README.md) check the variable template and what this page says about Google's cookies and consent against Google's tagging server image, once they run.

## Contents

- [Google's building blocks](#googles-building-blocks)
  - [The tagging server image](#the-tagging-server-image)
  - [The GA4 client's server-managed client ID (`FPID`)](#the-ga4-clients-server-managed-client-id-fpid)
  - [The Conversion Linker's server-set cookies (`FPGCLAW` and others)](#the-conversion-linkers-server-set-cookies-fpgclaw-and-others)
- [Where to serve sGTM: beside `/_sid/*`, on your own hostname](#where-to-serve-sgtm-beside-_sid-on-your-own-hostname)
  - [Safari's IP-address rule applies to sGTM too](#safaris-ip-address-rule-applies-to-sgtm-too)
  - [On Cloudflare](#on-cloudflare)
  - [Both in containers, with docker-compose](#both-in-containers-with-docker-compose)
  - [On Google Cloud](#on-google-cloud)
- [The SharedID in sGTM](#the-sharedid-in-sgtm)
  - [Option A: add the SharedID to GA4 events on the page](#option-a-add-the-sharedid-to-ga4-events-on-the-page)
  - [Option B: sGTM reads the cookie](#option-b-sgtm-reads-the-cookie)
- [Google's cookies: the keeper or sGTM, not both](#googles-cookies-the-keeper-or-sgtm-not-both)
- [Consent: keeping Consent Mode and SharedID Edge consistent](#consent-keeping-consent-mode-and-sharedid-edge-consistent)
- [Sources](#sources)

## Google's building blocks

### The tagging server image

Google distributes the tagging server as a container image, **`gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable`**, which runs anywhere a container does (Cloud Run, or your own platform: Google's [manual setup guide](https://developers.google.com/tag-platform/tag-manager/server-side/manual-setup-guide)). Per that guide:

| Variable | What it is |
| --- | --- |
| `CONTAINER_CONFIG` | Required: the server container's configuration string, from **Manually provision tagging server** in your server container in Tag Manager. |
| `RUN_AS_PREVIEW_SERVER` | `true` on the one preview server. Google: "You must deploy exactly 1 preview server. Do not configure autoscaling beyond 1 instance." |
| `PREVIEW_SERVER_URL` | On the tagging servers: the preview server's HTTPS URL. |
| `PORT` | Optional; the examples listen on `8080`. |
| `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT` | Optional, for BigQuery or Firestore outside Google Cloud. |

A running server answers `GET /healthy` with `200`. Google also says the servers "should have at most 1 vCPU", and recommends running several tagging servers behind a load balancer.

### The GA4 client's server-managed client ID (`FPID`)

The server container's **Google Analytics: GA4** client has a **Cookies and Client Identification** setting:

- **Server managed:** in Google's words, "server-side tagging will manage a separate client ID and substitute it for measurements it processes. It also enables several options for how that cookie is written, and an over-time migration option" from existing `_ga` client IDs ([Analytics Help](https://support.google.com/analytics/answer/14847402)). Google adds that all of the stream's measurements must then go through the server container. The cookie is **`FPID`**: Google's [cookie list](https://business.safety.google/adscookies/) has `FPID` as a Google Analytics cookie lasting 2 years. Google's documentation doesn't say it's `HttpOnly`; third-party write-ups (Simo Ahava's [FPID article](https://www.simoahava.com/analytics/fpid-cookie-google-analytics-server-side-tagging/)) describe it as `HttpOnly` and set with `Set-Cookie`. Check yours in the browser's developer tools.
- **JavaScript managed:** the client ID comes from the page's `_ga` cookie, as without sGTM. Google's [server-side tagging course](https://developers.google.com/tag-platform/learn/sst-fundamentals/5-sst-setup-analytics) says it's the only mode that works until the server container runs on your own domain. **Not confirmed:** whether, in this mode, sGTM also re-sets `_ga` from the server (with `Set-Cookie`). Google's documentation doesn't say, and we found no primary source; look for `Set-Cookie: _ga` on your tagging server's responses.

### The Conversion Linker's server-set cookies (`FPGCLAW` and others)

Google's [Google Ads setup for sGTM](https://developers.google.com/tag-platform/tag-manager/server-side/ads-setup) starts with a **Conversion Linker** tag in the server container, usually on the All pages trigger. Google's [cookie list](https://business.safety.google/adscookies/) names the server-side counterparts of the `_gcl_*` cookies, each lasting 90 days: **`FPGCLAW`**, **`FPGCLGB`** and **`FPGSID`** (Google Ads), and `FPGCLDC`, `FPGCLGS` and `FPAU`. Google's documentation doesn't say which server tag writes which, or whether they're `HttpOnly`. A third-party write-up ([Simo Ahava, 2021](https://www.simoahava.com/analytics/google-ads-server-side-tagging-google-tag-manager/)) describes the server Conversion Linker writing `FPGCLAW` when the page has a `gclid`, and not writing it when `ad_storage` is denied. Check yours in the developer tools.

**What that means for SharedID Edge:** a publisher whose sGTM runs on its own hostname (below) already gets server-set GA4 and Google Ads cookies from Google's own client and tags. Use those for Google's cookies, and keep SharedID Edge's [`reflect` keeper](../packages/modules/reflect/README.md#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au) for publishers without sGTM and for non-Google cookies. See [the keeper or sGTM, not both](#googles-cookies-the-keeper-or-sgtm-not-both).

## Where to serve sGTM: beside `/_sid/*`, on your own hostname

Google's [custom domain guide](https://developers.google.com/tag-platform/tag-manager/server-side/custom-domain) gives three options, for a site on `www.example.com`:

| | Same origin (Google: "best practice") | Subdomain | Default domain |
| --- | --- | --- | --- |
| Example | `https://www.example.com/metrics` | `https://metrics.example.com` | `https://metrics.run.app` |
| Server-set cookies, per Google | "Full access to security and durability benefits." | The same | "None. Can only set Javascript cookies." |

For the same-origin option, Google's steps are, in short:

- **Pick an unused path,** such as `/collect`, `/metrics` or `/data`. It "must not contain `/gtm`". Route **all** of it to the tagging server; if you route sub-paths only, you must also route `/_/*`, or "core functionality" breaks.
- **In the CDN or load balancer,** add the tagging server as an origin, override the `Host` header to the tagging server's own domain (such as the `run.app` one), forward all cookies and query strings, and give the path rule a higher priority than the default rule.
- **Check** `https://www.example.com/metrics/healthy` answers `ok`.
- **In Tag Manager,** under **Admin > Container Settings**, remove the previous server container URLs and add the one with the path ("all server container URLs must share the same path").

SharedID Edge's `/_sid/*` and sGTM's `/metrics/*` are two path rules on the same CDN, side by side. Neither forwards the other's path.

**When the CDN sends the tagging server's own `Host`:** sGTM's `setCookie` API, used by templates, works out `domain: 'auto'` from the eTLD+1 of the `Forwarded` header, then `X-Forwarded-Host`, then `Host` ([`setCookie`](https://developers.google.com/tag-platform/tag-manager/server-side/api#setcookie)). Send your site's hostname in `X-Forwarded-Host`, as the examples below do, so such cookies land on `example.com` and not on the cloud provider's domain. Google doesn't document which domain its own GA4 client and Conversion Linker use: check the `Domain` of `FPID` and `FPGCLAW` in the developer tools.

### Safari's IP-address rule applies to sGTM too

WebKit "detects third-party CNAME cloaking and third-party IP address cloaking requests and caps the expiry of any cookies set in the HTTP response to 7 days" ([WebKit tracking prevention](https://webkit.org/tracking-prevention/); the IP-address part first shipped in [Safari Technology Preview 157](https://webkit.org/blog/13575/release-notes-for-safari-technology-preview-157/), then Safari 16.4). It's the same rule that keeps SharedID Edge on your site's CDN ([How it works](../README.md#how-it-works)), and it applies to sGTM's cookies just the same:

- **A path of your own hostname** through your CDN (Google's recommended setup) answers from your site's addresses: its cookies keep their lifetime.
- **A subdomain served by the same CDN** as your site (a proxied hostname in the same Cloudflare zone, an alternate domain name on the same distribution) answers from the same addresses too.
- **A subdomain whose DNS points straight at the tagging server** (a Cloud Run domain mapping, a hosting provider's IP addresses, a CNAME to a provider's hostname) answers from other addresses, and Safari caps what it sets to 7 days, whatever Google's table says about subdomains. Google's custom domain guide doesn't mention Safari's rule.

WebKit doesn't document how closely the addresses must match. Compare them with `dig +short www.example.com` and `dig +short metrics.example.com`; SharedID Edge's own `npm run verify-deployment` reports the same for `/_sid/*` ([Verifying your own deployment](verification.md#verifying-your-own-deployment)).

### On Cloudflare

Two Workers on two routes of your zone: SharedID Edge's own (the [Cloudflare adapter](../packages/adapters/cloudflare/README.md), route `www.example.com/_sid/*`), and a forwarding Worker for the sGTM path. Cloudflare picks the route by path, so they don't overlap.

```text
Browser ──► www.example.com (proxied by Cloudflare)
              ├─ /_sid/*     ──► the SharedID Edge Worker
              ├─ /metrics/*  ──► the forwarding Worker ──► your tagging server (e.g. https://sgtm-xxxx.a.run.app)
              └─ anything else ──► your origin, as before
```

The forwarding Worker, `sgtm-forward.js`, follows the shape of SharedID Edge's own live-tested [forwarding Worker](../packages/adapters/cloudflare/live/forward.js):

```js
// Forwards www.example.com/metrics/* to the tagging server, keeping the path (sGTM's server container URL includes it).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', url.hostname);
    // The visitor's address, from Cloudflare; never what the visitor sent.
    const ip = request.headers.get('cf-connecting-ip');
    if (ip === null) headers.delete('x-forwarded-for'); else headers.set('x-forwarded-for', ip);
    const upstream = new URL(url.pathname + url.search, env.SGTM_ORIGIN);
    // fetch() sends the tagging server's own Host, as Google's guide asks; cookies and the body go through.
    return fetch(upstream, { method: request.method, headers, body: request.body, redirect: 'manual' });
  }
};
```

Its `wrangler.jsonc`:

```jsonc
{
  "name": "sgtm-forward",
  "main": "sgtm-forward.js",
  "compatibility_date": "2026-11-01",
  "routes": [{ "pattern": "www.example.com/metrics/*", "zone_name": "example.com" }],
  "workers_dev": false,
  "vars": { "SGTM_ORIGIN": "https://sgtm-xxxx.a.run.app" }
}
```

Deploy it with `npx wrangler deploy`, then:

- `https://www.example.com/metrics/healthy` answers `ok`;
- `https://www.example.com/_sid/v1` still answers SharedID Edge's JSON;
- in sGTM's **Preview**, a request from your site is claimed by the GA4 client, and its **Request** tab shows your site's cookies and the visitor's IP address. Cloudflare adds headers of its own to a Worker's requests; if sGTM shows a Cloudflare address instead of the visitor's, look at the `X-Forwarded-For` it received.

Run the preview server on a hostname of its own (it needs no first-party cookies) and set `PREVIEW_SERVER_URL` on the tagging servers to it.

### Both in containers, with docker-compose

The tagging server image and SharedID Edge's [Node.js server](../packages/adapters/node/README.md) are both plain HTTP services, so one deployment can run both, behind the proxy that serves your site. This example runs them beside nginx; put your CDN or load balancer, with TLS, in front, routing the whole hostname to nginx.

```text
CDN or load balancer (TLS) ──► nginx
                                 ├─ /_sid/*     ──► sharedid      (node packages/adapters/node/dist/cli.js, :8787)
                                 ├─ /metrics/*  ──► sgtm          (gtm-cloud-image, :8080)
                                 └─ anything else ──► your application
sgtm-preview.example.com ──► nginx ──► sgtm-preview (gtm-cloud-image, RUN_AS_PREVIEW_SERVER=true)
```

`docker-compose.yml`, next to a clone of this repository in `./sharedid-edge`:

```yaml
services:
  proxy:
    image: nginx:1.27-alpine
    ports: ["80:80"]
    volumes: ["./nginx.conf:/etc/nginx/conf.d/default.conf:ro"]
    depends_on: [sharedid, sgtm, sgtm-preview]

  sharedid:
    image: node:24-alpine
    working_dir: /app
    volumes: ["./sharedid-edge:/app:ro"]
    command: ["node", "packages/adapters/node/dist/cli.js"]
    environment:
      HOST: 0.0.0.0
      PORT: "8787"
      SID_COOKIE_DOMAIN: example.com
      SID_PUBLIC_ORIGIN: https://www.example.com
      SID_TRUST_PROXY: "true"
      # The visitor's country, from a header your CDN sets: see the Node.js README, "Per CDN".
      # SID_LOCATION_HEADERS: '{"country":"cloudfront-viewer-country"}'

  sgtm:
    image: gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable
    environment:
      CONTAINER_CONFIG: ${CONTAINER_CONFIG}
      PREVIEW_SERVER_URL: https://sgtm-preview.example.com

  sgtm-preview:   # exactly one
    image: gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable
    environment:
      CONTAINER_CONFIG: ${CONTAINER_CONFIG}
      RUN_AS_PREVIEW_SERVER: "true"
```

`nginx.conf`:

```nginx
server {
    listen 80;
    server_name www.example.com;

    location /_sid/ {
        proxy_pass http://sharedid:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, don't append
        proxy_cache off;
        access_log off;                                  # its URLs carry the ID and consent strings
    }

    location /metrics/ {
        proxy_pass http://sgtm:8080;                     # no URI part: the /metrics prefix is kept
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_cache off;
    }

    location / {
        proxy_pass http://your-application;
    }
}

server {
    listen 80;
    server_name sgtm-preview.example.com;
    location / {
        proxy_pass http://sgtm-preview:8080;
        proxy_set_header Host $host;
    }
}
```

1. Build SharedID Edge once, in a Linux container so `node_modules` matches the runtime: `docker run --rm -v "$PWD/sharedid-edge:/app" -w /app node:24 sh -c "npm ci && npm run build"`.
2. Set `CONTAINER_CONFIG` (from **Manually provision tagging server** in Tag Manager) in the environment or an `.env` file, and run `docker compose up -d`.
3. Set the server container URL in Tag Manager to `https://www.example.com/metrics`, as above.
4. Check `/metrics/healthy` (`ok`) and `/_sid/v1` through your CDN, and run `npm run verify-deployment -- --site https://www.example.com` from the clone.

- **The visitor's address:** `$remote_addr` is whatever connects to nginx. Behind a CDN or load balancer, that's the CDN: set nginx's [real IP](https://nginx.org/en/docs/http/ngx_http_realip_module.html) module to trust it, or point SharedID Edge's `SID_CLIENT_IP_HEADER` at the CDN's client-IP header ([Per CDN](../packages/adapters/node/README.md#per-cdn)).
- **The visitor's country** decides whether GDPR applies to SharedID Edge; nginx has none to give. Pass the CDN's ([Pass the visitor's country on](../packages/adapters/node/README.md#deploy-behind-your-proxy)).
- **Only through the proxy:** neither service may be reachable from the internet except through it (don't publish their ports), or visitors could send their own forwarding headers.

### On Google Cloud

With an external Application Load Balancer in front of your site, the same layout is two path rules on one URL map: `/_sid/*` to SharedID Edge's Cloud Run function ([Add the path rule to your URL map](../packages/adapters/gcp-functions/README.md#add-the-path-rule-to-your-url-map)) and `/metrics/*` to the tagging server's Cloud Run service, each through its own serverless network endpoint group. Both then answer from the load balancer's addresses, your site's.

## The SharedID in sGTM

Two ways to give tags in your server container the SharedID, and `/_sid/v1`'s other signals. They can be combined.

| | Option A: on the page | Option B: sGTM reads the cookie |
| --- | --- | --- |
| Change to the page | A few lines before the Google tag | None |
| Change to sGTM | An Event Data variable | Import [the variable template](../templates/sgtm/README.md) |
| What sGTM gets | Anything `/_sid/v1` returns: the SharedID, `ortb2.device.geo.country`, the traffic signal | The SharedID |
| Needs | Nothing more | `_pubcid` reaching the tagging server's host |
| Also goes to Google Analytics | Yes, unless you exclude it (below) | No |

### Option A: add the SharedID to GA4 events on the page

Call `/_sid/v1` before configuring the Google tag, and set what it returns as event parameters (`gtag('set', {...})`) or user properties (`gtag('set', 'user_properties', {...})`), which every later event carries. The same timing as the [`reflect` snippet](../packages/modules/reflect/README.md#timing-gtagjs-reads-_ga-when-it-loads): wait for the call, but never more than half a second.

```html
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());

  Promise.race([
    fetch('/_sid/v1', { credentials: 'include' }).then(response => response.json()),
    new Promise(resolve => setTimeout(resolve, 500))
  ]).catch(() => undefined).then(payload => {
    const sharedid = payload?.sharedid;                       // absent without consent, after opt-out, with GPC or COPPA
    const country = payload?.ortb2?.device?.geo?.country;     // with SID_MODULES=geo: ISO 3166-1 alpha-3, such as "USA"
    if (sharedid !== undefined) gtag('set', { pubcid: sharedid });
    if (country !== undefined) gtag('set', { edge_country: country });
    // Or as user properties: gtag('set', 'user_properties', { pubcid: sharedid });
    gtag('config', 'G-XXXXXXXXXX', { server_container_url: 'https://www.example.com/metrics' });
  });
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
```

With Google Tag Manager on the page instead, push the values to the data layer before the container loads and add them to the Google tag's configuration as parameters.

- **Event parameters or user properties:** Google Analytics takes event parameter values up to 100 characters, and user property values up to **36** ([collection limits](https://support.google.com/analytics/answer/9267744)). Minted SharedIDs are UUIDs, exactly 36 characters, but SharedID Edge adopts any valid ID up to 128 characters, so an older, longer ID would be dropped as a user property. Event parameters are the safer choice; user property names can't start with `google_`, `ga_` or `firebase_`.
- **In sGTM:** an **Event Data** variable with the key `pubcid` (or `edge_country`). Check the key in Preview's **Event Data** tab; Google doesn't document where the GA4 client puts user properties in the event data, so look there for those too.
- **They also reach Google Analytics** through the GA4 tag in your server container. If they're only for other tags, remove them from the GA4 tag with an **Exclude parameters** [transformation](https://developers.google.com/tag-platform/tag-manager/server-side/transformations). To report on them in Google Analytics instead, register them as custom dimensions.
- **Consent:** `/_sid/v1` leaves `sharedid` out whenever SharedID Edge may not store it, so the snippet sends nothing then. Add the consent parameters you have to the call (`gdpr`, `gdpr_consent`, `us_privacy`, `coppa=1`; see [Consent and opt-out](consent.md)).

### Option B: sGTM reads the cookie

sGTM sees the cookies the browser sends to it. `_pubcid` reaches it when:

- sGTM runs on a path of your site (`www.example.com/metrics`): always;
- sGTM runs on a subdomain (`metrics.example.com`): when `SID_COOKIE_DOMAIN` is your registrable domain (`example.com`), the normal setting. Not with `SID_COOKIE_DOMAIN=host-only`;
- sGTM runs on the provider's domain (`*.run.app`): never.

The [SharedID variable template](../templates/sgtm/README.md) (`templates/sgtm/sharedid-variable.tpl`) reads it with sGTM's `getCookieValues`, choosing between `_pubcid` and its `HttpOnly` recovery copy as SharedID Edge does, and returns `undefined` after opt-out or with Global Privacy Control. Its README has the import steps, the permissions it asks for, and an example tag. On a visitor's first page view, the GA4 events may reach sGTM before Prebid.js or SharedID Edge has set the cookie; from the next request on, it's there.

## Google's cookies: the keeper or sGTM, not both

SharedID Edge's `reflect` module can keep `_ga`, `_gcl_aw` and `_gcl_au` durable and restore them from its keeper cookie (`_sid_keep`) after Safari deletes them. An sGTM setup can do the same for Google's cookies, with the GA4 client's `FPID`, the Conversion Linker's `FPGCLAW`, or a community template that restores cookies (Stape's [Cookie Keeper](https://stape.io/helpdesk/documentation/cookie-keeper-power-up), [Cookie Extender](https://github.com/stape-io/cookie-extender-tag) or [Cookie reStore](https://github.com/stape-io/cookie-restore-tag)). Two servers restoring the same cookie can put back different values (one restores an older `_ga`, the other keeps the one gtag.js just minted), and a visitor's client ID or click attribution flips between them.

**Use one or the other for each Google cookie:**

- **With sGTM on your own hostname:** use Google's GA4 client (**Server managed**) and Conversion Linker for Google's cookies, and **leave `_ga`, `_gcl_aw` and `_gcl_au` out of `reflect`'s `cookies`**. Keep `reflect` for non-Google cookies (`uid1` and others). [`clickid`](../packages/modules/clickid/README.md) doesn't touch Google's cookies (it writes its own, `_sid_gclid` and others), so it doesn't conflict.
- **Without sGTM, or with sGTM on a domain that can't set durable cookies** (the provider's domain, or a subdomain on other IP addresses): use `reflect` with `restore` for them, as in [its Google section](../packages/modules/reflect/README.md#restore-google-analytics-and-ads-cookies-after-safari-deletes-them-_ga-_gcl_aw-_gcl_au), and don't add a restoring template to sGTM.

**How to tell which is active,** in the browser's developer tools on a page of your site:

| Look at | SharedID Edge's keeper is active | sGTM handles Google's cookies |
| --- | --- | --- |
| Application > Cookies | `_sid_keep` (or your `keeper.cookie`; with `"mode": "per-cookie"`, `_ga_backup` and the like, the names Stape's Cookie Extender uses too, so check which response sets them) | `FPID`, `FPGCLAW` and the other `FP*` cookies |
| Network: a `/_sid/sync` or `/_sid/v1` response | `Set-Cookie: _ga=…` and `X-SharedID-Modules: reflect=…` | no `Set-Cookie` for `_ga` or `_gcl_*` |
| Network: a response from your sGTM path | no `Set-Cookie` for the cookies the keeper restores | `Set-Cookie: FPID=…`, or for the cookies your restoring template handles |
| Configuration | `SID_MODULES` includes `reflect`, and `SID_MODULE_CONFIG`'s `reflect.cookies` lists `_ga` or `_gcl_*` | The GA4 client's **Cookies and Client Identification** is **Server managed**; a Conversion Linker tag, or a restoring template, in the server container |

From a terminal, the keeper shows on SharedID Edge's own response: `curl -sI https://www.example.com/_sid/sync -H 'Cookie: _ga=GA1.1.1234567890.1700000000'` sets `_ga` again when `reflect` handles it. If both columns show, take `_ga` and `_gcl_*` out of one of them.

## Consent: keeping Consent Mode and SharedID Edge consistent

The two read consent from different places:

| | Where it reads consent |
| --- | --- |
| **SharedID Edge** | The opt-out cookie (`_pubcid_optout`), `Sec-GPC: 1`, `coppa=1`, the TCF TC string (the `euconsent-v2` cookie or `gdpr_consent`), and with the opt-in modules, your CMP's own cookie ([`cmp`](../packages/modules/cmp/README.md)) and the GPP string's US sections ([`gpp`](../packages/modules/gpp/README.md)). A `us_privacy` opt-out of sale removes precise location and click IDs, not the SharedID. See [Consent and opt-out](consent.md). |
| **sGTM** | Google Consent Mode, which the Google tag on the page adds to each request; the server container's Google tags adjust to it. Google: "you only need to set up consent mode in the web container" ([Consent mode with sGTM](https://developers.google.com/tag-platform/tag-manager/server-side/consent-mode)). In the event data it's the `x-ga-gcs` and `x-ga-gcd` parameters, among Google's [internal parameters](https://developers.google.com/tag-platform/tag-manager/server-side/internal-parameters), whose names "are subject to change" and whose format Google doesn't document. TCF strings are read when TCF support is enabled on the page. |

Neither reads the other's signals today: SharedID Edge never sees Consent Mode, which lives in the page (a [consent provider](../spec/SPEC.md#consent-providers) for it is planned, alongside [Prebid.js issue #16159](https://github.com/prebid/Prebid.js/issues/16159)), and sGTM's Google tags don't read SharedID Edge's decision. So keep them consistent at the source:

- **One CMP drives both.** Have your CMP update Consent Mode (`gtag('consent', 'update', …)`) and write the TC string (or the cookie the `cmp` module reads) from the same choice. With TCF, a visitor who refuses storage (Purpose 1) gets no SharedID, and should get `ad_storage` and `analytics_storage` denied too.
- **Gate the tags that send the SharedID,** not just Google's. sGTM's Google tags follow Consent Mode on their own; a tag that sends `{{SharedID}}` to another platform follows whatever consent you give it. A visitor can allow the SharedID and still deny `ad_storage`, say. Send the consent your CMP decided along with the event (an event parameter such as `ads_allowed`, set by the page from the CMP), and add it to those tags' triggers. Don't hand-parse `x-ga-gcd`: its format isn't documented.
- **Option A follows SharedID Edge already:** `/_sid/v1` returns no `sharedid` when storage isn't allowed. Make the page call it only once the CMP has answered, with the consent parameters.
- **Option B follows the cookie:** SharedID Edge deletes `_pubcid` when consent is withdrawn, but only on its next call; until then the browser still sends it. The variable template checks the opt-out cookie and `Sec-GPC` itself; for TCF and the rest, gate the tag.
- **COPPA:** sGTM has no COPPA signal. On pages directed at children, call `/_sid/v1` with `coppa=1` (which deletes the ID) and don't send the SharedID from sGTM.
- **The `reflect` keeper follows SharedID Edge's decision, not Consent Mode** ([its consent rules](../packages/modules/reflect/README.md#consent-and-opt-out)). That's another reason to let sGTM's consent-aware Google tags handle Google's cookies when you run sGTM.

## Sources

Checked on 18 November 2026:

- Google: [manual setup guide](https://developers.google.com/tag-platform/tag-manager/server-side/manual-setup-guide) (the image and its variables), [custom domain configuration](https://developers.google.com/tag-platform/tag-manager/server-side/custom-domain) (same origin, paths, the CDN steps), [server-side APIs](https://developers.google.com/tag-platform/tag-manager/server-side/api) and [permissions](https://developers.google.com/tag-platform/tag-manager/server-side/permissions), [consent mode with sGTM](https://developers.google.com/tag-platform/tag-manager/server-side/consent-mode), [internal parameters](https://developers.google.com/tag-platform/tag-manager/server-side/internal-parameters), [transformations](https://developers.google.com/tag-platform/tag-manager/server-side/transformations), [Google Ads setup](https://developers.google.com/tag-platform/tag-manager/server-side/ads-setup), [server-side tagging course: Analytics](https://developers.google.com/tag-platform/learn/sst-fundamentals/5-sst-setup-analytics), [Analytics Help: server managed client ID](https://support.google.com/analytics/answer/14847402), [Google's cookie list](https://business.safety.google/adscookies/), [collection limits](https://support.google.com/analytics/answer/9267744), [event parameters](https://developers.google.com/analytics/devguides/collection/ga4/event-parameters), [the `user_properties` reference](https://developers.google.com/analytics/devguides/collection/ga4/reference/config#user_properties), [custom templates](https://developers.google.com/tag-platform/tag-manager/templates) and [gallery submission](https://developers.google.com/tag-platform/tag-manager/templates/gallery).
- WebKit: [tracking prevention](https://webkit.org/tracking-prevention/), [Safari Technology Preview 157](https://webkit.org/blog/13575/release-notes-for-safari-technology-preview-157/).
- Third-party, where Google's documentation is silent: Simo Ahava on [`FPID`](https://www.simoahava.com/analytics/fpid-cookie-google-analytics-server-side-tagging/) and [Google Ads with sGTM](https://www.simoahava.com/analytics/google-ads-server-side-tagging-google-tag-manager/).

**Not confirmed** by Google's documentation: that `FPID` and the `FPGCL*` cookies are `HttpOnly`; which server tag writes each `FP*` cookie; whether the GA4 client re-sets `_ga` from the server in JavaScript-managed mode; which cookie domain Google's own client and tags use behind a CDN that sends the tagging server's `Host`; where the GA4 client puts user properties in the event data; and how closely Safari compares IP addresses.
