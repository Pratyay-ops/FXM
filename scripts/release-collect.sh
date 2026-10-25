#!/usr/bin/env bash
# Step of .github/workflows/release.yml's publish job: gathers the files that the artifact jobs
# uploaded into the one folder that is checksummed, attested and published.
#
#   release-collect.sh <x.y.z> <artifacts dir> <out dir>
#
# <artifacts dir> holds one folder per artifact, named after it (release-bundles, ...), as the
# publish job downloads them. Every file must be a plain file at the top of its artifact's
# folder, carry the version in its name and be one that fxm_release_catalog
# (scripts/release-lib.sh) lists for that artifact. No two artifacts may publish the same name.
# So an artifact job can neither replace another job's files nor slip in files of its own: any
# of that stops the release. <out dir> must be empty or missing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

[ $# -eq 3 ] || fxm_die "usage: release-collect.sh <x.y.z> <artifacts dir> <out dir>"
version=$1
artifacts=$2
out=$3
fxm_release_require_version "$version"
[ -d "$artifacts" ] || fxm_die "no such folder: $artifacts"
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  fxm_die "$out is not empty: collect into a new folder"
fi
mkdir -p "$out"

# Every entry, dot files included, so nothing is passed over unnoticed.
entries() { find "$1" -mindepth 1 -maxdepth 1 | LC_ALL=C sort; }

count=0
while IFS= read -r folder; do
  artifact=${folder##*/}
  if [ -L "$folder" ] || [ ! -d "$folder" ]; then
    fxm_die "$folder is not an artifact folder: the publish job downloads each artifact into" \
      "a folder named after it"
  fi
  fxm_release_catalog | cut -d'|' -f1 | grep -xF -- "$artifact" >/dev/null ||
    fxm_die "unknown artifact $artifact: list its files in fxm_release_catalog" \
      "(scripts/release-lib.sh)"
  files=0
  while IFS= read -r path; do
    name=${path##*/}
    if [ -L "$path" ] || [ ! -f "$path" ]; then
      fxm_die "$artifact/$name is not a plain file: release-* artifacts must contain flat files," \
        "at the top of the artifact, without folders or links"
    fi
    case "$name" in
      *"$version"*) ;;
      *) fxm_die "$artifact/$name does not carry the version $version in its name" ;;
    esac
    fxm_release_lookup "$artifact" "$name" "$version" >/dev/null ||
      fxm_die "$artifact/$name is not a file that $artifact may publish (fxm_release_catalog" \
        "in scripts/release-lib.sh)"
    [ ! -e "$out/$name" ] || fxm_die "$name comes from more than one artifact"
    cp "$path" "$out/$name"
    chmod 0644 "$out/$name"
    files=$((files + 1))
  done < <(entries "$folder")
  [ "$files" -gt 0 ] || fxm_die "artifact $artifact has no files"
  fxm_info "Collected $files file(s) from $artifact"
  count=$((count + files))
done < <(entries "$artifacts")

[ "$count" -gt 0 ] || fxm_die "no artifacts in $artifacts"
fxm_info "Collected $count release files for $version into $out"
