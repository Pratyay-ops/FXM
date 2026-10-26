#!/usr/bin/env bash
# Waits for the GitHub Release of the version that the checked-out commit of main has, so the
# deploy workflow promotes the site to production only once the release exists: the site links
# to the latest release, which would otherwise be the previous one, or none before v0.1.0
# (.github/workflows/deploy.yml, the release job). It waits whenever that version has no
# published release yet, which is when the release workflow publishes it from the same push
# (release-plan.sh): the merge of a release pull request, or any later push to main while that
# release is still missing, after a failed run. A version that is out passes after one request;
# the placeholder 0.0.0 passes at once.
#
#   release-wait.sh   waits up to FXM_RELEASE_WAIT_MINUTES (default 30) for the published
#                     release, asking GitHub every FXM_RELEASE_WAIT_INTERVAL seconds (default 30)
#
# A failed request counts as "not yet": it is asked again until the time is up. Needs gh with
# GH_TOKEN (contents: read is enough) and GITHUB_REPOSITORY (owner/repo).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository, e.g. Pratyay-ops/FXM}
minutes=${FXM_RELEASE_WAIT_MINUTES:-30}
interval=${FXM_RELEASE_WAIT_INTERVAL:-30}
[[ $minutes =~ ^[0-9]+$ && $interval =~ ^[0-9]+$ ]] ||
  fxm_die "FXM_RELEASE_WAIT_MINUTES and FXM_RELEASE_WAIT_INTERVAL must be whole numbers"

note() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::notice title=Release::$*"; else fxm_info "$*"; fi
}
warn() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::warning title=Release::$*"; else fxm_warn "$*"; fi
}

version=$(fxm_release_current_version)
if [ "$version" = 0.0.0 ]; then
  note "Version 0.0.0 has no release to wait for: production gets this commit"
  exit 0
fi
fxm_release_require_version "$version"
tag=v$version

log=$(mktemp)
trap 'rm -f "$log"' EXIT
deadline=$((SECONDS + minutes * 60))
waiting=false
while :; do
  # fxm_release_github prints the release's id, nothing while it doesn't exist (HTTP 404) and
  # fails on any other answer, which only means: ask again.
  if id=$(fxm_release_github "repos/$repo/releases/tags/$tag" '.id' 2>"$log"); then
    if [ -n "$id" ]; then
      note "$tag is published: production gets this commit"
      exit 0
    fi
    if ! $waiting; then
      note "$tag has no GitHub Release yet: production waits for it, up to $minutes minutes," \
        "while the release workflow publishes it"
      waiting=true
    fi
  else
    warn "GitHub didn't say whether $tag is published: $(grep -v '^$' "$log" | head -1)"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then break; fi
  sleep "$interval"
done
message="The GitHub Release $tag is not out after $minutes minutes, so production keeps the previous version. Once the release workflow has published it, re-run this workflow's failed jobs (docs/WORKFLOW.md, \"Releases\")."
if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error title=Release::$message"; fi
fxm_die "$message"
