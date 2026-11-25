#!/usr/bin/env bash
# Deploys this project's live test of the Node.js server's container image as an upstream operator's endpoint
# (README.md, Live tests; .github/workflows/e2e-node-upstream.yml). Not for deployers.
#
#   npm ci && npm run build && npm ci --prefix e2e      # first
#   NODE_UPSTREAM_SECRETS_DIR=<a private folder outside the repository> \
#   packages/adapters/node/live/upstream.sh [aws|cloudflare|id5]   # aws and cloudflare by default
#
# aws (the AWS CLI's usual credentials, us-east-1; Docker):
#   - builds the image from this checkout (packages/adapters/node/Dockerfile), then live/Dockerfile.lambda on top
#     (AWS Lambda Web Adapter, so Lambda runs the image unchanged behind a function URL);
#   - pushes it to the ECR repository NODE_UPSTREAM_REPOSITORY (default sharedid-node-upstream; created when missing,
#     keeping the last 5 images), tagged with the commit;
#   - deploys the stack NODE_UPSTREAM_STACK (default sharedid-node-upstream) from live/upstream.yaml: two functions
#     from the image, each with a public function URL: <stack> with the browser tests' settings, in trusted-upstream
#     mode with the publisher in SID_HOSTS, and <stack>-conformance with the default settings.
# cloudflare (Wrangler: logged in, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID):
#   - sharedid-node-upstream-publisher: the Cloudflare recipe (packages/adapters/cloudflare/live/forward.js) on
#     NODE_UPSTREAM_SITE<prefix>/_sid/*, forwarding to the first function URL, with the e2e test page at <prefix>/;
#   - sharedid-node-upstream-conformance: the same recipe on NODE_UPSTREAM_SITE<conformance prefix>/_sid/*,
#     forwarding to the second.
#   The publisher's hostname is shared with other live setups (e2e.sharedid.dev), so this one lives under its own
#   path prefixes (default /node-upstream and /node-upstream-conformance), with SID_BASE_PATH following them.
# id5 (not run by default; after aws, which pushed this commit's image; the AWS CLI and Wrangler, as above):
#   - deploys the stack NODE_UPSTREAM_ID5_STACK (default <stack>-id5) from live/upstream-id5.yaml: one function from
#     the same image, with the browser tests' settings plus the id5 vendor module, which asks ID5's real API with
#     partner 173, ID5's test partner, and its public function URL;
#   - sharedid-node-upstream-id5-publisher: the Cloudflare recipe on NODE_UPSTREAM_SITE<id5 prefix>/_sid/* (default
#     /node-upstream-id5), forwarding to it, with the e2e test page at <id5 prefix>/.
#   The other parts' resources aren't touched.
#
# The shared secret is NODE_UPSTREAM_SECRETS_DIR/upstream-secret-node; it's created (openssl rand -hex 32) when missing,
# except in CI (CI=true), where a missing one is an error. It's never printed. Every resource is named sharedid-*.
# With GITHUB_OUTPUT set, it writes endpoint=<function URL> and conformance-endpoint=<function URL> there (aws and
# cloudflare), or id5-endpoint=<function URL> (id5).
set -euo pipefail
case "${1:-}" in
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
parts="${1:-aws cloudflare}"
for part in $parts; do
  case "$part" in aws|cloudflare|id5) ;; *) echo "Unknown part: $part (aws, cloudflare, id5)" >&2; exit 2 ;; esac
done

export MSYS_NO_PATHCONV=1
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
aws="${AWS_CLI:-aws}"
stack="${NODE_UPSTREAM_STACK:-sharedid-node-upstream}"
repository="${NODE_UPSTREAM_REPOSITORY:-sharedid-node-upstream}"
export NODE_UPSTREAM_SITE="${NODE_UPSTREAM_SITE:-e2e.sharedid.dev}"
export NODE_UPSTREAM_ZONE="${NODE_UPSTREAM_ZONE:-sharedid.dev}"
export NODE_UPSTREAM_COOKIE_DOMAIN="${NODE_UPSTREAM_COOKIE_DOMAIN:-sharedid.dev}"
export NODE_UPSTREAM_PREFIX="${NODE_UPSTREAM_PREFIX:-/node-upstream}"
export NODE_UPSTREAM_CONFORMANCE_PREFIX="${NODE_UPSTREAM_CONFORMANCE_PREFIX:-/node-upstream-conformance}"
: "${NODE_UPSTREAM_SECRETS_DIR:?}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cloudflare_dir="$repo_root/packages/adapters/cloudflare"

