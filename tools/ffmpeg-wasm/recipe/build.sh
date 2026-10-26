#!/usr/bin/env bash
# Builds FXM's LGPL, audio-only ffmpeg core: ffmpeg-core.js and ffmpeg-core.wasm, plus
# ffmpeg-core.json, which says what they were built from (tools/ffmpeg-wasm/README.md).
#
#   make ffmpeg-wasm     (or tools/ffmpeg-wasm/recipe/build.sh)
#
# Everything goes into .tools/ of the main checkout, so `make nuke` removes it:
#
#   .tools/emsdk/<version>/                    emsdk and the Emscripten toolchain
#   .tools/ffmpeg-wasm/downloads/              the tarballs, each checked by its SHA-256
#   .tools/ffmpeg-wasm/libs/<libs hash>/       Opus, LAME and FFmpeg, built (libs.sh)
#   .tools/ffmpeg-wasm/builds/<recipe hash>/   the core; dist/ holds its three files,
#                                              licenses/, the licence texts of its parts and
#                                              the notices of its linked files, and source/,
#                                              the tarballs it was built from and the recipe
#
# A build is keyed by the hash of this folder (core-build.ts), so it is reused until the recipe
# changes; the libraries are reused until versions.sh, libs.sh or pkg-config.sh changes, so a
# change to fxm_convert.c only links again. FXM_FFMPEG_JOBS sets make's parallel jobs (default
# 2, for a shared machine; CI passes its CPU count). FXM_FFMPEG_REBUILD=1 builds everything
# again.
set -euo pipefail

recipe=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$recipe/../../.." && pwd)
# shellcheck source=../../../scripts/env.sh
source "$root/scripts/env.sh"
# shellcheck source=../../../scripts/lib.sh
source "$root/scripts/lib.sh"
# shellcheck source=versions.sh
source "$recipe/versions.sh"

export LC_ALL=C TZ=UTC
jobs=${FXM_FFMPEG_JOBS:-2}
core_build=(node --experimental-strip-types --disable-warning=ExperimentalWarning
  "$root/tools/ffmpeg-wasm/core-build.ts")
hash=$("${core_build[@]}" hash)
libs_hash=$("${core_build[@]}" libs-hash)
work="$FXM_TOOLS/ffmpeg-wasm"
build="$work/builds/$hash"
libs="$work/libs/$libs_hash"
dist="$build/dist"

if [ -f "$dist/ffmpeg-core.json" ] && [ -z "${FXM_FFMPEG_REBUILD:-}" ]; then
  fxm_info "The ffmpeg core of recipe $hash is built already: $dist"
  "${core_build[@]}" check "$dist"
  exit 0
fi

platform=$(fxm_platform)
case $platform in
  linux-x64) emscripten_sha=$EMSCRIPTEN_SHA256_linux_x64 emscripten_file=wasm-binaries.tar.xz ;;
  darwin-arm64)
    emscripten_sha=$EMSCRIPTEN_SHA256_darwin_arm64 emscripten_file=wasm-binaries-arm64.tar.xz
    ;;
  *) fxm_die "no pinned Emscripten binaries for $platform: add a hash to recipe/versions.sh" ;;
esac
emscripten_os=${platform%%-*}
[ "$emscripten_os" = darwin ] && emscripten_os=mac

rm -rf "$build"
mkdir -p "$work/downloads" "$build"
log="$build/build.log"
fxm_info "Building the ffmpeg core of recipe $hash (make -j$jobs); log: $log"

# fetch <sha256> <file name> <url> [mirror …]: the file from the first URL that delivers the
# pinned SHA-256, kept for the next build. Prints its path; fails when no URL delivers it. Call it
# as `file=$(fetch …) || exit 1`: a failure inside $(…) doesn't stop the script by itself.
fetch() {
  local sha=$1 name=$2 url
  local target="$work/downloads/$name"
  shift 2
  if [ -f "$target" ] && [ "$(fxm_sha256 "$target")" = "$sha" ]; then
    echo "$target"
    return 0
  fi
  for url in "$@"; do
    [ -n "$url" ] || continue
    if fxm_curl "$url" "$target.part" && [ "$(fxm_sha256 "$target.part")" = "$sha" ]; then
      mv "$target.part" "$target"
      echo "$target"
      return 0
    fi
    rm -f "$target.part"
    fxm_warn "$name: $url didn't deliver the pinned file"
  done
  fxm_die "$name: no source delivered the file with SHA-256 $sha"
}

