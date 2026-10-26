#!/usr/bin/env bash
# Creates the key that signs FXM's release APKs (stage 6.6). Run it once, as the owner:
#
#   scripts/make-android-keystore.sh ~/fxm-android-key
#
# It writes three files into that folder, which must be outside every git checkout, and never
# overwrites one:
#
#   fxm-android.p12           the keystore: PKCS12 with one RSA 4096 key under the alias fxm and a
#                             self-signed certificate (CN=FXM) valid for about 30 years
#   fxm-android-password.txt  its password, which is also the key's: PKCS12 keeps one password
#   README.txt                what the files are, the certificate's SHA-256 and how to keep them
#
# Then it prints the GitHub Actions secrets that the release workflow signs with
# (ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD),
# the gh commands that set them, and the fingerprint to pin in apps/mobile/release-certificate.txt.
# keytool comes from the JDK that make android-setup puts into .tools, and the password never
# appears on a command line. Android installs an update only when it is signed with the key of the
# installed app, so keep an offline copy of the folder: without it, FXM can never be updated.
# apps/mobile/RELEASING.md has the whole procedure.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The folder is relative to where you are; the toolchain is the checkout's, wherever you are.
start=$PWD
cd "$here/.."
source "$here/env.sh"
source "$here/lib.sh"

usage="usage: make-android-keystore.sh <folder outside the repository>"
case "${1:-}" in
  -h | --help)
    echo "$usage"
    exit 0
    ;;
  '' | -*) fxm_die "$usage" ;;
