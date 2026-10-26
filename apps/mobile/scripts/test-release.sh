#!/usr/bin/env bash
# Offline tests of the release signing (make apk-sign-test, which the Android workflow runs):
# scripts/make-android-keystore.sh, `release-apk.sh sign` and `dry-run`, and the build's refusal of
# signing variables, with a throwaway key made in a temporary folder and small APKs that aapt2
# links from a bare manifest, so no Gradle build or device is needed. Needs the JDK and the
# Android SDK in .tools (make android-setup) and zip.
set -euo pipefail
mobile=$(cd "$(dirname "$0")/.." && pwd)
cd "$mobile"
source ../../scripts/env.sh
source ../../scripts/lib.sh
source ../../scripts/release-lib.sh

../../scripts/android-setup.sh --check >/dev/null
command -v zip >/dev/null 2>&1 || fxm_die "zip is required (Debian and Ubuntu: sudo apt install zip)"
tools=$ANDROID_HOME/build-tools/$(sed -n 's/^SDK_BUILD_TOOLS=//p' ../../scripts/android-setup.sh)
platform=$ANDROID_HOME/platforms/android-$(sed -n 's/^SDK_PLATFORM=//p' ../../scripts/android-setup.sh)
keystore_script=$mobile/../../scripts/make-android-keystore.sh
release_apk=$mobile/scripts/release-apk.sh
tmp=$(mktemp -d)
trap 'rm -rf "${tmp:?}"' EXIT
# None of the caller's signing variables may leak into a test.
unset ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS \
  ANDROID_KEY_PASSWORD GITHUB_STEP_SUMMARY

