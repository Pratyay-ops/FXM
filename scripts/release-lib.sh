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
