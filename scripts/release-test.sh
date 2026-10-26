#!/usr/bin/env bash
# Offline tests for the release scripts (make release-check, which CI runs after make check).
# Each group runs this checkout's scripts inside a throwaway repository whose origin is a local
# bare repository, with a stand-in for gh that records its calls and answers from files.
# Nothing reaches GitHub, and your git configuration is not read. The only download is
# git-cliff, when .tools lacks it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

"$here/install-git-cliff.sh" >/dev/null
cliff=$FXM_TOOLS/bin/git-cliff
tmp=$(mktemp -d)
trap 'rm -rf "${tmp:?}"' EXIT

# Commits in the throwaway repositories: a fixed identity, and no global or system git config
# (signing, hooks or aliases would change what the scripts see). No credentials either.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid
unset GH_TOKEN GITHUB_TOKEN GITHUB_OUTPUT GITHUB_ACTIONS DRY_RUN
export GITHUB_REPOSITORY=test/fxm

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
# expect <description> <command...>: passes when the command succeeds.
expect() {
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
has() { grep -qF -- "$2" "$1"; }
lacks() { ! grep -qF -- "$2" "$1"; }
says() { grep -qF -- "$1" <<<"$out"; }
not() { ! "$@"; }

# run <dir> <command...>: runs a command in a repository; sets $out (stdout and stderr) and
# $status.
run() {
  local dir=$1
  shift
  status=0
  out=$(cd "$dir" && "$@" 2>&1) || status=$?
}

write_gh_stub() {
  cat >"$1" <<'STUB'
#!/usr/bin/env bash
# Stand-in for gh (scripts/release-test.sh): logs every call to $GH_STUB_DIR/calls.log and
# answers from files there, where an empty file counts as none: logged-out, open-pr ("<url>
# <title>" lines), released/<tag>, released-after/<tag> (how many times to answer 404 before
# the release counts as published), tags/<tag> (a commit, or "tag <object>" for an annotated
# tag), tag-objects/<object> ("commit <sha>"), drafts/<tag>, and broken (API paths that fail
# with HTTP 502).
set -euo pipefail
state=${GH_STUB_DIR:?}
printf '%s\n' "$*" >>"$state/calls.log"
not_found() {
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
}
case "$1 ${2:-}" in
  "auth status") [ ! -s "$state/logged-out" ] ;;
  "pr list") cat "$state/open-pr" 2>/dev/null || true ;;
  "pr create" | "pr edit")
    while [ $# -gt 0 ]; do
      if [ "$1" = --body-file ]; then cp "$2" "$state/pr-body.md"; fi
      shift
    done
    echo "https://github.com/test/fxm/pull/7"
    ;;
  "release create")
    tag=$3
    shift 3
    [ -s "$state/tags/$tag" ] || { echo "tag $tag does not exist" >&2 && exit 1; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --notes-file) cp "$2" "$state/release-notes.md" && shift 2 ;;
        --repo | --title) shift 2 ;;
        --*) shift ;;
        *) basename "$1" >>"$state/release-files.txt" && shift ;;
      esac
    done
    mkdir -p "$state/released"
    echo 1001 >"$state/released/$tag"
    ;;
  "api "*)
    shift
    method=GET path='' jq='' ref='' sha=''
    while [ $# -gt 0 ]; do
      case "$1" in
        -X) method=$2 && shift 2 ;;
        --jq) jq=$2 && shift 2 ;;
        --paginate) shift ;;
        -f)
          case "$2" in ref=*) ref=${2#ref=} ;; sha=*) sha=${2#sha=} ;; esac
          shift 2
          ;;
        *) path=$1 && shift ;;
      esac
    done
    if [ -s "$state/broken" ] && grep -qxF -- "$path" "$state/broken"; then
      echo "gh: Server Error (HTTP 502)" >&2
      exit 1
    fi
    case "$method $path" in
      "GET repos/test/fxm/releases/tags/"*)
        after=$state/released-after/${path##*/}
        if [ -s "$after" ]; then
          [ "$(cat "$after")" -eq 0 ] || { echo $(($(cat "$after") - 1)) >"$after" && not_found; }
          echo 4001
        elif [ -s "$state/released/${path##*/}" ]; then
          cat "$state/released/${path##*/}"
        else
          not_found
        fi
        ;;
      "GET repos/test/fxm/git/ref/tags/"*)
        [ -s "$state/tags/${path##*/}" ] || not_found
        object=$(cat "$state/tags/${path##*/}")
        case "$object" in "tag "*) echo "$object" ;; *) echo "commit $object" ;; esac
        ;;
      "GET repos/test/fxm/git/tags/"*)
        if [ -s "$state/tag-objects/${path##*/}" ]; then cat "$state/tag-objects/${path##*/}"; else not_found; fi
        ;;
      "GET repos/test/fxm/git/matching-refs/tags/v")
        for tag in "$state"/tags/v*; do
          if [ -s "$tag" ]; then echo "refs/tags/${tag##*/}"; fi
        done
        ;;
      "POST repos/test/fxm/git/refs")
        tag=${ref#refs/tags/}
        if [ -s "$state/tags/$tag" ]; then echo "Reference already exists (HTTP 422)" >&2 && exit 1; fi
        mkdir -p "$state/tags"
        echo "$sha" >"$state/tags/$tag"
        ;;
      "GET repos/test/fxm/releases?per_page=100")
        tag=$(printf '%s' "$jq" | sed -n 's/.*tag_name == "\([^"]*\)".*/\1/p')
        cat "$state/drafts/$tag" 2>/dev/null || true
        ;;
      "DELETE repos/test/fxm/releases/"*)
        for draft in "$state"/drafts/*; do
          if [ "$(cat "$draft")" = "${path##*/}" ]; then : >"$draft"; fi
        done
        ;;
      *) echo "gh stub: unexpected request $method $path" >&2 && exit 2 ;;
    esac
    ;;
  *) echo "gh stub: unexpected call: $*" >&2 && exit 2 ;;
esac
STUB
  chmod +x "$1"
}

write_pnpm_stub() {
  cat >"$1" <<'STUB'
#!/usr/bin/env bash
# Stand-in for pnpm (scripts/release-test.sh): logs every call to $PNPM_STUB_DIR/calls.log, with
# the make level it runs at (MAKELEVEL: 0 outside make, 1 in a recipe of a make that no other
# make started, and so on). make dist's command replaces dist/pages with a copy of
# $PNPM_STUB_DIR/pages, modes and dates included; FXM Connect's build writes its two zips, named
# with its package.json's version. While $PNPM_STUB_DIR/no-match exists, it does what pnpm does
# when a filter matches no package: nothing, successfully. The install and the lint that
# release-pr.sh runs on the release commit log where they run, and fail while install-fails or
# lint-fails exists there.
set -euo pipefail
state=${PNPM_STUB_DIR:?}
printf '%s (make level %s)\n' "$*" "${MAKELEVEL:-0}" >>"$state/calls.log"
[ ! -e "$state/no-match" ] || exit 0
case " $* " in
  *" install --frozen-lockfile "*)
    printf 'install in %s\n' "$PWD" >>"$state/calls.log"
    [ ! -e "$state/install-fails" ] || { echo "ERR_PNPM_OUTDATED_LOCKFILE" >&2 && exit 1; }
    ;;
  *" run lint "*)
    printf 'lint in %s\n' "$PWD" >>"$state/calls.log"
    [ ! -e "$state/lint-fails" ] || { echo "Found 1 error." >&2 && exit 1; }
    ;;
  *" --filter @fxm/deploy dist "*)
    rm -rf dist/pages
    mkdir -p dist
    cp -Rp "$state/pages" dist/pages
    ;;
  *" --filter @fxm/extension build "*)
    version=$(node -p 'require("./apps/extension/package.json").version')
    mkdir -p apps/extension/dist
    for browser in chromium firefox; do
      echo "$browser" >"apps/extension/dist/fxm-connect-$browser-$version.zip"
    done
    ;;
  *) echo "pnpm stub: unexpected call: $*" >&2 && exit 2 ;;
esac
STUB
  chmod +x "$1"
}

