#!/usr/bin/env bash
# Installs one Playwright browser and its system packages on a CI runner, without letting an apt mirror outage fail
# the job: `playwright install --with-deps` runs apt-get, and GitHub's runners sometimes can't reach the Ubuntu mirrors
# for hours. When they can't, each apt run hangs for about 7 minutes before failing, so retrying the whole install
# runs the job out of time.
#
#   ./install-browser.sh chromium|firefox|webkit      (from e2e/, after npm ci)
#
# 1. The browser itself, from Playwright's CDN (not apt), so an apt outage doesn't stop it.
# 2. Its system packages, through apt, with a time limit: two tries of up to 3 minutes each.
# 3. If apt still fails, carry on with the runner image's packages, with a warning. The image already has most of
#    them (all of Chromium's), so the tests usually still run; if one is missing, the browser fails to launch and the
#    test step fails, naming the library.
set -u
browser="${1:?usage: install-browser.sh chromium|firefox|webkit}"

npx playwright install "$browser" || exit 1

for attempt in 1 2; do
  if timeout 180 npx playwright install-deps "$browser"; then
    exit 0
  fi
  echo "::warning::Installing $browser's system packages failed or took over 3 minutes (attempt $attempt of 2)."
done

echo "::warning::apt is unavailable; running $browser with the runner image's system packages."
