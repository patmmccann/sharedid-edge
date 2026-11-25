#!/usr/bin/env bash
# Deploys this project's Vercel live tests (.github/workflows/e2e-vercel.yml; README.md, Live tests). Not for deployers.
#
#   npm run build && npm run bundle -w @sharedid-edge/vercel        # first: the bundle, deploy/sharedid-edge.mjs
#   npm ci --prefix e2e && npm run bundle-prebid --prefix e2e       # the test page's Prebid.js bundle
#   npm ci --prefix packages/adapters/vercel/example                 # Next.js, for vercel build
#   VERCEL_TOKEN=<token> VERCEL_SCOPE=<team slug> VERCEL_LIVE_ORG_ID=<team ID> packages/adapters/vercel/live/deploy.sh
#
# Uses the Vercel CLI, pinned below, through npx, with --token and --scope on every call. (The team ID isn't passed as
# VERCEL_ORG_ID: the CLI reads that variable, and then wants VERCEL_PROJECT_ID too.) It creates, if missing, and
# deploys two projects, each the example (example/) staged by live/stage.mjs, built here with `vercel build` and
# deployed with `vercel deploy --prebuilt --prod`:
#
#   <prefix>               the test page and its Prebid.js bundle (e2e/site/public) at /, and /_sid with the e2e
#                          settings (as the Cloudflare e2e environment, plus ip and geo for check-live-site)
#   <prefix>-conformance   /_sid with the default settings, for the conformance suite's default-configuration cases
#
# <prefix> is SID_LIVE_PREFIX, default sharedid-e2e. Neither project is connected to a Git repository: the workflow
# deploys, from main only. The settings are the projects' Production environment variables (vercel env add --force).
#
# The cookie domain is the e2e project's production hostname (*.vercel.app, a public suffix; README.md, Live tests),
# which Vercel assigns on the first production deployment. A first deployment therefore deploys that project twice:
# once to learn its hostname, then with the cookie domain set to it.
#
# The tests use the projects' production domains, which Vercel's standard deployment protection leaves public; the
# per-deployment URLs it protects aren't used. It prints the hostnames, and writes them as GitHub step outputs when
# GITHUB_OUTPUT is set.
set -euo pipefail

VERCEL_CLI_VERSION=65.16.0

: "${VERCEL_TOKEN:?Set VERCEL_TOKEN}"
: "${VERCEL_SCOPE:?Set VERCEL_SCOPE, the team slug the token deploys to}"
: "${VERCEL_LIVE_ORG_ID:?Set VERCEL_LIVE_ORG_ID, that team ID}"
unset VERCEL_ORG_ID VERCEL_PROJECT_ID
export VERCEL_TELEMETRY_DISABLED=1
# Git Bash on Windows: don't turn the API paths below into Windows paths (so node gets relative paths only).
export MSYS_NO_PATHCONV=1

prefix="${SID_LIVE_PREFIX:-sharedid-e2e}"
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
example="$package_dir/example"

if [ ! -f "$package_dir/deploy/sharedid-edge.mjs" ]; then
  echo "deploy/sharedid-edge.mjs is missing: run npm run build && npm run bundle -w @sharedid-edge/vercel first." >&2
  exit 1
fi
if [ ! -d "$example/node_modules/next" ]; then
  echo "Next.js isn't installed in example/: run npm ci --prefix packages/adapters/vercel/example first." >&2
  exit 1
fi

vercel() {
  npx --yes "vercel@$VERCEL_CLI_VERSION" "$@" --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE"
}

# Everything below runs in example/, with relative paths. It goes back to how it is in the repository, whatever
# happens.
cd "$example"
trap 'node ../live/stage.mjs clean; rm -rf .vercel' EXIT

# A project's production *.vercel.app domain (the shortest, if there are several), or nothing before its first
# production deployment.
project_domain() {
  vercel api "/v9/projects/$1/domains" 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; }).on("end", () => {
      let domains = [];
      try { domains = JSON.parse(text).domains ?? []; } catch { /* none yet */ }
      const names = domains
        .filter(d => typeof d.name === "string" && d.name.endsWith(".vercel.app") && !d.redirect && !d.gitBranch)
        .map(d => d.name)
        .sort((a, b) => a.length - b.length || a.localeCompare(b));
      process.stdout.write(names[0] ?? "");
    });' || true
}

set_env() {
  vercel env add "$1" --environment production --value "$2" --force --yes >/dev/null
  echo "  $1=$2"
}

