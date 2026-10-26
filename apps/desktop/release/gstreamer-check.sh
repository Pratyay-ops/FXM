#!/usr/bin/env bash
# Linux release builds (.github/workflows/desktop-release.yml): checks which GStreamer plugins the
# AppImage will bundle. `bundleMediaFramework` (tauri.conf.json) copies every plugin installed on
# the build machine into the AppImage, which then plays with those alone. FXM ships only LGPL
# plugins: base and good (Opus, Vorbis, MP3, FLAC, WebM and MP4 demuxing), the audio outputs, and
# what WebKitGTK itself installs. So this fails when a package whose plugins aren't all LGPL is
# installed: gst-libav (FFmpeg, built with GPL parts on Ubuntu), ugly or bad. The .deb gets AAC
# from the distribution's own gst-libav instead (bundle > linux > deb > depends).
#
# Prints the packages the plugins come from, with how many each, and adds them to the job summary.
set -euo pipefail

denied=(gstreamer1.0-libav gstreamer1.0-plugins-ugly gstreamer1.0-plugins-bad)
for package in "${denied[@]}"; do
  if [ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" = installed ]; then
    echo "::error title=GStreamer plugins::$package is installed, so the AppImage would bundle its" \
      "plugins, which aren't all LGPL. Remove it before building."
    exit 1
  fi
done

dir="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/gstreamer-1.0"
[ -d "$dir" ] || {
  echo "::error title=GStreamer plugins::$dir is missing: install gstreamer1.0-plugins-base"
  exit 1
}
owners=$(for plugin in "$dir"/*.so; do
  owner=$(dpkg-query -S "$plugin" 2>/dev/null | cut -d: -f1 || true)
  echo "${owner:-(no package): $(basename "$plugin")}"
done | sort | uniq -c)
echo "The AppImage bundles the GStreamer plugins of:"
echo "$owners"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### GStreamer plugins in the AppImage"
    echo
    echo '```'
    echo "$owners"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
if grep -q '(no package)' <<<"$owners"; then
  echo "::error title=GStreamer plugins::a plugin in $dir comes from no package"
  exit 1
fi
