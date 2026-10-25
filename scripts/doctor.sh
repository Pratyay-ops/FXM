#!/usr/bin/env bash
# Checks prerequisites and shows where every tool lives. Exits non-zero when a
# required tool is missing or something would be installed outside .tools/.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

failed=0
ok() { printf '  \033[32m✔\033[0m %-10s %s\n' "$1" "$2"; }
bad() {
  printf '  \033[31m✘\033[0m %-10s %s\n' "$1" "$2"
  failed=1
}
opt() { printf '  \033[2m·\033[0m %-10s %s\n' "$1" "$2"; }
short() { echo "${1/#$FXM_HOME/.}"; }

echo "FXM doctor"
echo "  checkout   $FXM_ROOT"
echo "  tools      $FXM_TOOLS ($(du -sh "$FXM_TOOLS" 2>/dev/null | cut -f1 || echo empty))"
echo
echo "Required"
version_of() {
  case "$1" in
    openssl) openssl version ;;
    *) "$1" --version 2>&1 | head -1 | cut -c1-60 ;;
  esac
}
for cmd in git curl tar openssl make; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd" "$(version_of "$cmd")"; else bad "$cmd" "not found"; fi
done

want=$(fxm_wanted_node_major)
if command -v node >/dev/null 2>&1; then
  have=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$have" = "$want" ]; then
    ok node "$(node --version) ($(command -v node))"
  else
    bad node "$(node --version) found, Node $want wanted (.nvmrc): run 'nvm install && nvm use'"
  fi
else
  bad node "not found: install Node $want with nvm ('nvm install')"
fi

if [ -x "$FXM_TOOLS/bin/pnpm" ]; then
  store=$(cd "$FXM_ROOT" && pnpm store path 2>/dev/null)
  case "$store" in
    "$FXM_TOOLS"/*) ok pnpm "$(pnpm --version), store $(short "$store")" ;;
    *) bad pnpm "store is outside .tools/: $store" ;;
  esac
else
  bad pnpm "not set up: run 'make setup'"
fi

echo
echo "Optional"
if [ -x "$FXM_TOOLS/bin/uv" ]; then ok uv "$(uv --version)"; else opt uv "not installed: 'make py-setup' (needed from stage 7.1)"; fi
if [ -x "$FXM_ROOT/.venv/bin/python" ]; then
  ok .venv "$("$FXM_ROOT/.venv/bin/python" --version) ($(short "$(readlink -f "$FXM_ROOT/.venv/bin/python" 2>/dev/null || echo "$FXM_ROOT/.venv/bin/python")"))"
else
  opt .venv "not created: 'make py-setup'"
fi
if [ -x "$FXM_TOOLS/bin/gh" ]; then ok gh "$(gh --version | head -1)"; else opt gh "not installed: 'make gh-setup' (only for the PR workflow)"; fi
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  ok java "$("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
else
  opt java "not installed: 'make android-setup' (stage 6.1)"
fi
# Gradle: the version the Android project's wrapper pins, and whether `make apk` fetched it yet.
wrapper=$FXM_ROOT/apps/mobile/android/gradle/wrapper/gradle-wrapper.properties
if [ -f "$wrapper" ]; then
  gradle=$(sed -n 's|^distributionUrl=.*/gradle-\([^/]*\)-[a-z]*\.zip$|\1|p' "$wrapper")
  fetched=
  for bin in "$GRADLE_USER_HOME/wrapper/dists/gradle-$gradle-"*/*/"gradle-$gradle/bin/gradle"; do
    if [ -x "$bin" ]; then fetched=1; fi
  done
  if [ -n "$fetched" ]; then
    ok gradle "$gradle (wrapper, in $(short "$GRADLE_USER_HOME"))"
  else
    opt gradle "$gradle (wrapper): the first 'make apk' downloads it"
  fi
fi
if [ -d "$ANDROID_HOME/platform-tools" ]; then ok android "$(short "$ANDROID_HOME")"; else opt android "not installed: 'make android-setup' (stage 6.1)"; fi
if command -v ffmpeg >/dev/null 2>&1; then
  ok ffmpeg "$(ffmpeg -version | head -1 | cut -d' ' -f1-3) (system, used by the self-hosted server)"
else
  opt ffmpeg "not found (only the self-hosted server in stage 7.1 needs it)"
fi

echo
if [ "$failed" -ne 0 ]; then
  fxm_die "Some required checks failed"
fi
fxm_info "All required checks passed"