mkdir -p "$NODE_UPSTREAM_SECRETS_DIR"
secret_file="$NODE_UPSTREAM_SECRETS_DIR/upstream-secret-node"
if [ ! -s "$secret_file" ]; then
  if [ "${CI:-}" = true ]; then
    echo "Missing $secret_file; not creating one in CI" >&2
    exit 1
  fi
  (umask 077 && openssl rand -hex 32 > "$secret_file")
fi
secret="$(cat "$secret_file")"

output() {
  "$aws" cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

if [[ " $parts " == *" aws "* ]]; then
  account="$("$aws" sts get-caller-identity --query Account --output text)"
  registry="$account.dkr.ecr.$AWS_REGION.amazonaws.com"
  revision="$(git -C "$repo_root" rev-parse HEAD)"
  image="$registry/$repository:$revision"

  if ! "$aws" ecr describe-repositories --repository-names "$repository" >/dev/null 2>&1; then
    echo "Creating the ECR repository $repository"
    "$aws" ecr create-repository --repository-name "$repository" --image-tag-mutability MUTABLE \
      --tags Key=project,Value=sharedid-edge Key=purpose,Value=live-tests >/dev/null
    "$aws" ecr put-lifecycle-policy --repository-name "$repository" --lifecycle-policy-text \
      '{"rules":[{"rulePriority":1,"description":"Keep the last 5 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' >/dev/null
  fi

  echo "Building the image from $revision"
  (cd "$repo_root" && docker build -q -f packages/adapters/node/Dockerfile --build-arg "REVISION=$revision" -t sharedid-edge-node:live .)
  # Lambda takes single-platform images in Docker's v2 manifest format, without attestations.
  docker build -q --platform linux/amd64 --provenance=false -f "$package_dir/live/Dockerfile.lambda" \
    --build-arg BASE=sharedid-edge-node:live -t "$image" "$package_dir/live"
  "$aws" ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker push -q "$image"

  hosts="$(node "$cloudflare_dir/live/configs.mjs" node-upstream-hosts)"
  echo "Deploying $stack"
  "$aws" cloudformation deploy --stack-name "$stack" --template-file "$package_dir/live/upstream.yaml" \
    --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "ImageUri=$image" "UpstreamSecrets=[\"$secret\"]" "Hosts=$hosts" \
    "BasePath=$NODE_UPSTREAM_PREFIX/_sid" "ConformanceBasePath=$NODE_UPSTREAM_CONFORMANCE_PREFIX/_sid" >/dev/null
fi

if [[ " $parts " == *" id5 "* ]]; then
  export NODE_UPSTREAM_ID5_PREFIX="${NODE_UPSTREAM_ID5_PREFIX:-/node-upstream-id5}"
  id5_stack="${NODE_UPSTREAM_ID5_STACK:-$stack-id5}"
  account="$("$aws" sts get-caller-identity --query Account --output text)"
  revision="$(git -C "$repo_root" rev-parse HEAD)"
  # The image the aws part pushed for this commit; the id5 endpoint runs the same image, with other settings.
  if ! "$aws" ecr describe-images --repository-name "$repository" --image-ids "imageTag=$revision" >/dev/null 2>&1; then
    echo "No image for $revision in $repository: run the aws part first" >&2
    exit 1
  fi
  hosts="$(node "$cloudflare_dir/live/configs.mjs" node-upstream-id5-hosts)"
  echo "Deploying $id5_stack"
  "$aws" cloudformation deploy --stack-name "$id5_stack" --template-file "$package_dir/live/upstream-id5.yaml" \
    --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "ImageUri=$account.dkr.ecr.$AWS_REGION.amazonaws.com/$repository:$revision" \
    "UpstreamSecrets=[\"$secret\"]" "Hosts=$hosts" "BasePath=$NODE_UPSTREAM_ID5_PREFIX/_sid" >/dev/null
  id5_endpoint="$("$aws" cloudformation describe-stacks --stack-name "$id5_stack" --query "Stacks[0].Outputs[?OutputKey=='EndpointUrl'].OutputValue" --output text)"
  export NODE_UPSTREAM_ID5_ENDPOINT="$id5_endpoint"

  (
    cd "$cloudflare_dir"
    node live/configs.mjs node-upstream-id5
    # As in the cloudflare part: the secret goes up with the Worker's version, from a file removed afterwards.
    secrets_file="$NODE_UPSTREAM_SECRETS_DIR/.wrangler-secrets-id5.json"
    trap 'rm -f "$secrets_file"' EXIT
    secrets_arg="$secrets_file"
    ! command -v cygpath >/dev/null || secrets_arg="$(cygpath -w "$secrets_file")"
    (umask 077 && printf '{"SID_UPSTREAM_SECRET":"%s"}' "$secret" > "$secrets_file")
    echo "Deploying the id5 publisher on https://$NODE_UPSTREAM_SITE$NODE_UPSTREAM_ID5_PREFIX/"
    npx wrangler deploy --config live/.out/node-upstream-id5-publisher.json --secrets-file "$secrets_arg"
  )

  [ -z "${GITHUB_OUTPUT:-}" ] || echo "id5-endpoint=${id5_endpoint%/}" >> "$GITHUB_OUTPUT"
  echo "id5 endpoint:  ${id5_endpoint%/}$NODE_UPSTREAM_ID5_PREFIX/_sid (403 without the secret)"
  echo "id5 publisher: https://$NODE_UPSTREAM_SITE$NODE_UPSTREAM_ID5_PREFIX/"
  # The id5 part alone touches nothing else.
  [[ " $parts " == *" aws "* || " $parts " == *" cloudflare "* ]] || exit 0
fi

# NODE_UPSTREAM_ENDPOINT and NODE_UPSTREAM_CONFORMANCE_ENDPOINT, when set, replace the stack's function URLs (to point the
# publisher elsewhere by hand).
endpoint="${NODE_UPSTREAM_ENDPOINT:-$(output EndpointUrl)}"
conformance_endpoint="${NODE_UPSTREAM_CONFORMANCE_ENDPOINT:-$(output ConformanceUrl)}"
export NODE_UPSTREAM_ENDPOINT="$endpoint" NODE_UPSTREAM_CONFORMANCE_ENDPOINT="$conformance_endpoint"

if [[ " $parts " == *" cloudflare "* ]]; then
  cd "$cloudflare_dir"
  node live/configs.mjs node-upstream
  # Wrangler's --secrets-file, uploaded with the Worker's version, so it never runs without it; removed afterwards.
  secrets_file="$NODE_UPSTREAM_SECRETS_DIR/.wrangler-secrets.json"
  trap 'rm -f "$secrets_file"' EXIT
  secrets_arg="$secrets_file"
  ! command -v cygpath >/dev/null || secrets_arg="$(cygpath -w "$secrets_file")"
  (umask 077 && printf '{"SID_UPSTREAM_SECRET":"%s"}' "$secret" > "$secrets_file")
  echo "Deploying the publisher on https://$NODE_UPSTREAM_SITE$NODE_UPSTREAM_PREFIX/"
  npx wrangler deploy --config live/.out/node-upstream-publisher.json --secrets-file "$secrets_arg"
  echo "Deploying the conformance publisher on https://$NODE_UPSTREAM_SITE$NODE_UPSTREAM_CONFORMANCE_PREFIX/_sid/*"
  npx wrangler deploy --config live/.out/node-upstream-conformance.json --secrets-file "$secrets_arg"
  rm -f "$secrets_file"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "endpoint=${endpoint%/}" >> "$GITHUB_OUTPUT"
  echo "conformance-endpoint=${conformance_endpoint%/}" >> "$GITHUB_OUTPUT"
fi
echo "Endpoint:  ${endpoint%/}$NODE_UPSTREAM_PREFIX/_sid (403 without the secret)"
echo "Publisher: https://$NODE_UPSTREAM_SITE$NODE_UPSTREAM_PREFIX/"
