#!/usr/bin/env bash
# Builds the files a GitHub Release ships, into one folder:
#
#   fxm-web-<version>.zip               what Cloudflare Pages serves, for self-hosting: make dist's
#                                       dist/pages as it is, with the landing page at the root,
#                                       the web app in app/, the sandbox documents, _headers,
#                                       third-party-notices.txt and .well-known/
#                                       (scripts/build-dist/README.md, "Self-hosting")
#   fxm-connect-chromium-<version>.zip  FXM Connect for Chromium browsers (apps/extension)
#   fxm-connect-firefox-<version>.zip   FXM Connect for Firefox
#
#   release-build.sh [dir]             builds them into dir (default dist/release)
#   release-build.sh --checksums dir   writes dir/SHA256SUMS for every other file in dir, which
#                                      must all be plain files (no folders or links)
#
# The release workflow runs both (the checksums once every job's files are together); so does
# make release-build. Every package must have the release version, as on main and on develop
# after make release-pr. The zips are reproducible: sorted entries, fixed permissions, no extra
# attributes, and the commit's time as every file's date. Needs zip (preinstalled on macOS and
# GitHub's runners) and the dependencies (make setup).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

write_checksums() {
  local dir=$1 list
  list=$(mktemp)
  fxm_release_sums "$dir" >"$list"
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
if ! "$here/release-version.sh" --check; then
  fxm_die "release-build.sh builds the files of a release, so every package needs the release" \
    "version: they agree on main and on develop after make release-pr. To try the build before" \
    "then, set a version in a throwaway worktree (make wt-new, then scripts/release-version.sh" \
    "x.y.z there) and never commit that change."
fi
out=${1:-dist/release}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
root=$(pwd -P)
# make dist replaces dist/pages and deletes dist/.staging, which would take the release along.
case "$out/" in
  "$root/dist/pages/"* | "$root/dist/.staging/"*)
    fxm_die "$out is inside a folder that make dist replaces: build the release elsewhere," \
      "such as dist/release"
    ;;
esac
# Only this script's own files go, so pointing it at the wrong folder deletes nothing else.
rm -f "$out"/fxm-*.zip "$out/SHA256SUMS"
# touch -t format in UTC, the same on macOS and Linux.
stamp=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M.%S)

# zip_folder <folder> <zip>: everything in the folder, dot files included, at the zip's root.
zip_folder() {
  local stage
  rm -f "$2"
  stage=$(mktemp -d)
  mkdir "$stage/root"
  cp -R "$1"/. "$stage/root"
  (
    cd "$stage/root"
    find . -type d -exec chmod 0755 {} +
    find . -type f -exec chmod 0644 {} +
    TZ=UTC find . -exec touch -h -t "$stamp" {} +
    find . -type f | sed 's|^\./||' | LC_ALL=C sort | TZ=UTC zip -X -D -q -9 "$2" -@
  )
  rm -rf "$stage"
  fxm_info "Packed $(basename "$2")"
}

exists() {
  if [ -f "apps/$1/package.json" ]; then return 0; fi
  fxm_warn "apps/$1 doesn't exist yet: skipped"
  return 1
}

# The web zip is the folder Cloudflare Pages serves, built by make dist itself, as the deploy
# workflow builds it, so whatever its recipe runs, the release runs too. It composes the site, the
# app and the sandbox documents with _headers and the third-party notices, and runs its licence,
# header and privacy checks (scripts/build-dist/README.md). pnpm succeeds when its filter matches
# nothing, so the folder an earlier make dist left goes first: only this build's can be zipped.
rm -rf dist/pages
make -s --no-print-directory dist
# What every copy must carry: the site, the app, their headers, and the notices that the bundled
# packages' licences (MIT, ISC and others) require.
for file in index.html app/index.html _headers third-party-notices.txt; do
  [ -f "dist/pages/$file" ] || fxm_die "make dist built no dist/pages/$file for the web zip"
done
zip_folder dist/pages "$out/fxm-web-$version.zip"

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

fxm_info "Release files for $version are in ${out#"$root"/}"
