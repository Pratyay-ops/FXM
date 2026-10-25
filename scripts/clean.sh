#!/usr/bin/env bash
# clean.sh build  removes build output in every checkout (keeps dependencies).
# clean.sh all    also removes every installed tool, dependency and cache:
#                 node_modules and .venv in every worktree, plus the shared .tools/.
# Nothing tracked by git and no uncommitted work is touched.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

mode=${1:-build}
case "$mode" in build | all) ;; *) fxm_die "usage: clean.sh build|all" ;; esac

remove_build_output() {
  (cd "$1" && rm -rf dist coverage .wrangler ./*.tsbuildinfo \
    apps/*/dist apps/*/coverage apps/*/.wrangler apps/*/.astro apps/*/*.tsbuildinfo \
    packages/*/dist packages/*/coverage packages/*/*.tsbuildinfo)
}

remove_dependencies() {
  (cd "$1" && rm -rf node_modules apps/*/node_modules packages/*/node_modules .venv apps/*/.venv)
}

while IFS= read -r checkout; do
  [ -d "$checkout" ] || continue
  remove_build_output "$checkout"
  if [ "$mode" = all ]; then
    remove_dependencies "$checkout"
  fi
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

if [ "$mode" = build ]; then
  fxm_info "Removed build output"
  exit 0
fi

if [ -d "$FXM_TOOLS" ]; then
  size=$(du -sh "$FXM_TOOLS" 2>/dev/null | cut -f1)
  chmod -R u+w "$FXM_TOOLS" 2>/dev/null || true
  rm -rf "$FXM_TOOLS"
  fxm_info "Removed .tools ($size)"
fi
fxm_info "Removed node_modules and .venv from every checkout. Run 'make setup' to start again."
