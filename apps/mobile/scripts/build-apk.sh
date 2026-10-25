#!/usr/bin/env bash
# Builds the debug APK (make apk): the web app with base '/', `cap sync android`, then Gradle's
# assembleDebug with the JDK, Android SDK and Gradle home in .tools/ (scripts/env.sh). Like
# make android-setup, it checks that nothing appeared in ~/.android, ~/.gradle, ~/.m2 or
# ~/Library/Android. Gradle runs without a daemon, so nothing keeps running afterwards.
set -euo pipefail
mobile=$(cd "$(dirname "$0")/.." && pwd)
cd "$mobile"
source ../../scripts/env.sh
source ../../scripts/lib.sh

../../scripts/android-setup.sh --check

home_dirs=("$HOME/.android" "$HOME/.gradle" "$HOME/.m2" "$HOME/Library/Android")
absent=()
for dir in "${home_dirs[@]}"; do [ -e "$dir" ] || absent+=("$dir"); done

pnpm --filter @fxm/web build:mobile
pnpm --filter @fxm/mobile cap sync android
(cd android && ./gradlew --no-daemon assembleDebug)

for dir in ${absent[@]+"${absent[@]}"}; do
  [ ! -e "$dir" ] ||
    fxm_die "$dir was created during the build, so a tool ignored scripts/env.sh. Remove it with: rm -rf '$dir'"
done

apk=android/app/build/outputs/apk/debug/app-debug.apk
[ -f "$apk" ] || fxm_die "Gradle finished without writing $apk"
fxm_info "Debug APK ($(du -h "$apk" | cut -f1 | tr -d ' ')): apps/mobile/$apk"
