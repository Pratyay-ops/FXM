#!/usr/bin/env bash
# Installs pnpm's official standalone binary (@pnpm/exe.<platform>) into .tools/bin,
# pinned and verified against the npm registry's integrity hash. No corepack and
# no global install. The version must match "packageManager" in package.json.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

PNPM_VERSION=12.12.1
case "$(fxm_platform)" in
  darwin-arm64) pkg=exe.darwin-arm64 sri=sha512-MiDDp8DLFFizQId7oiOhtzZ2yM97d3gHVFAxL0wgFCu/SZv8enY9N283HJebyAj63P2pDIYe70krHgWEyVvElQ== ;;
  darwin-x64) pkg=exe.darwin-x64 sri=sha512-81CoZFGlOddF7kiuW+KRMabrWpUWyfljPydes6n8P3sFGBdR+d04tKP8E9I9wp4MQ+kj/n2g8MbFDu0+c7pwSw== ;;
  linux-x64) pkg=exe.linux-x64 sri=sha512-3bJ3kvMif7clfxePoBZ40FGvU54GhLwQ+ebxjxGuKYHwrDySMfyggVGR0gYYcprq6IPGy6CrTPiqgP5TOTLC5w== ;;
  linux-arm64) pkg=exe.linux-arm64 sri=sha512-RsGsD7WF1xQbTU1LW/5PLRiVMdMkQCYrOjTbHdaTYebelRYPgjRlxG8u0oVtVTD62ePNCjwQp+DSE8q8E+dyUA== ;;
esac

pinned=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' "$FXM_ROOT/package.json")
[ "$pinned" = "$PNPM_VERSION" ] ||
  fxm_die "package.json pins pnpm@$pinned but scripts/install-pnpm.sh installs $PNPM_VERSION; update both together"

if [ -x "$FXM_TOOLS/bin/pnpm" ] && [ "$("$FXM_TOOLS/bin/pnpm" --version 2>/dev/null)" = "$PNPM_VERSION" ]; then
  fxm_info "pnpm $PNPM_VERSION already installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fxm_download_sri "https://registry.npmjs.org/@pnpm/$pkg/-/$pkg-$PNPM_VERSION.tgz" "$tmp/pnpm.tgz" "$sri"
tar -xzf "$tmp/pnpm.tgz" -C "$tmp"
mkdir -p "$FXM_TOOLS/bin"
install -m 0755 "$tmp/package/pnpm" "$FXM_TOOLS/bin/pnpm"
fxm_info "pnpm $PNPM_VERSION installed in .tools/bin"
