# @sharedid-edge/aws-lambda

For opt-in reference-data refreshes, see [Scheduled data updates: AWS](../../../docs/data-updates.md#aws-eventbridge-and-a-separate-update-function): a separate EventBridge-triggered updater writes private S3 snapshots; a custom request entry point polls them read-only. The default template and request bundle are unchanged.

[SharedID Edge](../../../README.md) on AWS: a Lambda function behind a `/_sid/*` behaviour of the CloudFront distribution that serves your site. It's the same platform-neutral handler as the Cloudflare Worker and the Node.js server, with built-in modules `ip`, `geo`, `reflect`, `bot`, `ua` and `clickid` (`ec` and vendor modules are added at build time), and it passes the same conformance suite.

To run it at CloudFront's edge instead, near each visitor, see [Lambda@Edge](#lambdaedge): the same handler, on the origin-request or viewer-request event of the behaviour.

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
- [Lambda@Edge](#lambdaedge): the function at CloudFront's edge, with its own guide

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

**`ec` and vendor modules (opt-in).** The bundle has the built-in modules (`ip`, `geo`, `reflect`, `bot`, `ua`, `clickid`). [`ec`](../../vendor-modules/ec/README.md) (Trusted Server Edge Cookies, whose ID is derived from the IP address), [`cmp`](../../modules/cmp/README.md) (consent from a non-TCF CMP's cookie) and [vendor modules](../../vendor-modules/README.md) aren't in it: add each with `--module <package>#<export>`, in place of `npm run bundle -w @sharedid-edge/aws-lambda`:

```sh
npm run bundle -w @sharedid-edge/aws-lambda -- --module @sharedid-edge/module-ec#ecModule
```

Then list it in `SID_MODULES`, with its settings and secrets (the [`ec` README](../../vendor-modules/ec/README.md#turning-it-on)). Without `--module`, `SID_MODULES=ec` reports `ec` as `skipped` (`not installed`) and sets no `ts-ec`. `ec` used to be built in: if you deploy it, add `--module` to your build before you next bundle. The bundle's size is reported but the 32 KB budget isn't enforced with opt-in modules; `--bowser` and `--module` can be combined.

**Bowser (opt-in).** The `ua` module's [full `User-Agent` parsing](../../modules/ua/README.md#full-parsing-with-bowser) fills `device` (`sua`, `devicetype`, `make`, `model`, `os`, `osv`) for Safari, Firefox, TVs and other browsers that send no Client Hints. It isn't in the default bundle, to keep it small. `npm run bundle:bowser -w @sharedid-edge/aws-lambda` (in place of `bundle`; same `deploy/lambda.mjs`, so `sam deploy` is unchanged) builds it in, then `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` turns it on. The cost, minified and gzipped, against the budgets CI checks (32 KB for the default build; 40 KB for the opt-in Bowser build, which adds full User-Agent parsing):

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

An upstream operator can run one function for many publishers, with each publisher's CDN passing `/_sid/*` to it ([SharedID Edge for upstream operators](../../../docs/upstream-operators.md) has the whole setup, and the configuration for each publisher CDN). Deploy the template with its own distribution (`CreateDistribution=true`): the publishers' CDNs send `/_sid/*` to that distribution's domain (or your alias on it), and the function URL still accepts only your distribution.

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

What these don't cover, and a first deployment should check: origin access control signing, the function URL's resource policy, and CloudFront's actual header values. This project checked them on a real distribution with its [live tests](#live-tests)' steps, run by hand.

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
- **The client IP is the connection's,** always the loopback address in a test, so the cases that set one, for the `ip`, `ec`, `dbip`, `maxmind` and `ip2location` modules, can't pass. This includes `module-data-stale.json`'s two successful IPv4/IPv6 fixture lookups; its empty lookup still verifies the `stale: true` report flag on the emulator.
- **No CORS or cross-site requests:** AWS Emulator refuses every request with an `Origin` header or `Sec-Fetch-Site: cross-site` (its guard against web pages driving a local emulator), so the CORS cases and the clickid module's cross-site case never reach the function. Function URLs on AWS pass them on.

Two gaps of the emulator's runtime are filled in, without changing the bundle: it runs Node.js code in an embedded JavaScript engine that has neither the Fetch API (`Headers`, `Request`, `Response`) nor WebCrypto's HMAC (`crypto.subtle.importKey` and `sign`), both in Node.js 24. `conformance/src/aws-emulator-runtime.ts` adds them, preloaded through `NODE_OPTIONS`, and adds nothing a runtime already has. AWS Emulator can't yet run the stack in `template.yaml` (its Serverless transform doesn't create the function URL), or pass CloudFront's response headers, `Set-Cookie` included, back from a function URL origin, so the CloudFront path still needs a real deployment.

## Live tests

Some things can only be checked on a real CloudFront distribution:

- that the template deploys;
- origin access control signing and the function URL's resource policy;
- the headers CloudFront actually passes: the `CloudFront-Viewer-*` address and location, `User-Agent` and the Client Hints, `Origin` and `Sec-GPC`, but not `Host`;
- the [Safari rule](#architecture), with unmodified Prebid.js on a page from the same distribution;
- GDPR for a real visitor in the EU: CloudFront's `CloudFront-Viewer-Country` for a German address deciding it.

The [Live tests (AWS) workflow](../../../.github/workflows/e2e-aws.yml) checks them in this project's AWS test account after every merge to `main`, nightly and on demand from the Actions tab, like the [Cloudflare live tests](../cloudflare/README.md#live-tests). It never runs on pull requests, which stay account-free, and runs don't overlap, since they deploy to the same stacks. It first ran green on 17 November 2026 ([the run](https://github.com/patmmccann/sharedid-edge/actions/runs/44015773690)), and its [run history](https://github.com/patmmccann/sharedid-edge/actions/workflows/e2e-aws.yml) is the result on record; see [How SharedID Edge is verified](../../../docs/verification.md#live-tests-aws). Without the `AWS_E2E_ROLE_ARN` repository variable (in a fork, say), it skips with a notice.

[`live/deploy.sh`](live/deploy.sh) deploys with the AWS CLI alone. There's no SAM CLI: `aws cloudformation package` uploads the bundle, and CloudFormation runs the Serverless transform.

| Stack | What |
| --- | --- |
| `sharedid-e2e` | This package's `template.yaml` with the Cloudflare `e2e` environment's settings (no pixel caching, `reflect` with `uid1` and `_ga`, `clickid`), on `/_sid` |
| `sharedid-e2e-platform` | `template.yaml` with `SID_MODULES=ip,geo,ua,bot` and an allowed origin, on `/_sid-platform`: the modules that read what CloudFront passes |
| `sharedid-e2e-site` | [`live/site.yaml`](live/site.yaml): a private S3 bucket with the test page and its Prebid.js bundle (`e2e/site/public`), behind a distribution with S3 origin access control. Both functions' behaviours are added as [for an existing distribution](#add-the-behaviour-to-an-existing-distribution), with the managed `CachingDisabled` and `AllViewerExceptHostHeader` policies. |
| `sharedid-e2e-conformance` | `template.yaml` with `CreateDistribution=true` and the default settings, on a distribution of its own, for the conformance suite's default-configuration cases |
| `sharedid-eu-visitor` (eu-central-1) | [`live/eu-visitor.yaml`](live/eu-visitor.yaml), deployed by [`live/eu-visitor.sh`](live/eu-visitor.sh): [the EU visitor](#the-eu-visitor), a function in Frankfurt that requests the live setups from a German address |

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
- [The EU visitor](#the-eu-visitor), after deploying it: GDPR on `/_sid` and `/_sid-platform` for a visitor in Germany.

A failing run, after a merge or overnight, opens an issue, or comments on the open one; the next green run on `main` that deployed and tested (including a re-run of the failed jobs) comments and closes it.

**The cookie domain on `cloudfront.net`.** The test site has no domain of its own yet, so it's served on the distribution's `<id>.cloudfront.net` hostname. Because `cloudfront.net` is on the [Public Suffix List](https://publicsuffix.org/):

- browsers refuse cookies with `Domain=cloudfront.net`;
- Prebid.js's probe for the highest domain it can write on settles on the hostname itself, and writes `_pubcid` with `Domain=<id>.cloudfront.net`.

That's a domain cookie, not a host-only one. So `SID_COOKIE_DOMAIN` is the distribution's hostname, and so is `E2E_COOKIE_DOMAIN`; `host-only` would leave two `_pubcid` cookies. On a site's own domain, use the registrable domain as usual.

### The EU visitor

The live runs come from GitHub's runners in the US, where GDPR doesn't apply. So that GDPR is decided by a real visitor's location, not a header set by hand, a small function in `eu-central-1` (Frankfurt), `sharedid-eu-visitor`, acts as the visitor: it makes the HTTPS requests it's given and returns, for each, the status, every `Set-Cookie`, the `X-SharedID-*` headers and the JSON body. Its outbound address is in Germany, so CloudFront and Cloudflare see a German viewer.

- **What it is:** [`live/eu-visitor.yaml`](live/eu-visitor.yaml), the stack `sharedid-eu-visitor`: a Node.js 24 function with its code inline, and an execution role with no permissions (so it can't write logs either). It holds no secrets, logs nothing and has no function URL: only `aws lambda invoke`, with the live tests' credentials, can call it. It requests `https` URLs only, at most 40 per call.
- **Deploying it:** [`live/eu-visitor.sh`](live/eu-visitor.sh), with the same credentials as `deploy.sh`; it's idempotent. The AWS live tests' `eu-visitor` job runs it on every run, then the checks; the other live workflows only invoke it.
- **The check:** [`scripts/check-eu-visitor.ts`](../../../scripts/check-eu-visitor.ts) invokes it and asserts, for each target, with no `gdpr` parameter so GDPR follows from the location: `/v1` and `/sync` without a TC string are `denied: tcf: GDPR applies and there is no TC string`, with no ID and no `Set-Cookie`; with the conformance suite's TC string that consents to Purposes 1 and 2, `/v1` returns an ID and sets `_pubcid`, and `/sync` sets the ID Prebid.js sends; where `geo` is on, `device.geo.country` is an EU member state. It first checks that Cloudflare places the function's address in the EU.
- **Where it runs:** an `eu-visitor` job in each live workflow, after its deploy and checks, against that workflow's own targets ([the shared action](../../../.github/actions/eu-visitor/action.yml)): the test site's `/_sid` and `/_sid-platform` here, `e2e.sharedid.dev` in the Cloudflare live tests, and the upstream-operator and SaaS publishers. Elsewhere it needs `AWS_E2E_ROLE_ARN` and is skipped without it. A failure fails the run like any other check.

By hand, once the stacks are deployed:

```sh
AWS_PROFILE=<profile> packages/adapters/aws-lambda/live/eu-visitor.sh
npx tsc -b packages/core packages/modules/geo      # or npm run build
AWS_PROFILE=<profile> npx tsx scripts/check-eu-visitor.ts --target https://<site>.cloudfront.net/_sid   --geo https://<site>.cloudfront.net/_sid-platform --geo https://<a site with geo>/_sid
```

### Setting it up

In the AWS account: us-east-1, and eu-central-1 for [the EU visitor](#the-eu-visitor). The stacks, functions, roles and buckets are all named `sharedid-*`, which is what the permissions are scoped to.

1. **The GitHub OIDC provider.** Once per account: IAM → Identity providers → Add provider. Choose OpenID Connect, with provider URL `https://token.actions.githubusercontent.com` and audience `sts.amazonaws.com`. If the account already has one ("A provider with this URL already exists"), reuse it and skip this step; check that its audiences include `sts.amazonaws.com`, and add it if not.
2. **The permission policy.** IAM → Policies → Create policy, with the JSON in [`live/iam-policy.json`](live/iam-policy.json), `ACCOUNT_ID` replaced by the account's ID.
   - It must be a customer-managed policy, because it's over IAM's 2,048-character limit for a user's inline policy.
   - It allows CloudFormation on `sharedid-*` stacks and the Serverless transform, Lambda on `sharedid-*` functions, S3 on `sharedid-*` buckets, the functions' log groups, and CloudFront distributions, origin access controls and invalidations.
   - CloudFormation stacks and Lambda functions are allowed in us-east-1 and eu-central-1 (the `Stacks` and `Functions` statements), the latter for the EU visitor's stack and function only by name (`sharedid-*`). Everything else is in us-east-1. The EU visitor's execution role is a `sharedid-*` role, already covered (IAM is global), and it has no log group. A policy from before the EU visitor lacks the eu-central-1 resources: update it (IAM → Policies → the policy → Edit → a new default version) with the current file.
   - It also allows the functions' execution roles (`sharedid-*`), with limits so the role can't grant itself more: only `AWSLambdaBasicExecutionRole` can be attached, and the roles can be passed only to Lambda.
3. **The role.** IAM → Roles → Create role → Custom trust policy, with [`live/trust-policy.json`](live/trust-policy.json) (`ACCOUNT_ID` replaced).
   - Only workflow runs on `main` of `patmmccann/sharedid-edge` may assume it: pushes, the nightly schedule, and runs started from the Actions tab on `main`.
   - The token's `sub` claim names the repository in one of two forms, and the policy lists both. The classic form is `repo:patmmccann/sharedid-edge:ref:refs/heads/main`. A repository that uses GitHub's immutable subjects adds the owner's and the repository's numeric IDs, which don't change if either is renamed: `repo:patmmccann@1683175/sharedid-edge@1452979248:ref:refs/heads/main`. This repository issues the immutable form; with only the classic one, `configure-aws-credentials` fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity".
   - To see which form a repository issues, run `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`: `"use_immutable_subject": true` means the immutable form, and `sub_claim_prefix` shows the IDs.
   - A fork changes the repository in `sub`: its owner, name and IDs, in whichever form it issues.
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
aws cloudformation delete-stack --stack-name sharedid-eu-visitor --region eu-central-1
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

The regional function above runs in one AWS region: a visitor on another continent waits for a round trip to it on every `/_sid/v1`. With Lambda@Edge the same handler runs at CloudFront's edge, near the visitor, and answers the `/_sid/*` behaviour from the CloudFront event itself: a generated response, with no function URL, origin access control or origin to run. Everything else (the routes, the cookies, consent, the modules) is the same handler, and passes the same conformance suite.

- [Which trigger](#which-trigger)
- [What's different from the regional function](#whats-different-from-the-regional-function)
- [Build](#build-lambdaedge)
- [Deploy](#deploy-lambdaedge)
- [Add it to an existing distribution](#add-it-to-an-existing-distribution)
- [Update, roll back and remove](#update-roll-back-and-remove)
- [Verify](#verify-lambdaedge)
- [How CloudFront events map to requests and responses](#how-cloudfront-events-map-to-requests-and-responses)
- [Testing without an AWS account](#testing-lambdaedge-without-an-aws-account)
- [Live tests](#lambdaedge-live-tests)
- [Troubleshooting](#troubleshooting-lambdaedge)

CloudFront Functions aren't an option: they have no Web Crypto and no async code. Trusted-upstream mode (behind a publisher's CDN) isn't available on Lambda@Edge yet ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)); use the regional function for it.

### Which trigger

The function runs on one of two CloudFront events, chosen when you build it and when you deploy it:

| | `origin-request` (the default) | `viewer-request` |
| --- | --- | --- |
| Where it runs | CloudFront's regional edge caches (a dozen or so regions), after the edge location | Every edge location, before anything else |
| The visitor's location | Yes: the `CloudFront-Viewer-*` headers (country, region, city, …) | **None:** CloudFront adds those headers after the viewer request |
| GDPR by the visitor's country | Yes | No: GDPR applies to every visitor without a TC string (or [the client decides](#gdpr-without-a-location)) |
| The `geo` module | Yes | Refused: the build fails |
| The client IP (`ip`, `ec`) | Yes (`clientIp`) | Yes (`clientIp`) |
| Limits ([quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-lambda-at-edge)) | 30 s, a generated response up to 1 MB | 5 s, 128 MB of memory, a generated response up to 40 KB |

SharedID Edge answers in milliseconds with responses under 2 KB, so the limits don't matter here; where it runs and what it knows do:

- **Use `origin-request`** when you want GDPR decided by the visitor's location (visitors in the EU, the EEA, the UK or Turkey without a TC string get no cookie, as on every other platform), or the `geo` module. It's one hop further from the visitor than `viewer-request`, still far closer than one region.
- **Use `viewer-request`** when the page supplies consent itself: your CMP writes the TC string to the `euconsent-v2` cookie (or the page sends `gdpr_consent`) before Prebid.js calls `/_sid/sync`, so the decision never needs the country. It's the lowest latency.

#### GDPR without a location

Without a country (always on `viewer-request`; on `origin-request` when CloudFront can't place the address, or a custom origin request policy doesn't forward `CloudFront-Viewer-Country`), SharedID Edge never assumes the visitor is outside the EU. The bundle's `--gdpr-without-location` option says what happens:

- **`applies` (the default): fail closed.** GDPR applies, so without a valid TC string nothing is set and existing ID cookies are deleted (`X-SharedID-Status: denied: tcf: GDPR applies and there is no TC string`); with one, the TC string decides, as everywhere. A page can still say `gdpr=0` on calls it makes itself (`/_sid/v1`). On a site whose visitors outside the EU have no TC string, they get no server-set ID: use `origin-request` for those.
- **`client`: the client decides.** GDPR applies only when the request says so: a TC string, or `gdpr=1`. Choose it only when your CMP writes the TC string for every visitor GDPR covers before Prebid.js calls `/_sid/sync`; an EU visitor without one gets the ID. This is how the other platforms treat a request without a location.

### What's different from the regional function

- **No environment variables.** Lambda@Edge doesn't have them, so the settings are baked into the bundle when you build it, from a JSON file of the same `SID_*` settings ([Configuration](#configuration)). The build validates them as the function would, and fails on an invalid one; changing a setting means rebuilding and deploying a new version.
- **Secrets are in the code.** `SID_MODULE_SECRETS` (the `ec` module's passphrase) is baked in too, so anyone allowed `lambda:GetFunction` on the function can download it, in every region CloudFront replicates it to. Keep that permission to the people who deploy it, and keep your configuration file out of version control (`edge.config.json` is ignored here).
- **us-east-1, a numbered version.** Lambda@Edge functions are created in US East (N. Virginia), and a behaviour is associated with a published version (`…:function:<name>:<n>`), never `$LATEST` or an alias. The template publishes one whenever the code changes.
- **x86_64, 128 MB, 5 seconds.** Lambda@Edge doesn't run arm64, and viewer events allow at most 128 MB and 5 seconds; the template uses those for both events.
- **Logs in every region.** Each edge location writes to CloudWatch Logs in its nearest region, as `/aws/lambda/us-east-1.<function name>`. The handler logs nothing about requests, only a configuration error, once per cold start.
- **No function URL or origin access control.** The function runs inside CloudFront, so nothing else can call it. The behaviour still needs an origin, which is never contacted; CloudFront resolves its name before an `origin-request` function runs, so give it a real one (your site's origin).
- **The site's host is the viewer's.** The origin request policy forwards `Host`, and with `viewer-request` the function sees the viewer's request as sent, so there's no `SID_PUBLIC_ORIGIN` to set, and [`SID_HOSTS`](../../../docs/configuration.md#several-sites-from-one-deployment) picks each site's settings without a CloudFront Function. The scheme is `https` (from `CloudFront-Forwarded-Proto` on `origin-request`), which the behaviour's redirect guarantees.
- **The bundle is the same size.** About 23 KB gzipped, against the 32 KB budget every bundle has; Lambda@Edge's package limit is 50 MB.

### Build (Lambda@Edge)

From the repository root:

```sh
npm ci
npm run build
cp packages/adapters/aws-lambda/edge.config.example.json packages/adapters/aws-lambda/edge.config.json   # then set your values
npm run bundle:edge -w @sharedid-edge/aws-lambda                                          # origin-request
npm run bundle:edge -w @sharedid-edge/aws-lambda -- --event-type viewer-request           # or viewer-request
```

`edge.config.json` is a JSON object of `SID_*` settings: the same names and values as the regional function's environment variables, with `SID_MODULE_CONFIG` and the like as JSON objects if you prefer. `SID_COOKIE_DOMAIN` is required. For example:

```json
{
  "SID_COOKIE_DOMAIN": "example.com",
  "SID_MODULES": "ip,geo,reflect",
  "SID_MODULE_CONFIG": { "reflect": { "cookies": [{ "name": "uid1", "maxAgeDays": 365, "domain": "example.com", "restore": true }] } }
}
```

The bundle goes to `packages/adapters/aws-lambda/deploy-edge/edge.mjs`, alone in its directory; its handler is `edge.handler`. The build:

1. reads the file (`--config <file>` for another one) and refuses settings Lambda@Edge can't use: trusted-upstream mode (`SID_UPSTREAM_*`, `SID_CLIENT_IP_HEADER`, `SID_LOCATION_HEADERS`), and with `--event-type viewer-request`, the `geo` module (for the deployment or any `SID_HOSTS` site);
2. validates the settings as the function does, failing on any error with the setting's name;
3. bundles them into the code with `--event-type` (`origin-request` or `viewer-request`) and `--gdpr-without-location` (`applies` or `client`, [above](#gdpr-without-a-location));
4. checks the size against the 32 KB budget and Lambda@Edge's 50 MB package limit;
5. smoke-tests the bundle with a CloudFront event of that type: a first sync must set the ID and `/v1` must report no module errors, within the event's response limit. A bundle that fails is removed.

`--bowser` and `--module <package>#<export>` work as for the [regional bundle](#build). The bundle reads its settings once, when it starts; should they be invalid anyway, every request gets `500 SharedID Edge is misconfigured`, with the reason in the function's logs.

### Deploy (Lambda@Edge)

The template [`edge-template.yaml`](edge-template.yaml) creates the function (Node.js 24, x86_64, an execution role that `lambda.amazonaws.com` and `edgelambda.amazonaws.com` can assume, with basic logging) and publishes a version. In **us-east-1**, from `packages/adapters/aws-lambda`, after building:

```sh
sam deploy --guided --template-file edge-template.yaml --region us-east-1
```

| Prompt | Answer |
| --- | --- |
| Stack name | e.g. `sharedid-edge-edge`. |
| AWS Region | `us-east-1`, always. |
| `EventType` | The `--event-type` you built with: `origin-request` or `viewer-request`. |
| `CreateDistribution` | `false` to [add it to your distribution](#add-it-to-an-existing-distribution) (usual); `true` to try it on a new one, with `SiteOriginDomainName` (and optionally `Aliases`, `AcmCertificateArn`, `SidBasePath`) as for the [regional template](#a-new-distribution). |
| Allow IAM role creation | `y`. |

Outputs: `FunctionVersionArn` (the version to associate), `EventType`, and the two managed policies' IDs; with `CreateDistribution=true`, `DistributionId` and `DistributionDomainName`. Without SAM, `aws cloudformation package --template-file edge-template.yaml --s3-bucket <bucket> --output-template-file packaged.yaml` and `aws cloudformation deploy --template-file packaged.yaml --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --region us-east-1 --stack-name … --parameter-overrides EventType=…` do the same.

The first association in an account creates two service-linked roles, `AWSServiceRoleForLambdaReplicator` and `AWSServiceRoleForCloudFrontLogger`, so whoever deploys needs `iam:CreateServiceLinkedRole` once, besides `lambda:GetFunction`, `lambda:EnableReplication*` and `lambda:DisableReplication*` on the function's versions and `cloudfront:UpdateDistribution` ([Lambda@Edge permissions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-permissions.html)).

### Add it to an existing distribution

In the CloudFront console, open your distribution:

1. **Behaviors → Create behavior.**
   - Path pattern: `/_sid/*` (or your `SID_BASE_PATH` plus `/*`; the root path `/` isn't supported, as for the [regional function](#base-path)).
   - Origin: your site's origin. The function answers every request, so nothing reaches it, but CloudFront resolves its name first.
   - Viewer protocol policy: *Redirect HTTP to HTTPS*.
   - Allowed HTTP methods: *GET, HEAD, OPTIONS*.
   - Cache policy: **CachingDisabled**. Responses carry per-visitor cookies; CloudFront would otherwise cache what an `origin-request` function generates.
   - Origin request policy: **AllViewerAndCloudFrontHeaders-2022-06** (`33f36d7e-f396-46d9-90e0-52428a34d9dc`): every viewer header (`Host`, `User-Agent`, the Client Hints, `Origin`, `Sec-GPC`), cookie and query string, plus CloudFront's `CloudFront-Viewer-Address`, location headers and `CloudFront-Forwarded-Proto`. With origin access control gone, forwarding `Host` is right here. A custom policy would need more than CloudFront's default quota of 10 headers.
   - **Function associations:** for the event you built for (*Origin request* or *Viewer request*), function type *Lambda@Edge*, the `FunctionVersionArn` output (ending `:<version number>`), *Include body* off.
2. **Order:** move `/_sid/*` above any broader pattern that would match it first.
3. Save, and wait for the distribution to deploy, which takes a few minutes while CloudFront replicates the function.

As code, the template's `Distribution` resource shows the behaviour in CloudFormation syntax. With the CLI, `aws cloudfront get-distribution-config --id <id>`, add the behaviour (its `LambdaFunctionAssociations` with `EventType`, `LambdaFunctionARN` and `IncludeBody: false`) to `CacheBehaviors`, then `aws cloudfront update-distribution --id <id> --if-match <ETag> --distribution-config file://config.json`.

### Update, roll back and remove

- **Update:** rebuild with the new settings or code and redeploy the stack: a new version is published, and its ARN is the new `FunctionVersionArn`. A distribution the template created moves to it; on your own distribution, edit the behaviour's association to the new version. CloudFront replicates it within minutes.
- **Roll back:** point the association back at the previous version's ARN. Versions are kept for this.
- **Remove:** first remove the association from the behaviour (or the behaviour), then wait: CloudFront deletes the function's replicas some hours after nothing uses it, and until then the function's versions, and so the stack, can't be deleted ([deleting Lambda@Edge functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-delete-replicas.html)). Retry `aws cloudformation delete-stack` later.

### Verify (Lambda@Edge)

```sh
npm run verify-deployment -- --site https://www.example.com
curl -sI 'https://www.example.com/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie, x-amz-cf-pop
curl -s  'https://www.example.com/_sid/v1' | jq .
```

With `viewer-request` and the default `--gdpr-without-location applies`, a request without a TC string answers `X-SharedID-Status: denied: tcf: GDPR applies and there is no TC string` and sets no cookie; add `gdpr=0` to the URL (`/_sid/v1?gdpr=0`) to see an ID. Then [turn it on in Prebid.js](../../../docs/prebid.md).

### How CloudFront events map to requests and responses

`@sharedid-edge/aws-lambda/edge` exports `createEdgeHandler(options)`, which takes a CloudFront request event and returns a generated response; the bundled entry point (`src/edge-lambda.ts`) builds it from the baked settings with `edgeHandlerFromText`. `edgeOptions(build)` is the validation the bundle script runs, and `edgePlatformInfo(request, options)` the platform data. The types (`CloudFrontRequestEvent`, `CloudFrontResultResponse`) are structural: a full `CloudFrontRequestEvent` from `@types/aws-lambda` is assignable, and the package doesn't depend on it.

**Event to `Request`** (`Records[0].cf.request`):

| Event | `Request` |
| --- | --- |
| `method` | `method` |
| `uri`, `querystring` | The URL's path and query, as sent (not decoded). |
| `headers` | Headers. Each is a list of `{ key, value }`; repeated values are joined with `, `, and `Cookie` with `; `. |
| `body` | Not read: no route takes one, and the association doesn't include it. |
| URL origin | `https://` and the viewer's `Host` (`http://` only when `CloudFront-Forwarded-Proto` says `http`), else `config.distributionDomainName`. `SID_PUBLIC_ORIGIN` overrides it. |
| `config.eventType` | Must be the event the bundle was built for; otherwise every request is a `500` and the log says to rebuild. |

**`Response` to generated response:**

| `Response` | Generated response |
| --- | --- |
| `status` | `status`, as a string (`'200'`), with `statusDescription` when there is one. |
| Headers except `Set-Cookie` | `headers`, lowercase name to `[{ key, value }]`. Headers CloudFront refuses in a generated response (`Content-Length`, `Transfer-Encoding`, `Connection`, `Via`, `X-Amz-Cf-*` and the others in its [list](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html#function-restrictions-headers)) are left out; core sets none. |
| Each `Set-Cookie` | One entry in `headers['set-cookie']`, so each cookie stays separate. |
| Body | `body`, with `bodyEncoding` `text` for text and JSON, `base64` for anything else (the sync GIF). HEAD gets an empty body. |

**Platform information:**

| Field | `origin-request` | `viewer-request` |
| --- | --- | --- |
| `clientIp` | `cf.request.clientIp`, which CloudFront sets from the connection. Never `X-Forwarded-For`. | The same. |
| `country`, `region`, `city`, `postalCode`, `metroCode`, `latitude`, `longitude`, `timezone` | The `CloudFront-Viewer-*` headers, as for the [regional function](#platform-information). CloudFront replaces a visitor's own copies. | None. The visitor can send those headers, and CloudFront hasn't replaced them yet, so they're ignored. |
| `isEU` | From the country; `true` when there's none and `--gdpr-without-location` is `applies` (core then treats the visitor as one GDPR covers). | `true` with `applies`; unknown with `client`. |

### Testing Lambda@Edge without an AWS account

- `npm test -w @sharedid-edge/aws-lambda`: unit tests with CloudFront events shaped after AWS's examples (`test/edge-events.ts`): one `set-cookie` entry per cookie, the base64 GIF, a missing country header, a forged `X-Forwarded-For` ignored in favour of `clientIp`, IPv6, `viewer-request` ignoring forged `CloudFront-Viewer-*`, both GDPR choices, the wrong event, and the build's validation.
- `npm run conformance:lambda-edge`: bundles the function without baked settings (`--unbaked`, for the stand-in only), then runs the whole conformance suite against it behind `conformance/src/lambda-edge-emulator.ts`, a stand-in for CloudFront that builds `origin-request` events (with `CloudFront-Viewer-Address`, the location headers and `CloudFront-Forwarded-Proto`, replacing a visitor's own) and then `viewer-request` events (the visitor's headers as sent), and checks each generated response as CloudFront would (a string status from 200 to 599, lowercase header names, no headers CloudFront refuses, the event's size limit). It runs with GDPR without a location left to the client, since the cases send a location only when they need one; the default, `applies`, is unit-tested. On `viewer-request`, the cases where GDPR follows from the country, and the files that turn on `geo` (refused there), are listed as known limitations, and `trusted-upstream.json` on both.
- `npm run bundle:edge -w @sharedid-edge/aws-lambda -- --config edge.config.example.json`: the baked build of the example configuration, validated and smoke-tested (also in CI, for both events).
- CI runs `cfn-lint` on `edge-template.yaml` and `live/edge-site.yaml`.

What these don't cover: CloudFront's real events and headers, replication, the association and the deployment itself. The [live tests](#lambdaedge-live-tests) do.

### Lambda@Edge live tests

The [Live tests (AWS) workflow](../../../.github/workflows/e2e-aws.yml) has a Lambda@Edge part, the `lambda-edge` jobs. They run only when the `AWS_LAMBDA_EDGE_ENABLED` repository variable is `true` (and `AWS_E2E_ROLE_ARN` is set); until then a job prints a notice and the run stays green. [`live/deploy-edge.sh`](live/deploy-edge.sh) deploys, in us-east-1:

| Stack | What |
| --- | --- |
| `sharedid-e2e-edge` | `edge-template.yaml`, `origin-request`, with the e2e settings (no pixel caching, `reflect` with `uid1` and `_ga`, `clickid`), on `/_sid` |
| `sharedid-e2e-edge-platform` | `origin-request`, `SID_MODULES=ip,geo,ua,bot` and an allowed origin, on `/_sid-platform` |
| `sharedid-e2e-edge-viewer` | `viewer-request`, `SID_MODULES=ip,ua,bot` and an allowed origin, on `/_sid-viewer`, with GDPR applying without a location (the default) |
| `sharedid-e2e-edge-site` | [`live/edge-site.yaml`](live/edge-site.yaml): the test page in a private S3 bucket, behind a distribution with the three behaviours, [as for an existing distribution](#add-it-to-an-existing-distribution) |
| `sharedid-e2e-edge-conformance` | `edge-template.yaml` with `CreateDistribution=true` and the default settings, for the conformance suite's default-configuration cases |

Each function's settings are baked into its bundle, so the script bundles, packages and deploys each in turn. **The stacks stay up between runs:** a bundle that changed publishes a new version and the behaviour moves to it, while old versions stay, since CloudFront deletes a function's replicas only hours after nothing uses it, and a stack that's torn down every run would fail to delete. An unchanged bundle publishes nothing. Then the jobs run:

- `verify-deployment` against the site;
- [`scripts/check-cloudfront.ts`](../../../scripts/check-cloudfront.ts) against `/_sid-platform` (what CloudFront passes an `origin-request` function: the client IP, the location, the Client Hints, `Origin`, `Sec-GPC`, forged headers replaced, no caching), and with `--event viewer-request` against `/_sid-viewer` (the same without the location, and without a TC string, `denied: tcf: GDPR applies and there is no TC string`);
- the 26 default-configuration conformance cases against the conformance distribution;
- the 14 browser tests in Chromium, Firefox and WebKit against the site;
- [the EU visitor](#the-eu-visitor), from Frankfurt, against `/_sid` and `/_sid-viewer`, and with the geo check `/_sid-platform`: on `origin-request`, CloudFront's `CloudFront-Viewer-Country` at the edge decides GDPR; on `viewer-request`, GDPR applies anyway.

**Setting it up.** In addition to [Setting it up](#setting-it-up) above, once:

1. **Update the policy** with the current [`live/iam-policy.json`](live/iam-policy.json) (IAM → Policies → the policy → Edit → a new default version), `ACCOUNT_ID` replaced. Its Lambda@Edge statements:
   - `LambdaEdgeReplication`: `lambda:GetFunction`, `lambda:EnableReplication*` and `lambda:DisableReplication*` on the `sharedid-*` functions' versions (`arn:aws:lambda:us-east-1:ACCOUNT_ID:function:sharedid-*:*`), which CloudFront needs to associate and replicate them. The `Functions` statement's `lambda:*` already covers them; they're listed so the policy says what Lambda@Edge uses.
   - `LambdaEdgeServiceLinkedRoles`: `iam:CreateServiceLinkedRole` for `AWSServiceRoleForLambdaReplicator` (`replicator.lambda.amazonaws.com`) and `AWSServiceRoleForCloudFrontLogger` (`logger.cloudfront.amazonaws.com`), which the first association in the account creates. Not needed if the account already has them.
   - Everything else is already allowed: CloudFormation on `sharedid-*` stacks and the Serverless transform, the function's execution role (a `sharedid-*` role with `AWSLambdaBasicExecutionRole`, passed to Lambda), the `sharedid-*` buckets and `cloudfront:CreateDistribution` and `UpdateDistribution`.
2. **Set the repository variable** `AWS_LAMBDA_EDGE_ENABLED` to `true` (Settings → Secrets and variables → Actions → Variables).
3. Run the workflow from the Actions tab. The first run deploys the function stacks and the site twice (the e2e function's cookie domain is the site's hostname); allow up to an hour.

By hand, with credentials allowed by the same policy:

```sh
npm ci && npm run build && npm ci --prefix e2e
AWS_PROFILE=<profile> packages/adapters/aws-lambda/live/deploy-edge.sh     # prints the site and conformance URLs
npm run verify-deployment -- --site https://<site>.cloudfront.net
npx tsx scripts/check-cloudfront.ts --endpoint https://<site>.cloudfront.net/_sid-platform
npx tsx scripts/check-cloudfront.ts --endpoint https://<site>.cloudfront.net/_sid-viewer --event viewer-request
node conformance/dist/run.js --base-url https://<conformance>.cloudfront.net/_sid
cd e2e && E2E_BASE_URL=https://<site>.cloudfront.net E2E_COOKIE_DOMAIN=<site>.cloudfront.net npx playwright test
```

To remove everything: empty the site bucket, delete `sharedid-e2e-edge-conformance` and `sharedid-e2e-edge-site` (which removes the associations), wait some hours for CloudFront to delete the replicas, then delete the three function stacks.

### Troubleshooting (Lambda@Edge)

| Symptom | Check |
| --- | --- |
| `500 SharedID Edge is misconfigured` | The bundle was built for the other event (`EventType` and `--event-type` must match), or built `--unbaked`. The reason is in CloudWatch Logs, in the region of the edge location that answered (`/aws/lambda/us-east-1.<function name>`). |
| `502` or `503` from CloudFront, `LambdaValidationError` or `LambdaExecutionError` | CloudFront refused the function or its response: its [standard logs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html) give the reason in `x-edge-detailed-result-type`, and the CloudFront console's Monitoring page shows Lambda@Edge errors by region. Check the association names a numbered version, the function is x86_64 in us-east-1, and its role trusts `edgelambda.amazonaws.com`. |
| No cookie for anyone, `denied: tcf: GDPR applies and there is no TC string` | No location: a `viewer-request` function, or an origin request policy that doesn't forward `CloudFront-Viewer-Country`. See [GDPR without a location](#gdpr-without-a-location). |
| The build fails: `geo needs the visitor's location` | `geo` on `viewer-request`: build for `origin-request`, or drop it. |
| Your site's page or 404 on `/_sid/sync` | The behaviour isn't there, its path doesn't match `SID_BASE_PATH`, or a broader behaviour is above it. |
| The same ID on two visitors' responses | The behaviour's cache policy isn't `CachingDisabled`. |
| Old settings after an update | The behaviour still points at the previous version, or CloudFront is still replicating (minutes). |