passed=0
failed=0
ok() {
  printf '  \033[32m✔\033[0m %s\n' "$1"
  passed=$((passed + 1))
}
bad() {
  printf '  \033[31m✘\033[0m %s\n' "$1"
  if [ -n "${out:-}" ]; then printf '%s\n' "$out" | tail -15 | sed 's/^/      | /'; fi
  failed=$((failed + 1))
}
expect() {
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
says() { grep -qF -- "$1" <<<"$out"; }
# run <command...>: sets $out (stdout and stderr) and $status.
run() {
  status=0
  out=$("$@" 2>&1) || status=$?
}
# refused <description> <message> <command...>: the command fails with the message.
refused() {
  local name=$1 message=$2
  shift 2
  run "$@"
  if [ "$status" -ne 0 ] && says "$message"; then ok "$name"; else bad "$name"; fi
}

# apk <file> <version> <version code> [debuggable]: an APK of FXM's package with no code, linked
# by aapt2 from a bare manifest.
apk() {
  local dir debuggable=''
  dir=$(mktemp -d "$tmp/apk.XXXXXX")
  if [ "${4:-}" = debuggable ]; then debuggable=' android:debuggable="true"'; fi
  cat >"$dir/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="io.github.pratyayops.fxm" android:versionCode="$3" android:versionName="$2">
    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36" />
    <application android:hasCode="false"$debuggable />
</manifest>
EOF
  "$tools/aapt2" link -o "$1" --manifest "$dir/AndroidManifest.xml" -I "$platform/android.jar"
}

# unsigned <dir> <version> <version code> [debuggable]: both unsigned APKs, as `build` names them.
unsigned() {
  mkdir -p "$1"
  apk "$1/fxm-android-arm64-v8a-$2-unsigned.apk" "$2" "$3" "${4:-}"
  apk "$1/fxm-android-universal-$2-unsigned.apk" "$2" "$3" "${4:-}"
}

# with_native <apk> <abi>: adds a native library for that processor.
with_native() {
  local dir
  dir=$(mktemp -d "$tmp/lib.XXXXXX")
  mkdir -p "$dir/lib/$2"
  printf 'not really a library' >"$dir/lib/$2/libfxm.so"
  (cd "$dir" && zip -q -0 "$1" "lib/$2/libfxm.so")
}

echo "make-android-keystore.sh"
key=$tmp/key
run "$keystore_script" "$key"
expect "creates a key in a folder outside the repository" test "$status" -eq 0
expect "writes the keystore, its password and a README" \
  test -s "$key/fxm-android.p12" -a -s "$key/fxm-android-password.txt" -a -s "$key/README.txt"
modes_ok() {
  local file mode
  for file in "$key"/*; do
    mode=$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")
    [ "$mode" = 600 ] || return 1
  done
}
expect "readable by its owner only" modes_ok
password=$(cat "$key/fxm-android-password.txt")
expect "with a password of 48 hexadecimal digits" grep -Eqx '[0-9a-f]{48}' <<<"$password"
for secret in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  expect "prints the secret $secret" says "$secret"
done
fingerprint=$(sed -n 's/^  Certificate SHA-256: //p' <<<"$out")
expect "and the certificate's SHA-256" grep -Eqx '([0-9A-F]{2}:){31}[0-9A-F]{2}' <<<"$fingerprint"
expect "which README.txt keeps" grep -qxF "$fingerprint" "$key/README.txt"
"$JAVA_HOME/bin/keytool" -J-Duser.language=en -exportcert -keystore "$key/fxm-android.p12" \
  -storetype PKCS12 -alias fxm -storepass "$password" -file "$tmp/certificate.der" >/dev/null 2>&1 ||
  : >"$tmp/certificate.der"
expect "a PKCS12 keystore with the key under the alias fxm" test -s "$tmp/certificate.der"
expect "whose certificate is the one printed" \
  test "$(fxm_release_colons "$(fxm_sha256 "$tmp/certificate.der")")" = "$fingerprint"
details=$(openssl x509 -inform DER -in "$tmp/certificate.der" -noout -text -enddate)
expect "an RSA 4096 key" grep -qF 'Public-Key: (4096 bit)' <<<"$details"
expect "named CN=FXM, without personal data" \
  test "$(grep -c 'CN *= *FXM$' <<<"$details")" = 2
expires=$(sed -n 's/^notAfter=.* \([0-9]\{4\}\) GMT$/\1/p' <<<"$details")
expect "valid for about 30 years" test "$expires" -ge $(($(date -u +%Y) + 29))
refused "never replaces a key" "exists already" "$keystore_script" "$key"
refused "refuses a folder inside the repository" "inside the FXM repository" \
  "$keystore_script" "$mobile/keys"
mkdir -p "$tmp/other-repo"
git -C "$tmp/other-repo" init -q
refused "or inside another git checkout" "inside a git checkout" \
  "$keystore_script" "$tmp/other-repo/keys"
expect "and creates nothing there" test ! -e "$mobile/keys" -a ! -e "$tmp/other-repo/keys"
# A home folder of its own, with the folders that cloud services sync.
home=$tmp/home
mkdir -p "$home/Library/Mobile Documents/com~apple~CloudDocs" "$home/Library/CloudStorage/Dropbox" \
  "$home/Documents" "$home/Desktop" "$home/OneDrive - Example"
refused "refuses iCloud Drive" "which a cloud service may sync" \
  env HOME="$home" "$keystore_script" "$home/Library/Mobile Documents/com~apple~CloudDocs/keys"
refused "and the other services' folders" "which a cloud service may sync" \
  env HOME="$home" "$keystore_script" "$home/Library/CloudStorage/Dropbox/keys"
refused "and OneDrive's" "which a cloud service may sync" \
  env HOME="$home" "$keystore_script" "$home/OneDrive - Example/keys"
refused "and Documents, which iCloud may sync" "which a cloud service may sync" \
  env HOME="$home" "$keystore_script" "$home/Documents/keys"
refused "and Desktop" "which a cloud service may sync" \
  env HOME="$home" "$keystore_script" "$home/Desktop"
synced_untouched() {
  test -z "$(find "$home" -type f)" && test ! -e "$home/Documents/keys"
}
expect "and writes nothing there" synced_untouched
if [ "$(uname -s)" = Darwin ]; then
  backup_excluded() {
    local file
    for file in "$key/fxm-android.p12" "$key/fxm-android-password.txt" "$key/README.txt"; do
      xattr -p com.apple.metadata:com_apple_backup_excludeItem "$file" >/dev/null 2>&1 || return 1
    done
  }
  expect "keeps the files out of Time Machine's backups (macOS)" backup_excluded
fi

echo "release-apk.sh sign"
export ANDROID_KEYSTORE_FILE=$key/fxm-android.p12 ANDROID_KEYSTORE_PASSWORD=$password
export ANDROID_KEY_ALIAS=fxm ANDROID_KEY_PASSWORD=$password
pin=$tmp/pin.txt
printf '# The test key\n%s\n' "$fingerprint" >"$pin"
placeholder=$tmp/placeholder.txt
printf '# No key yet\nnone yet: run scripts/make-android-keystore.sh\n' >"$placeholder"
other=$tmp/other-pin.txt
printf '%s\n' "$(printf 'ab%.0s' $(seq 32))" >"$other"
unsigned "$tmp/u-1.2.3" 1.2.3 1002003

sign() { "$release_apk" sign --version 1.2.3 "$@"; }
run sign --certificate "$pin" "$tmp/u-1.2.3" "$tmp/signed"
expect "signs both APKs with the pinned key" test "$status" -eq 0 \
  -a -f "$tmp/signed/fxm-android-arm64-v8a-1.2.3.apk" -a -f "$tmp/signed/fxm-android-universal-1.2.3.apk"
expect "and prints its certificate" says "Certificate SHA-256: $fingerprint"
expect "names nothing else" test "$(find "$tmp/signed" -type f | wc -l | tr -d ' ')" = 2
report=$("$tools/apksigner" verify --verbose --print-certs "$tmp/signed/fxm-android-universal-1.2.3.apk" 2>&1 || true)
expect "the APKs verify with APK Signature Scheme v2 and v3" \
  test -n "$(grep -x 'Verified using v2 scheme (APK Signature Scheme v2): true' <<<"$report")" \
  -a -n "$(grep -x 'Verified using v3 scheme (APK Signature Scheme v3): true' <<<"$report")"
expect "without a v4 signature file" test ! -e "$tmp/signed/fxm-android-universal-1.2.3.apk.idsig"
expect "with the key's certificate" grep -qi "SHA-256 digest: $(fxm_release_android_certificate "$pin")" <<<"$report"
refused "refuses to sign while no certificate is pinned" "pins no signing certificate yet" \
  sign --certificate "$placeholder" "$tmp/u-1.2.3" "$tmp/placeholder-out"
refused "refuses a key whose certificate is not the pinned one" "is not FXM's" \
  sign --certificate "$other" "$tmp/u-1.2.3" "$tmp/other-out"
expect "and writes nothing then" test ! -e "$tmp/placeholder-out" -a ! -e "$tmp/other-out"
run sign --dry-run --certificate "$other" "$tmp/u-1.2.3" "$tmp/dry"
expect "a dry run signs with any key" test "$status" -eq 0 -a -f "$tmp/dry/fxm-android-universal-1.2.3.apk"
expect "and says never to publish its files" says "Never publish these files"
refused "refuses to write into a folder that isn't empty" "is not an empty folder" \
  sign --dry-run "$tmp/u-1.2.3" "$tmp/dry"
refused "fails closed without the key's secrets, naming them" \
  "ANDROID_KEYSTORE_BASE64 and ANDROID_KEY_ALIAS are not set" \
  env -u ANDROID_KEYSTORE_FILE -u ANDROID_KEY_ALIAS \
  "$release_apk" sign --dry-run --version 1.2.3 "$tmp/u-1.2.3" "$tmp/no-key"
# Wrapped at 64 characters, as some tools write Base64.
run env -u ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_BASE64="$(openssl base64 -in "$key/fxm-android.p12")" \
  "$release_apk" sign --version 1.2.3 --certificate "$pin" "$tmp/u-1.2.3" "$tmp/base64"
expect "takes the keystore as Base64, also with line breaks" test "$status" -eq 0
refused "refuses a secret that isn't Base64" "is not Base64" \
  env -u ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_BASE64='not base64 at all!' \
  "$release_apk" sign --version 1.2.3 --certificate "$pin" "$tmp/u-1.2.3" "$tmp/bad-base64"
refused "refuses a wrong password" "apksigner could not sign" \
  env ANDROID_KEYSTORE_PASSWORD=wrong ANDROID_KEY_PASSWORD=wrong \
  "$release_apk" sign --version 1.2.3 --certificate "$pin" "$tmp/u-1.2.3" "$tmp/wrong-password"
refused "refuses a wrong alias" "apksigner could not sign" \
  env ANDROID_KEY_ALIAS=other \
  "$release_apk" sign --version 1.2.3 --certificate "$pin" "$tmp/u-1.2.3" "$tmp/wrong-alias"
refused "refuses missing APKs" "has no fxm-android-arm64-v8a-1.2.4-unsigned.apk" \
  "$release_apk" sign --dry-run --version 1.2.4 "$tmp/u-1.2.3" "$tmp/missing"
refused "refuses a version that isn't x.y.z" "is not a release version" \
  "$release_apk" sign --dry-run --version 1.2 "$tmp/u-1.2.3" "$tmp/bad-version"

unsigned "$tmp/u-code" 1.2.3 1002
refused "refuses an APK whose version code isn't the version's" \
  "is not io.github.pratyayops.fxm 1.2.3 with the version code 1002003" \
  sign --dry-run "$tmp/u-code" "$tmp/code-out"
unsigned "$tmp/u-0.5.0" 0.5.0 5000
run "$release_apk" sign --dry-run --version 0.5.0 "$tmp/u-0.5.0" "$tmp/code-0.5.0"
expect "0.5.0's version code is 5000" test "$status" -eq 0
unsigned "$tmp/u-0.0.0" 0.0.0 1
run "$release_apk" sign --dry-run --version 0.0.0 "$tmp/u-0.0.0" "$tmp/code-0.0.0"
expect "0.0.0's, before the first release, is 1" test "$status" -eq 0
refused "refuses versions without a version code" "has no Android version code" \
  "$release_apk" sign --dry-run --version 1.1000.0 "$tmp/u-1.2.3" "$tmp/no-code"
unsigned "$tmp/u-debug" 1.2.3 1002003 debuggable
refused "refuses to sign a debuggable APK" "apksigner could not sign" \
  sign --dry-run "$tmp/u-debug" "$tmp/debug-out"

echo "release-apk.sh build and dry-run"
# The signing variables are still set from above: neither step may run with them.
refused "the build refuses to run while a signing variable is set, naming them" \
  "ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD are set, but the build runs third-party code" \
  "$release_apk" build "$tmp/build-out"
refused "even one of them" "ANDROID_KEY_PASSWORD is set, but the build runs third-party code" \
  env -u ANDROID_KEYSTORE_FILE -u ANDROID_KEYSTORE_PASSWORD -u ANDROID_KEY_ALIAS \
  "$release_apk" build "$tmp/build-out"
expect "and builds nothing then" test ! -e "$tmp/build-out"
refused "a dry run refuses them too" "a dry run signs with a throwaway key of its own" \
  "$release_apk" dry-run --version 1.2.3 "$tmp/u-1.2.3" "$tmp/dry-refused"
mkdir "$tmp/dry-tmp"
run env -u ANDROID_KEYSTORE_FILE -u ANDROID_KEYSTORE_PASSWORD -u ANDROID_KEY_ALIAS \
  -u ANDROID_KEY_PASSWORD TMPDIR="$tmp/dry-tmp" \
  "$release_apk" dry-run --version 1.2.3 "$tmp/u-1.2.3" "$tmp/dry-run"
expect "a dry run signs both APKs with a key of its own" test "$status" -eq 0 \
  -a -f "$tmp/dry-run/fxm-android-arm64-v8a-1.2.3.apk" -a -f "$tmp/dry-run/fxm-android-universal-1.2.3.apk"
expect "says never to publish them" says "Never publish these files"
dry_certificate=$(sed -n 's/^  Certificate SHA-256: //p' <<<"$out")
expect "with another certificate each time" \
  test -n "$dry_certificate" -a "$dry_certificate" != "$fingerprint"
expect "and deletes the key" test -z "$(ls -A "$tmp/dry-tmp")"
unsigned "$tmp/u-native" 1.2.3 1002003
with_native "$tmp/u-native/fxm-android-universal-1.2.3-unsigned.apk" x86_64
with_native "$tmp/u-native/fxm-android-arm64-v8a-1.2.3-unsigned.apk" arm64-v8a
run sign --dry-run "$tmp/u-native" "$tmp/native-out"
expect "accepts arm64-v8a code in the arm64-v8a APK, and any in the universal one" test "$status" -eq 0
with_native "$tmp/u-native/fxm-android-arm64-v8a-1.2.3-unsigned.apk" x86_64
refused "refuses other processors' code in the arm64-v8a APK" "not only for arm64-v8a" \
  sign --dry-run "$tmp/u-native" "$tmp/native-other"

echo "Pinned certificate (scripts/release-lib.sh)"
lower=$(printf '%s' "$fingerprint" | tr -d ':' | tr '[:upper:]' '[:lower:]')
expect "reads a fingerprint with colons" test "$(fxm_release_android_certificate "$pin")" = "$lower"
printf '# comment\n\n  %s  \n' "$lower" >"$tmp/plain.txt"
expect "or without, after comments and blank lines" \
  test "$(fxm_release_android_certificate "$tmp/plain.txt")" = "$lower"
expect "and shows it with colons again" test "$(fxm_release_colons "$lower")" = "$fingerprint"
placeholder_ok() { ! (fxm_release_android_certificate "$placeholder" >/dev/null 2>&1); }
expect "fails on the placeholder" placeholder_ok
committed=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' release-certificate.txt | head -n 1)
committed_ok() {
  [ "$committed" = 'none yet: run scripts/make-android-keystore.sh' ] ||
    fxm_release_android_certificate release-certificate.txt >/dev/null
}
expect "the committed release-certificate.txt is the placeholder or a fingerprint" committed_ok

echo
if [ "$failed" -eq 0 ]; then
  fxm_info "All $passed release signing tests passed"
else
  fxm_die "$failed of $((passed + failed)) release signing tests failed"
fi