# --- emsdk -------------------------------------------------------------------------------
emsdk="$FXM_TOOLS/emsdk/$EMSDK_VERSION"
if [ ! -f "$emsdk/.fxm-installed-$EMSCRIPTEN_RELEASE" ]; then
  fxm_info "Installing emsdk $EMSDK_VERSION into $emsdk"
  rm -rf "$emsdk"
  mkdir -p "$emsdk"
  archive=$(fetch "$EMSDK_SHA256" "emsdk-$EMSDK_VERSION.tar.gz" "$EMSDK_URL") || exit 1
  tar -xzf "$archive" -C "$emsdk" --strip-components=1
  # The release emsdk names for this version must be the one whose binaries are pinned.
  named=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["releases"][sys.argv[2]])' \
    "$emsdk/emscripten-releases-tags.json" "$EMSDK_VERSION")
  [ "$named" = "$EMSCRIPTEN_RELEASE" ] ||
    fxm_die "emsdk $EMSDK_VERSION installs release $named, but versions.sh pins $EMSCRIPTEN_RELEASE"
  # emsdk downloads nothing its downloads/ folder holds already (EMSDK_KEEP_DOWNLOADS), so the
  # checked archive goes there first and emsdk only unpacks it.
  mkdir -p "$emsdk/downloads"
  archive=$(fetch "$emscripten_sha" "emscripten-$EMSDK_VERSION-$platform.tar.xz" \
    "$EMSCRIPTEN_URL_BASE/$emscripten_os/$EMSCRIPTEN_RELEASE/$emscripten_file") || exit 1
  cp "$archive" "$emsdk/downloads/$EMSCRIPTEN_RELEASE-$emscripten_file"
  # Only the toolchain: Node comes from the checkout's environment, not from emsdk.
  (cd "$emsdk" && EMSDK_KEEP_DOWNLOADS=1 python3 ./emsdk.py install "releases-$EMSCRIPTEN_RELEASE-64bit" &&
    python3 ./emsdk.py activate "releases-$EMSCRIPTEN_RELEASE-64bit") >>"$log" 2>&1 ||
    fxm_die "emsdk failed; see $log"
  rm -rf "$emsdk/downloads"
  touch "$emsdk/.fxm-installed-$EMSCRIPTEN_RELEASE"
fi
export EMSDK_QUIET=1
# shellcheck source=/dev/null
source "$emsdk/emsdk_env.sh" >>"$log" 2>&1
EM_NODE_JS=$(command -v node)
export EM_NODE_JS
command -v emcc >/dev/null || fxm_die "emcc is missing after activating emsdk; see $log"
fxm_info "Emscripten: $(emcc --version | head -1)"

# --- the libraries -----------------------------------------------------------------------
if [ -f "$libs/.complete" ] && [ -z "${FXM_FFMPEG_REBUILD:-}" ]; then
  fxm_info "Reusing the libraries in $libs"
else
  # shellcheck source=libs.sh
  source "$recipe/libs.sh"
fi
ffmpeg_license=$(sed -n 's/^#define FFMPEG_LICENSE "\(.*\)"$/\1/p' "$libs/ffmpeg-config.h")
configure_line=$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$libs/ffmpeg-config.h")

# --- the core ----------------------------------------------------------------------------
# Exported: FXM's entry points (fxm_convert.c) and what core.ts calls them with. No eval in
# the glue (DYNAMIC_EXECUTION=0): the app's policy allows 'wasm-unsafe-eval', never
# 'unsafe-eval'. WORKERFS lets the worker read the input from a Blob without copying it. The
# glue reads only the module options core.ts passes (INCOMING_MODULE_JS_API): instantiateWasm,
# through which core.ts instantiates the very bytes it checked against the manifest (the glue
# never fetches the WebAssembly itself), and print and printErr. The linker lists every object it
# takes from an archive (--why-extract, which leaves the output as it is), for the licences below.
fxm_info "Linking the core"
mkdir -p "$dist"
cp "$recipe/fxm_convert.c" "$build/fxm_convert.c"
(
  cd "$build" &&
    emcc -O3 fxm_convert.c -o dist/ffmpeg-core.js -Wl,--why-extract=linked.tsv \
      -I"$libs/stage/usr/include" -L"$libs/stage/usr/lib" -L"$libs/prefix/lib" \
      -lavformat -lavcodec -lswresample -lavutil -lmp3lame -lopus -lm \
      --no-entry -lworkerfs.js \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFfmpegCore \
      -sENVIRONMENT=worker,node -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2 \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB \
      -sABORTING_MALLOC=0 -sFORCE_FILESYSTEM=1 \
      -sNODEJS_CATCH_EXIT=0 -sNODEJS_CATCH_REJECTION=0 \
      -sINCOMING_MODULE_JS_API=instantiateWasm,print,printErr \
      -sEXPORTED_FUNCTIONS=_fxm_convert,_fxm_probe,_fxm_version,_fxm_last_error,_fxm_log \
      -sEXPORTED_RUNTIME_METHODS=FS,ccall,UTF8ToString
) >>"$log" 2>&1 || fxm_die "Linking the core failed; see $log"

