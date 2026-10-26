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
case "$mode" in build | all | android) ;; *) fxm_die "usage: clean.sh build|all|android" ;; esac

remove_build_output() {
  (cd "$1" && rm -rf dist coverage .wrangler ./*.tsbuildinfo \
    apps/*/dist apps/*/coverage apps/*/.wrangler apps/*/.astro apps/*/*.tsbuildinfo \
    packages/*/dist packages/*/coverage packages/*/*.tsbuildinfo)
}

remove_dependencies() {
  (cd "$1" && rm -rf node_modules apps/*/node_modules packages/*/node_modules .venv apps/*/.venv \
    scripts/build-dist/node_modules scripts/build-dist-wrangler/node_modules)
}

# --- Android app (stage 6.1) -------------------------------------------------------------
# `make apk` leaves the web app's mobile build, the web assets copied into the app and
# Gradle's cache and output in a checkout. `clean.sh android` (make android-clean) removes
# them from this checkout only; `build` and `all` from every checkout. Before `all` deletes
# .tools/, it stops the Gradle daemons running from there and the adb server (adb restarts it
# on demand), so they cannot write to .tools/ again when they exit.
remove_android_output() {
  (cd "$1/apps" && rm -rf web/dist-mobile mobile/android/.gradle mobile/android/build \
    mobile/android/app/build mobile/android/capacitor-cordova-android-plugins/build \
    mobile/android/fxm-http/build mobile/android/app/src/main/assets/public)
}

stop_android_processes() {
  local pid daemons=() waited=0 running
  for pid in $(pgrep -f GradleDaemon || true); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in *"$FXM_TOOLS/"*) daemons+=("$pid") ;; esac
  done
  if [ -x "$FXM_TOOLS/bin/adb" ]; then "$FXM_TOOLS/bin/adb" kill-server >/dev/null 2>&1 || true; fi
  [ ${#daemons[@]} -gt 0 ] || return 0
  kill "${daemons[@]}" 2>/dev/null || true
  while [ "$waited" -lt 20 ]; do
    running=0
    for pid in "${daemons[@]}"; do if kill -0 "$pid" 2>/dev/null; then running=1; fi; done
    [ "$running" -eq 1 ] || break
    sleep 0.5
    waited=$((waited + 1))
  done
  fxm_info "Stopped ${#daemons[@]} Gradle daemon(s) running from .tools"
}

case "$mode" in
  android)
    remove_android_output "$FXM_ROOT"
    fxm_info "Removed the Android build output of this checkout"
    exit 0
    ;;
  all) stop_android_processes ;;
esac
while IFS= read -r checkout; do
  if [ -d "$checkout/apps" ]; then remove_android_output "$checkout"; fi
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')
# --- end of Android app -------------------------------------------------------------------

while IFS= read -r checkout; do
  [ -d "$checkout" ] || continue
  remove_build_output "$checkout"
  if [ "$mode" = all ]; then
    remove_dependencies "$checkout"
  fi
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

# Desktop app (stage 7.1): Cargo's target directory (several GB per checkout), the
# generated capability schemas and the web build the app embeds. Both modes remove them.
while IFS= read -r checkout; do
  [ -d "$checkout" ] || continue
  (cd "$checkout" && rm -rf apps/desktop/src-tauri/target apps/desktop/src-tauri/gen/schemas \
    apps/web/dist-desktop)
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
