# @sharedid-edge/gcp-functions

[SharedID Edge](../../../README.md) on Google Cloud: a Cloud Run function (2nd gen, Node.js 24, the Functions Framework) behind a `/_sid/*` path rule of **the external Application Load Balancer that serves your site**. It's the same platform-neutral handler as the Cloudflare Worker, the Node.js server and the Lambda function, with built-in modules `ip`, `ec`, `geo` and `reflect`. It passes the same conformance suite, and it uses `@sharedid-edge/node`'s request and response conversion.

The main README has a [quick start](../../../README.md#deploy-on-google-cloud-cloud-run-functions-and-load-balancing). This is the full guide.

## Contents

- [Architecture](#architecture)
- [Functions or services](#functions-or-services)
- [Firebase Hosting](#firebase-hosting)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy with Terraform](#deploy-with-terraform)
- [Add the path rule to your URL map](#add-the-path-rule-to-your-url-map)
- [Deploy with gcloud instead](#deploy-with-gcloud-instead)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Verify](#verify)
- [Platform information](#platform-information)
- [Using it in code](#using-it-in-code)
- [Testing without a Google Cloud account](#testing-without-a-google-cloud-account)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
External Application Load Balancer: your site's forwarding rule, certificate and URL map (www.example.com)
   ├─ path rule /_sid, /_sid/*  → backend service (Cloud CDN off), custom request headers:
   │                                x-client-region: {client_region}, x-client-region-subdivision: {client_region_subdivision},
   │                                x-client-city: {client_city}, x-client-city-lat-long: {client_city_lat_long}
   │                              appends <client>,<load balancer> to X-Forwarded-For
   │                              → serverless NEG → the function
   └─ default                   → your site's backends, unchanged
                     │
                     ▼
Cloud Run function sharedid-edge (Node.js 24, ingress: internal and Cloud Load Balancing only)
   Functions Framework → sharedidEdge(req, res): req → Request → SharedID Edge handler → Response → res
```

- **On your site's own load balancer.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A path rule on the URL map that serves `www.example.com` answers from the same IP address as your pages. The function's own `*.run.app` URL, or a separate load balancer on another host name, doesn't, and Safari would cap the cookies. **Add the path rule to the host rule that serves your pages.**
- **Only the load balancer reaches the function.** Its ingress is "internal and Cloud Load Balancing", so the `*.run.app` URL refuses requests from the internet. This matters: the function trusts the load balancer's `X-Forwarded-For` entry and custom request headers, and a visitor who could call the function directly could forge them.
- **Nothing cached.** Cloud CDN is off on the backend service, and the handler sends `Cache-Control: no-store` or `private`.
- **No forwarding.** The function answers every request it gets; nothing reaches your site's backends.

## Functions or services

Cloud Run has two shapes, and SharedID Edge fits both:

- **Cloud Run functions (this package):** you deploy a source directory, Google builds it, and the Functions Framework runs it. It's the least to maintain: no image, no Dockerfile. It reads the load balancer's `X-Forwarded-For` entry and location headers, so the `ip`, `ec` and `geo` modules work.
- **Cloud Run services running the Node.js server ([`@sharedid-edge/node`](../node/README.md))** in a container: choose this if you already deploy containers, want to pin the image, or run the same image elsewhere. A published image is planned ([#35](https://github.com/patmmccann/sharedid-edge/issues/35)). The routing is the same (a serverless NEG and a path rule). But the Node.js server's `SID_TRUST_PROXY` takes the **first** `X-Forwarded-For` entry, which behind this load balancer is whatever the visitor sent. So leave `SID_TRUST_PROXY` off there. The server then has no client IP or location to give (the `ip`, `ec` and `geo` modules return nothing, and GDPR comes from `gdpr=1`).

Choose functions unless you have a reason for containers. Both run on the same infrastructure, with the same scaling and pricing model.

## Firebase Hosting

Firebase Hosting can send `/_sid/**` to a function with a rewrite, on the site's own domain:

```json
{ "hosting": { "rewrites": [{ "source": "/_sid/**", "function": { "functionId": "sharedid-edge", "region": "us-central1" } }] } }
```

**But this doesn't work for SharedID Edge.** Firebase Hosting [strips cookies](https://firebase.google.com/docs/hosting/manage-cache#using_cookies) from requests to functions, except one named `__session`. The function would never see `_pubcid`, the `HttpOnly` recovery copy `_pubcid_sv` or the opt-out cookie. It couldn't restore an ID that Safari capped, the main reason to run it, and it couldn't honour an opt-out cookie. Firebase Hosting also adds no location headers, and its `X-Forwarded-For` hasn't been verified for this adapter. Serve the site through the external Application Load Balancer instead, or, if the site must stay on Firebase Hosting, keep using Prebid.js's own cookie without SharedID Edge.

## Prerequisites

- Your site served through a **global external Application Load Balancer** (or the classic one), with a URL map you can edit, on your own domain over https.
- A Google Cloud project with the Cloud Functions, Cloud Run, Cloud Build, Artifact Registry and Compute Engine APIs enabled, and permission to create functions, service accounts, NEGs and backend services, and to edit the URL map.
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later with Google credentials (`gcloud auth application-default login`), or the [gcloud CLI](https://cloud.google.com/sdk/docs/install).
- Node.js 24 or later and npm, to build.
- An organization policy that allows `allUsers` as a Cloud Run invoker (Domain Restricted Sharing can forbid it); see [Troubleshooting](#troubleshooting).

## Build

From a clone of this repository:

```sh
npm ci
npm run build                                     # compiles core, the modules and @sharedid-edge/node
npm run bundle -w @sharedid-edge/gcp-functions    # packages/adapters/gcp-functions/deploy/
```

`deploy/` is the function's whole source:

| File | |
| --- | --- |
| `sharedid-edge.mjs` | The function: `src/function.ts` with core, `@sharedid-edge/node`'s conversion and the built-in modules, in one minified ESM file (about 16 KB gzipped; the bundle step fails it over 32 KB). It registers the HTTP function `sharedidEdge`. |
| `package.json` | `main` is the bundle; its one dependency is `@google-cloud/functions-framework`, which Cloud Build installs and which runs the function. |

To parse User-Agents fully with Bowser in the `ua` module, bundle with `npm run bundle:bowser -w @sharedid-edge/gcp-functions` instead (see the [`ua` module](../../modules/ua/README.md)). Rebuild and bundle after updating the code.

## Deploy with Terraform

[`terraform/`](terraform/main.tf) creates:

- a bucket with the zipped `deploy/` and the function: Node.js 24, entry point `sharedidEdge`, ingress *internal and Cloud Load Balancing*, every `SID_*` setting as an environment variable, its own service account, and `allUsers` as invoker (ingress keeps everyone but the load balancer out);
- a serverless network endpoint group for the function;
- a backend service: Cloud CDN off, the four location headers as custom request headers (`location_headers`, on by default), and the same `load_balancing_scheme` as your load balancer.

```sh
cd packages/adapters/gcp-functions/terraform
terraform init
terraform apply -var project=my-project -var region=us-central1 \
  -var sid_cookie_domain=.example.com -var sid_modules=ip,geo
```

| Variable | |
| --- | --- |
| `project`, `region` | Your project, and the region for the function (any; the global load balancer reaches it). |
| `load_balancing_scheme` | `EXTERNAL_MANAGED` (global external Application Load Balancer, the default) or `EXTERNAL` (classic); it must match your URL map's load balancer. |
| `sid_base_path` | `SID_BASE_PATH`; the `path_rule_paths` output follows it. `/` serves `/sync`, `/v1`, `/optout` and `/optin` at the root. |
| `sid_*` | The other [settings](#configuration), empty for the default. |
| `sid_module_secrets_secret` | A Secret Manager secret holding `SID_MODULE_SECRETS`; see [Secrets](#secrets). |
| `location_headers` | `true`: the custom request headers, and `SID_LOCATION_HEADERS` to read them. |
| `sid_trusted_hops` | `SID_TRUSTED_HOPS`, `1` behind the load balancer. |
| `min_instance_count`, `max_instance_count` | Instances kept warm (to avoid cold starts, at a baseline cost) and the scale limit. |

Outputs: `backend_service` and `path_rule_paths` for the next step, and `function_uri` (which refuses direct requests).

## Add the path rule to your URL map

Terraform doesn't change your URL map, which you manage already. Add a path rule to the path matcher of the host rule that serves your pages, for the `path_rule_paths` output (`/_sid` and `/_sid/*`), to the `backend_service` output.

In Terraform, in your `google_compute_url_map`:

```hcl
path_matcher {
  name            = "site"
  default_service = google_compute_backend_service.site.id
  path_rule {
    paths   = module.sharedid_edge.path_rule_paths    # or ["/_sid", "/_sid/*"]
    service = module.sharedid_edge.backend_service
  }
}
```

With gcloud, export the URL map, add the rule, and import it:

```sh
gcloud compute url-maps export my-url-map --destination=url-map.yaml
# under the pathMatcher that serves your host, add:
#   pathRules:
#   - paths: ['/_sid', '/_sid/*']
#     service: <backend_service output>
gcloud compute url-maps import my-url-map --source=url-map.yaml
```

If your host rule has no path matcher yet, add one whose `defaultService` is your site's current backend. URL map changes take a few minutes to reach every edge.

## Deploy with gcloud instead

Put the settings in a YAML file first: copy [`env.example.yaml`](env.example.yaml), which lists every setting, and fill in what you need. `--set-env-vars` splits its value on commas, which breaks the JSON in `SID_LOCATION_HEADERS` and `SID_MODULE_CONFIG` and lists like `SID_MODULES=ip,geo`. A file doesn't.

```sh
cp packages/adapters/gcp-functions/env.example.yaml env.yaml     # then edit env.yaml
gcloud functions deploy sharedid-edge --gen2 --region=us-central1 --runtime=nodejs24 \
  --source=packages/adapters/gcp-functions/deploy --entry-point=sharedidEdge --trigger-http \
  --ingress-settings=internal-and-gclb --allow-unauthenticated \
  --env-vars-file=env.yaml
gcloud compute network-endpoint-groups create sharedid-edge --region=us-central1 \
  --network-endpoint-type=serverless --cloud-run-service=sharedid-edge
gcloud compute backend-services create sharedid-edge --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --custom-request-header='x-client-region: {client_region}' \
  --custom-request-header='x-client-region-subdivision: {client_region_subdivision}' \
  --custom-request-header='x-client-city: {client_city}' \
  --custom-request-header='x-client-city-lat-long: {client_city_lat_long}'
gcloud compute backend-services add-backend sharedid-edge --global \
  --network-endpoint-group=sharedid-edge --network-endpoint-group-region=us-central1
```

Cloud CDN is off unless you turn it on (`--enable-cdn`); keep it off. Then [add the path rule](#add-the-path-rule-to-your-url-map). To change one setting later, use `--update-env-vars` with gcloud's [alternative delimiter](https://cloud.google.com/sdk/gcloud/reference/topic/escaping) whenever the value has a comma: `--update-env-vars='^;^SID_MODULES=ip,geo'` (the `^;^` makes `;` the separator instead of `,`). Add `--set-secrets=SID_MODULE_SECRETS=sid-module-secrets:latest` for [secrets](#secrets).

## Configuration

Settings are the function's environment variables, the same `SID_*` variables as everywhere else (see the [configuration reference](../../../README.md#configuration-reference)). Terraform has a variable for each (`sid_cookie_name` for `SID_COOKIE_NAME` and so on). Changing them deploys a new revision. Configuration is read once per instance: an invalid setting makes every request return `500 SharedID Edge is misconfigured`, and the reason is logged, rather than setting wrong cookies.

Read only by the Google Cloud adapter:

| Variable | Default | |
| --- | --- | --- |
| `SID_TRUSTED_HOPS` | `1` | How many `X-Forwarded-For` entries your infrastructure appends after the client's address. The external Application Load Balancer appends `<client>,<load balancer>`, so the client is the second-to-last entry: `1`. Raise it only if another proxy of yours appends its own entry after the load balancer's. 0 to 10. |
| `SID_CLIENT_IP_HEADER` | none | A custom request header with the client's address (`x-client-ip: {client_ip_address}` on the backend service), used instead of `X-Forwarded-For`. |
| `SID_LOCATION_HEADERS` | none (no location) | JSON: location field → the custom request header with it, like `{"country":"x-client-region"}`. Fields: `country` (`{client_region}`), `region` (`{client_region_subdivision}`), `city` (`{client_city}`), `latLong` (`{client_city_lat_long}`). Terraform sets all four. An invalid value is a configuration error. |
| `SID_PUBLIC_ORIGIN` | `https://` and the `Host` header | The origin of request URLs. Only its scheme matters (`https` makes cookies `Secure`). |
| `SID_BEHIND_LOAD_BALANCER` | `true` | `false` when no load balancer is in front (local development): `X-Forwarded-For` and the location headers are then ignored, and there's no client IP or location. Don't serve a site that way: without the load balancer the endpoint isn't on the site's IP address. |

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) comes from **Secret Manager**. Cloud Run resolves it into the environment variable when an instance starts, so SharedID Edge still reads a plain setting and makes no network calls:

```sh
printf '%s' '{"ec":{"passphrase":"'"$(openssl rand -hex 32)"'"}}' | gcloud secrets create sid-module-secrets --data-file=-
terraform apply ... -var sid_module_secrets_secret=sid-module-secrets -var sid_modules=ip,ec
```

Terraform grants the function's service account *Secret Manager Secret Accessor* on that secret. With gcloud, use `--set-secrets=SID_MODULE_SECRETS=sid-module-secrets:latest`. To rotate, add a secret version and deploy a new revision (instances read `latest` when they start).

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie
curl -s  'https://www.example.com/_sid/v1' | jq .                # the payload
curl -sI "$(terraform -chdir=packages/adapters/gcp-functions/terraform output -raw function_uri)/_sid/v1"   # 404 or 403: ingress refuses it
```

Then [turn it on in Prebid.js](../../../README.md#configure-prebidjs).

## Platform information

| Field | Source | Notes |
| --- | --- | --- |
| `clientIp` | The `X-Forwarded-For` entry before the last `SID_TRUSTED_HOPS` ones: the second-to-last behind the load balancer | The load balancer appends `<client>,<load balancer>` to whatever the visitor sent. **The first entry is the visitor's own and is never used.** IPv4 or IPv6; anything that isn't an IP address is ignored. Or `SID_CLIENT_IP_HEADER`'s header (`{client_ip_address}`). |
| `country` | `x-client-region` (`{client_region}`) | ISO 3166-1 alpha-2, like `FR`. |
| `region` | `x-client-region-subdivision` (`{client_region_subdivision}`) | The load balancer runs the country and the subdivision together (`USCA`); the adapter drops the country (`CA`). |
| `city` | `x-client-city` (`{client_city}`) | For the `geo` module. |
| `latitude`, `longitude` | `x-client-city-lat-long` (`{client_city_lat_long}`) | `37.386051,-122.083851`; both are needed, and out-of-range values are dropped. |
| `isEU` | from `country` | `true` for the 27 EU member states (core's `EU_COUNTRY_CODES`, the meaning of Cloudflare's `isEUCountry`), `false` for other countries, unknown without a country. |
| `traffic` | none | The load balancer passes no bot verdict to the function, so there is none from the platform. (Cloud Armor rules can add request headers, but the adapter reads none.) The `bot` module and other modules still report to the traffic signal, and `SID_SKIP_BOTS` acts on theirs. |
| `postalCode`, `metroCode`, `timezone`, `continent` | none | The load balancer has no variables for them. The `geo` module therefore never sends `zip`, `metro` or `utcoffset` on Google Cloud. |

Core's `locationInfo` validates every value the same way as on the other platforms; an empty header (the load balancer doesn't know the location) means unknown.

**The trust model.** The load balancer appends the client's address to `X-Forwarded-For`, and its custom request headers **overwrite** headers of the same name that a visitor sends. Both are only trustworthy because the function's ingress admits the load balancer and the project's own network alone. That's why the adapter reads no location header unless `SID_LOCATION_HEADERS` names it: without the backend service's custom headers, those names would be visitor-controlled. With `SID_BEHIND_LOAD_BALANCER=false`, nothing is trusted.

**GDPR.** With the location headers, EU visitors get GDPR from their country. Without them (`location_headers = false`), `isEU` is unknown, and GDPR applies only when the page sends `gdpr=1`, as on the other platforms when the location is unknown. EEA countries outside the EU (Iceland, Liechtenstein, Norway) and the UK aren't in the list: pages there should send `gdpr=1` (the [consent rules](../../../README.md#consent-and-opt-out)).

## Using it in code

The package exports the pieces, if you want your own entry point (other modules, a different configuration source):

```ts
import { http } from '@google-cloud/functions-framework';
import { resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createGcpHandler } from '@sharedid-edge/gcp-functions';

http('sharedidEdge', createGcpHandler({
  config: resolveConfig(process.env),
  modules: [...builtInModules, myModule],
  trustedHops: 1,
  locationHeaders: { country: 'x-client-region' }
}));
```

- `createGcpHandler(options)`: the HTTP function; options are core's `HandlerOptions` plus `publicOrigin`, `behindLoadBalancer`, `trustedHops`, `clientIpHeader` and `locationHeaders`. It converts with `@sharedid-edge/node`'s `toWebRequest` and `sendWebResponse`.
- `handlerFromEnv(env, modules?)`: what the bundled entry point (`src/function.ts`) uses.
- `platformInfo(req, options?)`, `clientIp(req, options?)`, `parseTrustedHops(value)`, `parseLocationHeaders(json)`, `EU_COUNTRY_CODES`.
- `@google-cloud/functions-framework` is an optional peer dependency, for `src/function.ts` only.

## Testing without a Google Cloud account

Nothing here needs an account:

- `npm test -w @sharedid-edge/gcp-functions`: unit tests against a real Node.js HTTP server, with requests shaped as the load balancer delivers them, plus checks on the Terraform (every `SID_*` setting passed, ingress, Cloud CDN off, the location variables).
- `npm run conformance:gcp`: bundles the function, then runs the whole conformance suite against **the real Functions Framework** serving `deploy/`, as Cloud Run functions does, behind a local stand-in for the load balancer (`conformance/src/gcp-emulator.ts`). The stand-in appends `<client>,<load balancer>` to `X-Forwarded-For`, using the connection's address or, as the cases need, the case's `X-Forwarded-For` when the case sets `SID_TRUST_PROXY`. It also sets the four location headers from the cases' Cloudflare-style headers, overwriting any the client sent. The cases' metro code, postal code and time zone have no load balancer variable, so the runner checks that `metro`, `zip` and `utcoffset` are absent instead.
- CI validates the Terraform with `terraform validate`, which needs no credentials.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

What these don't cover, and a first deployment should check:

- **the Terraform against Google Cloud** (`terraform plan` and `apply`), including the serverless NEG pointing at the function's Cloud Run service and the `allUsers` invoker binding;
- **the real `X-Forwarded-For` shape** through the serverless NEG (that the client is the second-to-last entry), and the custom header values (the subdivision format, city encoding);
- **Cloud Build** installing the Functions Framework for the bundle;
- **cold-start latency.**

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's page or 404 | The path rule isn't on the path matcher of the host that serves the page, its paths don't match `SID_BASE_PATH`, or the URL map change hasn't propagated yet. |
| 403 or 404 from Google, not the function | Ingress refused the request: expected when calling the `*.run.app` URL directly. Through the load balancer, check the serverless NEG points at the function's service and region. |
| 403 "Your client does not have permission" through the load balancer | `allUsers` isn't a Cloud Run invoker, perhaps refused by a Domain Restricted Sharing policy. Allow it for this service, or put Identity-Aware Proxy in front (not covered here). |
| 500 `SharedID Edge is misconfigured` | An invalid setting; the reason is in the function's logs (Cloud Logging). |
| `/_sid/v1` has `ortb2.device.ip` set to a Google address | `SID_TRUSTED_HOPS` is too low for your setup: another proxy appends an entry. Check what `X-Forwarded-For` holds. |
| `/_sid/v1` has no `ortb2.device.ip` with `SID_MODULES=ip` | `SID_TRUSTED_HOPS` is too high, `SID_BEHIND_LOAD_BALANCER` is `false`, or consent rules it out (`ext.modules.ip.status` is `empty`). |
| EU visitors get cookies without consent | No country: the backend service lacks the custom request headers, or `SID_LOCATION_HEADERS` doesn't name them. See `X-SharedID-Status`. |
| Responses cached, or one visitor's cookie on another's response | Cloud CDN is on for the backend service. Turn it off. |
| Cookie set but gone after a week in Safari | `/_sid/*` isn't on the load balancer and host that serve your pages, or the site is on Firebase Hosting (see [Firebase Hosting](#firebase-hosting)). Run `verify-deployment`. |
