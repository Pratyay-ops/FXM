# FXM's ffmpeg core

The web app saves downloads in other formats (stage 4.2, "Save to device") with its own build of FFmpeg for WebAssembly: **LGPL, audio only, about 2.4 MiB**. This folder is its recipe and the tools around it. The conversion code that uses it is [`packages/convert`](../../packages/convert/README.md).

Why FXM builds its own:

- The stock `@ffmpeg/core` 0.12.10 is **GPL-2.0-or-later** and its wasm file is 30.7 MiB, over Cloudflare Pages' **25 MiB** limit per file (ARCHITECTURE.md §3, §17). Loading it from a CDN would also break the no-third-party-scripts rule.
- **No `ffmpeg` command-line tool inside.** Since FFmpeg 7 the CLI needs threads, and threads in WebAssembly need `SharedArrayBuffer`, which only a cross-origin isolated page gets (COOP and COEP headers). Isolation would block the covers and media FXM loads from other sites. So `recipe/fxm_convert.c` calls FFmpeg's libraries itself: one input, its best audio stream, one output, copied (a remux) or decoded, resampled and encoded.

## What it is

Three files and the licence texts, served together from the app's `ffmpeg/` folder (`/app/ffmpeg/` on the site), and the core's source, served at `/source/ffmpeg-core/`:

