#!/bin/sh
# Waits until the stack answers through nginx: sGTM's /metrics/healthy, SharedID Edge's /_sid/v1, and the echo
# client's /metrics/sid-echo with JSON, which shows the tagging server has loaded the published container from
# CONTAINER_CONFIG. Usage: ./wait.sh [seconds], from e2e/sgtm, with the stack up (docker compose up -d).
set -eu
cd "$(dirname "$0")"
[ -f .env ] && . ./.env
host="${SITE_HOST:-www.sharedid.test}"
port="${HTTPS_PORT:-8443}"
limit="${1:-300}"
get() { curl -sk --max-time 5 --resolve "$host:$port:127.0.0.1" "https://$host:$port$1"; }
start=$(date +%s)
until get /metrics/healthy | grep -q ok && get /_sid/v1 | grep -q '^{' && get /metrics/sid-echo | grep -q '"sharedid"'; do
  if [ $(( $(date +%s) - start )) -ge "$limit" ]; then
    echo "The stack isn't ready after ${limit}s. What each path answers:"
    for path in /metrics/healthy /_sid/v1 /metrics/sid-echo; do echo "$path: $(get "$path" | head -c 300)"; done
    echo "No JSON from /metrics/sid-echo: is the container from gtm/container.json published, and CONTAINER_CONFIG its config? (README.md)"
    docker compose ps
    exit 1
  fi
  sleep 5
done
echo "ready: https://$host:$port/"
