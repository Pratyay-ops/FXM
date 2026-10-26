#!/usr/bin/env bash
# Opens the release pull request from develop into main: make release-pr VERSION=x.y.z
#
#   1. Checks that develop is checked out, clean, equal to origin/develop and contains
#      origin/main and every release tag; that the version is higher than the current one, has
#      no tag and has a finished summary (docs/releases/vX.Y.Z.md, not marked as a draft); that
#      apps/mobile/release-certificate.txt pins the certificate the Android APKs are signed
#      with; that no release pull request is open; and that the release commit passes make lint
#      and the release script tests, by making its changes in a temporary worktree and running
#      them there.
#   2. Sets the version everywhere (release-version.sh) and regenerates CHANGELOG.md (git-cliff).
#   3. Commits "chore(release): vX.Y.Z" on develop and pushes develop.
#   4. Opens the pull request "Release vX.Y.Z" with the version's notes (release-notes.sh: the
#      summary, the legal notice, then the changes) and prints its URL.
#
# Run with the version of a release that is under way (develop already has it, and it has no
# tag yet), it updates that release instead: after a fix reached develop while the pull request
# was open, after the pull request was closed, or after a failed push or pull request step. It
# sets the version in any package that lacks it, regenerates CHANGELOG.md, commits and pushes
# them if they changed, then updates the open pull request's notes, or opens it again.
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
root=$(pwd -P)

