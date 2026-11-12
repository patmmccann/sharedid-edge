# @sharedid-edge/aws-lambda

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
- [Verify](#verify)
- [How events map to requests and responses](#how-events-map-to-requests-and-responses)
- [Platform information](#platform-information)
- [Using it in code](#using-it-in-code)
- [Testing without an AWS account](#testing-without-an-aws-account)
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

The bundle is a single ESM file with no dependencies (about 19 KB gzipped, minified; CI fails it over 32 KB). There's no `sam build` step: the template's `CodeUri` is `dist/`, and `sam deploy` zips it as it is. Rebuild and bundle after updating the code.

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

Two more variables are read only by the Lambda adapter. The template doesn't set them, since the defaults are right behind CloudFront:

| Variable | Default | |
| --- | --- | --- |
| `SID_PUBLIC_ORIGIN` | `https://` + `X-Forwarded-Host`, else `Host` | The origin of request URLs. Only its scheme matters, and cookies are `Secure` for a public hostname whatever the scheme, so it matters only for local development (see [Secure cookies](../../../docs/configuration.md#secure-cookies)). |
| `SID_BEHIND_CLOUDFRONT` | `true` | `false` when nothing is in front of the function (see [Platform information](#platform-information)). Don't use it for `/_sid/*` on a site: without CloudFront the endpoint isn't on the site's IP addresses. |

Configuration is read once per cold start. An invalid setting makes every request return `500 SharedID Edge is misconfigured`, and the reason is logged once per cold start to the function's CloudWatch log group, rather than setting wrong cookies.

## Secrets

`SID_MODULE_SECRETS` (JSON secrets per module, like the `ec` module's passphrase) is set through the `SidModuleSecrets` parameter:

```sh
sam deploy --parameter-overrides 'SidModuleSecrets={"ec":{"passphrase":"<openssl rand -hex 32>"}}' SidModules=ip,ec 'SidModuleConfig={"ec":{"domain":"example.com"}}'
```

The parameter is `NoEcho`, so CloudFormation doesn't display it. Lambda stores it as an environment variable, encrypted at rest with KMS (an AWS managed key by default; set `KmsKeyArn` on the function for your own key). Anyone allowed `lambda:GetFunctionConfiguration` on the function can read it, so keep that permission to the people who deploy it.

**Why an environment variable and not Secrets Manager:** SharedID Edge reads its configuration synchronously when the function starts, and makes no network calls. Fetching from Secrets Manager or Parameter Store at start-up would add the AWS SDK or the parameters-and-secrets extension, a network call on every cold start, and a failure mode where the function can't start. The secret changes rarely, so setting it at deploy time is simpler and as safe for this use. If your policy requires Secrets Manager as the source of truth, keep the value there and pass it to `sam deploy` from it (`aws secretsmanager get-secret-value --query SecretString --output text`) when you deploy or rotate.

To rotate, deploy with the new value; new execution environments use it straight away.

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
| URL origin | `publicOrigin` (`SID_PUBLIC_ORIGIN`), else `https://` with `X-Forwarded-Host`, else `Host`, else `requestContext.domainName`. Always https: CloudFront terminates TLS, and function URLs are https-only. With origin access control the host is the function URL's, which doesn't matter: cookies without a `Domain` belong to the host the browser asked, and the handler uses only the scheme. |

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
- **`isEU`** comes from a bundled list of the 27 EU member states (`EU_COUNTRY_CODES`), the same meaning as Cloudflare's `request.cf.isEUCountry`, so both platforms treat a visitor the same way. It's EU membership, not the EEA (Iceland, Liechtenstein, Norway) or the UK: pages there should send `gdpr=1` (the [consent rules](../../../docs/consent.md)). When it's `true`, GDPR applies unless the request says `gdpr=0`. When CloudFront sends no country (the header isn't forwarded, or the location is unknown) `isEU` is unknown, as on the other platforms.
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
- `npm run conformance:lambda`: bundles the function, then runs the whole conformance suite against `deploy/lambda.mjs` behind a local stand-in for CloudFront and the function URL (`conformance/src/lambda-emulator.ts`). It turns each HTTP request into a payload 2.0 event, moves cookies into `cookies[]`, drops any `CloudFront-Viewer-*` headers the client sent, and adds `CloudFront-Viewer-Address` from the connection (or, as the conformance cases need, from `X-Forwarded-For` when the case sets `SID_TRUST_PROXY`), then writes the result back.
- CI also runs `cfn-lint` on `template.yaml`.
- Against a real deployment: `node conformance/dist/run.js --base-url https://www.example.com` runs the default-configuration cases.

What these don't cover, and a first deployment should check: origin access control signing, the function URL's resource policy, and CloudFront's actual header values.

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
| Two cookies merged into one, or only one set | Something between CloudFront and the browser joins `Set-Cookie` headers. The function returns them separately in `cookies[]`. |

## Lambda@Edge

Future work: running the handler as a Lambda@Edge viewer-request function, at CloudFront's edge locations with no separate origin or region. The handler would answer `/_sid/*` from the trigger itself (generated responses). Lambda@Edge has different constraints: no environment variables, so configuration and secrets are bundled at deploy time; functions are deployed in us-east-1; viewer triggers are limited to 1 MB and short timeouts; and its event shape is CloudFront's, not payload 2.0. The bundle already fits. CloudFront Functions aren't suitable (no Web Crypto, no async).
