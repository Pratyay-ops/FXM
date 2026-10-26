#!/usr/bin/env bash
# Builds and signs FXM's release APKs (stage 6.6) in two steps, which the release workflow runs in
# separate jobs, so that the signing key never meets the build's third-party code (Gradle, its
# plugins and the npm packages):
#
#   release-apk.sh build <out dir>
#       make dist (for its third-party notices), the web app with base '/', cap sync, the APK's
#       third-party notices (below), then Gradle's assembleRelease with -PfxmReleaseApks: unsigned
#       APKs for arm64-v8a phones and for every phone, copied into <out dir> as
#       fxm-android-<arm64-v8a|universal>-<version>-unsigned.apk. It refuses to run while a
#       signing variable (below) is set, because everything it runs would see it.
#   release-apk.sh sign [--dry-run] [--version x.y.z] [--certificate <file>] <unsigned dir> <out dir>
#       signs them with apksigner, checks them and writes fxm-android-arm64-v8a-<version>.apk and
#       fxm-android-universal-<version>.apk into <out dir>
#   release-apk.sh dry-run [--version x.y.z] <unsigned dir> <out dir>
#       sign --dry-run with a throwaway key that it makes for the run in a private temporary
#       folder (scripts/make-android-keystore.sh) and deletes: make apk-release and the Android
#       workflow's dry run, which never see FXM's key
#
# The version is apps/mobile/package.json's, unless --version names it (which must then match the
# APKs). The key comes from four variables, the release workflow's secrets (RELEASING.md):
# ANDROID_KEYSTORE_BASE64 (or ANDROID_KEYSTORE_FILE, a path, which tests and dry runs use),
# ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Without them, sign fails:
# a release APK is signed with FXM's key or not at all. Its certificate must be the one pinned in
# apps/mobile/release-certificate.txt (or --certificate). --dry-run accepts any key and is for
# tests and dry runs, never for files that get published.
#
# FXM's key itself is only ever used by the release workflow's android-sign job, on a fresh runner
# where no build ran. Never put it into the environment of a shell on a computer that builds or
# installs anything: code that ran there before (an npm package, a Gradle plugin) could have
# changed the tools this script runs.
#
# The third-party notices, which Settings → About shows, go into every APK as
# assets/public/third-party-notices.txt: the Android libraries that Gradle resolves for the release
# build (fxmLibraryReport, android/app/libraries.gradle), checked against the licences FXM accepts,
# and make dist's notices of the web app (scripts/notices.ts, which fails the build on a library
# FXM may not ship).
#
# Every signed APK must verify with apksigner (APK Signature Scheme v2 and v3, exactly one signer),
# be the package io.github.pratyayops.fxm with the version and the version code of
# app/build.gradle, not be debuggable, carry the third-party notices, and in the arm64-v8a APK any
# native code must be for arm64-v8a. Like make apk, the build checks that nothing appeared in
# ~/.android, ~/.gradle, ~/.m2 or ~/Library/Android, and Gradle runs without a daemon.
set -euo pipefail
start=$PWD
mobile=$(cd "$(dirname "$0")/.." && pwd)
cd "$mobile"
source ../../scripts/env.sh
source ../../scripts/lib.sh
source ../../scripts/release-lib.sh

PACKAGE=io.github.pratyayops.fxm
ABIS=(arm64-v8a universal)
# The third-party notices in the APK and their first line, and the first line of make dist's notices
# inside them: APK_NOTICES_PATH, NOTICES_TITLE and WEB_NOTICES_TITLE in scripts/notices.ts, which a
# test keeps in step.
APK_NOTICES=assets/public/third-party-notices.txt
NOTICES_TITLE='FXM for Android: third-party notices'
WEB_NOTICES_TITLE='FXM third-party notices'
# sign's private folder for the key and the APKs it signs, and dry-run's for its throwaway key,
# deleted however the script ends.
work=
throwaway=
trap '[ -z "$work" ] || rm -rf "$work"; [ -z "$throwaway" ] || rm -rf "$throwaway"' EXIT
usage="usage: release-apk.sh build <out dir>
       release-apk.sh sign [--dry-run] [--version x.y.z] [--certificate <file>] <unsigned dir> <out dir>
       release-apk.sh dry-run [--version x.y.z] <unsigned dir> <out dir>"

