#!/usr/bin/env bash
# Installs one Playwright browser and its system packages on a CI runner, without depending on the Ubuntu apt mirrors
# being up: on GitHub's runners they're sometimes unreachable, or so slow (tens of KB/s) that each apt run takes many
# minutes, for hours at a time, and the runner image lacks some of WebKit's packages (libevent-2.1-7t64, for one), so
# WebKit can't start without them.
#
#   ./install-browser.sh chromium|firefox|webkit      (from e2e/, after npm ci)
#
# CI runs it through .github/actions/install-browser, which restores and saves BROWSER_DEBS (below) with actions/cache.
#
#   BROWSER_DEBS      a directory of the .deb files the browser needs on this runner image (optional)
#   BROWSER_DEBS_KEY  its cache key: the runner image (ImageOS, ImageVersion), the browser and e2e/package-lock.json
#
# 1. The browser itself, from Playwright's CDN (not apt), so an apt outage doesn't stop it.
# 2. Its system packages. When BROWSER_DEBS was saved under BROWSER_DEBS_KEY (its `complete` file holds the key), they
#    are installed from its .deb files with no network, and apt isn't used at all.
# 3. Otherwise through apt, with time limits: `apt-get update`, then the packages Playwright says are missing
#    (`playwright install-deps --dry-run`) are downloaded into BROWSER_DEBS and installed from there, which marks it
#    complete for the cache. If the runner's mirror fails or is too slow, it tries once more against another one:
#    archive.ubuntu.com, or azure.archive.ubuntu.com when the runner already uses archive.ubuntu.com. A stopped try's
#    apt-get is stopped too, so it doesn't hold dpkg's lock, and the second try keeps the files the first downloaded.
# 4. If apt still fails, any .deb files restored from an earlier runner image's cache are installed (those newer than
#    what's installed), then the browser's executables are checked with `ldd`. When a library is missing,
#    the job fails, naming the libraries and the apt outage, in the log and the step summary, and sets the step's
#    `infrastructure` output for the live workflows' issue. When none is, it carries on with the runner image's
#    packages, with a warning: Chromium's are all in the image, and Firefox has run on them.
set -u
browser="${1:?usage: install-browser.sh chromium|firefox|webkit}"
debs="${BROWSER_DEBS:-${RUNNER_TEMP:-/tmp}/browser-debs-$browser}"
key="${BROWSER_DEBS_KEY:-}"
apt_conf="${RUNNER_TEMP:-/tmp}/install-browser-apt.conf"

npx playwright install "$browser" || exit 1

notice() { echo "::notice::$1"; }
warning() { echo "::warning::$1"; }

# Sets the step output `name` (for the live workflows' issue); a no-op outside Actions.
output() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; return 0; }

# Appends Markdown to the step summary; a no-op outside Actions.
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; return 0; }

# The .deb files in BROWSER_DEBS that are newer than what's installed: packages that aren't installed, and upgrades
# the others need (WebKit's set upgrades one of the image's packages). One from an earlier image's cache that is older
# than the installed package would be a downgrade, so it's left out.
newer_debs() {
  local deb package version installed
  for deb in "$debs"/*.deb; do
    [ -f "$deb" ] || continue
    package=$(dpkg-deb -f "$deb" Package) || continue
    version=$(dpkg-deb -f "$deb" Version) || continue
    installed=$(dpkg-query -W -f '${db:Status-Abbrev} ${Version}' "$package" 2> /dev/null | sed -n 's/^ii  *//p')
    if [ -z "$installed" ] || dpkg --compare-versions "$version" gt "$installed"; then echo "$deb"; fi
  done
}

# Installs the newer .deb files in BROWSER_DEBS. With the full set from this image, apt needs no mirror; when they need
# a package that is neither installed nor among them, apt fails before changing anything (or, if a mirror answers,
# downloads it). Not `--no-download`: apt counts reading local .deb files as a download and refuses.
install_cached_debs() {
  local -a files
  mapfile -t files < <(newer_debs)
  [ "${#files[@]}" -eq 0 ] && return 0
  apt_with_limit 120 install -y --no-install-recommends "${files[@]}"
}

