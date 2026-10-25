#!/usr/bin/env bash
# Installs the Android toolchain into .tools/ (make android-setup):
#
#   .tools/jdk           Eclipse Temurin JDK 21, pinned and checksum-verified
#   .tools/android-sdk   the Android command-line tools (pinned and checksum-verified),
#                        then platform-tools, the SDK platform and the build tools
#   .tools/bin/adb       a wrapper that keeps adb's key in .tools/android-user
#
# It accepts the Android SDK licenses for you (`yes | sdkmanager --licenses`) and says
# so. scripts/env.sh points JAVA_HOME, ANDROID_HOME, ANDROID_USER_HOME (with
# ANDROID_PREFS_ROOT) and GRADLE_USER_HOME into .tools/; this script also checks that
# it created nothing in ~/.android, ~/.gradle, ~/.m2 or ~/Library/Android. Safe to
# re-run: it installs only what is missing, so a complete setup needs no network.
#
#   android-setup.sh           install what is missing
#   android-setup.sh --check   only check that everything is installed (make apk runs this)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

# Eclipse Temurin JDK 21: Gradle and the Android Gradle plugin run on it. The hashes are
# the .sha256.txt files published next to each tarball on the GitHub release.
JDK_VERSION=21.0.12.1+1
case "$(fxm_platform)" in
  darwin-arm64) jdk_target=aarch64_mac jdk_sha=3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998 ;;
  darwin-x64) jdk_target=x64_mac jdk_sha=44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce ;;
  linux-x64) jdk_target=x64_linux jdk_sha=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94 ;;
  linux-arm64) jdk_target=aarch64_linux jdk_sha=23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223 ;;
esac
jdk_asset=OpenJDK21U-jdk_${jdk_target}_hotspot_${JDK_VERSION/+/_}.tar.gz
jdk_url=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JDK_VERSION/+/%2B}/$jdk_asset

# Android SDK command-line tools (sdkmanager). The hashes are the SHA-256 column of
# https://developer.android.com/studio#command-line-tools-only; Google's repository listing,
# https://dl.google.com/android/repository/repository2-3.xml, has their SHA-1.
CMDLINE_TOOLS_VERSION=22.0
CMDLINE_TOOLS_BUILD=15859902
case "$(fxm_platform)" in
  darwin-arm64) tools_os=mac_arm64 tools_sha=835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e ;;
  darwin-x64) tools_os=mac_x86_64 tools_sha=c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3 ;;
  linux-*) tools_os=linux tools_sha=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583 ;;
esac
tools_asset=commandlinetools-${tools_os}-${CMDLINE_TOOLS_BUILD}_latest.zip

# What Capacitor 8's Android project builds with: the SDK platform of its compileSdkVersion
# (apps/mobile/android/variables.gradle, kept in step by a test) and the default build
# tools of its Android Gradle plugin 8.13. sdkmanager verifies each download.
SDK_PLATFORM=36
SDK_BUILD_TOOLS=35.0.0
sdk_packages=(platform-tools "platforms;android-$SDK_PLATFORM" "build-tools;$SDK_BUILD_TOOLS")

jdk_home=$FXM_TOOLS/jdk
if [ "$(uname -s)" = Darwin ]; then jdk_home=$FXM_TOOLS/jdk/Contents/Home; fi
sdkmanager=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager

jdk_ok() { grep -qs "^JAVA_RUNTIME_VERSION=\"$JDK_VERSION" "$jdk_home/release"; }
tools_ok() { grep -qs "^Pkg.Revision=$CMDLINE_TOOLS_VERSION" "$ANDROID_HOME/cmdline-tools/latest/source.properties"; }
package_ok() { [ -f "$ANDROID_HOME/${1//;//}/source.properties" ]; } # "a;b" lives in a/b
licenses_ok() { [ -f "$ANDROID_HOME/licenses/android-sdk-license" ]; }

missing_parts() {
  local package
  jdk_ok || echo "JDK $JDK_VERSION"
  tools_ok || echo "command-line tools $CMDLINE_TOOLS_VERSION"
  for package in "${sdk_packages[@]}"; do package_ok "$package" || echo "$package"; done
  licenses_ok || echo "accepted SDK licenses"
}

if [ "${1:-}" = --check ]; then
  missing=$(missing_parts | paste -sd, - | sed 's/,/, /g')
  [ -z "$missing" ] ||
    fxm_die "The Android toolchain is incomplete (missing: $missing). Run 'make android-setup' first."
  fxm_info "Android toolchain: JDK $JDK_VERSION, SDK platform $SDK_PLATFORM, build tools $SDK_BUILD_TOOLS"
  exit 0
