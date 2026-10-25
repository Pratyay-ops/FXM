#!/usr/bin/env bash
# Installs a pinned, checksum-verified GitHub CLI into .tools/bin (optional, for the PR workflow).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

GH_VERSION=2.102.0
case "$(fxm_platform)" in
  darwin-arm64) asset=gh_${GH_VERSION}_macOS_arm64.zip sha=da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e ;;
  darwin-x64) asset=gh_${GH_VERSION}_macOS_amd64.zip sha=b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3 ;;
  linux-x64) asset=gh_${GH_VERSION}_linux_amd64.tar.gz sha=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;;
  linux-arm64) asset=gh_${GH_VERSION}_linux_arm64.tar.gz sha=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;;
esac

if [ -x "$FXM_TOOLS/bin/gh" ] && "$FXM_TOOLS/bin/gh" --version | grep -q "gh version $GH_VERSION "; then
  fxm_info "gh $GH_VERSION already installed"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fxm_download "https://github.com/cli/cli/releases/download/v$GH_VERSION/$asset" "$tmp/$asset" "$sha"
  case "$asset" in
    *.zip) unzip -q "$tmp/$asset" -d "$tmp" && dir=${asset%.zip} ;;
    *) tar -xzf "$tmp/$asset" -C "$tmp" && dir=${asset%.tar.gz} ;;
  esac
  mkdir -p "$FXM_TOOLS/bin"
  install -m 0755 "$tmp/$dir/bin/gh" "$FXM_TOOLS/bin/gh"
  fxm_info "gh $GH_VERSION installed in .tools/bin"
fi

echo "Log in with:  source scripts/env.sh && gh auth login --insecure-storage"
echo "(--insecure-storage keeps the token in .tools/gh instead of your keychain, so 'make nuke' removes it.)"
