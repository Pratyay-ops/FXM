#!/usr/bin/env bash
# Prepares FXM's Android project for F-Droid's build: the web app, built as an F-Droid build, in
# the Android project's assets, with the APK's third-party notices. F-Droid's recipe
# (packaging/fdroid/README.md) runs it in its `build:` step, after F-Droid has scanned the source,
# from the Android app's folder:
#
#   build:
#     - cd ../../../..
#     - packaging/fdroid/build.sh
#
# and then builds the release APK itself (`gradle: [yes]` in apps/mobile/android/app). It runs
# the steps of the GitHub APK's build (apps/mobile/scripts/release-apk.sh build, stage 6.6), for
# F-Droid:
#
#   1. Node.js 22: the one on the PATH when it is 22.13 or a later 22.x (package.json's engines),
#      else Node.js's own Linux build, pinned and checked against its SHA-256 below, in
#      .tools/node. Debian's stable and testing suites have no Node.js 22 (trixie has 20, forky
#      24; sources.debian.org, 2026-10-26), and F-Droid's inclusion policy accepts Node.js's
#      prebuilt binaries ("Build Transparency and Reproducibility", read 2026-10-26).
#   2. pnpm, pinned and checked (scripts/install-pnpm.sh).
#   3. The npm packages, exactly as the lockfile has them: those of the Android app and the web
#      app, plus those of make dist when step 6 runs. They are installed here, after F-Droid's
#      scan, which would delete files that the build needs: Capacitor's template archive and
#      the prebuilt binaries of build tools (README.md, "The build").
#   4. The web app as an F-Droid build, with two flags, both needed until FXM has one:
#      VITE_FXM_DISTRIBUTION=fdroid holds the YouTube code updates from FXM's website (stage
#      1.13) and plugins (stage 8.3) back until the user opts in (apps/web/src/lib/distribution.ts,
#      the one gate both read), and FXM_DISTRIBUTION=fdroid keeps FXM's own app update check off
#      (stage 6.6). Vite builds in only VITE_ variables by itself: the gate reads FXM_DISTRIBUTION
#      too once stage 6.6's Vite config builds it in, and until then only VITE_FXM_DISTRIBUTION
#      asks before downloaded code.
#   5. `cap sync android`, which copies it into apps/mobile/android.
#   6. The APK's third-party notices, which Settings → About shows, as the GitHub APK's build
#      writes them (stage 6.6): make dist's notices of the web code, and the Android libraries
#      that Gradle resolves for the release build (fxmLibraryReport), joined by
#      apps/mobile/scripts/write-notices.ts into assets/public/third-party-notices.txt. A
#      checkout from before stage 6.6 has no such writer: the step is then skipped, with a
#      warning, and F-Droid must not build that checkout.
#
# Gradle runs from apps/mobile/android with the wrapper where the checkout has its JAR, else with
# gradlew-fdroid, which F-Droid's build server provides after its scan removed the JAR. The
# Android SDK is the one in .tools (make android-setup) or, without it, the caller's
# ANDROID_HOME, which F-Droid sets to its own.
#
# Run it yourself to try the recipe's first half on Linux or macOS; then build the APK with
# `scripts/run.sh bash -c 'cd apps/mobile/android && ./gradlew --no-daemon assembleRelease'`.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
caller_sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
source scripts/env.sh
source scripts/lib.sh
if [ ! -d "$ANDROID_HOME" ] && [ -n "$caller_sdk" ]; then
  export ANDROID_HOME=$caller_sdk ANDROID_SDK_ROOT=$caller_sdk
fi

# Node.js for the build, from https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt. Keep it a
# 22.x release that has been out for two weeks, like every other pinned tool.
NODE_VERSION=22.23.3
NODE_SHA256_LINUX_X64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_SHA256_LINUX_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f

