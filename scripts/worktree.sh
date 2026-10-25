#!/usr/bin/env bash
# Creates or removes the worktree for one plan stage (see docs/WORKFLOW.md).
#
#   worktree.sh new feat/1.4-jiosaavn     # branch from origin/develop + install deps
#   worktree.sh new feat/1.4-x other-ref  # branch from another ref (avoid stacking stages)
#   worktree.sh remove feat/1.4-jiosaavn  # refuses if there are uncommitted changes
#
# Worktrees live next to the main checkout in <checkout>-worktrees/ (override
# with FXM_WORKTREES) and share its .tools/ directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

cmd=${1:-}
branch=${2:-}
[ -n "$branch" ] || fxm_die "BRANCH is required, e.g. make wt-${cmd:-new} BRANCH=feat/1.4-jiosaavn"
case "$branch" in
  feat/* | fix/* | docs/* | chore/* | ci/* | build/* | refactor/* | test/* | perf/* | hotfix/*) ;;
  *) fxm_die "branch must look like <type>/<stage-id>-<slug>, e.g. feat/1.4-jiosaavn" ;;
esac

worktrees=${FXM_WORKTREES:-"$(dirname "$FXM_HOME")/$(basename "$FXM_HOME")-worktrees"}
path="$worktrees/${branch//\//-}"

case "$cmd" in
  new)
    base=${3:-origin/develop}
    case "$branch" in hotfix/*) base=${3:-origin/main} ;; esac
    git fetch --quiet origin
    git worktree add --no-track -b "$branch" "$path" "$base"
    (cd "$path" && pnpm install --prefer-offline)
    fxm_info "Worktree ready: $path (branch $branch from $base)"
    ;;
  remove)
    git worktree remove "$path"
    rmdir "$worktrees" 2>/dev/null || true
    fxm_info "Removed worktree $path (branch $branch is kept)"
    ;;
  *)
    fxm_die "usage: worktree.sh new|remove <branch>"
    ;;
esac