# A path the caller gave, relative to where they ran the script.
from_caller() {
  case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$start/$1" ;; esac
}

# check_fresh <dir>: fails unless <dir> is missing or an empty folder, which only a successful
# run creates or fills.
check_fresh() {
  if [ -e "$1" ] && { [ ! -d "$1" ] || [ -n "$(ls -A "$1")" ]; }; then
    fxm_die "$1 is not an empty folder: use a new one"
  fi
}

# list <word...>: "A", "A and B", "A, B and C".
list() {
  case $# in
    1) printf '%s' "$1" ;;
    2) printf '%s and %s' "$1" "$2" ;;
    *)
      printf '%s, ' "${@:1:$(($# - 2))}"
      printf '%s and %s' "${@:$(($# - 1)):1}" "${!#}"
      ;;
  esac
}

# This package's version (apps/mobile/package.json), which app/build.gradle builds into the APK.
package_version() {
  node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version ?? ""' \
    "$mobile/package.json"
}

# version_code <x.y.z>: the version code that app/build.gradle gives the version.
version_code() {
  local major minor patch code
  IFS=. read -r major minor patch <<<"$1"
  if [ "$major" -ge 2100 ] || [ "$minor" -ge 1000 ] || [ "$patch" -ge 1000 ]; then
    fxm_die "FXM $1 has no Android version code: minor and patch must stay below 1000, major" \
      "below 2100 (apps/mobile/RELEASING.md, Version codes)"
  fi
  code=$((major * 1000000 + minor * 1000 + patch))
  if [ "$code" -lt 1 ]; then code=1; fi
  echo "$code"
}

# The folders Android tools create in your home when they run outside scripts/env.sh.
home_dirs=("$HOME/.android" "$HOME/.gradle" "$HOME/.m2" "$HOME/Library/Android")
absent=()
note_absent_home_dirs() {
  local dir
  for dir in "${home_dirs[@]}"; do [ -e "$dir" ] || absent+=("$dir"); done
}
check_home_dirs() {
  local dir
  for dir in ${absent[@]+"${absent[@]}"}; do
    [ ! -e "$dir" ] ||
      fxm_die "$dir was created during the build, so a tool ignored scripts/env.sh. Remove it with: rm -rf '$dir'"
  done
}

