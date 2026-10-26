#!/usr/bin/env bash
# Waits for the GitHub Release of the version that the checked-out commit of main brings, so the
# deploy workflow promotes the site to production only once the release exists: the site links
# to the latest release, which would otherwise be the previous one, or none before v0.1.0
# (.github/workflows/deploy.yml, the release job). A commit brings a version when the version in
# package.json differs from that of its first parent, the commit main had before: the merge of a
# release pull request. Any other commit, and the placeholder 0.0.0, waits for nothing.
#
#   release-wait.sh   waits up to FXM_RELEASE_WAIT_MINUTES (default 30) for the published
#                     release, asking GitHub every FXM_RELEASE_WAIT_INTERVAL seconds (default 30)
#
# A failed request counts as "not yet": it is asked again until the time is up. Needs gh with
# GH_TOKEN (contents: read is enough), GITHUB_REPOSITORY (owner/repo) and the commit's first
# parent in the clone (fetch-depth: 2).
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
# The version of the first parent; empty when the clone lacks it (then it counts as changed).
previous=$(git -C "$FXM_ROOT" show HEAD^1:package.json 2>/dev/null |
  node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version ?? ""' 2>/dev/null) ||
  previous=
if [ "$version" = 0.0.0 ]; then
  note "Version 0.0.0 has no release to wait for: production gets this commit"
  exit 0
fi
if [ "$version" = "$previous" ]; then
  note "This commit keeps version $version: production gets it without waiting for a release"
  exit 0
fi
fxm_release_require_version "$version"
tag=v$version

log=$(mktemp)
trap 'rm -f "$log"' EXIT
deadline=$((SECONDS + minutes * 60))
note "This commit brings $tag: production waits for its GitHub Release (up to $minutes minutes)"
while :; do
  # fxm_release_github prints the release's id, nothing while it doesn't exist (HTTP 404) and
  # fails on any other answer, which only means: ask again.
  if id=$(fxm_release_github "repos/$repo/releases/tags/$tag" '.id' 2>"$log"); then
    if [ -n "$id" ]; then
      note "$tag is published: production gets this commit"
      exit 0
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
