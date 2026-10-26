# shellcheck shell=bash
# Helpers shared by the release scripts (scripts/release-*.sh). Source after env.sh and lib.sh.

# Release versions are plain SemVer x.y.z. No "v" and no pre-release or build label, because
# FXM Connect's manifest version refuses them; each number is at most 65535, the most Chrome
# accepts.
fxm_release_is_version() {
  [[ $1 =~ ^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$ ]] || return 1
  local part
  for part in "${BASH_REMATCH[@]:1}"; do
    [ "$part" -le 65535 ] || return 1
  done
}

fxm_release_require_version() {
  fxm_release_is_version "$1" ||
    fxm_die "'$1' is not a release version: use x.y.z such as 0.1.0 (no v, no label, numbers up to 65535)"
}

# fxm_release_newer <a> <b>: whether version a is higher than version b (both x.y.z).
fxm_release_newer() {
  local a b i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if [ "${a[i]}" -ne "${b[i]}" ]; then
      [ "${a[i]}" -gt "${b[i]}" ]
      return
    fi
  done
  return 1
}

# The product version: "version" in the root package.json.
fxm_release_current_version() {
  node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version ?? ""' \
    "$FXM_ROOT/package.json"
}

# fxm_release_flag <name> <value>: 1, true or yes mean on; unset, empty, 0, false or no mean off.
fxm_release_flag() {
  case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes) return 0 ;;
    '' | 0 | false | no) return 1 ;;
    *) fxm_die "$1 must be 1 or 0, got '$2'" ;;
  esac
}

# Runs git-cliff from the repository root (elsewhere it would only list commits that touch the
# current folder), offline, with cliff.toml. Its log (the configuration it read, how many merge
# commits it skipped) only shows when it fails.
fxm_release_cliff() {
  local log status=0
  log=$(mktemp)
  (cd "$FXM_ROOT" && git-cliff --offline --config cliff.toml "$@" 2>"$log") || status=$?
  [ "$status" -eq 0 ] || cat "$log" >&2
  rm -f "$log"
  return "$status"
}

# fxm_release_github <api path> <jq filter>: a GET request to the GitHub API through gh. Prints
# the filtered answer, or nothing when GitHub answers 404; any other failure (a 5xx, a 403, no
# network) is fatal. Its fxm_die can only end the $(...) it runs in, so call it as
# `answer=$(fxm_release_github ...) || exit 1`: a failure must never read as "not found".
fxm_release_github() {
  local log status=0 out
  log=$(mktemp)
  out=$(gh api "$1" --jq "$2" 2>"$log") || status=$?
  if [ "$status" -ne 0 ] && ! grep -q 'HTTP 404' "$log"; then
    cat "$log" >&2
    rm -f "$log"
    fxm_die "GitHub API request failed: GET $1"
  fi
  rm -f "$log"
  if [ "$status" -eq 0 ]; then printf '%s\n' "$out"; fi
}

# fxm_release_remote_tag <owner/repo> <tag>: the commit a tag on GitHub points at, or nothing.
# Callers run it as `tagged=$(...)` outside any condition, so that its exit stops them.
fxm_release_remote_tag() {
  local object type sha hops=0
  object=$(fxm_release_github "repos/$1/git/ref/tags/$2" '.object.type + " " + .object.sha') ||
    exit 1
  [ -n "$object" ] || return 0
  read -r type sha <<<"$object"
  # Annotated tags point at a tag object: follow it to the commit.
  while [ "$type" = tag ] && [ "$hops" -lt 5 ]; do
    object=$(fxm_release_github "repos/$1/git/tags/$sha" '.object.type + " " + .object.sha') ||
      exit 1
    read -r type sha <<<"$object"
    hops=$((hops + 1))
  done
  [ "$type" = commit ] || fxm_die "tag $2 on GitHub does not point at a commit"
  echo "$sha"
}

# fxm_release_published <owner/repo> <tag>: whether a published (not draft) release exists. A
# failed request ends the script, also when this runs as an if condition.
fxm_release_published() {
  local id
  id=$(fxm_release_github "repos/$1/releases/tags/$2" '.id') || exit 1
  [ -n "$id" ]
}