write_release_test_stub() {
  cat >"$1" <<'STUB'
#!/usr/bin/env bash
# Stand-in for scripts/release-test.sh in the throwaway repositories, where release-pr.sh runs it
# on the release commit: logs to $PNPM_STUB_DIR/calls.log where it runs, the version there and
# the changelog's newest release, and fails while $PNPM_STUB_DIR/release-test-fails exists.
set -euo pipefail
state=${PNPM_STUB_DIR:?}
version=$(node -p 'require("./package.json").version')
newest=$(grep -m1 '^## \[' CHANGELOG.md | cut -d']' -f1 || true)
printf 'release-test in %s: version %s, changelog %s]\n' "$PWD" "$version" "$newest" \
  >>"$state/calls.log"
[ ! -e "$state/release-test-fails" ] || { echo "1 of 9 release script tests failed" >&2 && exit 1; }
STUB
  chmod +x "$1"
}

package_json() { # <file> <name> <version>
  mkdir -p "$(dirname "$1")"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "private": true\n}\n' "$2" "$3" >"$1"
}

# new_repo <name>: a repository like FXM's, as far as the release scripts look, with this
# checkout's Makefile and scripts and an origin, and a stand-in for the release script tests.
# Prints its path. The gh stub's state is in <name>/gh.
new_repo() {
  local root=$tmp/$1 work=$tmp/$1/work
  mkdir -p "$root/gh" "$work/scripts" "$work/.tools/bin" "$work/packages/core/src"
  git init -q --bare -b main "$root/origin.git"
  git init -q -b main "$work"
  cp "$FXM_ROOT"/scripts/{env.sh,lib.sh,run.sh,install-git-cliff.sh} \
    "$FXM_ROOT"/scripts/release-*.sh "$work/scripts/"
  cp "$FXM_ROOT/Makefile" "$FXM_ROOT/cliff.toml" "$FXM_ROOT/cliff.notes.toml" "$work/"
  # The repository's changelog without its release sections, which every release adds to.
  awk '/^## \[/ { exit } { print }' "$FXM_ROOT/CHANGELOG.md" >"$work/CHANGELOG.md"
  # release-pr.sh runs the release script tests on the release commit; these would start again.
  write_release_test_stub "$work/scripts/release-test.sh"
  ln -s "$cliff" "$work/.tools/bin/git-cliff"
  write_gh_stub "$work/.tools/bin/gh"
  printf '/.tools/\n' >"$work/.gitignore"
  printf 'packages:\n  - apps/*\n  - packages/*\n' >"$work/pnpm-workspace.yaml"
  package_json "$work/package.json" fxm 0.0.0
  package_json "$work/apps/extension/package.json" @fxm/extension 0.1.0
  package_json "$work/apps/web/package.json" @fxm/web 0.0.0
  package_json "$work/packages/core/package.json" @fxm/core 0.0.0
  printf "export const APP_NAME = 'FXM'\n\nexport const APP_VERSION = '0.0.0'\n" \
    >"$work/packages/core/src/index.ts"
  # The Android signing certificate, pinned (apps/mobile/RELEASING.md).
  mkdir -p "$work/apps/mobile"
  printf '# The test key\n%s\n' "$(printf 'cd%.0s' $(seq 32))" \
    >"$work/apps/mobile/release-certificate.txt"
  git -C "$work" add -A
  git -C "$work" commit -q -m "Initial commit"
  git -C "$work" remote add origin "$root/origin.git"
  git -C "$work" push -q origin main
  echo "$work"
}

commit() { git -C "$1" commit -q --allow-empty -m "$2"; }
# section <file> <heading start>: the lines of one release in a changelog.
section() { awk -v start="$2" 'index($0, start) == 1 { on = 1; next } /^## / { on = 0 } on' "$1"; }

echo "Release library"
versions_ok=true
for good in 0.0.0 0.1.0 1.2.3 65535.65535.65535; do
  fxm_release_is_version "$good" || versions_ok=false
done
for bad_version in 1.2 v1.2.3 1.2.3-rc.1 01.2.3 1.02.3 65536.0.0 1.2.3.4 ''; do
  if fxm_release_is_version "$bad_version"; then versions_ok=false; fi
