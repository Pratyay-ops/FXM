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
  # env.sh turns it on, and pnpm-workspace.yaml must not (docs/DEVELOPMENT.md, "Node version").
  if [ "$(cd "$FXM_ROOT" && pnpm config get engine-strict 2>/dev/null)" != true ]; then
    bad pnpm "engine-strict is off: scripts/env.sh must export pnpm_config_engine_strict=true"
  fi
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

# Desktop app (stage 7.1): the repo-local Rust toolchain, then the OS packages Tauri
# needs, which can't live in the repo. Reads the toolchain directly, so rustup never
# starts a download from here.
rust_toolchain_file="$FXM_ROOT/apps/desktop/src-tauri/rust-toolchain.toml"
rust_channel=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$rust_toolchain_file" 2>/dev/null)
rust_toolchain=$(find "$RUSTUP_HOME/toolchains" -maxdepth 1 -name "$rust_channel-*" 2>/dev/null | head -1)
if [ -n "$rust_channel" ] && [ -x "$rust_toolchain/bin/rustc" ]; then
  ok rust "$("$rust_toolchain/bin/rustc" --version | cut -d' ' -f1-2), rustup in $(short "$CARGO_HOME/bin")"
else
  opt rust "not installed: 'make rust-setup' (desktop app)"
fi
# env.sh clears Rust overrides from the environment, but Cargo also reads .cargo/config.toml
# in every folder above the checkout, whatever CARGO_HOME says: ~/.cargo/config.toml too when
# the checkout is in your home folder. Only a warning, as it matters only for desktop builds.
cargo_config_dir=$(dirname "$FXM_ROOT")
while :; do
  for cargo_config in "$cargo_config_dir/.cargo/config.toml" "$cargo_config_dir/.cargo/config"; do
    if [ -f "$cargo_config" ] &&
      grep -Eq '^[^#]*(target-dir|rustc-wrapper|rustc-workspace-wrapper)[[:space:]]*=' \
        "$cargo_config"; then
      shown=${cargo_config#"$HOME"/}
      [ "$shown" = "$cargo_config" ] || shown="~/$shown"
      printf '  \033[33m!\033[0m %-10s %s\n' rust \
        "$shown sets target-dir or a rustc wrapper: desktop builds would write outside the repo"
    fi
  done
  [ "$cargo_config_dir" != / ] || break
  cargo_config_dir=$(dirname "$cargo_config_dir")
done
case "$(uname -s)" in
  Darwin)
    if clt=$(xcode-select -p 2>/dev/null); then
      ok desktop "Xcode Command Line Tools ($clt)"
    else
      opt desktop "Xcode Command Line Tools missing: 'xcode-select --install' (desktop app)"
    fi
    ;;
  Linux)
    if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1; then
      ok desktop "webkit2gtk-4.1 $(pkg-config --modversion webkit2gtk-4.1)"
    else
      opt desktop "webkit2gtk-4.1 not found: see 'Desktop app' in docs/DEVELOPMENT.md"
    fi
    ;;
  *)
    opt desktop "needs the MSVC Build Tools and WebView2: see 'Desktop app' in docs/DEVELOPMENT.md"
    ;;
esac

echo
if [ "$failed" -ne 0 ]; then
  fxm_die "Some required checks failed"
fi
fxm_info "All required checks passed"
