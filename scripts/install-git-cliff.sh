#!/usr/bin/env bash
# Installs a pinned, checksum-verified git-cliff (changelog and release notes generator) into
# .tools/bin. The release scripts run it; see "Releases" in docs/WORKFLOW.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

# Linux uses the static musl builds, which run on any distribution.
GIT_CLIFF_VERSION=2.14.2
case "$(fxm_platform)" in
  darwin-arm64) target=aarch64-apple-darwin sha=a0be97e237d440d34c5e508ec21d070b2c85cbb8be48a46a56f9a4e8bd247f05 ;;
  darwin-x64) target=x86_64-apple-darwin sha=4e647d2deb152aca1e987f225cf42b080b991dd98f3bce4027ef95446d982ac3 ;;
  linux-x64) target=x86_64-unknown-linux-musl sha=fa21e2fc70046fcfd0e43e5e4613873ab799aff3d9dc8559c00d31b270e417d0 ;;
  linux-arm64) target=aarch64-unknown-linux-musl sha=4be21b21ec9699af4d330b224aeba8a41d41d8f5b351ca2da8a9ea2bdc36380f ;;
esac

if [ -x "$FXM_TOOLS/bin/git-cliff" ] &&
  [ "$("$FXM_TOOLS/bin/git-cliff" --version | cut -d' ' -f2)" = "$GIT_CLIFF_VERSION" ]; then
  fxm_info "git-cliff $GIT_CLIFF_VERSION already installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
archive=git-cliff-$GIT_CLIFF_VERSION-$target.tar.gz
fxm_download "https://github.com/orhun/git-cliff/releases/download/v$GIT_CLIFF_VERSION/$archive" \
  "$tmp/$archive" "$sha"
tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$FXM_TOOLS/bin"
install -m 0755 "$tmp/git-cliff-$GIT_CLIFF_VERSION/git-cliff" "$FXM_TOOLS/bin/git-cliff"
fxm_info "git-cliff $GIT_CLIFF_VERSION installed in .tools/bin"