# refuse_signing_variables <why...>: fails while a signing variable (ANDROID_KEYSTORE_* or
# ANDROID_KEY_*) is set in the environment. Unsetting them for the child processes wouldn't do:
# a child running as the same user can read its parent's environment (/proc/<pid>/environ).
refuse_signing_variables() {
  local name found=()
  for name in $(compgen -e); do
    case "$name" in
      ANDROID_KEYSTORE_* | ANDROID_KEY_*) [ -z "${!name}" ] || found+=("$name") ;;
    esac
  done
  [ ${#found[@]} -eq 0 ] && return 0
  local verb=are pronoun=them
  if [ ${#found[@]} -eq 1 ]; then verb=is pronoun=it; fi
  fxm_die "$(list "${found[@]}") $verb set, but $*. Unset $pronoun: FXM's key belongs to the" \
    "release workflow only (apps/mobile/RELEASING.md)."
}

build() {
  [ $# -eq 1 ] || fxm_die "$usage"
  refuse_signing_variables "the build runs third-party code (npm packages, Gradle and its" \
    "plugins) that would see them: the key is for the separate signing step only"
  local version out abi apk outputs=android/app/build/outputs/apk/release
  local report=android/app/build/fxm/android-libraries.json
  local notices=android/app/src/main/assets/public/third-party-notices.txt
  version=$(package_version)
  fxm_release_require_version "$version"
  version_code "$version" >/dev/null
  ../../scripts/android-setup.sh --check
  out=$(from_caller "$1")
  check_fresh "$out"
  note_absent_home_dirs

  # make dist, whose notices of the web code the APK's notices include.
  pnpm --silent --filter @fxm/deploy dist
  # The GitHub Releases build: FXM's own update check stays on (F-Droid builds turn it off).
  FXM_DISTRIBUTION=standard pnpm --filter @fxm/web build:mobile
  pnpm --filter @fxm/mobile cap sync android
  # The third-party notices, into the web app's folder that cap sync filled: the Android
  # libraries the release build resolves, and make dist's notices (scripts/notices.ts).
  rm -rf "$outputs" "$report"
  (cd android && ./gradlew --no-daemon fxmLibraryReport)
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/write-notices.ts \
    "$report" ../../dist/pages/third-party-notices.txt "$notices"
  (cd android && ./gradlew --no-daemon -PfxmReleaseApks assembleRelease)
  check_home_dirs

  for abi in "${ABIS[@]}"; do
    apk=$outputs/app-$abi-release-unsigned.apk
    [ -f "$apk" ] || fxm_die "Gradle finished without writing apps/mobile/$apk"
    unzip -p "$apk" "$APK_NOTICES" | cmp -s - "$notices" ||
      fxm_die "apps/mobile/$apk doesn't carry the third-party notices the build wrote ($APK_NOTICES)"
  done
  mkdir -p "$out"
  for abi in "${ABIS[@]}"; do
    cp "$outputs/app-$abi-release-unsigned.apk" "$out/fxm-android-$abi-$version-unsigned.apk"
  done
  fxm_info "Unsigned release APKs of FXM $version in $(cd "$out" && pwd)"
}

# check_apk <apk> <abi> <version> <version code>: checks a signed APK, and prints the SHA-256 of
# its signing certificate.
check_apk() {
  local apk=$1 abi=$2 version=$3 code=$4 name report badging native notices
  name=$(basename "$apk")
  report=$("$apksigner" verify --verbose --print-certs -Werr "$apk" 2>&1) ||
    { printf '%s\n' "$report" >&2 && fxm_die "$name does not verify"; }
  for scheme in 'v2 scheme (APK Signature Scheme v2)' 'v3 scheme (APK Signature Scheme v3)'; do
    grep -qxF "Verified using $scheme: true" <<<"$report" ||
      { printf '%s\n' "$report" >&2 && fxm_die "$name is not signed with the APK Signature Scheme ${scheme%% *}"; }
  done
  [ "$(grep -c '^Signer #[0-9]* certificate SHA-256 digest: ' <<<"$report")" = 1 ] ||
    { printf '%s\n' "$report" >&2 && fxm_die "$name must have exactly one signer"; }

  badging=$("$aapt2" dump badging "$apk" 2>&1) ||
    { printf '%s\n' "$badging" >&2 && fxm_die "aapt2 could not read $name"; }
  grep -q "^package: name='$PACKAGE' versionCode='$code' versionName='$version' " <<<"$badging" ||
    fxm_die "$name is not $PACKAGE $version with the version code $code:" \
      "$(grep '^package:' <<<"$badging" || echo 'no package line')"
  if grep -q '^application-debuggable' <<<"$badging"; then fxm_die "$name is debuggable"; fi
  # The third-party notices that Settings → About shows: the Android libraries' and the web app's.
  notices=$(unzip -p "$apk" "$APK_NOTICES" 2>/dev/null) || notices=
  if [ "$(head -n 1 <<<"$notices")" != "$NOTICES_TITLE" ] ||
    ! grep -qxF "$WEB_NOTICES_TITLE" <<<"$notices"; then
    fxm_die "$name doesn't carry FXM's third-party notices ($APK_NOTICES)"
  fi
  native=$(sed -n 's/^native-code: //p' <<<"$badging")
  if [ "$abi" != universal ] && [ -n "$native" ] && [ "$native" != "'$abi'" ]; then
    fxm_die "$name holds native code for $native, not only for $abi"
  fi
  sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<<"$report"
}

sign() {
  local dry_run=false version='' certificate=$mobile/release-certificate.txt
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=true && shift ;;
      --version)
        [ $# -ge 2 ] || fxm_die "$usage"
        version=$2 && shift 2
        ;;
      --certificate)
        [ $# -ge 2 ] || fxm_die "$usage"
        certificate=$(from_caller "$2") && shift 2
        ;;
      -*) fxm_die "$usage" ;;
      *) break ;;
    esac
  done
  [ $# -eq 2 ] || fxm_die "$usage"
  local unsigned out code pinned='' name missing=() abi digest first=''
  unsigned=$(from_caller "$1")
  [ -d "$unsigned" ] || fxm_die "no such folder: $1"
  out=$(from_caller "$2")
  check_fresh "$out"
  [ -n "$version" ] || version=$(package_version)
  fxm_release_require_version "$version"
  code=$(version_code "$version")
  for abi in "${ABIS[@]}"; do
    [ -f "$unsigned/fxm-android-$abi-$version-unsigned.apk" ] ||
      fxm_die "$unsigned has no fxm-android-$abi-$version-unsigned.apk (release-apk.sh build)"
  done

  # Fail closed: FXM's key, and with it only the pinned certificate, or nothing.
  if ! $dry_run; then
    pinned=$(fxm_release_android_certificate "$certificate") || exit 1
  fi
  if [ -z "${ANDROID_KEYSTORE_BASE64:-}" ] && [ -z "${ANDROID_KEYSTORE_FILE:-}" ]; then
    missing+=(ANDROID_KEYSTORE_BASE64)
  fi
  for name in ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    local verb=are
    if [ ${#missing[@]} -eq 1 ]; then verb=is; fi
    fxm_die "Release APKs are signed with FXM's key or not at all, and $(list "${missing[@]}")" \
      "$verb not set. The release workflow takes them from the secrets of the android-release" \
      "environment (apps/mobile/RELEASING.md, Secrets)."
  fi

  ../../scripts/android-setup.sh --check >/dev/null
  local tools
  tools=$ANDROID_HOME/build-tools/$(sed -n 's/^SDK_BUILD_TOOLS=//p' ../../scripts/android-setup.sh)
  apksigner=$tools/apksigner
  aapt2=$tools/aapt2

  # The key goes into a folder only this user can read, and is deleted as soon as both APKs are
  # signed; nothing else runs while the passwords are in the environment.
  local keystore
  work=$(mktemp -d)
  keystore=$work/release.p12
  if [ -n "${ANDROID_KEYSTORE_FILE:-}" ]; then
    [ -f "$ANDROID_KEYSTORE_FILE" ] || fxm_die "ANDROID_KEYSTORE_FILE names no file: $ANDROID_KEYSTORE_FILE"
    (umask 077 && cp "$ANDROID_KEYSTORE_FILE" "$keystore")
  else
    # Line breaks and spaces are dropped, so a wrapped Base64 secret works too. openssl decodes
    # what it can of anything, so the text is checked first.
    local base64
    base64=$(printf '%s' "$ANDROID_KEYSTORE_BASE64" | tr -d ' \t\r\n')
    if [[ ! $base64 =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || [ $((${#base64} % 4)) -ne 0 ]; then
      fxm_die "ANDROID_KEYSTORE_BASE64 is not Base64: set it to the keystore's Base64" \
        "(apps/mobile/RELEASING.md, Secrets)"
    fi
    (umask 077 && printf '%s' "$base64" | openssl base64 -d -A >"$keystore") ||
      fxm_die "ANDROID_KEYSTORE_BASE64 is not Base64"
    base64=
  fi
  [ -s "$keystore" ] || fxm_die "the keystore is empty: check ANDROID_KEYSTORE_BASE64"
  for abi in "${ABIS[@]}"; do
    "$apksigner" sign --ks "$keystore" --ks-type PKCS12 --ks-key-alias "$ANDROID_KEY_ALIAS" \
      --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
      --v4-signing-enabled false --debuggable-apk-permitted false \
      --out "$work/$abi.apk" "$unsigned/fxm-android-$abi-$version-unsigned.apk" \
      >"$work/apksigner.log" 2>&1 ||
      { cat "$work/apksigner.log" >&2 && fxm_die "apksigner could not sign the $abi APK with the key" \
        "in the environment (wrong password, alias or keystore?)"; }
  done
  rm -f "$keystore"
  unset ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD

  for abi in "${ABIS[@]}"; do
    digest=$(check_apk "$work/$abi.apk" "$abi" "$version" "$code") || exit 1
    [[ $digest =~ ^[0-9a-f]{64}$ ]] || fxm_die "apksigner printed no certificate for the $abi APK"
    if [ -n "$first" ] && [ "$digest" != "$first" ]; then
      fxm_die "the two APKs are signed with different certificates"
    fi
    first=$digest
    if [ -n "$pinned" ] && [ "$digest" != "$pinned" ]; then
      fxm_die "The key in the environment is not FXM's: its certificate is" \
        "$(fxm_release_colons "$digest"), and $certificate pins" \
        "$(fxm_release_colons "$pinned"). Fix the android-release secrets, or pin a new" \
        "certificate on purpose (apps/mobile/RELEASING.md, If the key is lost or leaks)."
    fi
  done
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  for abi in "${ABIS[@]}"; do
    mv "$work/$abi.apk" "$out/fxm-android-$abi-$version.apk"
    chmod 0644 "$out/fxm-android-$abi-$version.apk"
  done

  local fingerprint
  fingerprint=$(fxm_release_colons "$first")
  if $dry_run; then
    fxm_warn "Dry run: signed with a key that release-certificate.txt doesn't pin. Never publish these files."
  fi
  fxm_info "Signed release APKs of FXM $version (version code $code) in $out"
  echo "  Certificate SHA-256: $fingerprint"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Android APKs of FXM $version"
      echo
      if $dry_run; then echo "A dry run, signed with a throwaway key: never publish these files."; fi
      echo
      echo "Version code $code. Signing certificate SHA-256: \`$fingerprint\`"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

# dry_run [--version x.y.z] <unsigned dir> <out dir>: sign --dry-run with a throwaway key made for
# this run only.
dry_run() {
  local versions=()
  if [ "${1:-}" = --version ]; then
    [ $# -ge 2 ] || fxm_die "$usage"
    versions=(--version "$2") && shift 2
  fi
  [ $# -eq 2 ] || fxm_die "$usage"
  refuse_signing_variables "a dry run signs with a throwaway key of its own"
  local unsigned out password
  unsigned=$(from_caller "$1")
  out=$(from_caller "$2")
  throwaway=$(mktemp -d)
  ../../scripts/make-android-keystore.sh "$throwaway/key" >/dev/null
  password=$(cat "$throwaway/key/fxm-android-password.txt")
  # In the environment of sign only, never on a command line.
  ANDROID_KEYSTORE_FILE=$throwaway/key/fxm-android.p12 ANDROID_KEY_ALIAS=fxm \
    ANDROID_KEYSTORE_PASSWORD=$password ANDROID_KEY_PASSWORD=$password \
    "$mobile/scripts/release-apk.sh" sign --dry-run ${versions[@]+"${versions[@]}"} \
    "$unsigned" "$out"
}

case "${1:-}" in
  build) shift && build "$@" ;;
  sign) shift && sign "$@" ;;
  dry-run) shift && dry_run "$@" ;;
  -h | --help) echo "$usage" ;;
  *) fxm_die "$usage" ;;
esac