# The run's temporary folder, by its real path, which is how git worktree list names the
# worktree in it. Two steps, each of which stops the script when it fails: `cd ""` succeeds, so
# a failed mktemp inside the cd would leave work naming the checkout, for finish to delete.
work=$(mktemp -d) || fxm_die "could not create a temporary folder (mktemp -d)"
work=$(cd "$work" && pwd -P)
# The temporary worktree the release commit's checks run in (check_release_commit below).
release_commit=$work/release-commit
step=checks
finish() {
  local status=$? worktrees
  worktrees=$(git worktree list --porcelain 2>/dev/null || true)
  if grep -qxF "worktree $release_commit" <<<"$worktrees" &&
    ! git worktree remove --force "$release_commit" 2>/dev/null; then
    fxm_warn "Could not remove the temporary worktree $release_commit: git worktree prune drops it"
  fi
  # Only a folder that is neither the checkout nor one that holds it, whatever went wrong.
  case "$root/" in
    "$work"/*) fxm_warn "Left $work alone: it holds the checkout" ;;
    *) rm -rf "$work" ;;
  esac
  if [ "$status" -ne 0 ] && [ "$step" = changes ]; then
    fxm_warn "Stopped before the release commit. Undo its changes with: git restore --staged --worktree ."
  fi
}
trap finish EXIT
# An interrupted run cleans up too.
trap 'exit 130' INT
trap 'exit 143' TERM

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
update=false
if fxm_release_newer "$version" "$current" 2>/dev/null; then
  pass "$version is higher than the current version $current"
elif [ "$version" = "$current" ] && [ "$version" != 0.0.0 ] &&
  ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  update=true
  pass "develop already has version $version, which has no tag yet: this updates its release"
else
  problem "$version is not higher than the current version $current"
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  problem "tag $tag already exists"
else
  pass "tag $tag does not exist yet"
fi

# The notes start with the release's own summary, written for the people who use FXM.
summary=$(fxm_release_summary_file "$version")
if ! fxm_release_has_summary "$version"; then
  problem "$summary is missing or empty: write the release's summary for the people who use" \
    "FXM (docs/WORKFLOW.md, \"Releases\"), then commit and push it on develop"
elif fxm_release_summary_is_draft "$version"; then
  problem "$summary is still a draft: check it against what $tag ships, delete its" \
    "'<!-- draft' line, then commit and push it on develop"
else
  pass "$summary has the release's summary"
fi

# The release workflow signs the Android APKs only with the key whose certificate this file pins,
# and stops before tagging while it pins none (apps/mobile/RELEASING.md, The signing key).
certificate=apps/mobile/release-certificate.txt
if (fxm_release_android_certificate "$certificate" >/dev/null 2>&1); then
  pass "$certificate pins the Android signing certificate"
else
  problem "$certificate pins no Android signing certificate, so the release would stop before" \
    "tagging: create the key, set its secrets and pin it first (apps/mobile/RELEASING.md)"
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

# The open pull request from develop into main, as "<url> <title>" lines. A fork's branch may
# be called develop too, so only this repository's own branch counts.
pr_url=
if $gh_ready; then
  open_prs=$(gh pr list --base main --head develop --state open --json url,title,isCrossRepository \
    --jq '.[] | select(.isCrossRepository | not) | .url + " " + .title')
  if [ -z "$open_prs" ]; then
    pass "no release pull request is open"
  elif $update && [ "$(printf '%s\n' "$open_prs" | wc -l | tr -d ' ')" = 1 ] &&
    [ "${open_prs#* }" = "Release $tag" ]; then
    pr_url=${open_prs%% *}
    pass "the pull request \"Release $tag\" is open, so its notes get updated: $pr_url"
  else
    problem "a pull request from develop into main is already open: ${open_prs%% *}"
  fi
fi

if "$here/install-git-cliff.sh" >/dev/null; then
  pass "git-cliff is installed"
else
  fxm_die "could not install git-cliff"
fi

# The release commit's own checks. CI runs make check and make release-check on the commit this
# script makes, and its changes alone, the versions and CHANGELOG.md, can break them: the
# generated changelog may trip a lint rule, or a test that reads it. So the same changes go into
# a temporary worktree of HEAD, which gets the dependencies from the lockfile, and make lint and
# the release script tests run there; the checkout itself stays untouched. A real run skips this
# when another check failed already, since it stops anyway.
release_log=$work/release-commit.log
changelog_entries=
show_release_log() { tail -15 "$release_log" | sed 's/^/      | /'; }
check_release_commit() {
  local where="the release commit (checked in a temporary worktree)"
  if ! git worktree add --quiet --detach "$release_commit" HEAD >"$release_log" 2>&1; then
    problem "could not add a temporary worktree to check the release commit in"
    show_release_log
    return
  fi
  if ! (cd "$release_commit" && scripts/release-version.sh "$version" &&
    scripts/release-notes.sh --changelog "$version") >"$release_log" 2>&1; then
    problem "could not make $where: release-version.sh or release-notes.sh --changelog failed"
    show_release_log
    return
  fi
  changelog_entries=$(awk -v start="## [$version]" \
    'index($0, start) == 1 { on = 1; next } /^## / { on = 0 } on && /^- /' \
    "$release_commit/CHANGELOG.md" | wc -l | tr -d ' ')
  if ! (cd "$release_commit" && scripts/run.sh pnpm install --frozen-lockfile --prefer-offline) \
    >"$release_log" 2>&1; then
    problem "the dependencies of $where don't install from the lockfile (pnpm install --frozen-lockfile)"
    show_release_log
    return
  fi
  if (cd "$release_commit" && make lint) >"$release_log" 2>&1; then
    pass "$where passes make lint"
  else
    problem "$where fails make lint"
    show_release_log
  fi
  if (cd "$release_commit" && scripts/release-test.sh) >"$release_log" 2>&1; then
    pass "$where passes the release script tests"
  else
    problem "$where fails the release script tests (scripts/release-test.sh)"
    show_release_log
  fi
}
if $dry_run || [ "$problems" -eq 0 ]; then check_release_commit; fi

if ! $dry_run && [ "$problems" -gt 0 ]; then
  fxm_die "$problems check(s) failed: fix them and run make release-pr again"
fi

notes=$work/notes.md
"$here/release-notes.sh" "$version" >"$notes"

body=$work/pull-request.md
{
  echo "Merging this pull request with a merge commit releases FXM $tag: the release workflow"
  echo "tags the merge commit, builds the release files and publishes the GitHub Release with"
  echo "the notes below. Afterwards, merge main back into develop."
  echo
  echo "---"
  echo
  cat "$notes"
} >"$body"
fxm_release_fit "$body" 65000 \
  "The list goes on in the GitHub Release once it is published, and CHANGELOG.md on develop has every change."

if $dry_run; then
  echo
  if $update; then
    echo "Plan (update the $tag release that is under way)"
    echo "  1. Set the version where it differs (scripts/release-version.sh $version):"
  else
    echo "Plan"
    echo "  1. Set the version (scripts/release-version.sh $version):"
  fi
  "$here/release-version.sh" --dry-run "$version" | sed 's/^/   /'
  echo "  2. Regenerate CHANGELOG.md with git-cliff${changelog_entries:+: $tag gets $changelog_entries entries}"
  if $update; then
    echo "  3. If either changed, commit \"chore(release): $tag\" on develop and push develop"
  else
    echo "  3. Commit \"chore(release): $tag\" on develop"
    echo "  4. Push develop to origin"
  fi
  if [ -n "$pr_url" ]; then
    echo "  4. Update the notes of the pull request $pr_url to the ones below"
  elif $update; then
    echo "  4. Open the pull request develop → main \"Release $tag\" with the notes below"
  else
    echo "  5. Open the pull request develop → main \"Release $tag\" with the notes below"
  fi
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

echo
step=changes
"$here/release-version.sh" "$version"
"$here/release-notes.sh" --changelog "$version"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if $update; then
    git commit --quiet -m "chore(release): $tag" \
      -m "Regenerates CHANGELOG.md, and sets the version in any package that
lacked it, because develop changed while the $tag release was under way:
CHANGELOG.md then lists every change the release brings."
  else
    git commit --quiet -m "chore(release): $tag" \
      -m "Sets every package version, APP_VERSION and the FXM Connect manifest
to $version and regenerates CHANGELOG.md, so the release pull request
into main carries the $tag notes."
  fi
  step=committed
  fxm_info "Committed $(git log -1 --format='%h %s')"
  git push --quiet origin HEAD:refs/heads/develop ||
    fxm_die "Push failed, so the release commit is only on your develop. Push it with" \
      "git push origin develop, then run make release-pr VERSION=$version again to finish."
  fxm_info "Pushed develop"
else
  step=committed
  fxm_info "The versions and CHANGELOG.md are up to date: nothing to commit"
fi

retry="develop is pushed, so run make release-pr VERSION=$version again to finish."
if [ -n "$pr_url" ]; then
  gh pr edit "$pr_url" --body-file "$body" >/dev/null ||
    fxm_die "Updating the pull request's notes failed. $retry"
  url=$pr_url
  fxm_info "Updated the notes of the release pull request: $url"
else
  url=$(gh pr create --base main --head develop --title "Release $tag" --body-file "$body") ||
    fxm_die "Opening the pull request failed. $retry"
  fxm_info "Release pull request: $url"
fi
cat <<EOF

Next:
  1. Wait for CI:  gh pr checks $url --watch
     If develop needs a fix first, push it to develop and run make release-pr VERSION=$version
     again: it brings CHANGELOG.md and the notes up to date.
  2. Merge it with a merge commit:  gh pr merge $url --merge
     The release workflow then tags $tag and publishes the GitHub Release.
  3. Once it is published, merge main back into develop, so the next release builds on it:
     git switch develop && git pull --ff-only
     git merge origin/main -m "Merge main back into develop after the $tag release"
     git push origin develop
EOF
