#!/usr/bin/env bash
# Opens the release pull request from develop into main: make release-pr VERSION=x.y.z
#
#   1. Checks that develop is checked out, clean, equal to origin/develop and contains
#      origin/main and every release tag; that the version is higher than the current one and
#      has no tag; and that no release pull request is open.
#   2. Sets the version everywhere (release-version.sh) and regenerates CHANGELOG.md (git-cliff).
#   3. Commits "chore(release): vX.Y.Z" on develop and pushes develop.
#   4. Opens the pull request "Release vX.Y.Z" with the version's notes and prints its URL.
#
# It never merges. DRY_RUN=1 runs the checks and prints the plan and the notes without changing,
# committing or pushing anything; a failed check is reported instead of stopping it. Merging the
# pull request makes .github/workflows/release.yml tag the merge commit and publish the release
# (docs/WORKFLOW.md, "Releases").
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

version=${1:-}
[ -n "$version" ] ||
  fxm_die "VERSION is required: make release-pr VERSION=x.y.z (DRY_RUN=1 to preview)"
fxm_release_require_version "$version"
dry_run=false
if fxm_release_flag DRY_RUN "${DRY_RUN:-}"; then dry_run=true; fi
tag=v$version
cd "$FXM_ROOT"

work=$(mktemp -d)
step=checks
finish() {
  local status=$?
  rm -rf "$work"
  if [ "$status" -ne 0 ] && [ "$step" = changes ]; then
    fxm_warn "Stopped before the release commit. Undo its changes with: git restore --staged --worktree ."
  fi
}
trap finish EXIT

problems=0
pass() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
problem() {
  printf '  \033[31m✘\033[0m %s\n' "$*"
  problems=$((problems + 1))
}

if $dry_run; then
  echo "Release $tag (dry run: no file changes, commits or pushes)"
else
  echo "Release $tag"
fi
echo
echo "Checks"

if git fetch --quiet --tags origin; then
  pass "fetched origin"
else
  problem "could not fetch origin: the checks below use what was fetched before"
fi

branch=$(git symbolic-ref -q --short HEAD || echo "a detached HEAD")
if [ "$branch" = develop ]; then
  pass "on develop"
else
  problem "on $branch, not develop: git switch develop"
fi

if [ -z "$(git status --porcelain)" ]; then
  pass "working tree is clean"
else
  problem "uncommitted or untracked files: commit, stash or remove them (git status)"
fi

head_sha=$(git rev-parse HEAD)
if [ "$head_sha" = "$(git rev-parse -q --verify origin/develop || true)" ]; then
  pass "matches origin/develop (${head_sha:0:7})"
else
  problem "${head_sha:0:7} is not origin/develop: git pull --ff-only (or push your commits first)"
fi

if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
  pass "contains origin/main"
else
  problem "origin/main has commits that are not here (the last release merge or a hotfix):" \
    "git merge origin/main && git push origin develop"
fi

outside=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --no-merged HEAD | tr '\n' ' ')
if [ -z "$outside" ]; then
  pass "contains every release tag"
else
  problem "release tags outside this history: ${outside% }. Merge main back into develop first"
fi

current=$(fxm_release_current_version)
if fxm_release_newer "$version" "$current" 2>/dev/null; then
  pass "$version is higher than the current version $current"
else
  problem "$version is not higher than the current version $current"
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  problem "tag $tag already exists"
else
  pass "tag $tag does not exist yet"
fi

gh_ready=false
if ! command -v gh >/dev/null 2>&1; then
  problem "the GitHub CLI is not installed: make gh-setup"
elif ! gh auth status >/dev/null 2>&1; then
  problem "the GitHub CLI is not logged in: gh auth login --insecure-storage"
else
  gh_ready=true
  pass "the GitHub CLI is logged in"
fi

if $gh_ready; then
  open_pr=$(gh pr list --base main --head develop --state open --json url --jq '.[].url')
  if [ -z "$open_pr" ]; then
    pass "no release pull request is open"
  else
    problem "a pull request from develop into main is already open: $open_pr"
  fi
fi

if "$here/install-git-cliff.sh" >/dev/null; then
  pass "git-cliff is installed"
else
  fxm_die "could not install git-cliff"
fi

notes=$work/notes.md
"$here/release-notes.sh" "$version" >"$notes"
entries=$(grep -c '^- ' "$notes" || true)

body=$work/pull-request.md
{
  echo "Merging this pull request with a merge commit releases FXM $tag: the release workflow"
  echo "tags the merge commit, builds the release files and publishes the GitHub Release with"
  echo "these notes. Afterwards, merge main back into develop."
  echo
  echo "## Notes"
  echo
  cat "$notes"
} >"$body"
fxm_release_fit "$body" 65000 \
  "The full list is in CHANGELOG.md on develop, and in the GitHub Release once it is published."

if $dry_run; then
  echo
  echo "Plan"
  echo "  1. Set the version (scripts/release-version.sh $version):"
  "$here/release-version.sh" --dry-run "$version" | sed 's/^/   /'
  echo "  2. Regenerate CHANGELOG.md with git-cliff: $tag gets $entries entries"
  echo "  3. Commit \"chore(release): $tag\" on develop"
  echo "  4. Push develop to origin"
  echo "  5. Open the pull request develop → main \"Release $tag\" with the notes below"
  echo
  echo "Notes for $tag"
  echo
  cat "$notes"
  echo
  if [ "$problems" -eq 0 ]; then
    fxm_info "Dry run done: every check passed. Run it again without DRY_RUN to release."
  else
    fxm_warn "Dry run done: $problems check(s) above would stop a real run."
  fi
  exit 0
fi

[ "$problems" -eq 0 ] || fxm_die "$problems check(s) failed: fix them and run make release-pr again"

echo
step=changes
"$here/release-version.sh" "$version"
"$here/release-notes.sh" --changelog "$version"
git add -A
git commit --quiet -m "chore(release): $tag" \
  -m "Sets every package version, APP_VERSION and the FXM Connect manifest
to $version and regenerates CHANGELOG.md, so the release pull request
into main carries the $tag notes."
step=committed
fxm_info "Committed $(git log -1 --format='%h %s')"

retry_pr="gh pr create --base main --head develop --title \"Release $tag\""
retry_pr+=" --body-file <(scripts/release-notes.sh $version)"
git push --quiet origin HEAD:refs/heads/develop ||
  fxm_die "Push failed, so the release commit is only on your develop." \
    "Push it with git push origin develop, then open the pull request: $retry_pr"
fxm_info "Pushed develop"

url=$(gh pr create --base main --head develop --title "Release $tag" --body-file "$body") ||
  fxm_die "Opening the pull request failed. develop is pushed, so open it with: $retry_pr"
fxm_info "Release pull request: $url"
cat <<EOF

Next:
  1. Wait for CI:  gh pr checks $url --watch
  2. Merge it with a merge commit:  gh pr merge $url --merge
     The release workflow then tags $tag and publishes the GitHub Release.
  3. Once it is published, merge main back into develop, so the next release builds on it:
     git switch develop && git pull --ff-only
     git merge origin/main -m "Merge main back into develop after the $tag release"
     git push origin develop
EOF
