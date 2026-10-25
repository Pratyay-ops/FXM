#!/usr/bin/env bash
# Builds the files a GitHub Release ships, into one folder:
#
#   fxm-web-<version>.zip               the web app (apps/web), inside app/ because it is served
#                                       from /app/
#   fxm-site-<version>.zip              the landing page (apps/site), served from /
#   fxm-connect-chromium-<version>.zip  FXM Connect for Chromium browsers (apps/extension)
#   fxm-connect-firefox-<version>.zip   FXM Connect for Firefox
#
#   release-build.sh [dir]             builds them into dir (default dist/release), skipping apps
#                                      that don't exist yet
#   release-build.sh --checksums dir   writes dir/SHA256SUMS for every other file in dir
#
# The release workflow runs both (the checksums once every job's files are together); so does
# make release-build. The zips are reproducible: sorted entries, fixed permissions, no extra
# attributes, and the commit's time as every file's date. Needs zip (preinstalled on macOS and
# GitHub's runners) and the dependencies (make setup).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

write_checksums() {
  local dir=$1 list file
  [ -d "$dir" ] || fxm_die "no such folder: $dir"
  list=$(mktemp)
  (
    cd "$dir"
    for file in *; do
      if [ -f "$file" ] && [ "$file" != SHA256SUMS ]; then
        printf '%s  %s\n' "$(fxm_sha256 "$file")" "$file"
      fi
    done
  ) | LC_ALL=C sort -k2 >"$list"
  [ -s "$list" ] || fxm_die "no files to checksum in $dir"
  mv "$list" "$dir/SHA256SUMS"
  chmod 0644 "$dir/SHA256SUMS"
  fxm_info "Wrote $dir/SHA256SUMS ($(wc -l <"$dir/SHA256SUMS" | tr -d ' ') files)"
}

if [ "${1:-}" = --checksums ]; then
  [ $# -eq 2 ] || fxm_die "usage: release-build.sh --checksums <dir>"
  write_checksums "$2"
  exit 0
fi
[ $# -le 1 ] || fxm_die "usage: release-build.sh [dir] | release-build.sh --checksums <dir>"

command -v zip >/dev/null 2>&1 || fxm_die "zip is required (Debian and Ubuntu: sudo apt install zip)"
cd "$FXM_ROOT"
version=$(fxm_release_current_version)
fxm_release_require_version "$version"
# Every file name and FXM Connect's manifest carry the version, so all packages must agree.
"$here/release-version.sh" --check
out=${1:-dist/release}
mkdir -p "$out"
out=$(cd "$out" && pwd)
# Only this script's own files go, so pointing it at the wrong folder deletes nothing else.
rm -f "$out"/fxm-*.zip "$out/SHA256SUMS"
# touch -t format in UTC, the same on macOS and Linux.
stamp=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M.%S)

# zip_folder <folder> <path inside the zip, or ""> <zip>
zip_folder() {
  local stage
  rm -f "$3"
  stage=$(mktemp -d)
  mkdir -p "$stage/root/$2"
  cp -R "$1"/. "$stage/root/$2"
  (
    cd "$stage/root"
    find . -type d -exec chmod 0755 {} +
    find . -type f -exec chmod 0644 {} +
    TZ=UTC find . -exec touch -h -t "$stamp" {} +
    find . -type f | sed 's|^\./||' | LC_ALL=C sort | TZ=UTC zip -X -D -q -9 "$3" -@
  )
  rm -rf "$stage"
  fxm_info "Packed $(basename "$3")"
}

exists() {
  if [ -f "apps/$1/package.json" ]; then return 0; fi
  fxm_warn "apps/$1 doesn't exist yet: skipped"
  return 1
}

if exists web; then
  pnpm --filter @fxm/web build
  zip_folder apps/web/dist app "$out/fxm-web-$version.zip"
fi

if exists site; then
  pnpm --filter @fxm/site build
  zip_folder apps/site/dist "" "$out/fxm-site-$version.zip"
fi

if exists extension; then
  # The release variant: the dev build also trusts localhost and must never ship.
  FXM_EXTENSION_DEV=0 pnpm --filter @fxm/extension build
  for browser in chromium firefox; do
    zip=apps/extension/dist/fxm-connect-$browser-$version.zip
    [ -f "$zip" ] ||
      fxm_die "$zip is missing: apps/extension/package.json must have version $version (scripts/release-version.sh)"
    cp "$zip" "$out/"
    chmod 0644 "$out/$(basename "$zip")"
    fxm_info "Copied $(basename "$zip")"
  done
fi

[ -n "$(ls -A "$out")" ] || fxm_die "no app was built"
fxm_info "Release files for $version are in ${out#"$FXM_ROOT"/}"