# apt's settings for every call: give up on an unreachable mirror in seconds rather than minutes, and wait for dpkg's
# lock (held by an apt run that a time limit stopped and that is still exiting) instead of failing at once on it.
write_apt_conf() {
  cat > "$apt_conf" << 'EOF'
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::Retries "1";
DPkg::Lock::Timeout "120";
EOF
}

# Points apt at another Ubuntu mirror, for the second try: copies of the runner's Ubuntu sources, whose archive URIs
# (a mirror list, mirror+file:/etc/apt/apt-mirrors.txt on 26.04 images, or a mirror's URL) become archive.ubuntu.com,
# or azure.archive.ubuntu.com when the runner's first mirror is archive.ubuntu.com. Fails when there's no Ubuntu source.
use_other_mirror() {
  local parts="${RUNNER_TEMP:-/tmp}/install-browser-sources" file found=1 other='http://archive.ubuntu.com/ubuntu/'
  if grep -hs -o 'https\?://[^ ]*' /etc/apt/apt-mirrors.txt /etc/apt/sources.list.d/*.sources /etc/apt/sources.list |
    head -n 1 | grep -q '//archive\.ubuntu\.com'; then
    other='http://azure.archive.ubuntu.com/ubuntu/'
  fi
  rm -rf "$parts" && mkdir -p "$parts"
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [ ! -f "$file" ] || ! grep -Eq 'mirror\+file:|archive\.ubuntu\.com' "$file"; then continue; fi
    sed -E "s#mirror\+file:[^ ]+|https?://[a-z0-9.-]*archive\.ubuntu\.com/ubuntu/?#$other#g" "$file" > "$parts/$(basename "$file")"
    found=0
  done
  [ "$found" -eq 0 ] || return 1
  # The copies replace the sources. apt reads only *.list and *.sources files from the parts directory.
  {
    echo "Dir::Etc::SourceList \"/dev/null\";"
    echo "Dir::Etc::SourceParts \"$parts\";"
  } >> "$apt_conf"
  notice "Trying $other for $browser's system packages."
}

# Runs apt-get as root with a time limit ($1, in seconds), then stops any apt-get still running: `timeout` stops sudo,
# which may not pass the signal on, and a leftover apt-get holds dpkg's lock (#200).
apt_with_limit() {
  local limit="$1" status
  shift
  timeout -k 10 "$limit" sudo apt-get -c "$apt_conf" "$@"
  status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    warning "apt-get $1 took over $limit seconds."
    sudo pkill -TERM -x apt-get
    for _ in $(seq 30); do
      pgrep -x apt-get > /dev/null || break
      sleep 1
    done
    sudo pkill -KILL -x apt-get
  fi
  return "$status"
}

# One try through apt: refresh the package lists, ask Playwright which of the browser's packages are missing, download
# them into BROWSER_DEBS and install them from there. $1 and $2 are the time limits, in seconds, for the refresh and
# the download.
install_with_apt() {
  local dry_run
  local -a missing
  # `update` fails when any source does, third-party ones included; the dry run below says whether the lists it needs
  # are there.
  apt_with_limit "$1" update || warning "apt-get update failed."
  dry_run=$(APT_CONFIG="$apt_conf" npx playwright install-deps --dry-run "$browser" 2>&1)
  echo "$dry_run"
  # Into a new directory, so a failed download keeps what the cache restored, for step 4. A second try reuses what the
  # first downloaded.
  mkdir -p "$debs.new/partial" || return 1
  if ! grep -q 'All system dependencies are installed' <<< "$dry_run"; then
    mapfile -t missing < <(sed -n 's/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' <<< "$dry_run")
    if [ "${#missing[@]}" -eq 0 ]; then
      warning "Couldn't tell which of $browser's system packages are missing."
      return 1
    fi
    apt_with_limit "$2" install -y --download-only --no-install-recommends \
      -o Dir::Cache::archives="$debs.new" "${missing[@]}" || return 1
    # The download is what needs the mirror; the install, from the downloaded files, doesn't.
    sudo apt-get -c "$apt_conf" install -y --no-download --no-install-recommends \
      -o Dir::Cache::archives="$debs.new" "${missing[@]}" || return 1
  fi
  # apt leaves its root-only lock file and an empty partial/ behind; actions/cache can't read the lock.
  sudo rm -rf "$debs.new/lock" "$debs.new/partial" "$debs"
  sudo chown -R "$(id -u):$(id -g)" "$debs.new"
  mv "$debs.new" "$debs" || return 1
  if [ -n "$key" ]; then
    echo "$key" > "$debs/complete"
    output complete true
  fi
  return 0
}

# The shared libraries the browser's executables can't find: each "not found" in `ldd`'s output, with the browser's
# own library directories on the path, as Playwright's launcher sets them.
missing_libraries() {
  local executable root library_path
  executable=$(node -e "console.log(require('@playwright/test')[process.argv[1]].executablePath())" "$browser") || return 0
  root=$(sed -E 's#(/ms-playwright/[^/]+)/.*#\1#' <<< "$executable")
  [ -d "$root" ] || root=$(dirname "$executable")
  library_path=$(find "$root" -name '*.so*' -printf '%h\n' | sort -u | paste -sd: -)
  find "$root" -type f -perm -u+x ! -name '*.so*' -print0 |
    while IFS= read -r -d '' file; do
      [ "$(head -c 4 "$file" | tail -c 3)" = ELF ] || continue
      LD_LIBRARY_PATH="$library_path" ldd "$file" 2> /dev/null
    done |
    sed -n 's/^[[:space:]]*\([^[:space:]]*\) => not found$/\1/p' | sort -u
}

write_apt_conf

# 2. From the cache, when it was saved on this image for this browser and Playwright.
if [ -n "$key" ] && [ "$(cat "$debs/complete" 2> /dev/null)" = "$key" ]; then
  if install_cached_debs; then
    notice "Installed $browser's system packages from the cache ($key), without apt's mirrors."
    exit 0
  fi
  warning "Installing $browser's system packages from the cache failed; trying apt."
fi

# 3. Through apt: the runner's mirror, then once more against another one, with shorter limits.
if install_with_apt 60 150; then
  exit 0
fi
warning "Installing $browser's system packages through apt failed; trying another Ubuntu mirror."
if use_other_mirror && install_with_apt 45 120; then
  exit 0
fi

# 4. apt is unavailable: install what an earlier image's cache has, then check the browser can load its libraries.
if [ -n "$(newer_debs)" ]; then
  install_cached_debs || warning "Installing $browser's system packages from the cache failed."
fi
mapfile -t libraries < <(missing_libraries)
if [ "${#libraries[@]}" -eq 0 ]; then
  warning "apt is unavailable; running $browser with the runner image's system packages."
  exit 0
fi
list=$(printf '%s, ' "${libraries[@]}")
list=${list%, }
message="Infrastructure: apt outage. The Ubuntu apt mirrors couldn't be reached or were too slow, the cache had no usable system packages for this runner image, and $browser can't start without these libraries: $list. This isn't a regression; re-run the job once the mirrors are back."
echo "::error title=apt outage: $browser's system packages couldn't be installed::$message"
summary "### Infrastructure: apt outage" "" "$message"
# The first few, for the issue.
short=$(printf '%s, ' "${libraries[@]:0:5}")
short=${short%, }
if [ "${#libraries[@]}" -gt 5 ]; then short="$short and $((${#libraries[@]} - 5)) more"; fi
output infrastructure "apt outage ($browser is missing $short)"
exit 1
