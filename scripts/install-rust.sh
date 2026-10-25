#!/usr/bin/env bash
# Installs a pinned, checksum-verified rustup into .tools/ (RUSTUP_HOME and CARGO_HOME
# come from env.sh), then the Rust toolchain pinned in
# apps/desktop/src-tauri/rust-toolchain.toml. Nothing is written to ~/.cargo, ~/.rustup
# or any shell profile: env.sh puts .tools/cargo/bin on PATH instead.
#
#   install-rust.sh          install or update to the pinned versions (make rust-setup)
#   install-rust.sh --check  only fail, with a hint, when Rust is not set up yet
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

toolchain_dir="$FXM_ROOT/apps/desktop/src-tauri"
toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$toolchain_dir/rust-toolchain.toml")
[ -n "$toolchain" ] || fxm_die "no channel in apps/desktop/src-tauri/rust-toolchain.toml"
rustup="$CARGO_HOME/bin/rustup"

if [ "${1:-}" = --check ]; then
  installed=$([ -x "$rustup" ] && "$rustup" toolchain list || true)
  case "$installed" in
    "$toolchain"-* | *$'\n'"$toolchain"-*) exit 0 ;;
    *) fxm_die "Rust $toolchain is not set up for the desktop app: run 'make rust-setup'" ;;
  esac
fi

RUSTUP_VERSION=1.29.1
case "$(fxm_platform)" in
  darwin-arm64) target=aarch64-apple-darwin sha=ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a ;;
  darwin-x64) target=x86_64-apple-darwin sha=259e2b84274434085163fe8d556510571772cda2aa6d87ca6aa664f57bc644e3 ;;
  linux-x64) target=x86_64-unknown-linux-gnu sha=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;;
  linux-arm64) target=aarch64-unknown-linux-gnu sha=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;;
esac

if [ -x "$rustup" ] && [ "$("$rustup" --version 2>/dev/null | cut -d' ' -f2)" = "$RUSTUP_VERSION" ]; then
  fxm_info "rustup $RUSTUP_VERSION already installed"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fxm_download "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$target/rustup-init" \
    "$tmp/rustup-init" "$sha"
  chmod +x "$tmp/rustup-init"
  # --no-modify-path leaves shell profiles alone, and --default-toolchain none skips the
  # latest stable: the pinned toolchain is installed from rust-toolchain.toml below. Its
  # stdout only explains how to edit PATH, which env.sh already does.
  "$tmp/rustup-init" -y --quiet --no-modify-path --profile minimal --default-toolchain none \
    >/dev/null
  fxm_info "rustup $RUSTUP_VERSION installed in .tools/cargo/bin"
fi

# rustup reads the channel, profile and components from the toolchain file. Making it the
# default too lets cargo run outside src-tauri.
(cd "$toolchain_dir" && "$rustup" toolchain install)
"$rustup" default "$toolchain"
# Keep rustup at the pinned version: `rustup update` must not replace it with the latest.
"$rustup" set auto-self-update disable

# Each toolchain takes about 500 MB: drop the ones an older pin left behind.
while IFS= read -r old; do
  case "$old" in
    "$toolchain"-*) ;;
    [0-9]*.[0-9]*.[0-9]*-*)
      "$rustup" toolchain uninstall "$old"
      fxm_info "Removed old Rust toolchain $old"
      ;;
  esac
done < <("$rustup" toolchain list | cut -d' ' -f1)
fxm_info "Rust $toolchain installed in .tools/rustup ($("$rustup" run "$toolchain" rustc --version))"