| File | What it is |
|---|---|
| `ffmpeg-core.wasm` | FFmpeg's libraries with LAME and Opus, and FXM's converter, compiled with Emscripten |
| `ffmpeg-core.js` | Emscripten's module factory (ES module, no `eval`: `-sDYNAMIC_EXECUTION=0`) |
| `ffmpeg-core.json` | The manifest: the recipe's hash, FFmpeg's licence and configure line, every part with its source and SHA-256, each file's size and SHA-256, and those of the source files |
| `licenses/` | The licence texts of the parts inside, copied by `build.sh` from the checked tarballs and emsdk: FFmpeg's `LICENSE.md` and `COPYING.LGPLv2.1`, LAME's `LICENSE` and `COPYING`, Opus's `COPYING`, Emscripten's `LICENSE` and musl's `COPYRIGHT` (`CORE_LICENSE_TEXTS` in `core-build.ts`); and `linked-notices.txt`, the parts' copyright lines and the notices of the linked files under licences of their own (below) |
| `source/` | The source the LGPL asks to come with the core: the tarballs of FFmpeg, LAME and Opus exactly as `build.sh` checked them (each under its release URL's name), and `fxm-ffmpeg-core-recipe.tar`, this folder with `scripts/env.sh` and `scripts/lib.sh`, which `build.sh` runs, FXM's `LICENSE` and `.nvmrc` (`recipe/source-archive.ts`: a ustar archive with sorted entries, all dated 1980-01-01, the same bytes on every machine). About 24 MB in all, each file under 25 MiB. `make dist` serves this folder at `/source/ffmpeg-core/`, outside the app, where its service worker would answer a page's request with the app |

| Part | Version | Licence | Source |
|---|---|---|---|
| FFmpeg (libavformat, libavcodec, libswresample, libavutil) | 9.0.2 | LGPL-2.1-or-later | `ffmpeg.org/releases`, SHA-256 pinned |
| LAME (MP3 encoder) | 4.0 | LGPL-2.0-or-later | `downloads.sourceforge.net/project/lame`, SHA-256 pinned |
| Opus (`libopus` encoder) | 1.6.1 | BSD-3-Clause | `downloads.xiph.org/releases/opus`, SHA-256 pinned |
| FXM's converter (`recipe/fxm_convert.c`) | | Apache-2.0 | this repository |
| Emscripten's runtime: the JavaScript glue and the C library (musl) | 6.0.12 | MIT (Emscripten also offers NCSA) | the pinned emsdk |

compiler-rt's builtins (Apache-2.0 with the LLVM exception, which asks nothing of compiled code) and dlmalloc (public domain) are linked in too.

Not every file of those parts is under its part's licence, so `build.sh` reads the licence of each file that goes in (`recipe/linked-licences.ts`). The linker lists every object it takes from an archive (`--why-extract`, which leaves the output as it is); each object's dependency file names the source and the headers it was compiled from (FFmpeg's `.d`, Opus's `.deps/*.Plo`; LAME keeps none, so its local includes are followed), and their comments state their licences. What it found on 2026-10-26, for FFmpeg 9.0.2, LAME 4.0 and Opus 1.6.1 as `libs.sh` configures them, in 381 objects and 804 files:

- **FFmpeg's Ogg demuxer is under the MIT licence**: `libavformat/oggdec.c`, `oggparseogm.c`, `oggparsevorbis.c`, `oggparsespeex.c` and `oggparsetheora.c` (Michael Ahlberg and Måns Rullgård, Reimar Döffinger, Matthieu Castet and Alex Beregszaszi). FLAC and Matroska take `oggparsevorbis.c` too, so it stays with any of them. So is `libavutil/avsscanf.c`, musl's code (Rich Felker, et al.).
- Two of FFmpeg's headers carry MIPS Technologies' BSD licence next to the LGPL (`libavutil/fixed_dsp.h`, `softfloat_tables.h`), and `libavutil/sha.c` says its SHA-2 code comes from Aaron D. Gifford's BSD-licensed code.
- **Opus's files** are under its BSD licences, some with copyright holders that its `COPYING` doesn't name (Arm, Koen Vos, Parrot, Vidyo).
- LAME's `libmp3lame/fft.c`, Ron Mayer's FFT, says it derives from a routine of his under the GPL, that he would let anyone do whatever they want with it, and asks for a credit. LAME has distributed it under its LGPL since 1999; a person read it, and `REVIEWED` in `linked-licences.ts` records that the notice gives the credit.
- Everything else is LGPL, states no licence (its part's applies), or is under a licence that asks nothing of binaries: the Boost licence of an algorithm in `libavutil/mathematics.c` and `libm.h`, and public domain. FFmpeg's libjpeg DCTs, which ask for a credit, are video code that never goes in.

`licenses/linked-notices.txt` carries FFmpeg's and LAME's copyright lines, then every MIT, BSD, ISC or IJG notice of those files as its source states it, grouped by licence text with every copyright holder and the files it covers, then the credits files ask for. It comes from the checked sources of each build, so an upgrade's notices are always the upgrade's.

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
| The core and its licence texts, with its build log | `.tools/ffmpeg-wasm/builds/<recipe hash>/dist/` |

Builds are keyed by hashes (`core-build.ts`): the core by every file in `recipe/`, the libraries by `versions.sh`, `libs.sh` and `pkg-config.sh` only, so a change to the converter links again in seconds. A finished build is reused until its recipe changes; `FXM_FFMPEG_REBUILD=1` builds everything again. Builds of older recipes stay until you delete them (worktrees share `.tools/`, and another may still use one): remove their folders under `builds/` and `libs/`, or everything with `make nuke`. Two builds from scratch on the same machine gave byte-identical files, and CI's Linux build differs from a macOS build in one byte of the wasm: a floating-point constant, one unit in the last place apart, which the compiler folds with the host's maths library (2026-10-26). So compare a local build with the deployed core on the same operating system as CI's, Linux x64. Emscripten's binaries are pinned for Linux x64 (CI) and macOS on Apple silicon; add a hash in `versions.sh` to build elsewhere. It needs `python3`, `make`, `tar` and Node from the checkout's environment, nothing installed globally.

Each tarball comes from its project's release URL; FFmpeg's and LAME's also from Debian's identical copy on snapshot.debian.org, tried when the first fails (SourceForge is not always up). The SHA-256 decides, wherever the file came from.

The build fails when:

- no source delivers a download with its pinned SHA-256;
- emsdk's release table names another Emscripten build than the pinned one;
- a file linked into the core states the GPL or a licence `linked-licences.ts` doesn't know, a statement a person reviewed (`REVIEWED`) has changed, or the core links an archive that is neither FFmpeg's, LAME's, Opus's nor one of the Emscripten libraries the notice credits;
- FFmpeg's configure reports a licence other than LGPL (`FFMPEG_LICENSE` in its `config.h`), or `CONFIG_GPL` or `CONFIG_NONFREE` isn't 0;
- the wasm or JS file contains a path of the build machine (FFmpeg keeps its configure line in the library, so every path in it is relative);
- a licence text is missing from its tarball or from emsdk;
- `make ffmpeg-wasm-check` fails: the wasm or a source file is 25 MiB or larger, a licence text or a source file is missing or isn't the file the manifest names, a tarball isn't the one `versions.sh` pins, or anything above.

At run time the worker refuses the core unless the wasm matches the manifest's SHA-256 and the libraries themselves report an LGPL licence (`avcodec_license()`, through `fxm_version`). The bytes it checked are the bytes that run: the glue reads only the module options `instantiateWasm`, `print` and `printErr` (`-sINCOMING_MODULE_JS_API`), and the worker instantiates the WebAssembly itself through `instantiateWasm`, so the glue never fetches the file on its own. Emscripten 6 no longer reads `wasmBinary` unless a build lists it, and an optimised build says nothing about an option it ignores.

## CI and the deploy

`.github/workflows/ffmpeg-wasm.yml` builds, checks and tests the core, cached by the recipe's hash (about 27 MB with its source). GitHub scopes caches to their branch: a run reads its own branch's caches and `main`'s, never `develop`'s. So each branch builds a recipe's core once (about 4 minutes on CI) until `main` holds its cache, and later runs of that branch take it from the cache. emsdk, the tarballs and the built libraries (about 800 MB) are restored wherever `main` saved them and saved from `main` only, so stage branches don't crowd the repository's other caches out. `deploy.yml` calls it on every push and hands the core to `make dist`, which ships it at `/app/ffmpeg/` and its source at `/source/ffmpeg-core/`, with its entry in `third-party-notices.txt`, and fails without it in CI. A release's web zip (`fxm-web-<version>.zip`, which is `make dist`'s folder) has both too, and the release attaches the source again as `fxm-ffmpeg-core-source-<version>.zip` (`scripts/release-build.sh`): `release.yml` builds and tests the core in its bundles job, from scratch and without caches like everything a release ships, before `scripts/release-build.sh`. Locally, `make dist` ships the core when one is built and otherwise composes a site that can't convert, and says so (scripts/build-dist/README.md). `make check` never builds or needs it: the code that uses the core is tested against a fake, and the real core only in `make ffmpeg-wasm-test` and CI.

`make dev` and `vite preview` serve the local build at the app's `ffmpeg/` path (`dev-server.ts`), so Save to device converts there too.

## The LGPL

- The core is a **separate, replaceable file**. To use your own FFmpeg (a newer release, a patched one), change `recipe/versions.sh` or add a patch step, run `make ffmpeg-wasm`, and put what `dist/` holds into the app's `ffmpeg/` folder. The app checks the wasm against the manifest that comes with it, so replace all three files.
- **Its source comes from the same place** (LGPL-2.1 §4 and §6, and FFmpeg's checklist, which asks to host the source on the same server as the binary): the site serves the exact tarballs it was built from, and the recipe, at `/source/ffmpeg-core/`; a release's web zip has them in `source/ffmpeg-core/`, so a copy hosted from it offers them too; and every GitHub Release attaches them as `fxm-ffmpeg-core-source-<version>.zip`, listed in `SHA256SUMS`. The recipe archive builds the core from the tarballs: unpack it, put the three tarballs into `fxm-ffmpeg-core-recipe/.tools/ffmpeg-wasm/downloads/` (or let `build.sh` download them), and run `fxm-ffmpeg-core-recipe/tools/ffmpeg-wasm/recipe/build.sh` with Node 22, `python3`, `make`, `curl` and `tar`. Its `core-build.ts hash` prints the recipe hash that `ffmpeg-core.json` names (checked 2026-10-26).
- `third-party-notices.txt` names every part, its licence, its source on the same site first (`/source/ffmpeg-core/…`, with each file's full address on FXM's own site, as Pages answers the folder's address with 404) and where its project publishes it (the release URL and Debian's copy), its SHA-256, FFmpeg's configure line and the patches (none), says how to replace the core, and carries the licence texts of `licenses/` in full, `linked-notices.txt` included: the LGPL asks for a copy of itself, and the MIT and BSD licences for their notices with every binary. It links this recipe, and `fxm_convert.c`, at the commit the site was built from (GITHUB_SHA in CI, else git's `HEAD`), which `make dist` checks is the recipe that built the core, so the link always matches the deployed binary. Each part's name, licence and homepage come from the current `core-build.ts` (`coreComponents`), so a fix to the notice reaches a deploy whose core came from CI's cache; the build's own facts, the licence texts and the linked files' notices come from the core.
- The app says so where users look: Settings → About and the Save to device dialog credit FFmpeg (LGPLv2.1), LAME (LGPL) and Opus (BSD), with links to their sites and to the notices (`apps/web/src/features/downloads/save/credit.tsx`). LAME asks to be acknowledged with a link to its site, which both do.
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
4. `make ffmpeg-wasm && make ffmpeg-wasm-test`. FFmpeg's API changes between major versions show up when `fxm_convert.c` compiles, and a file under a licence the notice can't carry yet when the build reads the linked files' licences: read the file's statement, then teach `linked-licences.ts` the licence or record a decision in `REVIEWED`.

## Files

| File | What it does |
|---|---|
| `recipe/versions.sh` | Every version, URL and SHA-256, and how each hash was checked |
| `recipe/build.sh` | emsdk, then the libraries (`libs.sh`), then the link, the path check, the licence texts, the manifest and the checks |
| `recipe/libs.sh` | Opus, LAME and FFmpeg, configured for WebAssembly |
| `recipe/pkg-config.sh` | A minimal `pkg-config` that answers from the build's own prefix (macOS has none; FFmpeg finds libopus only through it) |
| `recipe/fxm_convert.c` | The converter: the core's entry points |
| `recipe/linked-licences.ts` | The licence of every file linked into the core, and `licenses/linked-notices.txt` |
| `recipe/source-archive.ts` | The recipe's archive in `source/` |
| `core-build.ts` | The recipe's hashes, where builds live, the manifest, the licence texts every core carries, the checks and the notice; a CLI for `build.sh`, CI and `make` |
| `dev-server.ts` | Serves the local build on Vite's dev and preview servers |
