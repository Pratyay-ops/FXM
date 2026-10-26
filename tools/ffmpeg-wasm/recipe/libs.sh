# shellcheck shell=bash
# Builds the core's libraries into $libs (sourced by build.sh, which sets recipe, libs, jobs,
# log and the Emscripten environment): Opus, LAME, then FFmpeg against them. A finished build
# is reused until versions.sh, this file or pkg-config.sh changes (core-build.ts libs-hash).
#
#   $libs/src/     the unpacked sources, built in place
#   $libs/prefix/  Opus and LAME, installed
#   $libs/stage/   FFmpeg, installed (make install DESTDIR=…)
#   $libs/ffmpeg-config.h   FFmpeg's config.h, for the licence and the configure line

rm -rf "$libs"
mkdir -p "$libs/src" "$libs/prefix" "$libs/tools"

# unpack <sha256> <file name> <url> [mirror]: a checked tarball, unpacked into src/.
unpack() {
  local archive
  archive=$(fetch "$@") || exit 1
  tar -xf "$archive" -C "$libs/src"
}
unpack "$FFMPEG_SHA256" "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_URL" "$FFMPEG_MIRROR"
unpack "$LAME_SHA256" "lame-$LAME_VERSION.tar.gz" "$LAME_URL" "$LAME_MIRROR"
unpack "$OPUS_SHA256" "opus-$OPUS_VERSION.tar.gz" "$OPUS_URL"

prefix="$libs/prefix"
# The pkg-config that answers from the build's own prefix only (see pkg-config.sh).
cp "$recipe/pkg-config.sh" "$libs/tools/pkg-config"
chmod +x "$libs/tools/pkg-config"
export PATH="$libs/tools:$PATH"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
unset PKG_CONFIG_PATH PKG_CONFIG_SYSROOT_DIR

# Built paths stay out of the binaries: every source is compiled by a relative path, and
# build.sh checks the result.

# --- Opus (BSD-3-Clause) -----------------------------------------------------------------
fxm_info "Opus $OPUS_VERSION"
# Each step is chained with &&: `set -e` doesn't apply inside a ( … ) that || tests.
(
  cd "$libs/src/opus-$OPUS_VERSION" &&
    emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$prefix" \
      --enable-static --disable-shared --disable-doc --disable-extra-programs \
      --disable-asm --disable-rtcd --disable-intrinsics --disable-stack-protector \
      --disable-hardening CFLAGS=-O3 &&
    emmake make -j"$jobs" &&
    emmake make install
) >>"$log" 2>&1 || fxm_die "Opus failed to build; see $log"

# --- LAME (LGPL-2.0-or-later) ------------------------------------------------------------
# Its config.sub predates Emscripten, so it gets a generic 32-bit host; emconfigure supplies
# the compiler. No SSE: Emscripten's headers refuse it without -msse.
fxm_info "LAME $LAME_VERSION"
(
  cd "$libs/src/lame-$LAME_VERSION" &&
    emconfigure ./configure --host=i686-pc-linux-gnu --prefix="$prefix" \
      --enable-static --disable-shared --disable-frontend --disable-decoder \
      --disable-analyzer-hooks --disable-gtktest --disable-cpml --disable-dependency-tracking \
      --disable-rpath ac_cv_header_xmmintrin_h=no CFLAGS=-O3 &&
    emmake make -j"$jobs" &&
    emmake make install
) >>"$log" 2>&1 || fxm_die "LAME failed to build; see $log"

# --- FFmpeg (LGPL-2.1-or-later) ----------------------------------------------------------
# Every component is off (--disable-everything) except what FXM's formats need: the WebM,
# MP4/M4A, MP3, Ogg, FLAC, WAV and AAC demuxers, the muxers FXM writes, their decoders, and the
# FLAC, ALAC, PCM, MP3 (LAME), AAC and Opus (libopus) encoders. No GPL or non-free part can be
# enabled (--disable-gpl --disable-nonfree), and configure must report an LGPL licence below.
# Paths in these flags are relative, because FFmpeg keeps its configure line in the binary.
ffmpeg_flags=(
  --prefix=/usr
  --target-os=none --arch=wasm --enable-cross-compile
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm
  --disable-gpl --disable-nonfree --disable-autodetect --disable-everything
  --disable-programs --disable-doc --disable-debug --disable-stripping
  --disable-avdevice --disable-avfilter --disable-swscale --disable-network
  --disable-pthreads --disable-w32threads --disable-os2threads
  --disable-asm --disable-inline-asm --disable-runtime-cpudetect
  --enable-swresample --enable-libmp3lame --enable-libopus
  --enable-protocol=file
  --enable-demuxer=matroska,mov,mp3,ogg,flac,wav,aac
  --enable-muxer=flac,ipod,wav,mp3,ogg,webm
  --enable-decoder=opus,aac,mp3,mp3float,vorbis,flac,alac
  --enable-decoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8
  --enable-encoder=flac,alac,pcm_s16le,pcm_s24le,pcm_s32le,libmp3lame,aac,libopus
  --enable-parser=aac,flac,mpegaudio,opus,vorbis
  --extra-cflags=-I../../prefix/include
  --extra-ldflags=-L../../prefix/lib
)
fxm_info "FFmpeg $FFMPEG_VERSION"
ffmpeg_src="$libs/src/ffmpeg-$FFMPEG_VERSION"
(
  # The relative paths above are relative to this folder: src/ffmpeg-x → ../../prefix.
  cd "$ffmpeg_src" && ./configure "${ffmpeg_flags[@]}"
) >>"$log" 2>&1 || fxm_die "FFmpeg's configure failed; see $log and $ffmpeg_src/ffbuild/config.log"
cp "$ffmpeg_src/config.h" "$libs/ffmpeg-config.h"
ffmpeg_license=$(sed -n 's/^#define FFMPEG_LICENSE "\(.*\)"$/\1/p' "$libs/ffmpeg-config.h")
case $ffmpeg_license in
  "LGPL version 2.1 or later" | "LGPL version 3 or later") fxm_info "FFmpeg's licence: $ffmpeg_license" ;;
  *) fxm_die "FFmpeg's configure reports the licence \"$ffmpeg_license\", not LGPL: refusing to build" ;;
esac
for flag in CONFIG_GPL CONFIG_NONFREE; do
  grep -q "^#define $flag 0$" "$libs/ffmpeg-config.h" || fxm_die "FFmpeg's config.h doesn't say $flag 0"
done
(
  cd "$ffmpeg_src" && emmake make -j"$jobs" && emmake make install DESTDIR="$libs/stage"
) >>"$log" 2>&1 || fxm_die "FFmpeg failed to build; see $log"
touch "$libs/.complete"
