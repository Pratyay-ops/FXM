#!/usr/bin/env bash
# First step of .github/workflows/release.yml: decides whether the checked-out commit of main
# publishes a release. It does when the version in package.json has no published GitHub Release
# yet (0.0.0, the placeholder before the first release, never does). The version must be set in
# every package and be higher than every other release tag; otherwise the run fails.
#
# Prints release (true or false), version, tag and sha as name=value lines, and appends them to
# $GITHUB_OUTPUT in Actions. sha is HEAD, the commit the run was started for: the one to build,
# tag and attest. When tag vX.Y.Z exists without a published release, it must point at HEAD.
# Then an earlier run tagged this commit and failed, and this run finishes the release. A tag
# at any other commit stops the run: tags are not protected, so finishing it would let anyone
# who can push a tag have the workflow build and publish a commit that main never reviewed.
# Needs gh with GH_TOKEN, and GITHUB_REPOSITORY (owner/repo).
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
warn() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::warning title=Release::$*"; else fxm_warn "$*"; fi
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
    "$here/release-version.sh" --check
    refs=$(gh api --paginate "repos/$repo/git/matching-refs/tags/v" --jq '.[].ref')
    for ref in $refs; do
      released=${ref#refs/tags/v}
      if [ "$released" != "$version" ] && fxm_release_is_version "$released" &&
        ! fxm_release_newer "$version" "$released"; then
        fxm_die "$version is not higher than the released v$released: set a higher version"
      fi
    done
    tagged=$(fxm_release_remote_tag "$repo" "$tag")
    if [ -z "$tagged" ]; then
      note "Releasing $tag from ${sha:0:7}"
    elif [ "$tagged" = "$sha" ]; then
      note "Tag $tag exists at ${sha:0:7} without a published release: finishing that release"
    else
      fxm_die "Tag $tag points at ${tagged:0:7}, not at ${sha:0:7}, the commit this run builds." \
        "If a release run tagged ${tagged:0:7} and then failed, re-run that run: a re-run builds" \
        "the commit it started with. Otherwise delete the tag (git push origin :refs/tags/$tag)" \
        "and run this workflow again."
    fi
    has_section='index($0, heading) == 1 { found = 1 } END { exit !found }'
    if ! awk -v heading="## [$version]" "$has_section" "$FXM_ROOT/CHANGELOG.md" 2>/dev/null; then
      warn "CHANGELOG.md has no $version section, so the file in $tag misses this release." \
        "The release notes are complete; the next make release-pr regenerates the file."
    fi
    release=true
  fi
fi

output release "$release"
output version "$version"
output tag "$tag"
output sha "$sha"