# The files a release may publish, one per line: the artifact that carries it (the name of the
# artifact job's upload in .github/workflows/release.yml), its file name with <version> for the
# version (a glob, so a later job can match several files), and what it is, for the release's
# file table. scripts/release-collect.sh refuses every other file, so no artifact job can add
# or replace another job's files. A stage that adds an artifact job (the APK in 6.6, desktop
# installers in 7.5, the signed XPI in R.2) adds its files here.
fxm_release_catalog() {
  cat <<'EOF'
release-bundles|fxm-connect-chromium-<version>.zip|FXM Connect for Chrome, Edge, Brave and other Chromium browsers
release-bundles|fxm-connect-firefox-<version>.zip|FXM Connect for Firefox, unsigned: for review, or a temporary install that Firefox removes when it restarts. Use the signed `.xpi` when the release has one
release-bundles|fxm-web-<version>.zip|The website and web app for self-hosting: the files `fxmusic.pages.dev` serves, with the web app in `app/`, `_headers` and the third-party notices
release-firefox|fxm-connect-firefox-<version>.xpi|FXM Connect for Firefox, signed by Mozilla: install it from Firefox's Add-ons Manager
release-android|fxm-android-universal-<version>.apk|The Android app, for any phone or tablet with Android 7 or later: pick this one if unsure
release-android|fxm-android-arm64-v8a-<version>.apk|The Android app for 64-bit ARM processors (arm64-v8a), which most phones of the last few years have. While FXM has no native code it is the same app as the universal APK
EOF
}

# fxm_release_android_certificate <file>: prints the SHA-256 fingerprint of the certificate that
# signs the release APKs, pinned in apps/mobile/release-certificate.txt, as 64 lower-case
# hexadecimal digits. The first line that is neither empty nor a # comment holds it, with or
# without colons. Fails while the file holds no fingerprint, as before the owner creates the key:
# call it as `pinned=$(fxm_release_android_certificate <file>) || exit 1`.
fxm_release_android_certificate() {
  local line hex
  [ -f "$1" ] || fxm_die "no such file: $1"
  line=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$1" | head -n 1 || true)
  hex=$(printf '%s' "$line" | tr -d ' \t\r:' | tr '[:upper:]' '[:lower:]')
  [[ $hex =~ ^[0-9a-f]{64}$ ]] ||
    fxm_die "$1 pins no signing certificate yet ('$line'), so no release APK may be signed: create" \
      "the key with scripts/make-android-keystore.sh and pin its fingerprint (apps/mobile/RELEASING.md)"
  printf '%s\n' "$hex"
}

# fxm_release_colons <hex>: a SHA-256 fingerprint the way keytool and certificate viewers show
# it, upper case in pairs: AB:CD:…
fxm_release_colons() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/../&:/g; s/:$//'
  echo
}

# fxm_release_lookup <artifact or ""> <file name> <version>: prints the catalog's description of
# the file and succeeds when the catalog lists it (for that artifact, unless it is "").
fxm_release_lookup() {
  local artifact pattern description
  while IFS='|' read -r artifact pattern description; do
    if [ -n "$1" ] && [ "$artifact" != "$1" ]; then continue; fi
    # Unquoted on purpose: the pattern is a glob.
    case "$2" in
      ${pattern//<version>/$3})
        printf '%s\n' "$description"
        return 0
        ;;
    esac
  done < <(fxm_release_catalog)
  return 1
}

# fxm_release_check_flat <dir>: fails unless everything in dir is a plain file. Release files
# sit at the top of the folder: a folder or a link there would be neither checksummed nor
# published. Names that start with a dot are ignored.
fxm_release_check_flat() {
  local path
  for path in "$1"/*; do
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
      fxm_die "$path is not a plain file: release files sit at the top of their folder," \
        "without folders or links (release-* artifacts must contain flat files)"
    fi
  done
}

# fxm_release_sums <dir>: prints SHA256SUMS for the files in dir (SHA256SUMS itself left out),
# sorted by name, in the format `sha256sum --check` reads.
fxm_release_sums() {
  local dir=$1 file
  [ -d "$dir" ] || fxm_die "no such folder: $dir"
  fxm_release_check_flat "$dir"
  for file in "$dir"/*; do
    if [ -f "$file" ] && [ "$file" != "$dir/SHA256SUMS" ]; then
      printf '%s  %s\n' "$(fxm_sha256 "$file")" "${file##*/}"
    fi
  done | LC_ALL=C sort -k2
}

# fxm_release_fit <file> <max bytes> <note>: cuts the file at a line boundary so that it, plus
# the note on a line of its own, stays under the limit (GitHub caps pull request bodies at
# 65536 characters and release notes at 125000). Leaves a short enough file alone.
fxm_release_fit() {
  local file=$1 max=$2 note=$3 budget cut
  [ "$(wc -c <"$file")" -gt "$max" ] || return 0
  budget=$((max - ${#note} - 8))
  cut=$(mktemp)
  # LC_ALL=C: awk then counts bytes, which is what the limit is checked against.
  LC_ALL=C awk -v budget="$budget" '{ size += length($0) + 1; if (size > budget) exit; print }' \
    "$file" >"$cut"
  printf '\n%s\n' "$note" >>"$cut"
  mv "$cut" "$file"
}
