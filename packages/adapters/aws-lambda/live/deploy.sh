#!/usr/bin/env bash
# Deploys this project's AWS live tests (.github/workflows/e2e-aws.yml; README.md, Live tests). Not for deployers.
#
#   npm run build && npm run bundle -w @sharedid-edge/aws-lambda   # first: the function bundle, deploy/lambda.mjs
#   npm ci --prefix e2e                                             # and e2e's dependencies, for the Prebid.js bundle
#   packages/adapters/aws-lambda/live/deploy.sh
#
# Uses the AWS CLI's usual credentials (AWS_PROFILE, or the workflow's OIDC role) and AWS_REGION (default us-east-1).
# Every resource is named after SID_LIVE_PREFIX (default sharedid-e2e), so a narrowly scoped policy can allow just
# these. It creates or updates:
#
#   <prefix>-deploy-<account>   S3 bucket for the packaged function code (aws cloudformation package)
#   <prefix>                    template.yaml: the e2e settings (as the Cloudflare e2e environment), /_sid
#   <prefix>-platform           template.yaml: ip, geo, ua and bot, for scripts/check-cloudfront.ts, /_sid-platform
#   <prefix>-site               live/site.yaml: the test site's bucket and distribution, with both behaviours
#   <prefix>-conformance        template.yaml with CreateDistribution: the default configuration, its own distribution
#
# then uploads e2e/site/public (with the Prebid.js bundle) and invalidates the site's cache. The function stacks
# need the site's distribution ID (who may invoke them) and domain (the cookie domain), which exist only once the site
# stack does, so a first deployment deploys them twice. It prints the hostnames as GitHub step outputs when
# GITHUB_OUTPUT is set.
set -euo pipefail

# Git Bash on Windows: don't turn arguments like /* or /_sid into Windows paths for aws.exe.
export MSYS_NO_PATHCONV=1
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
aws="${AWS_CLI:-aws}"
prefix="${SID_LIVE_PREFIX:-sharedid-e2e}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cd "$package_dir"
# Relative paths only from here, which aws.exe on Windows also understands.
out=live/.out
mkdir -p "$out"

if [ ! -f deploy/lambda.mjs ]; then
  echo "deploy/lambda.mjs is missing: run npm run build && npm run bundle -w @sharedid-edge/aws-lambda first." >&2
  exit 1
fi

account="$("$aws" sts get-caller-identity --query Account --output text)"
deploy_bucket="$prefix-deploy-$account"

# Prints a stack's output, or nothing when the stack (or the output) doesn't exist yet.
output() {
  "$aws" cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null | sed 's/^None$//' || true
}

deploy() {
  local stack="$1" template="$2"
  shift 2
  echo "Deploying $stack"
  "$aws" cloudformation deploy --stack-name "$stack" --template-file "$template" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset \
    --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "$@"
}

if ! "$aws" s3api head-bucket --bucket "$deploy_bucket" >/dev/null 2>&1; then
  echo "Creating s3://$deploy_bucket"
  if [ "$AWS_REGION" = us-east-1 ]; then
    "$aws" s3api create-bucket --bucket "$deploy_bucket" >/dev/null
  else
    "$aws" s3api create-bucket --bucket "$deploy_bucket" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  "$aws" s3api put-public-access-block --bucket "$deploy_bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Uploads deploy/ (the bundle) and writes a template pointing at it; the Serverless transform runs in CloudFormation,
# so this needs neither SAM CLI nor sam build.
"$aws" cloudformation package --template-file template.yaml --s3-bucket "$deploy_bucket" --s3-prefix lambda \
  --output-template-file "$out/packaged.yaml" >/dev/null

