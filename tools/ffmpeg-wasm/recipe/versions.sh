# shellcheck shell=bash
# What FXM's ffmpeg core is built from (tools/ffmpeg-wasm/README.md). Every download is pinned
# by its SHA-256 and checked before use, and every version was public for at least 14 days when
# it was pinned (the rule pnpm and Dependabot follow, docs/DEVELOPMENT.md).
#
# How the hashes were checked (2026-10-26):
# - FFmpeg 9.0.2: matches FreeBSD ports (multimedia/ffmpeg/distinfo, SHA-256) and Debian's
#   ffmpeg_9.0.2.orig.tar.xz (snapshot.debian.org, SHA-1), both of which verify FFmpeg's
#   release signature. Released 2026-09-18.
# - LAME 4.0: matches FreeBSD ports (audio/lame/distinfo) and Debian's lame_4.0.orig.tar.gz
#   (snapshot.debian.org, SHA-1). Released 2026-07-11. 3.100 no longer builds with current Clang
#   (its UTF-8 ID3 functions), which 4.0 fixes.
# - Opus 1.6.1: matches xiph.org's SHA256SUMS.txt and FreeBSD ports (audio/opus/distinfo).
#   Released 2026-01-15.
# - emsdk 6.0.12: GitHub's archive of the tag (commit 35ff8a6d150541276abbc6bae512ca90bcfbe220,
#   2026-10-08). Its emscripten-releases-tags.json names the release below, and build.sh checks
#   that it still does.
# - Emscripten 6.0.12's binaries: downloaded from the URL emsdk uses and hashed here. Only the
#   platforms below are pinned; add a hash to build on another.
#
# Each *_MIRROR is the same file elsewhere, tried when the first URL fails: Debian's copy of the
# upstream tarball on snapshot.debian.org, whose addresses never change. The SHA-256 decides.
#
# Changing anything here, in build.sh, pkg-config.sh or fxm_convert.c changes the recipe's hash
# (core-build.ts), so CI builds a new core instead of using its cached one.

FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_MIRROR="https://snapshot.debian.org/archive/debian/20260919T203403Z/pool/main/f/ffmpeg/ffmpeg_${FFMPEG_VERSION}.orig.tar.xz"
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

LAME_VERSION=4.0
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_MIRROR="https://snapshot.debian.org/archive/debian/20260723T143410Z/pool/main/l/lame/lame_${LAME_VERSION}.orig.tar.gz"
LAME_SHA256=3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb

OPUS_VERSION=1.6.1
OPUS_URL="https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz"
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1

EMSDK_VERSION=6.0.12
EMSDK_URL="https://github.com/emscripten-core/emsdk/archive/refs/tags/${EMSDK_VERSION}.tar.gz"
EMSDK_SHA256=4dd39842a0e2cbe3b829879575fbb3fa702b224a5fd4b898c4768c00354224f9

# The emscripten-releases build that emsdk installs for EMSDK_VERSION, and its binaries per
# platform (fxm_platform in scripts/lib.sh).
EMSCRIPTEN_RELEASE=6e9f6885cb17a3d6c8fd488a5cff730f50aba61d
EMSCRIPTEN_URL_BASE="https://storage.googleapis.com/webassembly/emscripten-releases-builds"
EMSCRIPTEN_SHA256_linux_x64=7b073a102b07eca5a0fe344037681e53162639f3540432456874c0446a5e8fa7
EMSCRIPTEN_SHA256_darwin_arm64=8e91c0eca2b8728aa2babb32b805318eaf5e8d6652c6535163d0ea467a6d907c
