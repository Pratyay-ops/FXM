#!/usr/bin/env bash
# Last step of .github/workflows/release.yml: publishes the GitHub Release of one version.
#
#   release-publish.sh <x.y.z> <commit> <dir> <notes.md>
#
# <dir> holds plain files only, and <dir>/SHA256SUMS must match them exactly (release-build.sh
# --checksums). Creates tag vX.Y.Z at the commit unless it is already there, deletes a draft
# release that a failed run left behind, then publishes the release with the notes, a list of
# the files and every file in <dir> as an asset. With the Android APKs, the notes also give the
# SHA-256 of their signing certificate, pinned in apps/mobile/release-certificate.txt, and the
# release stops before tagging while nothing is pinned. gh uploads the assets to a draft and
# publishes it after the last upload, so a release never shows up half uploaded. Re-running is
# safe: a published release is left alone, and a tag that points at another commit stops it. A
# failed GitHub API request stops it too, instead of reading as "no release" or "no tag". Needs
# gh with GH_TOKEN (contents: write) and GITHUB_REPOSITORY (owner/repo).
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

# Only plain files, all of them listed in SHA256SUMS with the right checksum: what the
# attestations cover is exactly what gets published.
sums=$(mktemp)
trap 'rm -f "$sums"' EXIT
fxm_release_sums "$dir" >"$sums"
cmp -s "$sums" "$dir/SHA256SUMS" ||
  fxm_die "$dir/SHA256SUMS does not match the files in $dir: scripts/release-build.sh --checksums $dir"
# The release files, with SHA256SUMS last.
files=()
for file in "$dir"/*; do
  if [ "$file" != "$dir/SHA256SUMS" ]; then files+=("$file"); fi
done
files+=("$dir/SHA256SUMS")

# With the Android APKs, the notes quote the certificate they are signed with: the one pinned at
# the release commit, which the android-sign job checked them against. Read before anything is
# tagged, so that a missing pin stops the release before it starts.
certificate=
for file in "${files[@]}"; do
  case "$(basename "$file")" in
    fxm-android-*.apk)
      certificate=$(fxm_release_android_certificate "$FXM_ROOT/apps/mobile/release-certificate.txt") ||
        exit 1
      certificate=$(fxm_release_colons "$certificate")
      ;;
  esac
done

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

# The files' descriptions come from fxm_release_catalog (scripts/release-lib.sh).
describe() {
  if [ "$1" = SHA256SUMS ]; then
    echo "SHA-256 checksums of the other files"
  else
    fxm_release_lookup "" "$1" "$version" || true
  fi
}

# Who may have signed the attestations: release.yml, run for main. --repo alone would accept an
# attestation from any workflow on any branch of the repository.
identity="https://github.com/$repo/.github/workflows/release.yml@refs/heads/main"

body=$(mktemp)
trap 'rm -f "$sums" "$body"' EXIT
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
  echo
  if [ -n "$certificate" ]; then
    echo "Install the Android app with the [steps in its guide](https://github.com/$repo/blob/$tag/apps/mobile/INSTALL.md)."
    echo "The APKs are signed with FXM's key. Its certificate's SHA-256 fingerprint is:"
    echo
    echo '```text'
    echo "$certificate"
    echo '```'
    echo
    echo "Android installs an update only when it is signed with the same key, and the guide shows"
    echo "how to check the fingerprint before the first install."
    echo
  fi
  echo "To host the website and web app yourself, serve \`fxm-web-$version.zip\` as the [self-hosting steps](https://github.com/$repo/blob/$tag/scripts/build-dist/README.md#self-hosting) describe."
  echo
  echo "To verify a download, run these in its folder:"
  echo
  echo '```sh'
  echo "sha256sum --check --ignore-missing SHA256SUMS"
  echo "gh attestation verify <file> --repo $repo \\"
  echo "  --cert-identity $identity \\"
  echo "  --deny-self-hosted-runners"
  echo '```'
  echo
  echo "The first compares the file with its checksum. The second checks that FXM's release"
  echo "workflow, run for \`main\` on GitHub's own runners, built it."
} >>"$body"

gh release create "$tag" --repo "$repo" --verify-tag --title "FXM $tag" --notes-file "$body" \
  "${files[@]}"
fxm_info "Published https://github.com/$repo/releases/tag/$tag"