done
expect "accepts x.y.z up to 65535 only" $versions_ok
newer_ok() {
  fxm_release_newer 0.10.0 0.9.0 && fxm_release_newer 1.0.0 0.99.99 &&
    fxm_release_newer 0.1.1 0.1.0 && ! fxm_release_newer 0.1.0 0.1.0 &&
    ! fxm_release_newer 0.9.9 0.10.0
}
expect "compares versions numerically" newer_ok
# cliff_part <file> <first line> <last line>: a multi-line value of a git-cliff configuration.
cliff_part() { sed -n "/^$2/,/^$3/p" "$FXM_ROOT/$1"; }
same_cliff_parts() {
  [ -n "$(cliff_part cliff.toml 'body = """' '"""')" ] &&
    [ "$(cliff_part cliff.toml 'body = """' '"""')" = "$(cliff_part cliff.notes.toml 'body = """' '"""')" ] &&
    [ "$(cliff_part cliff.toml 'commit_preprocessors' ']')" = \
      "$(cliff_part cliff.notes.toml 'commit_preprocessors' ']')" ]
}
expect "the notes and the changelog share their template and preprocessors" same_cliff_parts
big=$tmp/big.md
for i in $(seq 1 2000); do echo "- entry $i, long enough to need many lines of notes"; done >"$big"
fxm_release_fit "$big" 20000 "See CHANGELOG.md."
expect "cuts notes to GitHub's size limit" \
  test "$(wc -c <"$big")" -le 20000 -a "$(tail -1 "$big")" = "See CHANGELOG.md."
folded=$tmp/folded.md
{
  printf 'FXM 9.9.9 brings things.\n\n## Changes\n\n<details>\n<summary>2000 changes</summary>\n\n'
  for i in $(seq 1 2000); do echo "- entry $i, long enough to need many lines of notes"; done
  printf '\n</details>\n'
} >"$folded"
fxm_release_fit "$folded" 20000 "See CHANGELOG.md."
closes_the_fold() {
  [ "$(wc -c <"$folded")" -le 20000 ] && [ "$(head -1 "$folded")" = "FXM 9.9.9 brings things." ] &&
    [ "$(tail -3 "$folded" | tr '\n' '|')" = "See CHANGELOG.md.||</details>|" ]
}
expect "a cut in the folded list puts the note in it and closes it" closes_the_fold
{
  printf '<details>\n<summary>1 change</summary>\n\n- one\n\n</details>\n\n'
  for i in $(seq 1 2000); do echo "- line $i of what follows the list"; done
} >"$folded"
fxm_release_fit "$folded" 5000 "See CHANGELOG.md."
expect "a cut after it closes nothing" \
  test "$(grep -c '^</details>$' "$folded")" = 1 -a "$(tail -1 "$folded")" = "See CHANGELOG.md."
catalog_ok() {
  fxm_release_lookup release-bundles fxm-web-0.1.0.zip 0.1.0 >/dev/null &&
    fxm_release_lookup release-bundles fxm-connect-firefox-0.1.0.zip 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-bundles fxm-web-0x1x0.zip 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-other fxm-web-0.1.0.zip 0.1.0 >/dev/null &&
    ! fxm_release_lookup "" SHA256SUMS 0.1.0 >/dev/null
}
expect "the catalog matches release files by artifact and exact version" catalog_ok
# The signed add-on comes only from the firefox job (apps/extension/store/firefox.ts).
xpi_ok() {
  fxm_release_lookup release-firefox fxm-connect-firefox-0.1.0.xpi 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-bundles fxm-connect-firefox-0.1.0.xpi 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-firefox fxm-connect-firefox-0.1.0.zip 0.1.0 >/dev/null
}
expect "only the firefox job may publish the signed XPI" xpi_ok
# The signed APKs come only from the android-sign job (apps/mobile/scripts/release-apk.sh).
apk_ok() {
  fxm_release_lookup release-android fxm-android-universal-0.1.0.apk 0.1.0 >/dev/null &&
    fxm_release_lookup release-android fxm-android-arm64-v8a-0.1.0.apk 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-bundles fxm-android-universal-0.1.0.apk 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-android fxm-android-universal-0.1.0-unsigned.apk 0.1.0 >/dev/null &&
    ! fxm_release_lookup release-android fxm-android-x86_64-0.1.0.apk 0.1.0 >/dev/null
}
expect "only the android-sign job may publish the APKs, signed" apk_ok
expect "every file in the catalog carries the version" \
  test -z "$(fxm_release_catalog | cut -d'|' -f2 | grep -v '<version>' || true)"
fingerprint_ok() {
  local file=$tmp/certificate.txt hex=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  printf '# a comment\n\n%s\n' "$(fxm_release_colons "$hex")" >"$file"
  [ "$(fxm_release_android_certificate "$file")" = "$hex" ] &&
    [ "$(fxm_release_colons "$hex")" = "01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF" ] &&
    printf 'none yet: run scripts/make-android-keystore.sh\n' >"$file" &&
    ! (fxm_release_android_certificate "$file" >/dev/null 2>&1)
}
expect "reads the pinned Android certificate, and fails on the placeholder" fingerprint_ok

echo "release-version.sh"
work=$(new_repo version)
refused=true
for bad_version in 1.2 v1.2.3 1.2.3-beta 70000.0.0; do
  run "$work" scripts/release-version.sh "$bad_version"
  if [ "$status" -eq 0 ]; then refused=false; fi
done
expect "refuses versions that are not x.y.z" $refused
run "$work" scripts/release-version.sh --dry-run 0.2.0
expect "--dry-run lists the changes and writes nothing" \
  test "$status" -eq 0 -a -z "$(git -C "$work" status --porcelain)"
expect "--dry-run shows each file" \
  test -n "$(printf '%s\n' "$out" | grep -E 'apps/extension/package.json +0.1.0 → 0.2.0')"
run "$work" scripts/release-version.sh --check
expect "--check fails while the versions differ" test "$status" -ne 0
run "$work" scripts/release-version.sh 0.2.0
expect "sets the version" test "$status" -eq 0
expect "in every package.json" test "$(grep -l '"version": "0.2.0"' "$work"/package.json \
  "$work"/apps/*/package.json "$work"/packages/*/package.json | wc -l | tr -d ' ')" = 4
expect "and in APP_VERSION" \
  has "$work/packages/core/src/index.ts" "export const APP_VERSION = '0.2.0'"
run "$work" scripts/release-version.sh --check
expect "--check passes once they agree" test "$status" -eq 0
mkdir -p "$work/packages/new"
printf '{\n  "name": "@fxm/new",\n  "private": true\n}\n' >"$work/packages/new/package.json"
run "$work" scripts/release-version.sh 0.2.1
expect "adds a version to a package that has none" \
  has "$work/packages/new/package.json" '"version": "0.2.1"'

echo "release-notes.sh"
work=$(new_repo notes)
git -C "$work" switch -q -c develop
commit "$work" "feat(core): add a thing"
commit "$work" "fix(web): repair a thing"
commit "$work" "docs(plan): mark 1.1 done"
git -C "$work" switch -q -c feat/side
commit "$work" "feat(core): cover the thing"
commit "$work" "test(core): test the thing"
git -C "$work" switch -q develop
git -C "$work" merge -q --no-ff feat/side -m "feat: a merge commit that looks conventional"
commit "$work" "style: tidy whitespace"
commit "$work" "chore(release): v0.0.9"
commit "$work" "build(deps): bump @playwright/test from 1.0.0 to 2.0.0"
commit "$work" "fix(core): answer user@example.com"
commit "$work" "perf(player): load @fxm/core lazily"
commit "$work" "docs(web): explain the thing"
commit "$work" "ci: run the checks on every push"
commit "$work" "refactor(core): tidy the thing"
commit "$work" "chore: pin a tool"
commit "$work" "feat(tooling): add a make target"
commit "$work" "fix(release): repair the release script"
commit "$work" "fix(deploy): repair the deploy"
# The same change twice, as when a stacked branch carries a copy of a commit.
commit "$work" "fix(web): repair a thing"
notes=$tmp/notes.md
(cd "$work" && scripts/release-notes.sh 0.1.0) >"$notes"
expect "groups features, fixes and performance" \
  test -n "$(grep -x '### Features' "$notes")" -a -n "$(grep -x '### Bug fixes' "$notes")" \
  -a -n "$(grep -x '### Performance' "$notes")"
expect "shows scopes" has "$notes" "- **core:** Add a thing"
expect "lists fixes" has "$notes" "**web:** Repair a thing"
expect "lists each message once" test "$(grep -c 'Repair a thing' "$notes")" = 1
expect "includes the commits of merged branches" has "$notes" "**core:** Cover the thing"
leaves_out_internal_work() {
  local entry
  for entry in "Test the thing" "Tidy whitespace" "Bump" "Explain the thing" "Run the checks" \
    "Tidy the thing" "Pin a tool" "### Other" "### Documentation" "### Tests"; do
    lacks "$notes" "$entry" || return 1
  done
}
expect "leaves out docs, tests, CI, build, chores, refactoring and other types" \
  leaves_out_internal_work
leaves_out_internal_scopes() {
  lacks "$notes" "Add a make target" && lacks "$notes" "Repair the release script" &&
    lacks "$notes" "Repair the deploy"
}
expect "and the internal scopes, whatever their type" leaves_out_internal_scopes
expect "skips docs(plan) bookkeeping" lacks "$notes" "Mark 1.1 done"
expect "skips merge commits" lacks "$notes" "looks conventional"
expect "skips the release commit" lacks "$notes" "0.0.9"
expect "skips unconventional commits" lacks "$notes" "Initial commit"
expect "puts @names in code spans, so the notes notify nobody" \
  has "$notes" '**player:** Load `@fxm/core` lazily'
expect "but leaves e-mail addresses alone" has "$notes" "**core:** Answer user@example.com ("
expect "has no version heading" test -z "$(grep -E '^## (\[|v?[0-9])' "$notes" || true)"
expect "carries the legal notice" has "$notes" \
  "not affiliated with or endorsed by YouTube, Google, Spotify or any other service"
notice_then_folded_list() {
  [ "$(grep -n -x -e '## Legal' -e '## Changes' -e '<details>' -e '### Features' "$notes" |
    cut -d: -f2- | tr '\n' '|')" = "## Legal|## Changes|<details>|### Features|" ] &&
    [ "$(tail -1 "$notes")" = "</details>" ]
}
expect "before the list, which is folded under its own heading" notice_then_folded_list
expect "and says how many entries the fold holds" \
  has "$notes" "<summary>$(grep -c '^- ' "$notes") changes</summary>"
expect "and since when" has "$notes" "changes since the project started, as their commit messages"
run "$work" scripts/release-notes.sh --changelog 0.1.0
expect "regenerates CHANGELOG.md" has "$work/CHANGELOG.md" \
  "## [0.1.0](https://github.com/Pratyay-ops/FXM/releases/tag/v0.1.0)"
expect "keeps its header" has "$work/CHANGELOG.md" "# Changelog"
expect "lists released versions only" lacks "$work/CHANGELOG.md" "## Unreleased"
section "$work/CHANGELOG.md" "## [0.1.0]" >"$notes"
keeps_every_change() {
  has "$notes" "**core:** Test the thing" && has "$notes" "### Other" &&
    has "$notes" '**deps:** Bump `@playwright/test` from 1.0.0 to 2.0.0' &&
    has "$notes" "**tooling:** Add a make target" && has "$notes" "**release:** Repair the release script"
}
expect "the changelog keeps every change" keeps_every_change
expect "each message once" test "$(grep -c 'Repair a thing' "$notes")" = 1
mkdir -p "$work/docs/releases"
printf '\nFXM 0.1.0 brings a thing.\n\n## Highlights\n\n- A thing\n\n\n' \
  >"$work/docs/releases/v0.1.0.md"
git -C "$work" add docs
git -C "$work" commit -q -m "docs(release): summarize v0.1.0"
(cd "$work" && scripts/release-notes.sh 0.1.0) >"$notes"
expect "starts with the version's summary" \
  test "$(head -1 "$notes")" = "FXM 0.1.0 brings a thing."
summary_then_changes() {
  [ "$(sed -n '/^- A thing$/,/^## Legal$/p' "$notes" | tr '\n' '|')" = "- A thing||## Legal|" ] &&
    [ "$(grep -n -x -e '- A thing' -e '## Legal' -e '## Changes' -e '### Features' "$notes" |
      cut -d: -f2- | tr '\n' '|')" = "- A thing|## Legal|## Changes|### Features|" ]
}
expect "then the legal notice and the changes under their own headings" summary_then_changes
(cd "$work" && scripts/release-notes.sh) >"$notes"
expect "without a version, there is no summary" lacks "$notes" "brings a thing"
expect "nor notice or fold: only the list" \
  test -z "$(grep -e '^## ' -e '<details>' "$notes" || true)" -a "$(head -1 "$notes")" = "### Features"
run "$work" scripts/release-notes.sh --changelog 0.1.0
expect "and the changelog has none" lacks "$work/CHANGELOG.md" "brings a thing"
git -C "$work" switch -q -c feat/late
commit "$work" "feat(web): add a late thing"
git -C "$work" switch -q develop
git -C "$work" tag v0.1.0
commit "$work" "perf(core): speed something up"
git -C "$work" merge -q --no-ff feat/late -m "Merge stage late"
(cd "$work" && scripts/release-notes.sh 0.2.0) >"$notes"
expect "the next release starts after the last tag" lacks "$notes" "Add a thing"
expect "and includes branches started before it" has "$notes" "Add a late thing"
expect "and says so" has "$notes" "changes since v0.1.0, as their commit messages"
(cd "$work" && scripts/release-notes.sh 0.1.0) >"$notes"
expect "a tagged release keeps its own notes" \
  test "$(grep -c 'Add a thing' "$notes")" = 1 -a "$(grep -c 'Speed something up' "$notes")" = 0
(cd "$work" && scripts/release-notes.sh) >"$notes"
expect "without a version: the unreleased changes" has "$notes" "Speed something up"
run "$work" scripts/release-notes.sh --changelog 0.2.0
expect "the changelog links each release to the previous one" has "$work/CHANGELOG.md" \
  "## [0.2.0](https://github.com/Pratyay-ops/FXM/compare/v0.1.0...v0.2.0)"
section "$work/CHANGELOG.md" "## [0.1.0]" >"$notes"
expect "and assigns commits by history, not by date" lacks "$notes" "Add a late thing"
expect "newest release first" \
  test "$(grep -m1 '^## \[' "$work/CHANGELOG.md" | cut -c1-10)" = "## [0.2.0]"
git -C "$work" tag v0.2.0
commit "$work" "docs(plan): mark 1.2 done"
(cd "$work" && scripts/release-notes.sh 0.3.0) >"$notes"
expect "says so when nothing notable changed" has "$notes" "No notable changes."
expect "without an empty fold" lacks "$notes" "<details>"

echo "release-pr.sh"
work=$(new_repo pr)
export GH_STUB_DIR=$tmp/pr/gh PNPM_STUB_DIR=$tmp/pr/pnpm
mkdir -p "$PNPM_STUB_DIR"
write_pnpm_stub "$work/.tools/bin/pnpm"
git -C "$work" switch -q -c develop
commit "$work" "feat(core): add a thing"
mkdir -p "$work/docs/releases"
echo "FXM 0.1.0 is the first release." >"$work/docs/releases/v0.1.0.md"
git -C "$work" add docs
git -C "$work" commit -q -m "docs(release): summarize v0.1.0"
git -C "$work" push -q -u origin develop
start=$(git -C "$work" rev-parse HEAD)
unchanged() {
  [ "$(git -C "$work" rev-parse develop)" = "$start" ] &&
    [ "$(git -C "$tmp/pr/origin.git" rev-parse develop)" = "$start" ] &&
    ! grep -q '^pr create' "$GH_STUB_DIR/calls.log" 2>/dev/null
}
# refuses <description> <message>: a real run fails with the message and changes nothing.
refuses() {
  run "$work" scripts/release-pr.sh 0.1.0
  if [ "$status" -ne 0 ] && says "$2" && unchanged; then ok "refuses $1"; else bad "refuses $1"; fi
}
echo stray >"$work/stray.txt"
refuses "a dirty working tree" "uncommitted or untracked files"
rm "${work:?}/stray.txt"
printf 'none yet: run scripts/make-android-keystore.sh\n' >"$work/apps/mobile/release-certificate.txt"
refuses "while no Android signing certificate is pinned" \
  "pins no Android signing certificate, so the release would stop before tagging"
git -C "$work" checkout -q -- apps/mobile/release-certificate.txt
git -C "$work" switch -q main
refuses "another branch than develop" "not develop"
git -C "$work" switch -q develop
commit "$work" "feat(core): not pushed"
run "$work" scripts/release-pr.sh 0.1.0
if [ "$status" -ne 0 ] && says "is not origin/develop"; then
  ok "refuses unpushed commits"
else
  bad "refuses unpushed commits"
fi
git -C "$work" reset -q --hard origin/develop
git -C "$work" tag v0.1.0
refuses "a version that is already tagged" "tag v0.1.0 already exists"
git -C "$work" tag -d v0.1.0 >/dev/null
run "$work" scripts/release-pr.sh 0.0.0
if [ "$status" -ne 0 ] && says "is not higher than the current version 0.0.0" && unchanged; then
  ok "refuses a version that is not higher"
else
  bad "refuses a version that is not higher"
fi
run "$work" scripts/release-pr.sh 0.2.0
if [ "$status" -ne 0 ] && says "docs/releases/v0.2.0.md is missing or empty" && unchanged; then
  ok "refuses a version without a summary"
else
  bad "refuses a version without a summary"
fi
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.2.0
expect "and DRY_RUN=1 reports it" test "$status" -eq 0 \
  -a -n "$(grep 'v0.2.0.md is missing or empty' <<<"$out")" \
  -a -n "$(grep 'would stop a real run' <<<"$out")"
# A summary written ahead of the release carries the draft mark until someone has checked it.
# Here it is only in the working tree, which fails the clean-tree check too.
cp "$work/docs/releases/v0.1.0.md" "$tmp/pr/summary.md"
{ echo "<!-- draft: check it against what v0.1.0 ships -->" && cat "$tmp/pr/summary.md"; } \
  >"$work/docs/releases/v0.1.0.md"
refuses "a summary that is still a draft" "docs/releases/v0.1.0.md is still a draft"
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
expect "and DRY_RUN=1 reports it" test "$status" -eq 0 \
  -a -n "$(grep 'v0.1.0.md is still a draft' <<<"$out")" \
  -a -n "$(grep 'would stop a real run' <<<"$out")"
cp "$tmp/pr/summary.md" "$work/docs/releases/v0.1.0.md"
echo https://github.com/test/fxm/pull/3 >"$GH_STUB_DIR/open-pr"
refuses "while a release pull request is open" "already open: https://github.com/test/fxm/pull/3"
: >"$GH_STUB_DIR/open-pr"
echo yes >"$GH_STUB_DIR/logged-out"
refuses "without a GitHub login" "not logged in"
: >"$GH_STUB_DIR/logged-out"
git -C "$work" switch -q main
commit "$work" "fix(core): hotfix on main"
git -C "$work" push -q origin main
git -C "$work" switch -q develop
refuses "when main has commits develop lacks" "origin/main has commits"
git -C "$work" merge -q --no-ff origin/main -m "Merge main back into develop"
git -C "$work" push -q origin develop
start=$(git -C "$work" rev-parse HEAD)
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
if [ "$status" -eq 0 ] && says "every check passed" && says "Add a thing" && unchanged &&
  [ -z "$(git -C "$work" status --porcelain)" ]; then
  ok "DRY_RUN=1 prints the plan and the notes and changes nothing"
else
  bad "DRY_RUN=1 prints the plan and the notes and changes nothing"
fi
checks=$PNPM_STUB_DIR/calls.log
# The folder the release script tests ran in, as their stand-in logged it last.
checked_in() { sed -n 's/^release-test in \(.*\): version .*/\1/p' "$checks" | tail -1; }
checked_release_commit() {
  grep -q "^install in $(checked_in)\$" "$checks" && grep -q "^lint in $(checked_in)\$" "$checks" &&
    grep -q ': version 0.1.0, changelog ## \[0.1.0\]$' "$checks"
}
expect "DRY_RUN=1 checks the release commit: its install, make lint and the release tests" \
  checked_release_commit
expect "with the lockfile frozen" grep -q '^install --frozen-lockfile' "$checks"
in_temporary_worktree() {
  [ -n "$(checked_in)" ] && [ "$(checked_in)" != "$work" ] && [ ! -e "$(checked_in)" ] &&
    [ "$(git -C "$work" worktree list | wc -l | tr -d ' ')" = 1 ]
}
expect "in a temporary worktree, which it removes" in_temporary_worktree
expect "and says how many entries the changelog gets" says "v0.1.0 gets 3 entries"
echo stray >"$work/stray.txt"
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
dry_status=$status
expect "DRY_RUN=1 reports failed checks instead of stopping" \
  test "$dry_status" -eq 0 -a -n "$(grep 'would stop a real run' <<<"$out")"
rm "${work:?}/stray.txt"
touch "$PNPM_STUB_DIR/lint-fails"
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
expect "DRY_RUN=1 reports a release commit that fails make lint" test "$status" -eq 0 \
  -a -n "$(grep 'fails make lint' <<<"$out")" -a -n "$(grep 'would stop a real run' <<<"$out")" \
  -a -n "$(grep 'Found 1 error.' <<<"$out")"
rm "$PNPM_STUB_DIR/lint-fails"
touch "$PNPM_STUB_DIR/install-fails"
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
expect "or whose dependencies don't install from the lockfile" test "$status" -eq 0 \
  -a -n "$(grep "don't install from the lockfile" <<<"$out")"
rm "$PNPM_STUB_DIR/install-fails"
touch "$PNPM_STUB_DIR/release-test-fails"
refuses "a release commit that fails the release script tests" "fails the release script tests"
expect "and removes its worktree then too" in_temporary_worktree
rm "$PNPM_STUB_DIR/release-test-fails"
run "$work" scripts/release-pr.sh 0.1.0
expect "a real run succeeds" test "$status" -eq 0
expect "commits chore(release) on develop" \
  test "$(git -C "$work" log -1 --format=%s)" = "chore(release): v0.1.0"
expect "with no attribution trailer" \
  test -z "$(git -C "$work" log -1 --format=%B | grep -i 'co-authored-by' || true)"
expect "pushes develop" \
  test "$(git -C "$tmp/pr/origin.git" rev-parse develop)" = "$(git -C "$work" rev-parse HEAD)"
expect "bumps the versions" has "$work/package.json" '"version": "0.1.0"'
expect "regenerates CHANGELOG.md" has "$work/CHANGELOG.md" "## [0.1.0]"
expect "opens the pull request develop → main" \
  has "$GH_STUB_DIR/calls.log" "pr create --base main --head develop --title Release v0.1.0"
expect "with the notes" has "$GH_STUB_DIR/pr-body.md" "- **core:** Add a thing"
summary_first() {
  [ "$(grep -n -e 'FXM 0.1.0 is the first release.' -e '^## Changes$' -e 'Add a thing' \
    "$GH_STUB_DIR/pr-body.md" | cut -d: -f2- | cut -c1-12 | tr '\n' '|')" = \
    "FXM 0.1.0 is|## Changes|- **core:** |" ]
}
expect "after the release's summary" summary_first
expect "and the legal notice" has "$GH_STUB_DIR/pr-body.md" "not affiliated with or endorsed by"
expect "prints the pull request URL" says "Release pull request: https://github.com/test/fxm/pull/7"
expect "leaves a clean tree" test -z "$(git -C "$work" status --porcelain)"
expect "never merges" lacks "$GH_STUB_DIR/calls.log" "pr merge"
# Run again with the same version, it updates the release that is under way.
commit "$work" "fix(core): a late fix"
git -C "$work" push -q origin develop
before=$(git -C "$work" rev-parse HEAD)
echo "https://github.com/test/fxm/pull/7 Release v0.1.0" >"$GH_STUB_DIR/open-pr"
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
expect "DRY_RUN=1 with the same version plans an update" \
  test "$status" -eq 0 -a -n "$(grep 'update the v0.1.0 release that is under way' <<<"$out")"
run "$work" scripts/release-pr.sh 0.1.0
expect "the same version again updates the release under way" test "$status" -eq 0
expect "with another chore(release) commit" \
  test "$(git -C "$work" log -1 --format=%s)" = "chore(release): v0.1.0" \
  -a "$(git -C "$work" rev-parse HEAD~1)" = "$before"
expect "whose CHANGELOG.md lists the late fix" has "$work/CHANGELOG.md" "**core:** A late fix"
expect "pushed to develop" \
  test "$(git -C "$tmp/pr/origin.git" rev-parse develop)" = "$(git -C "$work" rev-parse HEAD)"
expect "and new notes on the open pull request" \
  has "$GH_STUB_DIR/calls.log" "pr edit https://github.com/test/fxm/pull/7 --body-file"
expect "that list the late fix" has "$GH_STUB_DIR/pr-body.md" "**core:** A late fix"
expect "instead of a second pull request" \
  test "$(grep -c '^pr create' "$GH_STUB_DIR/calls.log")" = 1
: >"$GH_STUB_DIR/open-pr"
run "$work" scripts/release-pr.sh 0.1.0
expect "after the pull request was closed, opens it again" \
  test "$status" -eq 0 -a "$(grep -c '^pr create' "$GH_STUB_DIR/calls.log")" = 2
echo "https://github.com/test/fxm/pull/9 Sync develop" >"$GH_STUB_DIR/open-pr"
run "$work" scripts/release-pr.sh 0.1.0
if [ "$status" -ne 0 ] && says "already open: https://github.com/test/fxm/pull/9" &&
  lacks "$GH_STUB_DIR/calls.log" "pr edit https://github.com/test/fxm/pull/9"; then
  ok "refuses to update a pull request that is not the release's"
else
  bad "refuses to update a pull request that is not the release's"
fi
: >"$GH_STUB_DIR/open-pr"
git -C "$work" tag v0.1.0
run "$work" scripts/release-pr.sh 0.1.0
expect "refuses the version once it is tagged" \
  test "$status" -ne 0 -a -n "$(grep 'not higher than the current version 0.1.0' <<<"$out")"
git -C "$work" tag -d v0.1.0 >/dev/null

echo "release-pr.sh without a temporary folder"
# When mktemp -d fails, as on a full disk, the run must stop before its cleanup could delete
# anything, the checkout above all. The stand-in fails for folders only and hands every other
# call to the real mktemp.
work=$(new_repo full-disk)
real_mktemp=$(command -v mktemp)
cat >"$work/.tools/bin/mktemp" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = -d ]; then
  echo "mktemp: mkdtemp failed on /tmp/tmp.XXXXXXXX: No space left on device" >&2
  exit 1
fi
exec "$real_mktemp" "\$@"
EOF
chmod +x "$work/.tools/bin/mktemp"
git -C "$work" switch -q -c develop
git -C "$work" push -q -u origin develop
stops_and_keeps_the_checkout() {
  [ "$status" -ne 0 ] && says "could not create a temporary folder" &&
    [ -d "$work/.git" ] && [ -f "$work/scripts/release-pr.sh" ] &&
    [ "$(git -C "$work" rev-parse develop)" = "$(git -C "$tmp/full-disk/origin.git" rev-parse develop)" ]
}
run "$work" env DRY_RUN=1 scripts/release-pr.sh 0.1.0
expect "a dry run stops, and the checkout stays" stops_and_keeps_the_checkout
run "$work" scripts/release-pr.sh 0.1.0
expect "so does a real run" stops_and_keeps_the_checkout

echo "release-plan.sh"
work=$(new_repo plan)
export GH_STUB_DIR=$tmp/plan/gh GITHUB_OUTPUT=$tmp/plan/output
mkdir -p "$GH_STUB_DIR/tags" "$GH_STUB_DIR/tag-objects" "$GH_STUB_DIR/released"
plan() {
  : >"$GITHUB_OUTPUT"
  run "$work" scripts/release-plan.sh
}
value() { sed -n "s/^$1=//p" "$GITHUB_OUTPUT" | tail -1; }
# released_nothing: the plan failed, and neither its output nor $GITHUB_OUTPUT says to release.
released_nothing() { [ "$status" -ne 0 ] && [ "$(value release)" != true ] && ! says "release=true"; }
plan
expect "0.0.0 is never released" test "$status" -eq 0 -a "$(value release)" = false
first=$(git -C "$work" rev-parse HEAD)
(cd "$work" && scripts/release-version.sh 0.1.0 >/dev/null)
git -C "$work" commit -q -am "chore(release): v0.1.0"
plan
expect "warns when CHANGELOG.md has no section for the version" \
  says "CHANGELOG.md has no 0.1.0 section"
printf '\n## [0.1.0](https://example.invalid) - 2026-01-01\n' >>"$work/CHANGELOG.md"
git -C "$work" commit -q --amend -a --no-edit
head=$(git -C "$work" rev-parse HEAD)
plan
expect "a new version is released from HEAD" \
  test "$(value release)" = true -a "$(value sha)" = "$head" -a "$(value tag)" = v0.1.0
expect "without a warning once CHANGELOG.md has its section" not says "CHANGELOG.md has no"
echo 2001 >"$GH_STUB_DIR/released/v0.1.0"
plan
expect "a published version is not released again" test "$(value release)" = false
: >"$GH_STUB_DIR/released/v0.1.0"
echo "$head" >"$GH_STUB_DIR/tags/v0.1.0"
plan
expect "a tag at HEAD without a release is finished" \
  test "$status" -eq 0 -a "$(value release)" = true -a "$(value sha)" = "$head"
echo "tag 7a9b0c" >"$GH_STUB_DIR/tags/v0.1.0"
echo "commit $head" >"$GH_STUB_DIR/tag-objects/7a9b0c"
plan
expect "so is an annotated tag at HEAD" \
  test "$status" -eq 0 -a "$(value release)" = true -a "$(value sha)" = "$head"
# A tag at any other commit is refused, even with the right version: tags are not protected,
# and the attestations would name HEAD, not the commit that was built.
git -C "$work" switch -q -c unmerged
package_json "$work/package.json" fxm 6.6.6
git -C "$work" commit -q -am "feat: never reviewed"
unmerged=$(git -C "$work" rev-parse HEAD)
git -C "$work" switch -q main
commit "$work" "docs: a later commit on main"
later=$(git -C "$work" rev-parse HEAD)
refuses_tag() { # <description> <commit the tag points at>
  echo "$2" >"$GH_STUB_DIR/tags/v0.1.0"
  plan
  if released_nothing && says "Tag v0.1.0 points at ${2:0:7}, not at ${later:0:7}"; then
    ok "$1"
  else
    bad "$1"
  fi
}
refuses_tag "refuses a tag on a branch main never merged" "$unmerged"
refuses_tag "refuses a tag at an earlier commit of main" "$head"
refuses_tag "refuses a tag at a commit with another version" "$first"
: >"$GH_STUB_DIR/tags/v0.1.0"
# A failed GitHub API request stops the plan: it never reads as "not found".
fails_api() { # <description> <API path>
  echo "$2" >"$GH_STUB_DIR/broken"
  plan
  if released_nothing && says "GitHub API request failed: GET $2"; then ok "$1"; else bad "$1"; fi
  : >"$GH_STUB_DIR/broken"
}
fails_api "stops when GitHub can't say whether the release exists" \
  repos/test/fxm/releases/tags/v0.1.0
fails_api "stops when GitHub can't say whether the tag exists" repos/test/fxm/git/ref/tags/v0.1.0
echo "tag 7a9b0c" >"$GH_STUB_DIR/tags/v0.1.0"
fails_api "stops when GitHub can't say where an annotated tag points" \
  repos/test/fxm/git/tags/7a9b0c
: >"$GH_STUB_DIR/tags/v0.1.0"
echo "$first" >"$GH_STUB_DIR/tags/v0.0.9"
plan
expect "a version higher than every release tag is released" test "$(value release)" = true
echo "$first" >"$GH_STUB_DIR/tags/v0.2.0"
plan
expect "a version lower than a release tag stops the release" \
  test "$status" -ne 0 -a -n "$(grep 'not higher than the released v0.2.0' <<<"$out")"
: >"$GH_STUB_DIR/tags/v0.0.9"
: >"$GH_STUB_DIR/tags/v0.2.0"
package_json "$work/apps/web/package.json" @fxm/web 0.0.9
plan
expect "versions that disagree stop the release" test "$status" -ne 0
git -C "$work" checkout -q -- apps/web/package.json
unset GITHUB_OUTPUT

echo "release-wait.sh"
work=$(new_repo wait)
export GH_STUB_DIR=$tmp/wait/gh
mkdir -p "$GH_STUB_DIR/released" "$GH_STUB_DIR/released-after"
: >"$GH_STUB_DIR/calls.log"
# wait_for_release [minutes]: runs release-wait.sh without pauses between its requests.
wait_for_release() {
  : >"$GH_STUB_DIR/calls.log"
  run "$work" env FXM_RELEASE_WAIT_INTERVAL=0 FXM_RELEASE_WAIT_MINUTES="${1:-0}" \
    scripts/release-wait.sh
}
asked() { grep -c '^api repos/test/fxm/releases/tags/v0.1.0 ' "$GH_STUB_DIR/calls.log" || true; }
wait_for_release
expect "0.0.0 waits for nothing" test "$status" -eq 0 -a "$(asked)" = 0
(cd "$work" && scripts/release-version.sh 0.1.0 >/dev/null)
git -C "$work" commit -q -am "chore(release): v0.1.0"
wait_for_release
expect "a version without a published release fails while it isn't out" \
  test "$status" -ne 0 -a -n "$(grep 'v0.1.0 is not out after 0 minutes' <<<"$out")"
echo 2001 >"$GH_STUB_DIR/released/v0.1.0"
wait_for_release
expect "and passes once it is published" \
  test "$status" -eq 0 -a "$(asked)" = 1 -a -n "$(grep 'v0.1.0 is published' <<<"$out")"
: >"$GH_STUB_DIR/released/v0.1.0"
echo 2 >"$GH_STUB_DIR/released-after/v0.1.0"
wait_for_release 1
expect "asking again until it is out" test "$status" -eq 0 -a "$(asked)" = 3
rm "$GH_STUB_DIR/released-after/v0.1.0"
echo repos/test/fxm/releases/tags/v0.1.0 >"$GH_STUB_DIR/broken"
wait_for_release
expect "a failed request is no answer" test "$status" -ne 0 \
  -a -n "$(grep "didn't say whether v0.1.0 is published: gh: Server Error (HTTP 502)" <<<"$out")"
: >"$GH_STUB_DIR/broken"
# A later push to main that keeps the version, while its release is still missing (its run
# failed): the release workflow publishes the version from this push, so production waits too.
git -C "$work" switch -q -c fix/late
commit "$work" "fix(core): a later fix on main"
git -C "$work" switch -q main
git -C "$work" merge -q --no-ff fix/late -m "Merge a later fix"
wait_for_release
expect "a later merge that keeps the version waits while the release is missing" \
  test "$status" -ne 0 -a -n "$(grep 'v0.1.0 is not out after 0 minutes' <<<"$out")"
echo 2001 >"$GH_STUB_DIR/released/v0.1.0"
wait_for_release
expect "and passes after one request once it is out" \
  test "$status" -eq 0 -a "$(asked)" = 1 -a -n "$(grep 'v0.1.0 is published' <<<"$out")"

echo "release-collect.sh"
work=$(new_repo collect)
pristine=$tmp/collect/pristine
mkdir -p "$pristine/release-bundles"
for app in web connect-chromium connect-firefox; do
  echo "$app" >"$pristine/release-bundles/fxm-$app-0.1.0.zip"
done
# new_case: a fresh copy of the pristine artifacts in $case_dir/artifacts, to collect into
# $case_dir/out.
cases=0
new_case() {
  cases=$((cases + 1))
  case_dir=$tmp/collect/case-$cases
  mkdir -p "$case_dir"
  cp -R "$pristine" "$case_dir/artifacts"
}
collect() { run "$work" scripts/release-collect.sh 0.1.0 "$case_dir/artifacts" "$case_dir/out"; }
new_case
collect
expect "gathers the artifacts' files into one folder" \
  test "$status" -eq 0 -a "$(find "$case_dir/out" -type f | wc -l | tr -d ' ')" = 3
expect "unchanged" test "$(cat "$case_dir/out/fxm-web-0.1.0.zip")" = web
# refuses_file <description> <file to add to release-bundles> <message>
refuses_file() {
  new_case
  echo stowaway >"$case_dir/artifacts/release-bundles/$2"
  collect
  if [ "$status" -ne 0 ] && says "$3"; then ok "$1"; else bad "$1"; fi
}
refuses_file "refuses a file without the version" install.sh "does not carry the version 0.1.0"
refuses_file "refuses a file of another version" fxm-web-0.0.9.zip "does not carry the version"
refuses_file "refuses a file that the catalog doesn't list" fxm-extra-0.1.0.zip \
  "is not a file that release-bundles may publish"
refuses_file "looks at dot files too" .fxm-0.1.0.zip "is not a file that release-bundles may publish"
refuses_file "refuses an APK from a job other than android-sign" fxm-android-universal-0.1.0.apk \
  "is not a file that release-bundles may publish"
new_case
mkdir "$case_dir/artifacts/release-android"
for abi in arm64-v8a universal; do
  echo "$abi" >"$case_dir/artifacts/release-android/fxm-android-$abi-0.1.0.apk"
done
collect
expect "gathers the signed APKs from release-android" test "$status" -eq 0 \
  -a -f "$case_dir/out/fxm-android-arm64-v8a-0.1.0.apk" -a -f "$case_dir/out/fxm-android-universal-0.1.0.apk"
new_case
mkdir "$case_dir/artifacts/release-android"
echo unsigned >"$case_dir/artifacts/release-android/fxm-android-universal-0.1.0-unsigned.apk"
collect
expect "but never an unsigned one" \
  test "$status" -ne 0 -a -n "$(grep 'is not a file that release-android may publish' <<<"$out")"
new_case
mkdir "$case_dir/artifacts/release-bundles/bundle"
echo dmg >"$case_dir/artifacts/release-bundles/bundle/fxm-desktop-0.1.0.dmg"
collect
expect "refuses a folder inside an artifact" \
  test "$status" -ne 0 -a -n "$(grep 'must contain flat files' <<<"$out")"
new_case
ln -s fxm-web-0.1.0.zip "$case_dir/artifacts/release-bundles/fxm-connect-0.1.0.zip"
collect
expect "refuses a link" test "$status" -ne 0 -a -n "$(grep 'is not a plain file' <<<"$out")"
new_case
mkdir "$case_dir/artifacts/release-extra"
echo extra >"$case_dir/artifacts/release-extra/fxm-web-0.1.0.zip"
collect
expect "refuses an artifact that the catalog doesn't know" \
  test "$status" -ne 0 -a -n "$(grep 'unknown artifact release-extra' <<<"$out")"
# Even when the catalog lets two artifacts publish the same name, neither replaces the other.
cat >>"$work/scripts/release-lib.sh" <<'EOF'
fxm_release_catalog() {
  printf '%s\n' 'release-bundles|fxm-*-<version>.zip|Bundles' 'release-extra|fxm-web-<version>.zip|Web'
}
EOF
new_case
mkdir "$case_dir/artifacts/release-extra"
echo extra >"$case_dir/artifacts/release-extra/fxm-web-0.1.0.zip"
collect
expect "refuses a file name that two artifacts publish" \
  test "$status" -ne 0 -a -n "$(grep 'fxm-web-0.1.0.zip comes from more than one artifact' <<<"$out")"
new_case
mkdir "$case_dir/artifacts/release-extra"
collect
expect "refuses an empty artifact" \
  test "$status" -ne 0 -a -n "$(grep 'artifact release-extra has no files' <<<"$out")"
new_case
mkdir "$case_dir/out" && echo old >"$case_dir/out/fxm-web-0.0.9.zip"
collect
expect "refuses a folder that isn't empty" \
  test "$status" -ne 0 -a -n "$(grep 'is not empty' <<<"$out")"

echo "release-build.sh"
if ! command -v zip >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
  fxm_warn "Skipped: these tests need zip and unzip (preinstalled on macOS and GitHub's runners)"
else
  work=$(new_repo build)
  export PNPM_STUB_DIR=$tmp/build/pnpm
  mkdir -p "$PNPM_STUB_DIR"
  : >"$PNPM_STUB_DIR/calls.log"
  write_pnpm_stub "$work/.tools/bin/pnpm"
  # What make dist composes, in small, with modes and dates that must not reach the zip.
  pages=$PNPM_STUB_DIR/pages
  mkdir -p "$pages/.well-known" "$pages/app/assets" "$pages/sandbox"
  for file in index.html Z.html _headers third-party-notices.txt .well-known/security.txt \
    app/index.html app/assets/b.js app/assets/a.js sandbox/innertube.html; do
    echo "$file" >"$pages/$file"
  done
  chmod 0600 "$pages/_headers"
  chmod 0755 "$pages/app/assets/a.js"
  build() { run "$work" scripts/release-build.sh "${1:-dist/release}"; }
  build
  expect "refuses to build until every package has the release version" \
    test "$status" -ne 0 -a -n "$(grep 'every package needs the release version' <<<"$out")"
  (cd "$work" && scripts/release-version.sh 0.1.0 >/dev/null)
  GIT_COMMITTER_DATE=2026-10-25T12:30:42Z git -C "$work" commit -q -am "chore(release): v0.1.0"
  zip=$work/dist/release/fxm-web-0.1.0.zip
  build
  expect "builds the release files" test "$status" -eq 0
  # Run by make itself, one level below this test (make release-check is a level of its own), so
  # the call is whatever the Makefile's dist recipe makes it, as in the deploy workflow.
  made_dist="--filter @fxm/deploy dist.* (make level $((${MAKELEVEL:-0} + 1)))\$"
  expect "with make dist itself, once" \
    test "$(grep -c -- "$made_dist" "$PNPM_STUB_DIR/calls.log")" = 1
  no_own_builds() {
    lacks "$PNPM_STUB_DIR/calls.log" @fxm/site && lacks "$PNPM_STUB_DIR/calls.log" @fxm/web
  }
  expect "instead of building the site and the app on their own" no_own_builds
  expect "into the web zip and FXM Connect's two" \
    test "$(ls "$work/dist/release" 2>/dev/null | tr '\n' ' ')" = \
    "fxm-connect-chromium-0.1.0.zip fxm-connect-firefox-0.1.0.zip fxm-web-0.1.0.zip "
  sorted=(.well-known/security.txt Z.html _headers app/assets/a.js app/assets/b.js app/index.html
    index.html sandbox/innertube.html third-party-notices.txt)
  expect "the web zip holds exactly dist/pages, dot folders included, sorted by name" \
    test "$(unzip -Z1 "$zip" 2>/dev/null | tr '\n' ' ')" = "${sorted[*]} "
  # zipinfo's lines: mode, version, system, size, text or binary plus a hyphen when the entry has
  # no extra field (uid, gid, more dates), method, date.time and name.
  entry='^-rw-r--r-- .* [tb]- [a-zA-Z0-9]+ 20261025\.123042 '
  expect "every file 0644, without extra fields and dated with the release commit's time" \
    test "$(unzip -Z -T "$zip" 2>/dev/null | grep -cE "$entry")" = 9
  cp "$zip" "$tmp/build/first.zip" 2>/dev/null || true
  chmod 0640 "$pages/index.html"
  TZ=UTC find "$pages" -exec touch -t 200001020304.05 {} +
  build
  expect "the same files make the same zip, whatever their modes and dates" \
    cmp -s "$zip" "$tmp/build/first.zip"
  touch "$PNPM_STUB_DIR/no-match"
  build
  expect "never zips the dist/pages of an earlier make dist" test "$status" -ne 0 -a ! -e "$zip"
  rm "$PNPM_STUB_DIR/no-match"
  mv "$pages/third-party-notices.txt" "$tmp/build/notices.txt"
  build
  expect "refuses a dist/pages without the third-party notices" \
    test "$status" -ne 0 -a ! -e "$zip" -a -n "$(grep 'third-party-notices.txt' <<<"$out")"
  mv "$tmp/build/notices.txt" "$pages/third-party-notices.txt"
  calls=$(wc -l <"$PNPM_STUB_DIR/calls.log" | tr -d ' ')
  build dist/pages/release
  expect "refuses a release folder inside dist/pages, which make dist replaces" \
    test "$status" -ne 0 -a -n "$(grep 'inside a folder that make dist replaces' <<<"$out")" \
    -a "$(wc -l <"$PNPM_STUB_DIR/calls.log" | tr -d ' ')" = "$calls"
fi

echo "release-build.sh --checksums and release-publish.sh"
work=$(new_repo publish)
export GH_STUB_DIR=$tmp/publish/gh
files=$tmp/publish/files
mkdir -p "$files"
echo web >"$files/fxm-web-0.1.0.zip"
echo chromium >"$files/fxm-connect-chromium-0.1.0.zip"
run "$work" scripts/release-build.sh --checksums "$files"
expect "writes SHA256SUMS" test "$status" -eq 0 -a "$(wc -l <"$files/SHA256SUMS" | tr -d ' ')" = 2
if command -v sha256sum >/dev/null 2>&1; then verify=(sha256sum -c); else verify=(shasum -a 256 -c); fi
sums_pass() { (cd "$1" && "${verify[@]}" SHA256SUMS >/dev/null 2>&1); }
expect "in the format sha256sum --check reads" sums_pass "$files"
# copy_files <name>: a copy of the release files, SHA256SUMS included, in $copy.
copy_files() {
  copy=$tmp/publish/$1
  cp -R "$files" "$copy"
}
copy_files changed
echo changed >>"$copy/fxm-web-0.1.0.zip"
expect "so that a changed file fails the check" not sums_pass "$copy"
copy_files with-folder
mkdir "$copy/bundle" && echo dmg >"$copy/bundle/FXM.dmg"
run "$work" scripts/release-build.sh --checksums "$copy"
expect "refuses a folder among the files" \
  test "$status" -ne 0 -a -n "$(grep 'is not a plain file' <<<"$out")"
expect "and leaves SHA256SUMS as it was" cmp -s "$files/SHA256SUMS" "$copy/SHA256SUMS"
copy_files with-link
ln -s fxm-web-0.1.0.zip "$copy/fxm-connect-firefox-0.1.0.zip"
run "$work" scripts/release-build.sh --checksums "$copy"
expect "and a link" test "$status" -ne 0 -a -n "$(grep 'is not a plain file' <<<"$out")"
printf '### Features\n\n- **core:** Add a thing\n' >"$tmp/publish/notes.md"
sha=$(git -C "$work" rev-parse HEAD)
# publish <x.y.z> <commit> [dir]
publish() { run "$work" scripts/release-publish.sh "$1" "$2" "${3:-$files}" "$tmp/publish/notes.md"; }
publish 0.1.0 "$sha"
expect "creates the tag at the release commit" \
  test "$status" -eq 0 -a "$(cat "$GH_STUB_DIR/tags/v0.1.0" 2>/dev/null)" = "$sha"
expect "publishes the release" test -s "$GH_STUB_DIR/released/v0.1.0"
expect "with every file, SHA256SUMS included" test "$(sort "$GH_STUB_DIR/release-files.txt" |
  tr '\n' ' ')" = "SHA256SUMS fxm-connect-chromium-0.1.0.zip fxm-web-0.1.0.zip "
expect "with the notes" has "$GH_STUB_DIR/release-notes.md" "- **core:** Add a thing"
expect "and a table of the files from the catalog" has "$GH_STUB_DIR/release-notes.md" \
  "| \`fxm-web-0.1.0.zip\` | The website and web app for self-hosting"
expect "under a heading of the notes' level" \
  test -n "$(grep -x '## Files' "$GH_STUB_DIR/release-notes.md")"
expect "and where the self-hosting steps are" has "$GH_STUB_DIR/release-notes.md" \
  "(https://github.com/test/fxm/blob/v0.1.0/scripts/build-dist/README.md#self-hosting)"
expect "that ends with SHA256SUMS" \
  test "$(grep '^| `' "$GH_STUB_DIR/release-notes.md" | tail -1 | cut -d'`' -f2)" = SHA256SUMS
expect "and how to verify them against the release workflow on main" \
  has "$GH_STUB_DIR/release-notes.md" \
  "--cert-identity https://github.com/test/fxm/.github/workflows/release.yml@refs/heads/main"
publish 0.1.0 "$sha"
expect "a re-run leaves a published release alone" \
  test "$status" -eq 0 -a "$(grep -c '^release create' "$GH_STUB_DIR/calls.log")" = 1
other=$(git -C "$work" rev-list --max-parents=0 HEAD)
commit "$work" "feat(core): later"
sha=$(git -C "$work" rev-parse HEAD)
echo "$other" >"$GH_STUB_DIR/tags/v0.2.0"
publish 0.2.0 "$sha"
expect "refuses a tag that points at another commit" \
  test "$status" -ne 0 -a ! -s "$GH_STUB_DIR/released/v0.2.0"
mkdir -p "$GH_STUB_DIR/drafts" && echo 3001 >"$GH_STUB_DIR/drafts/v0.3.0"
publish 0.3.0 "$sha"
expect "replaces a draft left by a failed run" \
  test "$status" -eq 0 -a -s "$GH_STUB_DIR/released/v0.3.0" -a ! -s "$GH_STUB_DIR/drafts/v0.3.0"
expect "by deleting it" has "$GH_STUB_DIR/calls.log" "api -X DELETE repos/test/fxm/releases/3001"
# stopped <description> <x.y.z>: publishing failed before it tagged or published anything.
stopped() {
  if [ "$status" -ne 0 ] && [ ! -s "$GH_STUB_DIR/tags/v$2" ] &&
    [ ! -s "$GH_STUB_DIR/released/v$2" ]; then
    ok "$1"
  else
    bad "$1"
  fi
}
echo repos/test/fxm/releases/tags/v0.5.0 >"$GH_STUB_DIR/broken"
publish 0.5.0 "$sha"
stopped "stops before tagging when GitHub can't say whether the release exists" 0.5.0
echo repos/test/fxm/git/ref/tags/v0.5.0 >"$GH_STUB_DIR/broken"
publish 0.5.0 "$sha"
stopped "or whether the tag exists" 0.5.0
expect "without trying to create it" lacks "$GH_STUB_DIR/calls.log" "ref=refs/tags/v0.5.0"
echo "repos/test/fxm/releases?per_page=100" >"$GH_STUB_DIR/broken"
publish 0.5.0 "$sha"
expect "stops before publishing when GitHub can't list the drafts" \
  test "$status" -ne 0 -a ! -s "$GH_STUB_DIR/released/v0.5.0"
: >"$GH_STUB_DIR/broken"
copy_files tampered
echo changed >>"$copy/fxm-web-0.1.0.zip"
publish 0.6.0 "$sha" "$copy"
stopped "refuses files that SHA256SUMS doesn't match" 0.6.0
publish 0.6.0 "$sha" "$tmp/publish/with-folder"
stopped "refuses a folder among the files" 0.6.0
mkdir "$tmp/publish/no-sums"
cp "$files"/*.zip "$tmp/publish/no-sums/"
publish 0.6.0 "$sha" "$tmp/publish/no-sums"
stopped "needs SHA256SUMS" 0.6.0
expect "leaves Android out of notes without APKs" \
  lacks "$GH_STUB_DIR/release-notes.md" "Install the Android app"
# The Android APKs: the notes quote the certificate pinned at the release commit.
android=$tmp/publish/android
mkdir "$android"
cp "$files"/*.zip "$android/"
for abi in arm64-v8a universal; do echo "$abi" >"$android/fxm-android-$abi-0.7.0.apk"; done
run "$work" scripts/release-build.sh --checksums "$android"
mkdir -p "$work/apps/mobile"
printf '# Not pinned yet\nnone yet: run scripts/make-android-keystore.sh\n' \
  >"$work/apps/mobile/release-certificate.txt"
publish 0.7.0 "$sha" "$android"
stopped "stops before tagging while no Android certificate is pinned" 0.7.0
expect "and says so" says "pins no signing certificate yet"
printf '# The test key\n%s\n' "$(printf 'ab%.0s' $(seq 32))" >"$work/apps/mobile/release-certificate.txt"
publish 0.7.0 "$sha" "$android"
expect "publishes the APKs once a certificate is pinned" \
  test "$status" -eq 0 -a -s "$GH_STUB_DIR/released/v0.7.0"
expect "with the install guide" has "$GH_STUB_DIR/release-notes.md" \
  "[steps in its guide](https://github.com/test/fxm/blob/v0.7.0/apps/mobile/INSTALL.md)"
expect "and the certificate's SHA-256, with colons" has "$GH_STUB_DIR/release-notes.md" \
  "$(printf 'AB:%.0s' $(seq 31))AB"
expect "and both APKs in the file table" \
  test "$(grep -c '^| `fxm-android-' "$GH_STUB_DIR/release-notes.md")" = 2

echo
if [ "$failed" -eq 0 ]; then
  fxm_info "All $passed release script tests passed"
else
  fxm_die "$failed of $((passed + failed)) release script tests failed"
fi