# The function stacks. $1 and $2: the site's distribution ID and domain, empty on a first deployment (no invoke
# permission yet, and host-only cookies until the second pass).
deploy_functions() {
  local distribution="$1" domain="$2" cookie_domain public_origin='' uid1_domain=''
  cookie_domain="${domain:-host-only}"
  # The site's origin, since CloudFront sends the function URL's host, not the site's (README.md, The site's host).
  if [ -n "$domain" ]; then
    public_origin="https://$domain"
    uid1_domain="\"domain\":\"$domain\","
  fi
  # As the Cloudflare e2e environment (packages/adapters/cloudflare/wrangler.jsonc, env.e2e): no pixel caching,
  # reflect with uid1 and _ga, and clickid; the cookie domain is the distribution's own (see README.md, Live tests).
  deploy "$prefix" "$out/packaged.yaml" \
    "DistributionId=$distribution" "SidCookieDomain=$cookie_domain" "SidPublicOrigin=$public_origin" \
    SidSyncCacheSeconds=0 SidModules=reflect,clickid \
    "SidModuleConfig={\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,$uid1_domain\"httpOnly\":false,\"restore\":true},{\"name\":\"_ga\",\"maxAgeDays\":400,\"restore\":true}]}}"
  # The modules that read what CloudFront adds (scripts/check-cloudfront.ts), with an allowed origin for CORS.
  deploy "$prefix-platform" "$out/packaged.yaml" \
    "DistributionId=$distribution" "SidCookieDomain=$cookie_domain" "SidPublicOrigin=$public_origin" SidBasePath=/_sid-platform \
    SidModules=ip,geo,ua,bot SidAllowedOrigins=https://allowed.example
}

distribution="$(output "$prefix-site" DistributionId)"
domain="$(output "$prefix-site" DistributionDomainName)"
deploy_functions "$distribution" "$domain"

deploy "$prefix-site" live/site.yaml \
  "SidOriginDomainName=$(output "$prefix" OriginDomainName)" \
  "SidOriginAccessControlId=$(output "$prefix" OriginAccessControlId)" \
  "PlatformOriginDomainName=$(output "$prefix-platform" OriginDomainName)" \
  "PlatformOriginAccessControlId=$(output "$prefix-platform" OriginAccessControlId)"

if [ -z "$distribution" ]; then
  distribution="$(output "$prefix-site" DistributionId)"
  domain="$(output "$prefix-site" DistributionDomainName)"
  deploy_functions "$distribution" "$domain"
fi

# The conformance suite's default-configuration cases need /_sid with the defaults, on a hostname of its own: the
# template's own CreateDistribution path. Its default behaviour goes to the site bucket, which refuses it (403); the
# cases only use /_sid/*.
deploy "$prefix-conformance" "$out/packaged.yaml" \
  CreateDistribution=true "SiteOriginDomainName=$(output "$prefix-site" BucketRegionalDomainName)" SidCookieDomain=host-only

# The test site: the page and the Prebid.js bundle, as on e2e.sharedid.dev.
(cd "$repo_root" && npm run bundle-prebid --prefix e2e >/dev/null)
bucket="$(output "$prefix-site" BucketName)"
# s3 sync needs a path aws.exe can read: relative to the repository root.
(cd "$repo_root" && "$aws" s3 sync e2e/site/public "s3://$bucket" --delete --no-progress)
invalidation="$("$aws" cloudfront create-invalidation --distribution-id "$distribution" --paths '/*' --query Invalidation.Id --output text)"
echo "Waiting for invalidation $invalidation"
"$aws" cloudfront wait invalidation-completed --distribution-id "$distribution" --id "$invalidation"

conformance_domain="$(output "$prefix-conformance" DistributionDomainName)"
echo "Site:        https://$domain/"
echo "Conformance: https://$conformance_domain/_sid"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "site=https://$domain"
    echo "cookie-domain=$domain"
    echo "conformance=https://$conformance_domain"
    echo "distribution=$distribution"
    echo "platform-function-url=$(output "$prefix-platform" FunctionUrl)"
  } >> "$GITHUB_OUTPUT"
fi