# The third-party notices' writer of stage 6.6, and where it writes them.
NOTICES_WRITER=apps/mobile/scripts/write-notices.ts
NOTICES=apps/mobile/android/app/src/main/assets/public/third-party-notices.txt
LIBRARY_REPORT=apps/mobile/android/app/build/fxm/android-libraries.json

# node_ok: whether the node on the PATH is 22.13 or a later 22.x, as package.json's engines ask.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number)
    process.exit(major === 22 && minor >= 13 ? 0 : 1)
  '
}

# run_gradle <task...>: runs Gradle in apps/mobile/android, without a daemon left running.
run_gradle() {
  local android=apps/mobile/android
  if [ -f "$android/gradle/wrapper/gradle-wrapper.jar" ]; then
    (cd "$android" && ./gradlew --no-daemon "$@")
  elif command -v gradlew-fdroid >/dev/null 2>&1; then
    (cd "$android" && gradlew-fdroid --no-daemon "$@")
  else
    fxm_die "no Gradle: $android has no gradle-wrapper.jar, and gradlew-fdroid isn't on the PATH"
  fi
}

if ! node_ok; then
  case "$(fxm_platform)" in
    linux-x64) cpu=x64 sha=$NODE_SHA256_LINUX_X64 ;;
    linux-arm64) cpu=arm64 sha=$NODE_SHA256_LINUX_ARM64 ;;
    *) fxm_die "Node.js 22.13 or a later 22.x is required: install it (nvm install, which reads .nvmrc)" ;;
  esac
  dir="$FXM_TOOLS/node/node-v$NODE_VERSION-linux-$cpu"
  if [ ! -x "$dir/bin/node" ]; then
    mkdir -p "$FXM_TOOLS/node"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    fxm_download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$cpu.tar.xz" \
      "$tmp/node.tar.xz" "$sha"
    tar -xJf "$tmp/node.tar.xz" -C "$FXM_TOOLS/node"
  fi
  export PATH="$dir/bin:$PATH"
  node_ok || fxm_die "Node.js $NODE_VERSION in $dir doesn't run"
fi
fxm_info "Node.js $(node --version)"

scripts/install-pnpm.sh

notices=false
filters=(--filter '@fxm/mobile...' --filter '@fxm/web...')
if [ -f "$NOTICES_WRITER" ]; then
  notices=true
  filters+=(--filter '@fxm/deploy...' --filter '@fxm/site...')
fi
pnpm install --frozen-lockfile "${filters[@]}"

# make dist first: its notices of the web code go into the APK's (step 6).
if $notices; then
  pnpm --silent --filter @fxm/deploy dist
fi

# An F-Droid build of the web app (see the header), with base '/' as the Android app serves it.
rm -rf apps/web/dist-mobile
FXM_DISTRIBUTION=fdroid VITE_FXM_DISTRIBUTION=fdroid pnpm --filter @fxm/web build:mobile
[ -f apps/web/dist-mobile/index.html ] || fxm_die "the web app's build wrote no index.html"

pnpm --filter @fxm/mobile cap sync android
[ -f apps/mobile/android/app/src/main/assets/public/index.html ] ||
  fxm_die "cap sync left no web app in apps/mobile/android/app/src/main/assets/public"

if $notices; then
  rm -f "$LIBRARY_REPORT"
  run_gradle fxmLibraryReport
  node --experimental-strip-types --disable-warning=ExperimentalWarning "$NOTICES_WRITER" \
    "$LIBRARY_REPORT" dist/pages/third-party-notices.txt "$NOTICES"
  [ -s "$NOTICES" ] || fxm_die "the third-party notices' writer wrote no $NOTICES"
  fxm_info "The APK's third-party notices are in $NOTICES"
else
  fxm_warn "This checkout predates stage 6.6, so the APK would have no third-party notices" \
    "($NOTICES_WRITER is missing): F-Droid must not build it"
fi

fxm_info "The Android project holds the F-Droid build of the web app: Gradle's assembleRelease is next"
