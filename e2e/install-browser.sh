#!/usr/bin/env bash
# Installs one Playwright browser and its system packages on a CI runner, without letting an apt mirror outage fail
# the job: `playwright install --with-deps` runs apt-get, and GitHub's runners sometimes can't reach the Ubuntu mirrors
# for a while.
#
#   ./install-browser.sh chromium|firefox|webkit      (from e2e/, after npm ci)
#
# 1. apt retries each download itself (Acquire::Retries).
# 2. The whole install is tried three times, a minute apart.
# 3. If apt still fails, the browser is installed without system packages. The runner image already has most of
#    them (all of Chromium's), so the tests usually still run; if one is missing, the browser fails to launch and the
#    test step fails, saying which library.
set -u
browser="${1:?usage: install-browser.sh chromium|firefox|webkit}"

echo 'Acquire::Retries "5";' | sudo tee /etc/apt/apt.conf.d/80-retries >/dev/null

for attempt in 1 2 3; do
  if npx playwright install --with-deps "$browser"; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::Installing $browser with its system packages failed (attempt $attempt of 3); retrying in 60 s."
    sleep 60
  fi
done

echo "::warning::apt failed 3 times; installing $browser without system packages and relying on the runner image's."
npx playwright install "$browser"
