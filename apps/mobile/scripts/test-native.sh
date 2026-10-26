#!/usr/bin/env bash
# Runs the native unit tests (make android-test): the JVM tests of android/fxm-http, FXM's OkHttp
# client and FxmHttp plugin, of android/fxm-player, the native player's logic, and of
# android/fxm-spotify, the Spotify login's kept login and token call, with the JDK, Android SDK
# and Gradle home in .tools/ (scripts/env.sh). They run offline (fxm-http's and fxm-spotify's
# against a local MockWebServer) and need no device or emulator. Like make apk, it checks that
# nothing appeared in ~/.android, ~/.gradle, ~/.m2 or ~/Library/Android, and Gradle runs without a
# daemon.
set -euo pipefail
mobile=$(cd "$(dirname "$0")/.." && pwd)
cd "$mobile"
source ../../scripts/env.sh
source ../../scripts/lib.sh

../../scripts/android-setup.sh --check

home_dirs=("$HOME/.android" "$HOME/.gradle" "$HOME/.m2" "$HOME/Library/Android")
absent=()
for dir in "${home_dirs[@]}"; do [ -e "$dir" ] || absent+=("$dir"); done

# Gradle configures the whole project, which needs the files `cap sync` generates.
if [ ! -f android/capacitor-cordova-android-plugins/cordova.variables.gradle ]; then
  pnpm --filter @fxm/web build:mobile
  pnpm --filter @fxm/mobile cap sync android
fi
(cd android && ./gradlew --no-daemon :fxm-http:testDebugUnitTest :fxm-player:testDebugUnitTest :fxm-spotify:testDebugUnitTest)

for dir in ${absent[@]+"${absent[@]}"}; do
  [ ! -e "$dir" ] ||
    fxm_die "$dir was created during the tests, so a tool ignored scripts/env.sh. Remove it with: rm -rf '$dir'"
done
fxm_info "Native unit tests passed (reports: apps/mobile/android/{fxm-http,fxm-player,fxm-spotify}/build/reports/tests/testDebugUnitTest/index.html)"