fi
[ $# -eq 0 ] || fxm_die "usage: android-setup.sh [--check]"
command -v unzip >/dev/null 2>&1 || fxm_die "unzip is required but not installed"

# The folders Android tools create in your home when they run outside scripts/env.sh.
home_dirs=("$HOME/.android" "$HOME/.gradle" "$HOME/.m2" "$HOME/Library/Android")
absent=()
for dir in "${home_dirs[@]}"; do [ -e "$dir" ] || absent+=("$dir"); done

mkdir -p "$FXM_TOOLS"
tmp=$(mktemp -d "$FXM_TOOLS/.android-setup.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

if jdk_ok; then
  fxm_info "JDK $JDK_VERSION already installed"
else
  echo "Downloading Eclipse Temurin JDK $JDK_VERSION (about 200 MB)..."
  fxm_download "$jdk_url" "$tmp/$jdk_asset" "$jdk_sha"
  mkdir "$tmp/jdk"
  tar -xzf "$tmp/$jdk_asset" -C "$tmp/jdk" --strip-components 1
  rm -rf "$FXM_TOOLS/jdk"
  mv "$tmp/jdk" "$FXM_TOOLS/jdk"
  jdk_ok || fxm_die "the JDK archive does not contain JDK $JDK_VERSION"
  fxm_info "JDK $JDK_VERSION installed in .tools/jdk"
fi
export JAVA_HOME=$jdk_home

if tools_ok; then
  fxm_info "Android command-line tools $CMDLINE_TOOLS_VERSION already installed"
else
  echo "Downloading the Android command-line tools $CMDLINE_TOOLS_VERSION (about 160 MB)..."
  fxm_download "https://dl.google.com/android/repository/$tools_asset" "$tmp/$tools_asset" "$tools_sha"
  unzip -q "$tmp/$tools_asset" -d "$tmp/tools"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  tools_ok || fxm_die "the archive does not contain the command-line tools $CMDLINE_TOOLS_VERSION"
  fxm_info "Android command-line tools $CMDLINE_TOOLS_VERSION installed in .tools/android-sdk"
fi

missing_packages=()
for package in "${sdk_packages[@]}"; do package_ok "$package" || missing_packages+=("$package"); done

# Accepting the licenses needs the network, so it runs only when there is something to install.
if licenses_ok && [ ${#missing_packages[@]} -eq 0 ]; then
  fxm_info "Android SDK licenses already accepted"
else
  { yes || true; } | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >"$tmp/licenses.log" 2>&1 ||
    { cat "$tmp/licenses.log" >&2 && fxm_die "sdkmanager --licenses failed"; }
  licenses_ok || { cat "$tmp/licenses.log" >&2 && fxm_die "the Android SDK licenses were not accepted"; }
  fxm_info "Accepted the Android SDK licenses for you (yes | sdkmanager --licenses)." \
    "Terms: https://developer.android.com/studio/terms"
fi

if [ ${#missing_packages[@]} -gt 0 ]; then
  echo "Installing ${missing_packages[*]} with sdkmanager (about 300 MB)..."
  if [ -t 1 ]; then
    "$sdkmanager" --sdk_root="$ANDROID_HOME" --install "${missing_packages[@]}"
  else # no progress bars in CI logs
    "$sdkmanager" --sdk_root="$ANDROID_HOME" --install "${missing_packages[@]}" >"$tmp/sdkmanager.log" 2>&1 ||
      { tail -n 30 "$tmp/sdkmanager.log" >&2 && fxm_die "sdkmanager --install failed"; }
  fi
  for package in "${missing_packages[@]}"; do
    package_ok "$package" || fxm_die "sdkmanager did not install $package"
  done
fi
fxm_info "SDK packages: ${sdk_packages[*]}"

# adb ignores ANDROID_USER_HOME and keeps its key in $HOME/.android, so this wrapper (first on
# PATH through scripts/env.sh) runs it with .tools/android-user as its home.
mkdir -p "$FXM_TOOLS/bin"
cat >"$FXM_TOOLS/bin/adb" <<'WRAPPER'
#!/bin/sh
# Written by scripts/android-setup.sh: runs the repo-local adb with .tools/android-user as its
# home, so its key lands in .tools/android-user/.android (ANDROID_USER_HOME), not ~/.android.
tools=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$tools/android-user"
HOME=$tools/android-user exec "$tools/android-sdk/platform-tools/adb" "$@"
WRAPPER
chmod 0755 "$FXM_TOOLS/bin/adb"

for dir in ${absent[@]+"${absent[@]}"}; do
  [ ! -e "$dir" ] ||
    fxm_die "$dir was created during setup, so a tool ignored scripts/env.sh. Remove it with: rm -rf '$dir'"
done
tilde='~'
if [ ${#absent[@]} -eq ${#home_dirs[@]} ]; then
  fxm_info "Nothing was created in ~/.android, ~/.gradle, ~/.m2 or ~/Library/Android"
elif [ ${#absent[@]} -gt 0 ]; then
  fxm_info "Nothing was created in ${absent[*]/#$HOME/$tilde} (the others existed already)"
fi

if [ "$(fxm_platform)" = linux-arm64 ]; then
  fxm_warn "Google publishes the SDK build tools (aapt2) for x86-64 Linux only: 'make apk' needs x86-64 emulation here."
fi
fxm_info "Android toolchain ready: $(du -sh "$FXM_TOOLS/jdk" | cut -f1) JDK," \
  "$(du -sh "$ANDROID_HOME" | cut -f1) SDK. Build the app with 'make apk'."
