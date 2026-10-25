#!/usr/bin/env bash
# First step of .github/workflows/release.yml: decides whether the checked-out commit of main
# publishes a release. It does when the version in package.json has no published GitHub Release
# yet (0.0.0, the placeholder before the first release, never does). A new version must be
# higher than every release tag and set in every package; otherwise the run fails.
#
# Prints release (true or false), version, tag and sha as name=value lines, and appends them to
# $GITHUB_OUTPUT in Actions. sha is the commit to build and tag: HEAD, or the commit an existing
# tag points at when an earlier run created the tag but not the release. Needs gh with GH_TOKEN,
# and GITHUB_REPOSITORY (owner/repo).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository, e.g. Pratyay-ops/FXM}
version=$(fxm_release_current_version)
tag=v$version
sha=$(git -C "$FXM_ROOT" rev-parse HEAD)
release=false

note() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::notice title=Release::$*"; else fxm_info "$*"; fi
}
output() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}

if [ "$version" = 0.0.0 ]; then
  note "Version 0.0.0 is the placeholder before the first release: nothing to publish"
else
  fxm_release_require_version "$version"
  if fxm_release_published "$repo" "$tag"; then
    note "$tag is already published: nothing to do"
  else
    tagged=$(fxm_release_remote_tag "$repo" "$tag")
    if [ -n "$tagged" ]; then
      sha=$tagged
      note "Tag $tag exists at ${sha:0:7} without a published release: finishing that release"
    else
      "$here/release-version.sh" --check
      refs=$(gh api --paginate "repos/$repo/git/matching-refs/tags/v" --jq '.[].ref')
      for ref in $refs; do
        released=${ref#refs/tags/v}
        if fxm_release_is_version "$released" && ! fxm_release_newer "$version" "$released"; then
          fxm_die "$version is not higher than the released v$released: set a higher version"
        fi
      done
      note "Releasing $tag from ${sha:0:7}"
    fi
    release=true
  fi
fi

output release "$release"
output version "$version"
output tag "$tag"
output sha "$sha"
