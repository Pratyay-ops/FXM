# shellcheck shell=bash
# Helpers shared by the FXM bootstrap scripts. Source after env.sh.

fxm_info() { printf '\033[32m✔\033[0m %s\n' "$*"; }
fxm_warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
fxm_die() {
  printf '\033[31m✘\033[0m %s\n' "$*" >&2
  exit 1
}

# Prints the platform as <os>-<cpu>: darwin-arm64, darwin-x64, linux-x64, linux-arm64.
fxm_platform() {
  local os cpu
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fxm_die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) cpu=arm64 ;;
    x86_64 | amd64) cpu=x64 ;;
    *) fxm_die "unsupported CPU: $(uname -m)" ;;
  esac
  echo "$os-$cpu"
}

fxm_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fxm_curl <url> <dest>: download, retrying any failure (including mid-transfer resets).
fxm_curl() {
  curl --fail --location --silent --show-error --retry 4 --retry-all-errors --retry-delay 2 \
    --output "$2" "$1"
}

# fxm_download <url> <dest> <sha256>: download and refuse anything that doesn't match the pin.
fxm_download() {
  local url=$1 dest=$2 want=$3 got
  fxm_curl "$url" "$dest"
  got=$(fxm_sha256 "$dest")
  if [ "$got" != "$want" ]; then
    rm -f "$dest"
    fxm_die "checksum mismatch for $url (expected $want, got $got)"
  fi
}

# fxm_download_sri <url> <dest> <sha512-…>: same, for npm registry integrity strings.
fxm_download_sri() {
  local url=$1 dest=$2 want=$3 got
  fxm_curl "$url" "$dest"
  got="sha512-$(openssl dgst -sha512 -binary "$dest" | openssl base64 -A)"
  if [ "$got" != "$want" ]; then
    rm -f "$dest"
    fxm_die "integrity mismatch for $url (expected $want, got $got)"
  fi
}

# Major Node version the project wants, from .nvmrc.
fxm_wanted_node_major() {
  tr -d ' \nv' <"$FXM_ROOT/.nvmrc" | cut -d. -f1
}

fxm_require_prereqs() {
  local cmd want have
  for cmd in git curl tar openssl; do
    command -v "$cmd" >/dev/null 2>&1 || fxm_die "$cmd is required but not installed"
  done
  command -v node >/dev/null 2>&1 ||
    fxm_die "Node.js is required. Install it with nvm: 'nvm install' (reads .nvmrc)"
  want=$(fxm_wanted_node_major)
  have=$(node -p 'process.versions.node.split(".")[0]')
  [ "$have" = "$want" ] ||
    fxm_die "Node $want is required (found $(node --version)). Run 'nvm install && nvm use' in this folder"
}
