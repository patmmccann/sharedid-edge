# @sharedid-edge/azure-functions

[SharedID Edge](../../../README.md) on Azure: an Azure Functions app (Node.js v4 programming model) behind a `/_sid/*` route of **the Azure Front Door profile that serves your site**. It's the same platform-neutral handler as the Cloudflare Worker, the Node.js server, the Lambda function and the Vercel adapter, with built-in modules `ip`, `ec`, `geo`, `reflect`, `bot` and `ua`. It passes the same conformance suite, except for one documented limitation of Azure Functions: [cookie values](#cookie-values).

The main README has a [quick start](../../../README.md#deploy-on-azure-functions-and-front-door). This is the full guide.

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Hosting plan and Node.js version](#hosting-plan-and-nodejs-version)
- [Build](#build)
- [Deploy the infrastructure](#deploy-the-infrastructure)
- [Publish the code](#publish-the-code)
- [Run it locally](#run-it-locally)
- [Origin lock: only your Front Door](#origin-lock-only-your-front-door)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Verify](#verify)
- [Platform information](#platform-information)
- [Cookie values](#cookie-values)
- [Logging](#logging)
- [Using it in code](#using-it-in-code)
- [Testing without an Azure account](#testing-without-an-azure-account)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
Azure Front Door (Standard or Premium): your site's profile, endpoint and custom domain (www.example.com)
   ├─ route /_sid, /_sid/*  → origin group: the function app (<app>.azurewebsites.net), HTTPS only
   │                          caching off; rule set: x-sid-country = {geo_country} (overwritten on every request)
   │                          adds X-Azure-ClientIP and X-Azure-FDID (your profile's ID)
   └─ route /*              → your site's origin, unchanged
                     │
                     ▼
Function app (Flex Consumption, Node.js 24)
   access restriction: only the AzureFrontDoor.Backend service tag with your X-Azure-FDID
   └─ HTTP trigger, route _sid/{*path}, anonymous
        HttpRequest → Request → SharedID Edge handler → Response → HttpResponseInit with cookies[]
```

- **On your site's own Front Door endpoint and domain.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A route on the Front Door endpoint and custom domain that serve `www.example.com` answers from the same addresses as your pages. The function app's own `*.azurewebsites.net` host name, or a separate Front Door profile or endpoint on another host name, doesn't, and Safari would cap the cookies. **Add the route to the custom domains that serve your pages.**
- **Only your Front Door can reach the function.** See [Origin lock](#origin-lock-only-your-front-door). This matters because the function trusts `X-Azure-ClientIP` and the country header, and a visitor who could reach the function app directly could forge them.
- **Nothing cached.** The route has caching off, and the handler sends `Cache-Control: no-store` or `private`.
- **No forwarding.** The function answers every request on its route itself; nothing reaches your site's origin.

## Prerequisites

- Your site served through **Azure Front Door Standard or Premium** (a `Microsoft.Cdn/profiles` profile), on your own custom domain, over https. Front Door (classic) has no rule-set server variables and isn't covered by the template.
- The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az login`), with permission to create resources in a resource group and to add routes to the Front Door profile.
- [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) 4.x, to publish the code (or zip deploy, below).
- Node.js 24 or later and npm, to build.

## Hosting plan and Node.js version

The template uses the **Flex Consumption** plan with **Node.js 24**: it scales to zero, supports Node.js 24 and inbound access restrictions, and can keep instances always ready. Node.js 24 is generally available on Azure Functions (Microsoft lists its end of support as April 30, 2028; see [supported languages](https://learn.microsoft.com/azure/azure-functions/supported-languages)). The **Linux Consumption** plan stops at Node.js 22, so it can't run this adapter (it requires Node.js 24); use Flex Consumption, Premium or a Dedicated (App Service) plan. If your region doesn't offer Node.js 24 on Flex Consumption yet, deployment fails with a runtime error. The template's `nodeVersion` parameter is there for when a later version is available, not to go below 24.

**Cold starts.** A cold start delays the sync pixel, not the page, and Prebid.js reads the cookie when the pixel loads. If cold starts matter, configure always-ready instances on the Flex Consumption plan (`alwaysReady` in `functionAppConfig.scaleAndConcurrency`), which costs a baseline, or use a Premium plan.

## Build

From a clone of this repository:

```sh
npm ci
npm run build                                       # compiles core and the modules
npm run bundle -w @sharedid-edge/azure-functions    # packages/adapters/azure-functions/deploy/
cd packages/adapters/azure-functions/deploy
npm install --omit=dev                              # @azure/functions, the v4 programming model library
```

`deploy/` is the whole function app:

| File | |
| --- | --- |
| `sharedid-edge.mjs` | The function: `src/functions.ts` with core and the built-in modules, in one minified ESM file (about 14 KB gzipped; the bundle step fails it over 32 KB). |
| `host.json` | `extensions.http.routePrefix` is empty, so the route is the URL path (`/_sid/…`, not `/api/_sid/…`). Request telemetry is turned down; see [Logging](#logging). |
| `package.json` | `main` is the bundle; its one dependency is `@azure/functions`. That library isn't bundled: it reaches the Functions worker through a module only the worker provides. |

Rebuild and bundle after updating the code.

## Deploy the infrastructure

[`infra/main.bicep`](infra/main.bicep) creates, in the resource group you deploy to:

- a storage account (managed identity only, no keys) and a Flex Consumption plan;
- the function app (Node.js 24, system-assigned identity, https only) with every `SID_*` setting as an app setting and the [access restriction](#origin-lock-only-your-front-door);

and, on your existing Front Door profile (possibly in another resource group, through [`infra/frontdoor.bicep`](infra/frontdoor.bicep)):

- an origin group and an origin for the function app;
- a rule set that sets `x-sid-country` to Front Door's `{geo_country}` (`addCountryHeader`, on by default);
- a route for `/_sid` and `/_sid/*` (from `sidBasePath`) on your custom domains, HTTPS only, with caching off.

The template checks `sidBasePath` and normalizes it as SharedID Edge does ([`infra/basepath.bicep`](infra/basepath.bicep)), so the function's route and the Front Door route always agree:

| `sidBasePath` | `SID_BASE_PATH` on the function app | Function route | Front Door patterns |
| --- | --- | --- | --- |
| `/_sid` (the default) | `/_sid` | `_sid/{*path}` | `/_sid`, `/_sid/*` |
| `/identity` or `/identity/` | `/identity` | `identity/{*path}` | `/identity`, `/identity/*` |
| `/` | `/` | `{*path}` | `/sync`, `/sync/`, `/v1`, `/v1/`, `/optout`, `/optout/`, `/optin`, `/optin/` |

With `/`, the route takes only SharedID Edge's own four paths, not the whole site: Front Door matches the most specific pattern, so the rest of the site stays on your existing `/*` route. Anything else (no leading `/`, `//`, or characters other than letters, digits, `.`, `_`, `~`, `-` and `/`) fails the deployment with `Invalid sidBasePath`, before the function app is created or changed.

```sh
az deployment group create \
  --resource-group sharedid-edge \
  --template-file packages/adapters/azure-functions/infra/main.bicep \
  --parameters frontDoorProfileName=my-front-door frontDoorResourceGroup=my-site-rg \
               frontDoorEndpointName=my-endpoint 'customDomainNames=["www-example-com"]' \
               sidCookieDomain=.example.com sidModules=ip,geo
```

| Parameter | |
| --- | --- |
| `frontDoorProfileName`, `frontDoorResourceGroup`, `frontDoorEndpointName` | Your existing profile and endpoint. |
| `customDomainNames` | The names of the profile's custom domain resources that serve your pages (Front Door → Domains). Empty: only the endpoint's `*.azurefd.net` domain, for trying it out; cookies set there don't belong to your site. |
| `appName` | The function app's name; defaults to a unique one. |
| `sidBasePath` | `SID_BASE_PATH`; the Front Door route and the function's route follow it, normalized as in the table above. `/` serves `/sync`, `/v1`, `/optout` and `/optin` at the root. |
| `sid*` | The other [settings](#configuration), empty for the default. `sidModuleSecrets` is a secure parameter; see [Secrets](#secrets). |
| `addCountryHeader` | `true`: the country rule set (see [Platform information](#platform-information)). |
| `nodeVersion`, `maximumInstanceCount` | The Flex Consumption runtime version (`24`) and scale limit. |

Front Door matches the most specific route, so the `/_sid/*` route takes precedence over your site's `/*` route on the same domains. Route changes take a few minutes to reach every edge.

## Publish the code

```sh
cd packages/adapters/azure-functions/deploy
func azure functionapp publish <appName> --javascript
```

or, without Core Tools, zip `deploy/` (including `node_modules/`) and deploy the zip:

```sh
cd packages/adapters/azure-functions/deploy && zip -r ../sharedid-edge.zip . && cd ..
az functionapp deployment source config-zip --resource-group sharedid-edge --name <appName> --src sharedid-edge.zip
```

The function registers itself as `sharedid-edge`, with the route `_sid/{*path}` (from `SID_BASE_PATH`) and anonymous access.

## Run it locally

To try the function app on your machine with [Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local), after [building](#build) `deploy/`:

```sh
cd packages/adapters/azure-functions
cp local.settings.example.json deploy/local.settings.json
cd deploy && func start
curl -sI 'http://localhost:7071/_sid/sync?id=pubcid:test-id'
```

[`local.settings.example.json`](local.settings.example.json) lists every setting, empty for the default, with `SID_BEHIND_FRONT_DOOR=false` (no Front Door headers to trust locally) and `SID_PUBLIC_ORIGIN=http://localhost:7071` (so cookies aren't `Secure` over http). Core Tools doesn't publish `local.settings.json`. This is for trying it out only: without Front Door the endpoint isn't on your site's IP addresses.

## Origin lock: only your Front Door

Two locks, both set up by the template:

1. **Access restrictions** on the function app: the default action is *Deny*, and one rule allows the `AzureFrontDoor.Backend` service tag **with an `X-Azure-FDID` header filter** set to your profile's ID. The service tag alone would admit every Front Door profile, including other people's; the header filter narrows it to yours. Requests from anywhere else get the platform's 403 before the function runs. (Function app → Networking → Access restrictions shows the rule. Publishing isn't affected: the SCM site has its own rules.)
2. **`SID_FRONT_DOOR_ID`** in the handler: requests whose `X-Azure-FDID` isn't one of these IDs get a `403 Forbidden` without a cookie. The template sets it to your profile's ID. Several IDs can be given, comma-separated, for example while moving between profiles. This also protects deployments without access restrictions, such as a Dedicated plan where they were left off.

Find the ID under the Front Door profile's Overview ("Front Door ID"), or with `az afd profile show -g <rg> --profile-name <name> --query frontDoorId`.

## Configuration

Settings are the function app's app settings, the same `SID_*` variables as everywhere else (see the [configuration reference](../../../README.md#configuration-reference)). The template has a parameter for each (`sidCookieName` for `SID_COOKIE_NAME` and so on), and passes empty values through as "use the default". Change them by redeploying the template, or directly:

```sh
az functionapp config appsettings set -g sharedid-edge -n <appName> --settings SID_MODULES=ip,geo
```

Changing an app setting restarts the app. Configuration is read once per instance: an invalid setting makes every request return `500 SharedID Edge is misconfigured`, and the reason is logged, rather than setting wrong cookies. Changing `SID_BASE_PATH` changes the function's route too, but the Front Door route only follows if you redeploy the template with `sidBasePath`.

Read only by the Azure Functions adapter:

| Variable | Default | |
| --- | --- | --- |
| `SID_FRONT_DOOR_ID` | none (no check) | Front Door profile IDs (GUIDs), comma-separated. Requests with another or no `X-Azure-FDID` get a 403. The template sets it. |
| `SID_LOCATION_HEADERS` | none (no location) | JSON: location field → the request header a Front Door rule set adds, like `{"country":"x-sid-country"}`. Fields: `country`, `regionCode`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent`. The template sets `country` when `addCountryHeader` is on. An invalid value is a configuration error. |
| `SID_PUBLIC_ORIGIN` | the request's own origin | The origin of request URLs. Behind Front Door it's `https://<app>.azurewebsites.net`; only its scheme matters (`https` makes cookies `Secure`). |
| `SID_BEHIND_FRONT_DOOR` | `true` | `false` when Front Door isn't in front (local development): `X-Azure-ClientIP` and the location headers are then ignored, since anyone could send them. Don't serve a site that way: without Front Door the endpoint isn't on the site's IP addresses. |

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) is an app setting. The template takes it as the `@secure()` parameter `sidModuleSecrets`, which Azure Resource Manager doesn't log or show in the deployment history:

```sh
az deployment group create ... --parameters 'sidModuleSecrets={"ec":{"passphrase":"<openssl rand -hex 32>"}}' sidModules=ip,ec
```

App settings are encrypted at rest, but anyone who can read the function app's configuration can read them. To keep the secret in **Key Vault** instead, store it there, give the function app's identity the *Key Vault Secrets User* role on the vault, and set the setting to a Key Vault reference: `sidModuleSecrets=@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/sid-module-secrets/)`. The platform resolves the reference when the app starts, so SharedID Edge still reads a plain setting and makes no network calls. To rotate, update the secret (or the setting) and restart the app.

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'           # 200, image/gif, two set-cookie
curl -s  'https://www.example.com/_sid/v1' | jq .                        # the payload
curl -sI 'https://<appName>.azurewebsites.net/_sid/v1'                   # 403: only Front Door may call it
curl -sI -H 'X-Azure-FDID: <your id>' 'https://<appName>.azurewebsites.net/_sid/v1'   # still 403: not from Front Door
```

Then [turn it on in Prebid.js](../../../README.md#configure-prebidjs).

## Platform information

| Field | Source | Notes |
| --- | --- | --- |
| `clientIp` | `X-Azure-ClientIP` | Set by Front Door to the client's address. IPv4 or IPv6; anything that isn't an IP address is ignored. `X-Forwarded-For` and `X-Azure-SocketIP` aren't used. |
| `country` | the `country` header in `SID_LOCATION_HEADERS` (`x-sid-country` with the template) | Front Door's `{geo_country}`, which the rule set writes on every request. Empty when Front Door doesn't know it. |
| `isEU` | from `country` | `true` for the 27 EU member states (core's `EU_COUNTRY_CODES`, the meaning of Cloudflare's `isEUCountry`), `false` for other countries, unknown without a country. |
| `region`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone`, `continent` | headers in `SID_LOCATION_HEADERS`, if any | Front Door has no server variables for these, so with the template they're unknown, and the `geo` module sends only the country. They're there for a proxy in front of Front Door that adds them. |
| `traffic` | none | Front Door adds no bot verdict to the requests it forwards (its WAF bot rules can block or log, but pass nothing on), so the adapter adds nothing to the traffic signal; the `bot` module and other modules still report to it, and `SID_SKIP_BOTS` works from their reports. |

Core's `locationInfo` validates every value the same way as on the other platforms.

**The trust model.** Front Door sets `X-Azure-ClientIP` and `X-Azure-FDID` itself. The template's rule *overwrites* `x-sid-country` on every request, so a copy the visitor sends is replaced. These headers are only trustworthy because the function app accepts traffic from your Front Door profile alone ([Origin lock](#origin-lock-only-your-front-door)). If you name your own location headers in `SID_LOCATION_HEADERS`, the rule that sets them must overwrite them on every request, with no conditions, or visitors could send their own. With `SID_BEHIND_FRONT_DOOR=false`, nothing is trusted.

**GDPR.** Front Door adds no location headers by default. Without the country rule (`addCountryHeader=false`, or your own Front Door setup without it), `isEU` is always unknown, and GDPR applies only when the page sends `gdpr=1`, as on the other platforms when the location is unknown. With it, EU visitors get GDPR from their country. Either way, EEA countries outside the EU (Iceland, Liechtenstein, Norway) and the UK aren't in the list: pages there should send `gdpr=1` (the [consent rules](../../../README.md#consent-and-opt-out)).

## Cookie values

The Functions host writes `cookies[]` with ASP.NET Core's `Response.Cookies.Append`, which **percent-encodes cookie values**: anything other than letters, digits, `-`, `.`, `_` and `~` is changed (`a+b/c=` becomes `a%2Bb%2Fc%3D`). Every `Set-Cookie` has to go through `cookies[]`, because the host keeps one value per response header, so two `Set-Cookie` headers would lose one.

SharedID Edge's own cookies (`_pubcid`, `_pubcid_sv`, `_pubcid_optout`, the `ec` module's `ts-ec` and the `reflect` keeper) only use characters the host leaves alone. The **`reflect` module** re-sets other first-party cookies byte for byte, and their values may contain other characters (a `+`, `/`, `=` or `%`). The host would change such a value and break the cookie for whatever reads it. So the adapter **leaves such a cookie out** and logs its name (not its value). The cookie stays as it was in the browser, not refreshed. Cookies with plain values, like `_ga`'s `GA1.1.1234567890.1700000000`, are reflected as usual. This is the one place the adapter differs from the other platforms: the three conformance cases that reflect such a value are reported as known platform limitations.

## Logging

SharedID Edge logs nothing about requests. The Functions host logs invocations, and Application Insights, if you connect it, records a request for each invocation, **including its URL**. For `/_sid/sync` the URL includes the visitor's SharedID in the `id` parameter. The template doesn't create Application Insights, and `host.json` sets `Host.Results` (request telemetry) to `Error`. If you connect Application Insights for errors, keep it that way, or filter the URLs out with a telemetry processor. Configuration errors and failures are logged as errors, naming the setting or the error, never request data.

## Using it in code

The package exports the pieces, if you want your own entry point (other modules, a different configuration source):

```ts
import { app } from '@azure/functions';
import { resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createAzureHandler, routeFor } from '@sharedid-edge/azure-functions';

const config = resolveConfig(process.env);
app.http('sharedid-edge', {
  route: routeFor(config.basePath),
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  handler: createAzureHandler({ config, modules: [...builtInModules, myModule], frontDoorIds: ['<your id>'] })
});
```

- `createAzureHandler(options)`: the handler; options are core's `HandlerOptions` plus `publicOrigin`, `behindFrontDoor`, `frontDoorIds` and `locationHeaders`.
- `handlerFromEnv(env, modules?)` and `routeFromEnv(env)`: what the bundled entry point (`src/functions.ts`) uses.
- `routeFor(basePath)` and `frontDoorPatterns(basePath)`: the function's route template and the Front Door route patterns for a base path, as the templates build them (for your own infrastructure code); `platformInfo(headers, options?)`, `clientIp(headers)`, `parseSetCookie(header)`, `preservedByHost(value)`, `parseLocationHeaders(json)`, `parseFrontDoorIds(list)`, `EU_COUNTRY_CODES`.
- `AzureHttpRequest`, `AzureHttpResponseInit`, `AzureCookie`: minimal structural types; `@azure/functions`' `HttpRequest` is assignable, and the package doesn't depend on it at run time (it's an optional peer dependency for `src/functions.ts`).

## Testing without an Azure account

Nothing here needs an account:

- `npm test -w @sharedid-edge/azure-functions`: unit tests with requests built by `@azure/functions`' own `HttpRequest` (in its test mode), shaped as Front Door delivers them (`test/requests.ts`), and checks on the Bicep templates and `local.settings.example.json` (every `SID_*` setting passed, the base path normalized as core does with the Front Door patterns built from it, the secure parameter, the access restriction).
- `npm run conformance:azure`: bundles the function app, then runs the whole conformance suite against `deploy/sharedid-edge.mjs` behind a local stand-in for Front Door and the Functions host (`conformance/src/azure-emulator.ts`). It imports the bundle (where `@azure/functions` runs in test mode, so the bundle's registration is skipped) and calls the exported handler with `HttpRequest`s. It drops any `X-Azure-*` and location headers the client sent, sets `X-Azure-ClientIP` from the connection (or, as the cases need, from `X-Forwarded-For` when the case sets `SID_TRUST_PROXY`), `X-Azure-FDID` to the ID the handler is configured with, and the cases' Cloudflare-style location headers as rule-set headers named in `SID_LOCATION_HEADERS`. It sends only paths the function's route template matches (others get the host's 404), and writes `cookies[]` the way the host does, percent-encoding values. 122 of the 125 cases pass. The other three re-set a cookie value with `%`, `+`, `/` and `=`, which the adapter leaves out ([Cookie values](#cookie-values)); the runner reports them as known platform limitations.
- CI builds the Bicep templates with `az bicep build`, which needs no login.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

What these don't cover, and a first deployment should check:

- the template against Azure (resource API versions, the Flex Consumption runtime list in your region, the access restriction with its header filter);
- the real host:
  - the request URL it passes, including the encoded `id` parameter;
  - its cookie serialization, which the stand-in models on ASP.NET Core's;
  - the route template with the root base path;
- Front Door's real headers: `X-Azure-ClientIP` for IPv6 clients, and `{geo_country}` in the rule set;
- `func azure functionapp publish` with the bundle;
- cold-start latency.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's page or 404 | The route isn't on the custom domain that serves the page (`customDomainNames`), its patterns don't match `SID_BASE_PATH`, or the route hasn't propagated yet (a few minutes). |
| 404 from the function app, with an empty body | The function isn't published, `host.json` isn't the one from `deploy/` (the route then starts with `/api`), or the path isn't under `SID_BASE_PATH`. |
| 403 from the function app (an HTML page) | The access restriction refused the request: it didn't come through your Front Door profile. Expected when you call `<app>.azurewebsites.net` directly. |
| `403 Forbidden` (plain text) | `SID_FRONT_DOOR_ID` doesn't match the profile's `X-Azure-FDID`: check the profile's Front Door ID. |
| 500 `SharedID Edge is misconfigured` | An invalid setting; the reason is in the function app's logs (Log stream, or Application Insights traces). |
| `/_sid/v1` has no `ortb2.device.ip` with `SID_MODULES=ip` | `SID_BEHIND_FRONT_DOOR` is `false`, or consent rules it out (`ext.modules.ip.status` is `empty`). |
| EU visitors get cookies without consent | No country: the rule set isn't on the route, or `SID_LOCATION_HEADERS` doesn't name its header. See `X-SharedID-Status`, and send `gdpr=1` from the page if you don't use the rule. |
| A reflected cookie isn't refreshed, and the log says "Azure Functions would percent-encode its value" | Expected for values with characters other than letters, digits, `-`, `.`, `_` and `~`: see [Cookie values](#cookie-values). |
| Cookie set but gone after a week in Safari | `/_sid/*` isn't on the Front Door endpoint and domain that serve your pages. Run `verify-deployment`. |
| Deployment fails on the runtime version | Node.js 24 isn't offered on Flex Consumption in that region yet; see [Hosting plan](#hosting-plan-and-nodejs-version). |
