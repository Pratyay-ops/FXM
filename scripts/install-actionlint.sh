#!/usr/bin/env bash
# Installs a pinned, checksum-verified actionlint (GitHub Actions workflow linter) into .tools/bin.
# `make release-check` runs it on .github/workflows.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

ACTIONLINT_VERSION=1.7.12
case "$(fxm_platform)" in
  darwin-arm64) target=darwin_arm64 sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  darwin-x64) target=darwin_amd64 sha=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  linux-x64) target=linux_amd64 sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  linux-arm64) target=linux_arm64 sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
esac

if [ -x "$FXM_TOOLS/bin/actionlint" ] &&
  [ "$("$FXM_TOOLS/bin/actionlint" -version | head -1)" = "$ACTIONLINT_VERSION" ]; then
  fxm_info "actionlint $ACTIONLINT_VERSION already installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
archive=actionlint_${ACTIONLINT_VERSION}_$target.tar.gz
fxm_download "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/$archive" \
  "$tmp/$archive" "$sha"
tar -xzf "$tmp/$archive" -C "$tmp" actionlint
mkdir -p "$FXM_TOOLS/bin"
install -m 0755 "$tmp/actionlint" "$FXM_TOOLS/bin/actionlint"
fxm_info "actionlint $ACTIONLINT_VERSION installed in .tools/bin"
