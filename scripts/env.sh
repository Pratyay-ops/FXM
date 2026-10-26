# shellcheck shell=bash
# FXM toolchain environment.
#
# Every script in scripts/ sources this file, `make` runs tools through
# scripts/run.sh (which sources it), and you can source it from an interactive
# bash or zsh shell:
#
#   source scripts/env.sh
#
# Anything a tool would normally install or cache under your home directory is
# redirected into .tools/ of the *main* checkout. Every git worktree therefore
# shares one copy, and `make nuke` deletes all of it. Safe to source repeatedly.

# FXM_ROOT is the checkout you are in (main or a worktree); FXM_HOME is the main
# checkout that owns .tools/. Outside a checkout (a tool spawning bash in /tmp),
# keep what the parent process exported.
_fxm_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$_fxm_root" ] && [ -f "$_fxm_root/scripts/env.sh" ]; then
  FXM_ROOT=$_fxm_root
  FXM_HOME=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
elif [ -z "${FXM_HOME:-}" ]; then
  FXM_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
  FXM_HOME=$FXM_ROOT
fi
unset _fxm_root
export FXM_HOME FXM_ROOT
export FXM_TOOLS="$FXM_HOME/.tools"

# Node: pnpm is pinned in package.json ("packageManager") and installed into
# .tools/bin by scripts/install-pnpm.sh; its store and caches live here too.
export PNPM_HOME="$FXM_TOOLS/pnpm/home"
export pnpm_config_store_dir="$FXM_TOOLS/pnpm/store"
export pnpm_config_cache_dir="$FXM_TOOLS/pnpm/cache"
export pnpm_config_state_dir="$FXM_TOOLS/pnpm/state"
export pnpm_config_global_dir="$FXM_TOOLS/pnpm/global"
export pnpm_config_global_bin_dir="$FXM_TOOLS/pnpm/global-bin"
export pnpm_config_update_notifier=false
# Refuse to install with a Node outside "engines" in package.json, or a dependency whose own
# "engines" leave this Node out. Turned on here rather than in pnpm-workspace.yaml so that it
# covers every make target, scripts/run.sh command and CI job, but not Dependabot, which runs pnpm
# on its own, newer Node (docs/DEVELOPMENT.md, "Node version").
export pnpm_config_engine_strict=true
export npm_config_cache="$FXM_TOOLS/npm/cache"
export npm_config_devdir="$FXM_TOOLS/node-gyp"
export npm_config_update_notifier=false

# Python: uv manages the interpreter and the .venv of each checkout.
export UV_CACHE_DIR="$FXM_TOOLS/uv/cache"
export UV_PYTHON_INSTALL_DIR="$FXM_TOOLS/uv/python"
export UV_PYTHON_BIN_DIR="$FXM_TOOLS/uv/python-bin"
export UV_TOOL_DIR="$FXM_TOOLS/uv/tools"
export UV_TOOL_BIN_DIR="$FXM_TOOLS/uv/tool-bin"
export UV_PYTHON_PREFERENCE=only-managed
export UV_NO_MODIFY_PATH=1
export PIP_CACHE_DIR="$FXM_TOOLS/pip/cache"

# Rust (stage 7.1, the desktop app): rustup, its toolchains and Cargo's registry. The
# toolchain version is pinned in apps/desktop/src-tauri/rust-toolchain.toml.
export RUSTUP_HOME="$FXM_TOOLS/rustup"
export CARGO_HOME="$FXM_TOOLS/cargo"
# Overrides from your own Rust setup would undo that: a shared target directory outside the
# repo, a toolchain other than the pinned one, or a compiler wrapper such as sccache that
# caches under your home folder.
unset CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR RUSTUP_TOOLCHAIN RUSTC_WRAPPER \
  CARGO_BUILD_RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER

# Android (stage 6.1 installs the JDK and SDK here).
export GRADLE_USER_HOME="$FXM_TOOLS/gradle"
export ANDROID_HOME="$FXM_TOOLS/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Android tools keep their settings, keys and caches in ANDROID_USER_HOME, a .android folder.
# The Android Gradle plugin's analytics ignore it and read ANDROID_PREFS_ROOT, which the plugin
# accepts only as the folder holding that .android. ANDROID_SDK_HOME (deprecated) would compete.
export ANDROID_PREFS_ROOT="$FXM_TOOLS/android-user"
export ANDROID_USER_HOME="$ANDROID_PREFS_ROOT/.android"
unset ANDROID_SDK_HOME
_fxm_local_jdk=
if [ -d "$FXM_TOOLS/jdk/Contents/Home" ]; then
  _fxm_local_jdk="$FXM_TOOLS/jdk/Contents/Home"
elif [ -d "$FXM_TOOLS/jdk/bin" ]; then
  _fxm_local_jdk="$FXM_TOOLS/jdk"
fi
if [ -n "$_fxm_local_jdk" ]; then
  export JAVA_HOME="$_fxm_local_jdk"
fi

# Other tools that would write to $HOME.
export GH_CONFIG_DIR="$FXM_TOOLS/gh"
export GH_NO_UPDATE_NOTIFIER=1
export PLAYWRIGHT_BROWSERS_PATH="$FXM_TOOLS/playwright"
export PUPPETEER_CACHE_DIR="$FXM_TOOLS/puppeteer"
export WRANGLER_LOG_PATH="$FXM_TOOLS/wrangler/logs"
export WRANGLER_SEND_METRICS=false
export ASTRO_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1

# PATH: .tools/bin first, then the local JDK, Android tools and .tools/cargo/bin (rustup and
# its cargo and rustc proxies) when installed. Each folder moves to the front even when PATH
# has it already, as after an earlier `source scripts/env.sh`: the Android tools installed
# since then must not end up before .tools/bin, because the SDK's own adb would then shadow
# the wrapper there and write its key to ~/.android.
_fxm_path_prepend() {
  local rest=":$PATH:"
  while :; do
    case $rest in
      *":$1:"*) rest=${rest//":$1:"/:} ;;
      *) break ;;
    esac
  done
  rest=${rest#:}
  rest=${rest%:}
  PATH="$1${rest:+:$rest}"
}
if [ -d "$CARGO_HOME/bin" ]; then
  _fxm_path_prepend "$CARGO_HOME/bin"
fi
if [ -d "$ANDROID_HOME/platform-tools" ]; then
  _fxm_path_prepend "$ANDROID_HOME/platform-tools"
fi
if [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ]; then
  _fxm_path_prepend "$ANDROID_HOME/cmdline-tools/latest/bin"
fi
if [ -n "$_fxm_local_jdk" ]; then
  _fxm_path_prepend "$_fxm_local_jdk/bin"
fi
_fxm_path_prepend "$FXM_TOOLS/bin"
export PATH
unset -f _fxm_path_prepend
unset _fxm_local_jdk

# Settings for this machine only, never committed: for example fewer test workers while
# several worktrees run checks at once (export VITEST_MAX_WORKERS=3). The file lives in
# .tools/, so every worktree reads it and `make nuke` deletes it.
if [ -f "$FXM_TOOLS/env.local.sh" ]; then
  # shellcheck source=/dev/null
  . "$FXM_TOOLS/env.local.sh"
fi