esac
[ $# -eq 1 ] || fxm_die "$usage"

ALIAS=fxm
# About 30 years: 30 × 365.25 days.
VALIDITY_DAYS=10958
KEYSTORE=fxm-android.p12
PASSWORD_FILE=fxm-android-password.txt
README=README.txt

# keytool of the JDK in .tools, never another Java on the PATH or in JAVA_HOME.
jdk_home=$FXM_TOOLS/jdk
if [ -d "$jdk_home/Contents/Home" ]; then jdk_home=$jdk_home/Contents/Home; fi
keytool=$jdk_home/bin/keytool
[ -x "$keytool" ] ||
  fxm_die "keytool is missing: install the JDK into .tools with 'make android-setup'"
command -v openssl >/dev/null 2>&1 || fxm_die "openssl is required but not installed"
# English messages, whatever the system language: the output below quotes keytool.
kt() { "$keytool" -J-Duser.language=en -J-Duser.country=US "$@"; }

# The folder as an absolute path without links, also before it exists: its nearest existing
# folder decides where it is.
target=$1
while [ "${#target}" -gt 1 ] && [ "${target%/}" != "$target" ]; do target=${target%/}; done
case "$target" in /*) ;; *) target=$start/$target ;; esac
existing=$target
rest=
while [ ! -d "$existing" ]; do
  [ ! -e "$existing" ] || fxm_die "$existing is not a folder"
  rest=/${existing##*/}$rest
  existing=${existing%/*}
  [ -n "$existing" ] || existing=/
done
case "$rest/" in
  */./* | */../*) fxm_die "$1: the part of the path that doesn't exist yet can't contain . or .." ;;
esac
existing=$(cd "$existing" && pwd -P)
dir=${existing%/}$rest

# Never inside a git checkout, where the key could end up in a commit: this repository, one of
# its worktrees, or any other.
for checkout in "$FXM_ROOT" "$FXM_HOME"; do
  case "$dir/" in
    "$(cd "$checkout" && pwd -P)"/*) fxm_die "$dir is inside the FXM repository: pick a folder outside it" ;;
  esac
done
if [ "$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$existing" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  fxm_die "$dir is inside a git checkout ($(env -u GIT_DIR -u GIT_WORK_TREE git -C "$existing" \
    rev-parse --show-toplevel)), where the key could be committed: pick a folder outside it"
fi

for file in "$KEYSTORE" "$PASSWORD_FILE" "$README"; do
  [ ! -e "$dir/$file" ] || fxm_die "$dir/$file exists already: this script never replaces a key"
done

# Everything written from here on is readable by you alone.
umask 077
mkdir -p "$dir"
work=$(mktemp -d "$dir/.fxm-android-key.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 192 random bits as 48 hexadecimal digits: nothing to quote in a shell or a secret. keytool
# reads it from the environment, so it never shows in a process list.
FXM_ANDROID_KEY_PASSWORD=$(openssl rand -hex 24)
export FXM_ANDROID_KEY_PASSWORD
pass=(-storepass:env FXM_ANDROID_KEY_PASSWORD)

kt -genkeypair -noprompt -keystore "$work/$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity "$VALIDITY_DAYS" -dname CN=FXM \
  "${pass[@]}" -keypass:env FXM_ANDROID_KEY_PASSWORD >"$work/keytool.log" 2>&1 ||
  { cat "$work/keytool.log" >&2 && fxm_die "keytool could not create the key"; }

# Read it back as the release job will: one key under the alias, opened with the password.
entries=$(kt -list -keystore "$work/$KEYSTORE" -storetype PKCS12 "${pass[@]}" | grep -c 'PrivateKeyEntry' || true)
[ "$entries" = 1 ] || fxm_die "the new keystore holds $entries keys, not 1"
kt -exportcert -keystore "$work/$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" "${pass[@]}" \
  -file "$work/certificate.der" >/dev/null 2>&1 || fxm_die "keytool could not read the new key back"
# The SHA-256 of the certificate, as apksigner and Android's tools print it.
sha256=$(fxm_sha256 "$work/certificate.der")
[[ $sha256 =~ ^[0-9a-f]{64}$ ]] || fxm_die "could not compute the certificate's SHA-256"
fingerprint=$(printf '%s' "$sha256" | tr '[:lower:]' '[:upper:]' | sed 's/../&:/g; s/:$//')
expires=$(openssl x509 -inform DER -in "$work/certificate.der" -noout -enddate | sed 's/^notAfter=//')
bits=$(openssl x509 -inform DER -in "$work/certificate.der" -noout -text | grep -o 'Public-Key: ([0-9]* bit)' || true)
[ "$bits" = 'Public-Key: (4096 bit)' ] || fxm_die "the new key is not RSA 4096 ($bits)"

printf '%s' "$FXM_ANDROID_KEY_PASSWORD" >"$work/$PASSWORD_FILE"
cat >"$work/$README" <<EOF
FXM's Android signing key, made by scripts/make-android-keystore.sh on $(date -u +%Y-%m-%d).

$KEYSTORE           The keystore (PKCS12): one RSA 4096 key under the alias "$ALIAS",
                          with a self-signed certificate (CN=FXM) valid until $expires.
$PASSWORD_FILE  The keystore's password, which is also the key's.

Certificate SHA-256:
$fingerprint

Every FXM release APK is signed with this key, and Android installs an update only when it is
signed with the same key as the app on the phone. Without these two files nobody can publish an
update of FXM: users would have to uninstall it, losing their library, and install a new app.
With them, anyone can sign apps that phones accept as updates of FXM.

Keep them in two places only:
- the GitHub Actions secrets of the android-release environment, which the release workflow
  signs with (apps/mobile/RELEASING.md in the FXM repository);
- offline storage that you control, such as an encrypted USB drive or a password manager entry,
  better in two copies. Then delete this folder from the computer.

Never commit them, send them by e-mail or store them in a cloud folder.
EOF

mv "$work/$KEYSTORE" "$work/$PASSWORD_FILE" "$work/$README" "$dir/"

fxm_info "Created FXM's Android signing key in $dir"
cat <<EOF
  $KEYSTORE, $PASSWORD_FILE and $README (readable by you alone)
  Certificate SHA-256: $fingerprint
  Valid until $expires

Set these GitHub Actions secrets in the android-release environment, which only runs on main
can use (apps/mobile/RELEASING.md, "Secrets", creates it):

  ANDROID_KEYSTORE_BASE64    the keystore, Base64-encoded on one line
  ANDROID_KEYSTORE_PASSWORD  the password in $PASSWORD_FILE
  ANDROID_KEY_ALIAS          $ALIAS
  ANDROID_KEY_PASSWORD       the same password: a PKCS12 keystore has one

From the repository folder, with the GitHub CLI (make gh-setup):

  openssl base64 -A -in '$dir/$KEYSTORE' | scripts/run.sh gh secret set ANDROID_KEYSTORE_BASE64 --env android-release
  scripts/run.sh gh secret set ANDROID_KEYSTORE_PASSWORD --env android-release < '$dir/$PASSWORD_FILE'
  printf '%s' $ALIAS | scripts/run.sh gh secret set ANDROID_KEY_ALIAS --env android-release
  scripts/run.sh gh secret set ANDROID_KEY_PASSWORD --env android-release < '$dir/$PASSWORD_FILE'

Then pin the certificate, so that releases refuse any other key: replace the placeholder line in
apps/mobile/release-certificate.txt with

  $fingerprint

and commit it. Copy the folder to offline storage ($README says how), then delete it here.
EOF
