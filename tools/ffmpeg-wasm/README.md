# FXM's ffmpeg core

The web app saves downloads in other formats (stage 4.2, "Save to device") with its own build of FFmpeg for WebAssembly: **LGPL, audio only, about 2.4 MiB**. This folder is its recipe and the tools around it. The conversion code that uses it is [`packages/convert`](../../packages/convert/README.md).

Why FXM builds its own:

- The stock `@ffmpeg/core` 0.12.10 is **GPL-2.0-or-later** and its wasm file is 30.7 MiB, over Cloudflare Pages' **25 MiB** limit per file (ARCHITECTURE.md §3, §17). Loading it from a CDN would also break the no-third-party-scripts rule.
- **No `ffmpeg` command-line tool inside.** Since FFmpeg 7 the CLI needs threads, and threads in WebAssembly need `SharedArrayBuffer`, which only a cross-origin isolated page gets (COOP and COEP headers). Isolation would block the covers and media FXM loads from other sites. So `recipe/fxm_convert.c` calls FFmpeg's libraries itself: one input, its best audio stream, one output, copied (a remux) or decoded, resampled and encoded.

## What it is

Three files, served together from the app's `ffmpeg/` folder (`/app/ffmpeg/` on the site):

| File | What it is |
|---|---|
| `ffmpeg-core.wasm` | FFmpeg's libraries with LAME and Opus, and FXM's converter, compiled with Emscripten |
| `ffmpeg-core.js` | Emscripten's module factory (ES module, no `eval`: `-sDYNAMIC_EXECUTION=0`) |
| `ffmpeg-core.json` | The manifest: the recipe's hash, FFmpeg's licence and configure line, every part with its source and SHA-256, and each file's size and SHA-256 |

| Part | Version | Licence | Source |
|---|---|---|---|
| FFmpeg (libavformat, libavcodec, libswresample, libavutil) | 9.0.2 | LGPL-2.1-or-later | `ffmpeg.org/releases`, SHA-256 pinned |
| LAME (MP3 encoder) | 4.0 | LGPL-2.0-or-later | `downloads.sourceforge.net/project/lame`, SHA-256 pinned |
| Opus (`libopus` encoder) | 1.6.1 | BSD-3-Clause | `downloads.xiph.org/releases/opus`, SHA-256 pinned |
| FXM's converter (`recipe/fxm_convert.c`) | | Apache-2.0 | this repository |

FFmpeg is configured with `--disable-gpl --disable-nonfree --disable-autodetect --disable-everything`, then only what FXM's formats need:

