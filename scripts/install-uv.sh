#!/usr/bin/env bash
# Installs a pinned, checksum-verified uv (Python and virtualenv manager) into .tools/bin.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

UV_VERSION=0.12.24
case "$(fxm_platform)" in
  darwin-arm64) target=aarch64-apple-darwin sha=0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732 ;;
  darwin-x64) target=x86_64-apple-darwin sha=4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6 ;;
  linux-x64) target=x86_64-unknown-linux-gnu sha=b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6 ;;
  linux-arm64) target=aarch64-unknown-linux-gnu sha=5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21 ;;
esac

if [ -x "$FXM_TOOLS/bin/uv" ] && [ "$("$FXM_TOOLS/bin/uv" --version | cut -d' ' -f2)" = "$UV_VERSION" ]; then
  fxm_info "uv $UV_VERSION already installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fxm_download "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$target.tar.gz" "$tmp/uv.tar.gz" "$sha"
tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
mkdir -p "$FXM_TOOLS/bin"
install -m 0755 "$tmp/uv-$target/uv" "$tmp/uv-$target/uvx" "$FXM_TOOLS/bin/"
fxm_info "uv $UV_VERSION installed in .tools/bin"
