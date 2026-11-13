# @sharedid-edge/aws-lambda

For opt-in reference-data refreshes, see [Scheduled data updates: AWS](../../../docs/data-updates.md#aws-eventbridge-and-a-separate-update-function): a separate EventBridge-triggered updater writes private S3 snapshots; a custom request entry point polls them read-only. The default template and request bundle are unchanged.

[SharedID Edge](../../../README.md) on AWS: a Lambda function behind a `/_sid/*` behaviour of the CloudFront distribution that serves your site. It's the same platform-neutral handler as the Cloudflare Worker and the Node.js server, with built-in modules `ip`, `geo`, `reflect`, `bot`, `ua` and `clickid` (`ec` and vendor modules are added at build time), and it passes the same conformance suite.

This is the full guide. The other platforms are listed under [Pick your platform](../../../README.md#pick-your-platform).

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy](#deploy)
- [Add the behaviour to an existing distribution](#add-the-behaviour-to-an-existing-distribution)
- [A new distribution](#a-new-distribution)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Behind a publisher's CDN (trusted upstream)](#behind-a-publishers-cdn-trusted-upstream)
- [Verify](#verify)
- [How events map to requests and responses](#how-events-map-to-requests-and-responses)
- [Platform information](#platform-information)
- [Using it in code](#using-it-in-code)
- [Testing without an AWS account](#testing-without-an-aws-account)
- [Live tests](#live-tests)
- [Troubleshooting](#troubleshooting)
- [Lambda@Edge](#lambdaedge)

## Architecture

```text
Browser ── https://www.example.com/_sid/sync?id=pubcid:<id>
   │
   ▼
CloudFront: your site's distribution (www.example.com)
   ├─ /_sid/*  → origin: the function URL, signed with origin access control (SigV4)
   │             cache policy CachingDisabled; origin request policy AllViewerExceptHostHeader forwards
   │             cookies, query strings, every viewer header but Host (User-Agent, Client Hints, Origin,
   │             Sec-GPC), and CloudFront-Viewer-Address and the other viewer location headers
   └─ *        → your site's origin, unchanged
                     │
                     ▼
Lambda function URL (AuthType AWS_IAM: only your distribution may invoke it)
   └─ Node.js 24 function, handler lambda.handler (deploy/lambda.mjs)
        event (payload format 2.0) → Request → SharedID Edge handler → Response → result with cookies[]
```

- **On your site's own distribution.** Since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days. A behaviour on the distribution that serves `www.example.com` answers from the same addresses; a separate distribution, API Gateway endpoint or function URL on another hostname doesn't.
- **Only CloudFront can call the function.** The function URL uses `AWS_IAM` auth, and the resource policy allows only your distribution (`cloudfront.amazonaws.com` with your distribution's ARN). CloudFront signs each request with [origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html). This matters: the function trusts the `CloudFront-Viewer-*` headers for the client IP and location, and a visitor who could reach the URL directly could forge them. Through CloudFront they can't; CloudFront sets those headers itself.
- **Nothing cached.** Responses carry per-visitor cookies, so the behaviour uses the managed `CachingDisabled` policy. The handler also sends `Cache-Control: no-store` or `private`.

## Prerequisites

- A CloudFront distribution serving your site over https, and its ID (like `E2ABCDEFGHIJKL`). Or, to try it out, let the template create one ([A new distribution](#a-new-distribution)).
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), configured with credentials (`aws configure`) that can create CloudFormation stacks, Lambda functions and permissions, IAM roles, CloudWatch log groups, and CloudFront origin access controls and origin request policies.
- Node.js 24 or later and npm, to build.

## Build

From the repository root:

```sh
npm ci
npm run build                                  # compiles core and the modules
npm run bundle -w @sharedid-edge/aws-lambda    # bundles the function into packages/adapters/aws-lambda/deploy/lambda.mjs
```

The bundle is a single ESM file with no dependencies (about 19 KB gzipped, minified; CI fails it over 32 KB). There's no `sam build` step: the template's `CodeUri` is `deploy/` (the bundle alone), and `sam deploy` zips it as it is. Rebuild and bundle after updating the code.

**`ec` and vendor modules (opt-in).** The bundle has the built-in modules (`ip`, `geo`, `reflect`, `bot`, `ua`, `clickid`). [`ec`](../../vendor-modules/ec/README.md) (Trusted Server Edge Cookies, whose ID is derived from the IP address) and [vendor modules](../../vendor-modules/README.md) aren't in it: add each with `--module <package>#<export>`, in place of `npm run bundle -w @sharedid-edge/aws-lambda`:

```sh
npm run bundle -w @sharedid-edge/aws-lambda -- --module @sharedid-edge/module-ec#ecModule
```

Then list it in `SID_MODULES`, with its settings and secrets (the [`ec` README](../../vendor-modules/ec/README.md#turning-it-on)). Without `--module`, `SID_MODULES=ec` reports `ec` as `skipped` (`not installed`) and sets no `ts-ec`. `ec` used to be built in: if you deploy it, add `--module` to your build before you next bundle. The bundle's size is reported but the 32 KB budget isn't enforced with opt-in modules; `--bowser` and `--module` can be combined.

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` (`sua`, `devicetype`, `make`, `model`, `os`, `osv`) for Safari, Firefox, TVs and other browsers that send no Client Hints. It isn't in the default bundle, to keep it small. `npm run bundle:bowser -w @sharedid-edge/aws-lambda` (in place of `bundle`; same `deploy/lambda.mjs`, so `sam deploy` is unchanged) builds it in, then `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns it on. The cost, minified and gzipped, against the 32 KB budget CI checks for both builds:

| Bundle | Default (no Bowser) | With Bowser |
| --- | --- | --- |
| Lambda (`deploy/lambda.mjs`) | 18.9 KB | 27.4 KB |

## Deploy

```sh
cd packages/adapters/aws-lambda
sam deploy --guided
```

The prompts:

| Prompt | Answer |
| --- | --- |
| Stack name | e.g. `sharedid-edge`. Resource names derive from it. |
| AWS Region | Any; the function URL is a regional origin. Closer to most of your visitors is a little faster. |
| `CreateDistribution` | `false` (the usual case: you add the behaviour to your distribution). |
| `DistributionId` | Your distribution's ID. Only it may invoke the function. |
| `SiteOriginDomainName`, `Aliases`, `AcmCertificateArn` | Leave empty unless `CreateDistribution` is `true`. |
| `SidBasePath` | `/_sid`, unless you use another path. The behaviour's path pattern is this plus `/*`. |
| `SidPublicOrigin` | Your site's origin, like `https://www.example.com`. Recommended, and needed for the `clickid` module: see [The site's host](#the-sites-host). |
| `SidCookieDomain` | **Required:** the domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), or `host-only`. See [Configure Prebid.js](../../../docs/prebid.md). |
| Other `Sid*` | The [settings](#configuration). Empty means the default. |
| `SidModuleSecrets` | Only for modules that need a secret; see [Secrets](#secrets). |
| Confirm changes, allow IAM role creation | `y`. SAM creates the function's execution role. |
| Save arguments to `samconfig.toml` | `y`. Later deploys are just `sam deploy`. |

The stack creates the function and its function URL, the two resource-policy statements that let your distribution invoke it, a log group (30 days' retention) and an origin access control. The behaviour uses two managed CloudFront policies, so the stack creates none. Its outputs:

| Output | Use |
| --- | --- |
| `OriginDomainName` | The origin to add to your distribution. |
| `OriginAccessControlId` | The origin access control to attach to that origin. |
| `OriginRequestPolicyId` | The managed `AllViewerExceptHostHeader` policy (`b689b0a8-53d0-40ab-baf2-68738e2966ac`). |
| `CachePolicyId` | The managed `CachingDisabled` policy (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`). |
| `FunctionUrl` | For reference. Calling it directly returns 403. |

`samconfig.toml` holds your parameter values, including `SidModuleSecrets` if you set it; don't commit it to a shared repository.

## Add the behaviour to an existing distribution

In the CloudFront console, open your distribution.

1. **Origins → Create origin.**
   - Origin domain: the `OriginDomainName` output (`<id>.lambda-url.<region>.on.aws`).
   - Protocol: HTTPS only.
   - Origin access: *Origin access control settings*, and choose the stack's (`<stack>-lambda`).
2. **Behaviors → Create behavior.**
   - Path pattern: `/_sid/*` (or your `SidBasePath` plus `/*`).
   - Origin: the one from step 1.
   - Viewer protocol policy: *Redirect HTTP to HTTPS*.
   - Allowed HTTP methods: *GET, HEAD, OPTIONS* (`OPTIONS` for CORS preflights on `/_sid/v1`).
   - Cache policy: **CachingDisabled**.
   - Origin request policy: **AllViewerExceptHostHeader**.
   - No response headers policy, function associations or Lambda@Edge.
3. **Order:** behaviours match in order, so move `/_sid/*` above any broader pattern that would match it first.
4. Save, and wait for the distribution to deploy (a few minutes).

If you manage the distribution as code, add the same origin and cache behaviour there; the template's `Distribution` resource shows both in CloudFormation syntax. With Terraform or CDK, the values are the stack outputs above.

**Don't forward the `Host` header** to this origin (for example with `AllViewer`): with origin access control, the signed request must go to the function URL's own host. `AllViewerExceptHostHeader` forwards everything else the function reads. If you use your own origin request policy instead, it needs `CloudFront-Viewer-Address`, the location headers below, `Origin`, `Sec-GPC`, `User-Agent` and the Client Hints, which is more than CloudFront's default quota of 10 headers per policy.

## A new distribution

To try it out, or for a new site, the template can create a distribution with your site's origin as the default behaviour and `/_sid/*` going to the function:

```sh
sam deploy --guided --parameter-overrides CreateDistribution=true SiteOriginDomainName=origin.example.com
```

Without `Aliases` and `AcmCertificateArn` it answers on `<id>.cloudfront.net`, which is enough to check the function works. To serve your site, set `Aliases=www.example.com` and an ACM certificate for it in us-east-1, then point your DNS at the `DistributionDomainName` output. The default behaviour uses the managed `CachingOptimized` and `AllViewerExceptHostHeader` policies; adjust it for your site.

## Configuration

Settings are environment variables on the function, the same `SID_*` variables as everywhere else (see the [configuration reference](../../../docs/configuration.md)). The template has a parameter for each, `SidCookieName` for `SID_COOKIE_NAME` and so on, and passes empty values through as "use the default". Change them with:

```sh
sam deploy --parameter-overrides SidModules=ip SidCookieDomain=.example.com
```

(Parameters not listed keep their saved values; `sam deploy --guided` prompts for all of them.)

Two more variables are read only by the Lambda adapter:

| Variable | Default | |
| --- | --- | --- |
| `SID_PUBLIC_ORIGIN` | `https://` + `X-Forwarded-Host`, else `Host` | The origin of request URLs: your site's, like `https://www.example.com` (the template's `SidPublicOrigin`). Set it: behind CloudFront the function doesn't see your site's host (see [The site's host](#the-sites-host)). Its scheme also decides `Secure` cookies for local development ([Secure cookies](../../../docs/configuration.md#secure-cookies)). |
| `SID_BEHIND_CLOUDFRONT` | `true` | `false` when nothing is in front of the function (see [Platform information](#platform-information)). Don't use it for `/_sid/*` on a site: without CloudFront the endpoint isn't on the site's IP addresses. The template doesn't set it, since the default is right behind CloudFront. |

### The site's host

With origin access control, CloudFront must send the function URL's own hostname as `Host` (the reason for `AllViewerExceptHostHeader`), and it adds no `X-Forwarded-Host`. So, unless `SID_PUBLIC_ORIGIN` says otherwise, the function sees request URLs on `<id>.lambda-url.<region>.on.aws`, not on your site. Cookies don't mind: they belong to the host the browser asked. But anything that compares a URL with the site's host does:

- **The `clickid` module** reads landing pages only on the request's own host (and its `hosts` setting), and ignores a request whose `Referer` is on another one. Without `SID_PUBLIC_ORIGIN`, every page on your site is on another host, so it never keeps a click ID.
- **A visitor's own `X-Forwarded-Host`** reaches the function (`AllViewerExceptHostHeader` forwards it), and without `SID_PUBLIC_ORIGIN` it becomes the request URL's host. It can only change that visitor's own response, but with `SID_PUBLIC_ORIGIN` set it's ignored.

So set `SidPublicOrigin` to your site's origin (`https://www.example.com`). [`SID_HOSTS`](../../../docs/configuration.md#several-sites-from-one-deployment) (several hostnames on one distribution) needs the site's host per request instead: leave `SidPublicOrigin` empty and have CloudFront set `X-Forwarded-Host` from the viewer's `Host` (for example with a CloudFront Function on the behaviour's viewer requests), which also replaces a visitor's own.

Trusted-upstream mode, for a function behind publishers' CDNs, has its own settings and template parameters: see [Behind a publisher's CDN](#behind-a-publishers-cdn-trusted-upstream).

**Several sites on one distribution** (`SidHosts`, `SID_HOSTS`): the function picks the site from `X-Forwarded-Host`, which CloudFront doesn't add, and which `AllViewerExceptHostHeader` passes on as the visitor sent it. Add a CloudFront Function on viewer request to the `/_sid/*` behaviour that sets it from `Host`; [Amazon CloudFront and Lambda](../../../docs/hosting-companies.md#amazon-cloudfront-and-lambda) has the function. Lambda's environment variables share a 4 KB limit, so `SID_HOSTS` fits a few dozen sites.

Configuration is read once per cold start. An invalid setting makes every request return `500 SharedID Edge is misconfigured`, and the reason is logged once per cold start to the function's CloudWatch log group, rather than setting wrong cookies.

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) is set through the `SidModuleSecrets` parameter:

```sh
sam deploy --parameter-overrides 'SidModuleSecrets={"ec":{"passphrase":"<openssl rand -hex 32>"}}' SidModules=ip,ec 'SidModuleConfig={"ec":{"domain":"example.com"}}'
```

The parameter is `NoEcho`, so CloudFormation doesn't display it. Lambda stores it as an environment variable, encrypted at rest with KMS (an AWS managed key by default; set `KmsKeyArn` on the function for your own key). Anyone allowed `lambda:GetFunctionConfiguration` on the function can read it, so keep that permission to the people who deploy it.

**Why an environment variable and not Secrets Manager:** SharedID Edge reads its configuration synchronously when the function starts, and makes no network calls. Fetching from Secrets Manager or Parameter Store at start-up would add the AWS SDK or the parameters-and-secrets extension, a network call on every cold start, and a failure mode where the function can't start. The secret changes rarely, so setting it at deploy time is simpler and as safe for this use. If your policy requires Secrets Manager as the source of truth, keep the value there and pass it to `sam deploy` from it (`aws secretsmanager get-secret-value --query SecretString --output text`) when you deploy or rotate.

To rotate, deploy with the new value; new execution environments use it straight away.

## Behind a publisher's CDN (trusted upstream)

A sales house can run one function for the publishers it represents, with each publisher's CDN passing `/_sid/*` to it ([SharedID Edge for sales houses](../../../docs/sales-houses.md) has the whole setup, and the configuration for each publisher CDN). Deploy the template with its own distribution (`CreateDistribution=true`): the publishers' CDNs send `/_sid/*` to that distribution's domain (or your alias on it), and the function URL still accepts only your distribution.

Behind the publisher's CDN, the `CloudFront-Viewer-*` headers your distribution adds describe the publisher's CDN, not the visitor. So turn on trusted-upstream mode: the publisher's CDN sends a shared secret, and the visitor's IP address, country and site in headers of its own, and the function trusts those headers on requests with the secret only. Requests without it get `403 Forbidden` and no cookies.

```sh
sam deploy --parameter-overrides CreateDistribution=true \
  'SidUpstreamSecrets=["<publisher A secret>","<publisher B secret>"]' \
  SidClientIpHeader=x-sid-client-ip \
  'SidLocationHeaders={"country":"x-sid-country","regionCode":"x-sid-region"}' \
  'SidHosts={"www.pub-a.com":{"SID_COOKIE_DOMAIN":"pub-a.com"},"www.pub-b.com":{"SID_COOKIE_DOMAIN":"pub-b.com"}}'
```

- **`SidUpstreamSecrets`** (`SID_UPSTREAM_SECRETS`): a JSON array of secrets, 32 or more characters each (`openssl rand -hex 32`), one per publisher if you like. Like `SidModuleSecrets` it's `NoEcho` and stored as an encrypted environment variable ([Secrets](#secrets)).
- **`SidClientIpHeader`** and **`SidLocationHeaders`** name the headers the publishers' CDNs set; the country's is required. `SidUpstreamAuthHeader` (`x-sid-upstream-auth`) and `SidUpstreamHostHeader` (`x-forwarded-host`) can stay at their defaults.
- **The site** comes from `X-Forwarded-Host`, which picks the publisher in `SidHosts` and makes cookies `Secure` on its hostname. On AWS Emulator, the function URL doesn't hand the function a single `X-Forwarded-Host` as sent, so those conformance cases are listed as its limitation; whether Lambda function URLs on AWS pass it unchanged isn't tested yet. If the function sees another host (every request gets a 404), have the publishers' CDNs send the hostname in a header of your own, such as `X-SID-Host`, and set `SidUpstreamHostHeader=x-sid-host`.
- **Headers through your distribution:** the template's `AllViewerExceptHostHeader` origin request policy forwards the publisher CDN's headers to the function. A custom policy must forward `X-SID-Upstream-Auth`, `X-Forwarded-Host` and the client IP and location headers.

Check it: `curl -sI https://<your distribution>/_sid/v1` answers `403`; through a publisher's site, `/_sid/v1` with the `ip` and `geo` modules shows your own IP address and country. Not yet tested with a real publisher CDN in front of a real distribution and function.

## Verify

From the repository root:

```sh
npm run verify-deployment -- --site https://www.example.com
```

It checks, from outside, that `/_sid/*` resolves to the site's IP addresses (the Safari rule), that `/_sid/sync` returns the pixel and sets `_pubcid` and its recovery copy correctly, that the response isn't cached, and that `/_sid/v1` returns the payload. By hand:

```sh
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'      # 200, image/gif, two set-cookie
curl -s  'https://www.example.com/_sid/v1' | jq .                   # the payload
curl -sI "$(aws cloudformation describe-stacks --stack-name sharedid-edge --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)_sid/v1"   # 403: only CloudFront may call it
```

Then [turn it on in Prebid.js](../../../docs/prebid.md).

## How events map to requests and responses

The handler takes Lambda function URL events, which use the API Gateway HTTP API's [payload format 2.0](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html), so it also works behind an HTTP API (payload 2.0). It doesn't take REST API (payload 1.0) events.

**Event to `Request`:**

| Event | `Request` |
| --- | --- |
| `requestContext.http.method` | `method` |
| `rawPath`, `rawQueryString` | The URL's path and query, as sent (not decoded): `?id=pubcid%253A…` reaches the handler unchanged. |
| `headers` | Headers. Lambda joins repeated headers with commas. |
| `cookies[]` | The `Cookie` header, joined with `; `. Payload 2.0 moves cookies out of `headers`. |
| `body`, `isBase64Encoded` | The body (decoded from base64 if flagged), for methods other than GET and HEAD. The handler answers those with 405 anyway. |
| URL origin | `publicOrigin` (`SID_PUBLIC_ORIGIN`), else `https://` with `X-Forwarded-Host`, else `Host`, else `requestContext.domainName`. Always https: CloudFront terminates TLS, and function URLs are https-only. With origin access control `Host` is the function URL's, so set `SID_PUBLIC_ORIGIN` ([The site's host](#the-sites-host)). |

**`Response` to result:**

| `Response` | Result |
| --- | --- |
| `status` | `statusCode` |
| Headers except `Set-Cookie` | `headers` |
| Each `Set-Cookie` | One entry in `cookies[]`. Lambda doesn't support repeated headers, and joining cookies with commas breaks them; a sync sets two (`_pubcid` and `_pubcid_sv`). |
| Body | `body`. Text and JSON as UTF-8 with `isBase64Encoded: false`; anything else (the 43-byte sync GIF) as base64 with `isBase64Encoded: true`. HEAD gets an empty body. |

Unexpected errors return a generic `500 Internal error`; only the error's name is logged, never request data.

## Base path

`SID_BASE_PATH` (the template's `SidBasePath`) sets both the worker's routes and the CloudFront behaviour's path pattern (`<base path>/*`), so the two always match. The root base path, `/`, isn't supported here: a CloudFront behaviour for it would match the whole site, so the template's parameter pattern rejects it. Use a path such as `/_sid` (the default) or `/identity`.

## Platform information

The handler gets the client IP and location (`PlatformInfo`) from headers CloudFront adds when the origin request policy asks for them:

| Field | Header | Notes |
| --- | --- | --- |
| `clientIp` | `CloudFront-Viewer-Address` | `ip:port`. IPv4 is `198.51.100.10:46532`; IPv6 is accepted with brackets (`[2001:db8::1]:46532`) or without (`2001:db8::1:46532`, where the last field is the port). Anything else is ignored. |
| `country` | `CloudFront-Viewer-Country` | ISO 3166-1 alpha-2, like `FR`. |
| `region` | `CloudFront-Viewer-Country-Region` | The subdivision code without the country, like `WA` or `IDF`. |
| `city` | `CloudFront-Viewer-City` | For the `geo` module. |
| `postalCode` | `CloudFront-Viewer-Postal-Code` | For the `geo` module. |
| `metroCode` | `CloudFront-Viewer-Metro-Code` | US DMA code, for the `geo` module. |
| `latitude`, `longitude` | `CloudFront-Viewer-Latitude`, `CloudFront-Viewer-Longitude` | For the `geo` module. Both are needed; out-of-range values are dropped. |
| `timezone` | `CloudFront-Viewer-Time-Zone` | IANA name, for the `geo` module's `utcoffset`. |
| `isEU` | from `country` | `true` for the 27 EU member states, `false` for other countries, unknown without a country. |
| `traffic` | none | CloudFront adds no bot verdict, so there is none from the platform; the `bot` module and other modules still report to the traffic signal. |

Core's `locationInfo` validates the location values the same way as on the other platforms (dropping empty values, `XX`, and out-of-range coordinates). CloudFront has no continent header, so `continent` is never set on Lambda. The template's origin request policy (`AllViewerExceptHostHeader`) forwards all these headers. If you use your own policy, forward them too, or the `geo` module only gets what you forward.

**The `ua` module** reads the visitor's `User-Agent` and User-Agent Client Hints (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`, and any high-entropy hints you ask for). The template's origin request policy (`AllViewerExceptHostHeader`) forwards them. A policy that doesn't forward `User-Agent` makes CloudFront send `User-Agent: Amazon CloudFront` instead, which the module ignores, so it reports `empty`. See the [`ua` module's README](../../modules/ua/README.md#on-aws-lambda-behind-cloudfront).

- **`requestContext.http.sourceIp` is never used behind CloudFront:** it's CloudFront's address, not the visitor's. Nor is `X-Forwarded-For`.
- **`isEU`** comes from a bundled list of the 27 EU member states (`EU_COUNTRY_CODES`), the same meaning as Cloudflare's `request.cf.isEUCountry`, so both platforms treat a visitor the same way. It's EU membership, not the EEA (Iceland, Liechtenstein, Norway), the UK or Turkey. Whether GDPR applies is core's decision from the country: it applies to all of these, with or without `isEU`, unless the request says `gdpr=0` (the [consent rules](../../../docs/consent.md)). When CloudFront sends no country (the header isn't forwarded, or the location is unknown) `isEU` is unknown, as on the other platforms.
- **In trusted-upstream mode** (`SID_UPSTREAM_SECRETS`), none of the above is used: the `CloudFront-Viewer-*` headers describe the publisher's CDN. The client IP and location come from the headers `SID_CLIENT_IP_HEADER` and `SID_LOCATION_HEADERS` name, on requests carrying the secret ([Behind a publisher's CDN](#behind-a-publishers-cdn-trusted-upstream)).
- **Without CloudFront** (`SID_BEHIND_CLOUDFRONT=false`, for example behind an HTTP API on its own), the `CloudFront-Viewer-*` headers are ignored, since anyone could send them, and the client IP is `requestContext.http.sourceIp`. There's no location.

## Using it in code

The package exports the pieces, if you want your own entry point (other modules, a different configuration source):

```ts
import { resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createLambdaHandler } from '@sharedid-edge/aws-lambda';

export const handler = createLambdaHandler({
  config: resolveConfig(process.env),
  modules: [...builtInModules, myModule],
  // publicOrigin: 'https://www.example.com',
  // behindCloudFront: true
});
```

- `createLambdaHandler(options)`: the handler; options are core's `HandlerOptions` plus `publicOrigin` and `behindCloudFront`.
- `handlerFromEnv(env, modules?)`: what the bundled entry point (`src/lambda.ts`) uses: reads the variables above and turns a `ConfigError` into a 500 handler.
- `platformInfo(event, options?)`, `parseViewerAddress(value)`, `EU_COUNTRY_CODES`.
- `LambdaEventV2`, `LambdaResultV2`: minimal structural types. A full `APIGatewayProxyEventV2` from `@types/aws-lambda` is assignable; the package doesn't depend on it.

## Testing without an AWS account

Nothing here needs an account:

- `npm test -w @sharedid-edge/aws-lambda`: unit tests with recorded-style function URL events (`test/events.ts`).
- `npm run conformance:lambda`: bundles the function, then runs the whole conformance suite against `deploy/lambda.mjs` behind a local stand-in for CloudFront and the function URL (`conformance/src/lambda-emulator.ts`). It turns each HTTP request into a payload 2.0 event, moves cookies into `cookies[]`, drops any `CloudFront-Viewer-*` headers the client sent, sends the function URL's host as `Host` (as CloudFront does; the target sets `SID_PUBLIC_ORIGIN`), and adds `CloudFront-Viewer-Address` from the connection (or, as the conformance cases need, from `X-Forwarded-For` when the case sets `SID_TRUST_PROXY`), then writes the result back.
- `npm run conformance:lambda-aws-emulator`: deploys the same bundles to [AWS Emulator](https://github.com/aws/aws-emulator), AWS's open-source local emulator of the AWS APIs, and runs the suite through its Lambda function URL (`conformance/src/aws-emulator.ts`). See [On AWS Emulator](#on-aws-emulator).
- CI also runs `cfn-lint` on `template.yaml`.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

What these don't cover, and a first deployment should check: origin access control signing, the function URL's resource policy, and CloudFront's actual header values. This project checks them on a real distribution in its [live tests](#live-tests).

### On AWS Emulator

AWS Emulator runs offline, with no account, so CI runs this too (a job that isn't required yet). It's a check of the real bundle against an AWS-built Lambda runtime and function URL, where `conformance:lambda` uses this project's own stand-in. For each case file the target creates a `nodejs24.x` function from the unchanged `lambda.mjs` with the file's settings as environment variables, gives it a public function URL (`AuthType` `NONE`), runs the cases through it, and deletes it.

To run it, start the emulator first, on its default port (127.0.0.1:9297), and have the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed. On Linux, install the emulator's Debian or RPM package and run `aws-emulator` ([Getting started on Linux](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-linux.html)); on Windows and macOS, run it in Docker ([Getting started with Docker](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)). CI pins the version in `.github/workflows/ci.yml`. Then:

```sh
npm run build
npm run conformance:lambda-aws-emulator
```

The target points the AWS CLI at the emulator itself, with the credentials and certificate the emulator writes to `~/.aws/emulator/9297/`, and removes any AWS credentials from its environment, so it can't reach AWS. Set `CONFORMANCE_AWS_EMULATOR_PORT` for another port.

Nothing is in front of the function URL, so the functions run with `SID_BEHIND_CLOUDFRONT=false`, and some cases can't pass. They're listed as limitations in `conformance/src/targets.ts`:

- **No location:** that's CloudFront's, so there's no `geo` data and no GDPR from the visitor's country.
- **The client IP is the connection's,** always the loopback address in a test, so the cases that set one, for the `ip`, `ec`, `dbip` and `maxmind` modules, can't pass. This includes `module-data-stale.json`'s two successful IPv4/IPv6 fixture lookups; its empty lookup still verifies the `stale: true` report flag on the emulator.
- **No CORS or cross-site requests:** AWS Emulator refuses every request with an `Origin` header or `Sec-Fetch-Site: cross-site` (its guard against web pages driving a local emulator), so the CORS cases and the clickid module's cross-site case never reach the function. Function URLs on AWS pass them on.

Two gaps of the emulator's runtime are filled in, without changing the bundle: it runs Node.js code in an embedded JavaScript engine that has neither the Fetch API (`Headers`, `Request`, `Response`) nor WebCrypto's HMAC (`crypto.subtle.importKey` and `sign`), both in Node.js 24. `conformance/src/aws-emulator-runtime.ts` adds them, preloaded through `NODE_OPTIONS`, and adds nothing a runtime already has. AWS Emulator can't yet run the stack in `template.yaml` (its Serverless transform doesn't create the function URL), or pass CloudFront's response headers, `Set-Cookie` included, back from a function URL origin, so the CloudFront path still needs a real deployment.

## Live tests

Some things can only be checked on a real CloudFront distribution:

- that the template deploys;
- origin access control signing and the function URL's resource policy;
- the headers CloudFront actually passes: the `CloudFront-Viewer-*` address and location, `User-Agent` and the Client Hints, `Origin` and `Sec-GPC`, but not `Host`;
- the [Safari rule](#architecture), with unmodified Prebid.js on a page from the same distribution.

The [Live tests (AWS) workflow](../../../.github/workflows/e2e-aws.yml) checks them in this project's AWS test account after every merge to `main`, nightly and on demand from the Actions tab, like the [Cloudflare live tests](../cloudflare/README.md#live-tests). It never runs on pull requests, which stay account-free, and runs don't overlap, since they deploy to the same stacks. Until the `AWS_E2E_ROLE_ARN` repository variable is set, it skips with a notice.

[`live/deploy.sh`](live/deploy.sh) deploys with the AWS CLI alone. There's no SAM CLI: `aws cloudformation package` uploads the bundle, and CloudFormation runs the Serverless transform.

| Stack | What |
| --- | --- |
| `sharedid-e2e` | This package's `template.yaml` with the Cloudflare `e2e` environment's settings (no pixel caching, `reflect` with `uid1` and `_ga`, `clickid`), on `/_sid` |
| `sharedid-e2e-platform` | `template.yaml` with `SID_MODULES=ip,geo,ua,bot` and an allowed origin, on `/_sid-platform`: the modules that read what CloudFront passes |
| `sharedid-e2e-site` | [`live/site.yaml`](live/site.yaml): a private S3 bucket with the test page and its Prebid.js bundle (`e2e/site/public`), behind a distribution with S3 origin access control. Both functions' behaviours are added as [for an existing distribution](#add-the-behaviour-to-an-existing-distribution), with the managed `CachingDisabled` and `AllViewerExceptHostHeader` policies. |
| `sharedid-e2e-conformance` | `template.yaml` with `CreateDistribution=true` and the default settings, on a distribution of its own, for the conformance suite's default-configuration cases |

The packaged code goes in one more S3 bucket, `sharedid-e2e-deploy-<account>`. The script then uploads the site and invalidates its cache. The function stacks need the site distribution's ID (the only distribution allowed to invoke them) and its domain. Both exist only once the site stack does, so the first deployment deploys the function stacks twice. Then the workflow runs:

- `npm run verify-deployment -- --site https://<distribution>.cloudfront.net`.
- [`scripts/check-cloudfront.ts`](../../../scripts/check-cloudfront.ts) against `/_sid-platform`. It checks that:
  - the client IP is the address `checkip.amazonaws.com` sees;
  - there's a `device.geo` country;
  - Chrome's Client Hints become `device.sua`;
  - an allowed `Origin` gets CORS;
  - `Sec-GPC: 1` gets `denied: gpc`;
  - forged `CloudFront-Viewer-*` and `X-Forwarded-For` headers change nothing;
  - each request reaches the function (no caching);
  - the function URL refuses direct requests.
- The conformance suite's default-configuration cases, against the conformance distribution (`node conformance/dist/run.js --base-url https://<distribution>.cloudfront.net/_sid`). These cases need no client IP or location of their own. The cases that do need them run against the local stand-ins, since a live run only has the runner's real address and location. The Cloudflare live run does the same.
- The Playwright tests in [`e2e/`](../../../e2e/AGENTS.md), against the test site, in Chromium, Firefox and WebKit.

A failing run, after a merge or overnight, opens an issue, or comments on the open one.

**The cookie domain on `cloudfront.net`.** The test site has no domain of its own yet, so it's served on the distribution's `<id>.cloudfront.net` hostname. Because `cloudfront.net` is on the [Public Suffix List](https://publicsuffix.org/):

- browsers refuse cookies with `Domain=cloudfront.net`;
- Prebid.js's probe for the highest domain it can write on settles on the hostname itself, and writes `_pubcid` with `Domain=<id>.cloudfront.net`.

That's a domain cookie, not a host-only one. So `SID_COOKIE_DOMAIN` is the distribution's hostname, and so is `E2E_COOKIE_DOMAIN`; `host-only` would leave two `_pubcid` cookies. On a site's own domain, use the registrable domain as usual.

### Setting it up

In the AWS account (us-east-1). The stacks, functions, roles and buckets are all named `sharedid-*`, which is what the permissions are scoped to.

1. **The GitHub OIDC provider.** Once per account: IAM → Identity providers → Add provider. Choose OpenID Connect, with provider URL `https://token.actions.githubusercontent.com` and audience `sts.amazonaws.com`.
2. **The permission policy.** IAM → Policies → Create policy, with the JSON in [`live/iam-policy.json`](live/iam-policy.json), `ACCOUNT_ID` replaced by the account's ID.
   - It must be a customer-managed policy, because it's over IAM's 2,048-character limit for a user's inline policy.
   - It allows CloudFormation on `sharedid-*` stacks and the Serverless transform, Lambda on `sharedid-*` functions, S3 on `sharedid-*` buckets, the functions' log groups, and CloudFront distributions, origin access controls and invalidations.
   - It also allows the functions' execution roles (`sharedid-*`), with limits so the role can't grant itself more: only `AWSLambdaBasicExecutionRole` can be attached, and the roles can be passed only to Lambda.
3. **The role.** IAM → Roles → Create role → Custom trust policy, with [`live/trust-policy.json`](live/trust-policy.json) (`ACCOUNT_ID` replaced).
   - Only workflow runs on `main` of `patmmccann/sharedid-edge` may assume it: pushes, the nightly schedule, and runs started from the Actions tab on `main`.
   - A fork changes the repository in `sub`.
   - Attach the policy from step 2.
4. **The repository variables.** Under Settings → Secrets and variables → Actions → Variables (they're not secrets, since nothing here is secret), set `AWS_E2E_ROLE_ARN` to the role's ARN. `AWS_E2E_REGION` is optional (default `us-east-1`).
5. **A budget alarm** on the account is worth having. At test volumes, Lambda, CloudFront and S3 cost cents a month.

To deploy and test by hand, use credentials allowed by the same policy (a profile, say):

```sh
npm ci && npm run build && npm run bundle -w @sharedid-edge/aws-lambda
npm ci --prefix e2e
AWS_PROFILE=<profile> packages/adapters/aws-lambda/live/deploy.sh      # prints the site and conformance URLs
npm run verify-deployment -- --site https://<site>.cloudfront.net
npx tsx scripts/check-cloudfront.ts --endpoint https://<site>.cloudfront.net/_sid-platform
node conformance/dist/run.js --base-url https://<conformance>.cloudfront.net/_sid
cd e2e && E2E_BASE_URL=https://<site>.cloudfront.net E2E_COOKIE_DOMAIN=<site>.cloudfront.net npx playwright test
```

To remove everything, empty the site bucket first. Deleting a stack with a distribution takes a while, since CloudFormation disables the distribution and waits for that to deploy.

```sh
aws s3 rm s3://sharedid-e2e-site-<account> --recursive
aws cloudformation delete-stack --stack-name sharedid-e2e-conformance
aws cloudformation delete-stack --stack-name sharedid-e2e-site
aws cloudformation wait stack-delete-complete --stack-name sharedid-e2e-site
aws cloudformation delete-stack --stack-name sharedid-e2e
aws cloudformation delete-stack --stack-name sharedid-e2e-platform
aws s3 rb s3://sharedid-e2e-deploy-<account> --force
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's page or 404 | The behaviour isn't there, its path pattern doesn't match `SidBasePath`, or a broader behaviour is above it. |
| 403 `{"Message":"Forbidden"}` | The function URL refused CloudFront's request: the origin has no origin access control, the stack's `DistributionId` isn't this distribution, or the origin request policy forwards `Host`. |
| 500 `SharedID Edge is misconfigured` | An invalid setting; the reason is in the function's CloudWatch log group (`/aws/lambda/<function>`). |
| `/_sid/v1` has no `ortb2.device.ip` with `SID_MODULES=ip` | The origin request policy doesn't forward `CloudFront-Viewer-Address`, or consent rules it out (`ext.modules.ip.status` is `empty`). |
| EU visitors get cookies without consent, or the reverse | `CloudFront-Viewer-Country` isn't forwarded (GDPR is then unknown), or the page sends `gdpr=`. See `X-SharedID-Status`. |
| Responses served from cache, or one visitor's cookie on another's response | The behaviour's cache policy isn't `CachingDisabled`. |
| Cookie set but gone after a week in Safari | `/_sid/*` is not on the site's own distribution. Run `verify-deployment`. |
| The `clickid` module keeps no click IDs (`_sid_*` cookies) | `SidPublicOrigin` isn't set, so the function sees the function URL's host, not the site's ([The site's host](#the-sites-host)). |
| `403 Forbidden` (text, not JSON) behind a publisher's CDN | Trusted-upstream mode: the request doesn't carry one of `SID_UPSTREAM_SECRETS` in `X-SID-Upstream-Auth`. Check the publisher's CDN sets it, and that a custom origin request policy forwards it. |
| `404` behind a publisher's CDN | `X-Forwarded-Host` doesn't reach the function, or names a host `SidHosts` doesn't list. |
| Two cookies merged into one, or only one set | Something between CloudFront and the browser joins `Set-Cookie` headers. The function returns them separately in `cookies[]`. |

## Lambda@Edge

Future work: running the handler as a Lambda@Edge viewer-request function, at CloudFront's edge locations with no separate origin or region. The handler would answer `/_sid/*` from the trigger itself (generated responses). Lambda@Edge has different constraints: no environment variables, so configuration and secrets are bundled at deploy time; functions are deployed in us-east-1; viewer triggers are limited to 1 MB and short timeouts; and its event shape is CloudFront's, not payload 2.0. The bundle already fits. CloudFront Functions aren't suitable (no Web Crypto, no async).