| Kind | Enabled |
|---|---|
| Demuxers (what it reads) | WebM/Matroska, MP4/M4A, MP3, Ogg, FLAC, WAV, ADTS AAC |
| Decoders | Opus, AAC, MP3, Vorbis, FLAC, ALAC, PCM (16, 24, 32-bit, float, unsigned 8-bit) |
| Encoders | FLAC, ALAC, PCM (16, 24, 32-bit), MP3 (`libmp3lame`), AAC (FFmpeg's own), Opus (`libopus`) |
| Muxers (what it writes) | FLAC, M4A (`ipod`), WAV, MP3, Ogg, WebM |
| Parsers, protocols | AAC, FLAC, MPEG audio, Opus, Vorbis; `file` |

No video codec, filter, device, network protocol or thread is in it.

## Building

```sh
make ffmpeg-wasm        # tools/ffmpeg-wasm/recipe/build.sh
make ffmpeg-wasm-check  # under 25 MiB, LGPL, the files its manifest names, the current recipe
make ffmpeg-wasm-test   # every format, end to end, on generated sine waves
```

The first build installs emsdk and builds Opus, LAME and FFmpeg: 10 to 15 minutes with the default of two parallel jobs (`FXM_FFMPEG_JOBS`, kept low because the machine is shared), less on CI's four. Everything goes into `.tools/` of the main checkout, so `make nuke` removes it:

| What | Where |
|---|---|
| emsdk 6.0.12 and Emscripten | `.tools/emsdk/6.0.12/` (about 1 GB) |
| The source tarballs, checked by SHA-256 | `.tools/ffmpeg-wasm/downloads/` |
| The built libraries | `.tools/ffmpeg-wasm/libs/<libraries hash>/` |
| The core, with its build log | `.tools/ffmpeg-wasm/builds/<recipe hash>/dist/` |

Builds are keyed by hashes (`core-build.ts`): the core by every file in `recipe/`, the libraries by `versions.sh`, `libs.sh` and `pkg-config.sh` only, so a change to the converter links again in seconds. A finished build is reused until its recipe changes; `FXM_FFMPEG_REBUILD=1` builds everything again. Builds of older recipes stay until you delete them (worktrees share `.tools/`, and another may still use one): remove their folders under `builds/` and `libs/`, or everything with `make nuke`. Two builds from scratch on the same machine gave byte-identical files, and CI's Linux build differs from a macOS build in one byte of the wasm: a floating-point constant, one unit in the last place apart, which the compiler folds with the host's maths library (2026-10-26). So compare a local build with the deployed core on the same operating system as CI's, Linux x64. Emscripten's binaries are pinned for Linux x64 (CI) and macOS on Apple silicon; add a hash in `versions.sh` to build elsewhere. It needs `python3`, `make`, `tar` and Node from the checkout's environment, nothing installed globally.

Each tarball comes from its project's release URL; FFmpeg's and LAME's also from Debian's identical copy on snapshot.debian.org, tried when the first fails (SourceForge is not always up). The SHA-256 decides, wherever the file came from.

The build fails when:

- no source delivers a download with its pinned SHA-256;
- emsdk's release table names another Emscripten build than the pinned one;
- FFmpeg's configure reports a licence other than LGPL (`FFMPEG_LICENSE` in its `config.h`), or `CONFIG_GPL` or `CONFIG_NONFREE` isn't 0;
- the wasm or JS file contains a path of the build machine (FFmpeg keeps its configure line in the library, so every path in it is relative);
- `make ffmpeg-wasm-check` fails: the wasm is 25 MiB or larger, or anything above.

At run time the worker refuses the core unless the wasm matches the manifest's SHA-256 and the libraries themselves report an LGPL licence (`avcodec_license()`, through `fxm_version`).

## CI and the deploy

`.github/workflows/ffmpeg-wasm.yml` builds, checks and tests the core, cached by the recipe's hash, so it only builds when the recipe changes. `deploy.yml` calls it on every push and hands the core to `make dist`, which ships it at `/app/ffmpeg/` with its entry in `third-party-notices.txt` and fails without it in CI. A release's web zip (`fxm-web-<version>.zip`, which is `make dist`'s folder) has it too: `release.yml` builds and tests the core in its bundles job, from scratch and without caches like everything a release ships, before `scripts/release-build.sh`. Locally, `make dist` ships the core when one is built and otherwise composes a site that can't convert, and says so (scripts/build-dist/README.md). `make check` never builds or needs it: the code that uses the core is tested against a fake, and the real core only in `make ffmpeg-wasm-test` and CI.

`make dev` and `vite preview` serve the local build at the app's `ffmpeg/` path (`dev-server.ts`), so Save to device converts there too.

## The LGPL

- The core is a **separate, replaceable file**. To use your own FFmpeg (a newer release, a patched one), change `recipe/versions.sh` or add a patch step, run `make ffmpeg-wasm`, and put the three files of `dist/` into the app's `ffmpeg/` folder. The app checks the wasm against the manifest that comes with it, so replace all three.
- `third-party-notices.txt` names every part, its licence, source URL and SHA-256, FFmpeg's configure line and the patches (none), and says how to replace the core. LAME asks to be acknowledged with a link to its site, which the notice does.
- Nothing GPL or non-free can get in: the configure flags, the build's licence check, `make ffmpeg-wasm-check` and `make dist`'s check of the manifest refuse it.

## The converter's interface

`fxm_convert(input, output, options)` returns 0 or a negative FFmpeg error code, with `fxm_last_error()` and `fxm_log()` saying what failed. `options` is one `key=value` per line, values percent-encoded (`%0A` for a line break):

| Key | Value |
|---|---|
| `format` | The muxer: `flac`, `ipod` (M4A), `wav`, `mp3`, `ogg`, `webm` |
| `codec` | An encoder (`flac`, `alac`, `libmp3lame`, `aac`, `libopus`), `copy` (remux), or `pcm` (WAV that keeps the source's 16, 24 or 32 bits) |
| `bitrate` | Bits per second, for lossy encoders |
| `compression_level` | For FLAC |
| `metadata.<key>` | A container tag; FXM uses it only for WebM, whose tags only a muxer writes |

Lossless encoders keep the source's depth (a 24-bit FLAC stays 24-bit in ALAC or WAV); lossy encoders get float samples; the sample rate is kept where the encoder allows it (Opus always gets 48 kHz); a channel layout the encoder can't take becomes stereo; float audio becomes 16-bit with triangular dither. `fxm_probe(input)` describes an input's best audio stream as JSON, and `fxm_version()` the build. `packages/convert/src/core.ts` wraps all of it.

## Upgrading

1. Pick releases at least 14 days old (the rule pnpm and Dependabot follow).
2. Download each tarball, compute its SHA-256, and check it against an independent source: a distribution that verified the release (FreeBSD ports' `distinfo`, Debian's `.orig` tarballs on snapshot.debian.org) or the project's own checksum file. Record how in `versions.sh`, and point the `*_MIRROR` at Debian's copy when it is the same file.
3. For emsdk, take the tag's GitHub archive, read the release hash for that version from its `emscripten-releases-tags.json`, and hash the `wasm-binaries` archives for each pinned platform.
4. `make ffmpeg-wasm && make ffmpeg-wasm-test`. FFmpeg's API changes between major versions show up when `fxm_convert.c` compiles.

## Files

| File | What it does |
|---|---|
| `recipe/versions.sh` | Every version, URL and SHA-256, and how each hash was checked |
| `recipe/build.sh` | emsdk, then the libraries (`libs.sh`), then the link, the path check, the manifest and the checks |
| `recipe/libs.sh` | Opus, LAME and FFmpeg, configured for WebAssembly |
| `recipe/pkg-config.sh` | A minimal `pkg-config` that answers from the build's own prefix (macOS has none; FFmpeg finds libopus only through it) |
| `recipe/fxm_convert.c` | The converter: the core's entry points |
| `core-build.ts` | The recipe's hashes, where builds live, the manifest, the checks and the notice; a CLI for `build.sh`, CI and `make` |
| `dev-server.ts` | Serves the local build on Vite's dev and preview servers |