# The core must not carry this machine's paths (FFmpeg keeps its configure line in it).
for file in "$dist/ffmpeg-core.js" "$dist/ffmpeg-core.wasm"; do
  if LC_ALL=C grep -q -F -e "$work" -e "$HOME" "$file"; then
    fxm_die "$(basename "$file") contains a path of this machine"
  fi
done

# --- the licences ------------------------------------------------------------------------
# The texts the core's notice must carry in full (core-build.ts, CORE_LICENSE_TEXTS): FFmpeg's,
# LAME's and Opus's from their checked tarballs, and those of Emscripten's runtime and C library
# (musl), which are linked in too, from the pinned emsdk. compiler-rt's builtins (Apache-2.0
# with the LLVM exception, which asks nothing of compiled code) and dlmalloc (public domain) need
# none.
fxm_info "Collecting the licences"
licenses="$dist/licenses"
mkdir -p "$licenses"
# license_from <archive> <member> <file in licenses/>
license_from() {
  if ! tar -xOf "$1" "$2" >"$licenses/$3" || [ ! -s "$licenses/$3" ]; then
    fxm_die "no $2 in $(basename "$1")"
  fi
}
ffmpeg_tarball=$(fetch "$FFMPEG_SHA256" "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_URL" "$FFMPEG_MIRROR") || exit 1
license_from "$ffmpeg_tarball" "ffmpeg-$FFMPEG_VERSION/LICENSE.md" FFmpeg-LICENSE.md.txt
license_from "$ffmpeg_tarball" "ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" FFmpeg-COPYING.LGPLv2.1.txt
lame_tarball=$(fetch "$LAME_SHA256" "lame-$LAME_VERSION.tar.gz" "$LAME_URL" "$LAME_MIRROR") || exit 1
license_from "$lame_tarball" "lame-$LAME_VERSION/LICENSE" LAME-LICENSE.txt
license_from "$lame_tarball" "lame-$LAME_VERSION/COPYING" LAME-COPYING.txt
opus_tarball=$(fetch "$OPUS_SHA256" "opus-$OPUS_VERSION.tar.gz" "$OPUS_URL") || exit 1
license_from "$opus_tarball" "opus-$OPUS_VERSION/COPYING" Opus-COPYING.txt
emscripten="$emsdk/upstream/emscripten"
cp "$emscripten/LICENSE" "$licenses/Emscripten-LICENSE.txt"
cp "$emscripten/system/lib/libc/musl/COPYRIGHT" "$licenses/musl-COPYRIGHT.txt"

# The licences of every file the linker took into the core, read from the sources the libraries
# were built from: the notices that the texts above don't carry (FFmpeg's MIT and BSD files, such
# as its Ogg demuxer, and Opus's BSD files, with their copyright lines) go into
# linked-notices.txt, and a file under the GPL or a licence it doesn't know stops the build.
fxm_info "Reading the licences of the linked files"
node --experimental-strip-types --disable-warning=ExperimentalWarning "$recipe/linked-licences.ts" \
  "$build/linked.tsv" "$libs" "$emsdk" "$licenses/linked-notices.txt" ||
  fxm_die "The files linked into the core need a decision about their licences (above)"

# --- the source --------------------------------------------------------------------------
# What the LGPL asks to come with the core: the tarballs it was built from, exactly as checked
# above, and FXM's recipe, which builds the core from them and links FXM's converter with them
# (source-archive.ts). make dist serves them next to the core, and every release attaches them
# (tools/ffmpeg-wasm/README.md, "The LGPL").
fxm_info "Collecting the source"
mkdir -p "$dist/source"
cp "$ffmpeg_tarball" "$lame_tarball" "$opus_tarball" "$dist/source/"
node --experimental-strip-types --disable-warning=ExperimentalWarning "$recipe/source-archive.ts" \
  "$dist/source/fxm-ffmpeg-core-recipe.tar" "$root" || fxm_die "Couldn't archive the recipe"

"${core_build[@]}" manifest "$dist" \
  --recipe-hash "$hash" \
  --license "$ffmpeg_license" \
  --configure "$configure_line" \
  --emscripten "$EMSDK_VERSION"
"${core_build[@]}" check "$dist"
fxm_info "Built the ffmpeg core: $dist"