# The linked project's settings. $1: e2e or conformance; $2: the e2e project's hostname, empty before it has one.
configure() {
  echo "Production environment variables:"
  case "$1" in
    e2e)
      # As the Cloudflare e2e environment (packages/adapters/cloudflare/wrangler.jsonc, env.e2e): no pixel caching,
      # reflect with uid1 (on the cookie domain) and _ga, and clickid; plus ip and geo, which check-live-site reads, and
      # ua and bot (with missingHeaders) for the live demo's device and bot rows, with SID_SKIP_BOTS=declared: a client
      # that names itself as a bot gets none from /_sid/v1 (the e2e tests check it, with E2E_MODULES=ua,bot).
      local uid1_domain=''
      if [ -n "$2" ]; then uid1_domain="\"domain\":\"$2\","; fi
      set_env SID_COOKIE_DOMAIN "${2:-host-only}"
      set_env SID_SYNC_CACHE_SECONDS 0
      set_env SID_MODULES ip,geo,ua,bot,reflect,clickid
      set_env SID_SKIP_BOTS declared
      set_env SID_MODULE_CONFIG "{\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,$uid1_domain\"httpOnly\":false,\"restore\":true},{\"name\":\"_ga\",\"maxAgeDays\":400,\"restore\":true}]},\"bot\":{\"missingHeaders\":true}}"
      ;;
    conformance)
      # The defaults; SID_COOKIE_DOMAIN has none.
      set_env SID_COOKIE_DOMAIN host-only
      ;;
  esac
}

# Deploys the linked project's build to production; prints the production URL Vercel reports.
deploy_prebuilt() {
  vercel deploy --prebuilt --prod --yes --json "$@" | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; }).on("end", () => {
      const deployment = JSON.parse(text);
      if (deployment.readyState !== "READY") throw new Error(`Deployment ${deployment.url} is ${deployment.readyState}`);
      process.stdout.write(deployment.productionUrl ?? "");
    });'
}

# Waits up to 150 seconds for a URL to answer 200.
wait_for() {
  local status=''
  for _ in $(seq 1 30); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)"
    case "$status" in
      200) return 0 ;;
      401 | 403)
        echo "$1 answers $status. Is deployment protection on for production domains? The live tests need them public (README.md, Live tests)." >&2
        return 1 ;;
    esac
    sleep 5
  done
  echo "$1 didn't answer 200 within 150 seconds (last status: ${status:-none})." >&2
  return 1
}

# Creates (if missing), configures, builds and deploys one project; sets $host to its production hostname.
deploy_project() {
  local name="$1" kind="$2" linked_org configured url
  echo "== $name"
  node ../live/stage.mjs "$kind"
  if ! vercel project inspect "$name" >/dev/null 2>&1; then
    echo "Creating the project $name"
    vercel project add "$name"
  fi
  # Next.js, on Node.js 24.x. The example's "engines" (>=24) takes precedence on Vercel, which then uses its newest
  # Node.js major (README.md, Live tests).
  vercel project update "$name" --framework nextjs --node-version 24.x >/dev/null
  rm -rf .vercel
  vercel link --yes --project "$name" >/dev/null
  linked_org="$(node -p 'require("./.vercel/project.json").orgId')"
  if [ "$linked_org" != "$VERCEL_LIVE_ORG_ID" ]; then
    echo "The project $name is in another team than VERCEL_LIVE_ORG_ID names: check the VERCEL_SCOPE and VERCEL_ORG_ID repository variables (README.md, Live tests)." >&2
    exit 1
  fi

  configured="$(project_domain "$name")"
  configure "$kind" "$configured"
  vercel pull --yes --environment=production >/dev/null
  vercel build --prod --yes
  url="$(deploy_prebuilt)"
  host="$(project_domain "$name")"
  if [ -z "$host" ]; then host="${url#https://}"; fi
  if [ -z "$host" ]; then
    echo "Vercel reported no production domain for $name." >&2
    exit 1
  fi
  # A first deployment: now that the hostname is known, set the cookie domain to it and deploy the build again.
  if [ "$kind" = e2e ] && [ "$host" != "$configured" ]; then
    echo "The production hostname is $host: deploying again with it as the cookie domain."
    configure "$kind" "$host"
    deploy_prebuilt --force >/dev/null
  fi
}

host=''
deploy_project "$prefix" e2e
site_host="$host"
deploy_project "$prefix-conformance" conformance
conformance_host="$host"

wait_for "https://$site_host/"
wait_for "https://$site_host/_sid/v1"
wait_for "https://$conformance_host/_sid/v1"

echo "Site:        https://$site_host/"
echo "Conformance: https://$conformance_host/_sid"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "site=https://$site_host"
    echo "cookie-domain=$site_host"
    echo "conformance=https://$conformance_host"
  } >> "$GITHUB_OUTPUT"
fi
