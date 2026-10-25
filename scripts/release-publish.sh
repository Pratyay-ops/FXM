#!/usr/bin/env bash
# Last step of .github/workflows/release.yml: publishes the GitHub Release of one version.
#
#   release-publish.sh <x.y.z> <commit> <dir> <notes.md>
#
# Creates tag vX.Y.Z at the commit unless it is already there, deletes a draft release that a
# failed run left behind, then publishes the release with the notes, a list of the files and
# every file in <dir> as an asset. gh uploads the assets to a draft and publishes it after the
# last upload, so a release never shows up half uploaded. Re-running is safe: a published
# release is left alone, and a tag that points at another commit stops it. A failed GitHub API
# request stops it too, instead of reading as "no release" or "no tag". Needs gh with GH_TOKEN
# (contents: write) and GITHUB_REPOSITORY (owner/repo).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

[ $# -eq 4 ] || fxm_die "usage: release-publish.sh <x.y.z> <commit> <dir> <notes.md>"
version=$1
sha=$2
dir=$3
notes=$4
fxm_release_require_version "$version"
[[ $sha =~ ^[0-9a-f]{40}$ ]] || fxm_die "the commit must be a full SHA, got '$sha'"
[ -f "$notes" ] || fxm_die "no notes file: $notes"
[ -f "$dir/SHA256SUMS" ] || fxm_die "$dir/SHA256SUMS is missing: scripts/release-build.sh --checksums $dir"
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository, e.g. Pratyay-ops/FXM}
tag=v$version

# The release files, with SHA256SUMS last.
files=()
for file in "$dir"/*; do
  if [ -f "$file" ] && [ "$file" != "$dir/SHA256SUMS" ]; then files+=("$file"); fi
done
files+=("$dir/SHA256SUMS")

if fxm_release_published "$repo" "$tag"; then
  fxm_info "$tag is already published: nothing to do"
  exit 0
fi

tagged=$(fxm_release_remote_tag "$repo" "$tag")
if [ -z "$tagged" ]; then
  if gh api -X POST "repos/$repo/git/refs" -f ref="refs/tags/$tag" -f sha="$sha" >/dev/null; then
    fxm_info "Created tag $tag at ${sha:0:7}"
  else
    # A run that started at the same time may have created it.
    tagged=$(fxm_release_remote_tag "$repo" "$tag")
    [ "$tagged" = "$sha" ] || fxm_die "could not create tag $tag"
  fi
elif [ "$tagged" = "$sha" ]; then
  fxm_info "Tag $tag already points at ${sha:0:7}"
else
  fxm_die "tag $tag points at $tagged, not $sha, so the release would not match its tag." \
    "Delete the tag if it is wrong, or release a new version."
fi

drafts=$(fxm_release_github "repos/$repo/releases?per_page=100" \
  ".[] | select(.draft and .tag_name == \"$tag\") | .id")
for id in $drafts; do
  gh api -X DELETE "repos/$repo/releases/$id" >/dev/null
  fxm_info "Deleted draft release $id that an earlier run left behind"
done

describe() {
  case "$1" in
    fxm-connect-chromium-*.zip) echo "FXM Connect for Chrome, Edge, Brave and other Chromium browsers" ;;
    fxm-connect-firefox-*.zip) echo "FXM Connect for Firefox" ;;
    fxm-web-*.zip) echo "The web app for self-hosting: its files are in \`app/\`, served from \`/app/\`" ;;
    fxm-site-*.zip) echo "The landing page for self-hosting, served from \`/\`" ;;
    SHA256SUMS) echo "SHA-256 checksums of the other files" ;;
    *) echo "" ;;
  esac
}

body=$(mktemp)
trap 'rm -f "$body"' EXIT
cp "$notes" "$body"
fxm_release_fit "$body" 115000 \
  "The full list is in [CHANGELOG.md](https://github.com/$repo/blob/$tag/CHANGELOG.md)."
{
  echo
  echo "---"
  echo
  echo "### Files"
  echo
  echo "| File | What it is |"
  echo "|---|---|"
  for file in "${files[@]}"; do
    name=$(basename "$file")
    echo "| \`$name\` | $(describe "$name") |"
  done
  echo
  echo "Install FXM Connect with the [steps in its README](https://github.com/$repo/blob/$tag/apps/extension/README.md#install)."
  echo "To verify a download, \`sha256sum --check --ignore-missing SHA256SUMS\` compares it with the"
  echo "checksums, and \`gh attestation verify <file> --repo $repo\` checks that this repository's"
  echo "release workflow built it."
} >>"$body"

gh release create "$tag" --repo "$repo" --verify-tag --title "FXM $tag" --notes-file "$body" \
  "${files[@]}"
fxm_info "Published https://github.com/$repo/releases/tag/$tag"
