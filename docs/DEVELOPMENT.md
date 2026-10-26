# Development guide

Everything FXM needs is installed **inside the repository** and can be removed with one command. Nothing is installed globally or written to your home directory.

## Prerequisites

Only these live on your machine:

| Tool | Notes |
|---|---|
| git, make, curl, tar, openssl | Preinstalled on macOS and most Linux distributions |
| Node.js 22 | Version pinned in `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm): `nvm install && nvm use` |

## Quick start

```sh
git clone https://github.com/Pratyay-ops/FXM.git
cd FXM
nvm install && nvm use   # Node 22 from .nvmrc
make setup               # pinned pnpm + dependencies, all inside the repo
make doctor              # shows every tool and where it lives
```

Run `make` with no arguments to list all commands.

## Where things are installed

| What | Where | Installed by |
|---|---|---|
| pnpm 12.12.1 (standalone binary, hash-verified) | `.tools/bin/pnpm` | `make setup` |
| pnpm store, cache, state | `.tools/pnpm/` | `make setup` |
| JavaScript dependencies | `node_modules/` in each checkout (hard links into the store) | `make setup` / `make install` |
| uv 0.12.24 | `.tools/bin/uv` | `make py-setup` |
| Python 3.13 | `.tools/uv/python/` | `make py-setup` |
| Python virtualenv | `.venv/` in each checkout | `make py-setup` |
| GitHub CLI 2.102.0 and its login | `.tools/bin/gh`, `.tools/gh/` | `make gh-setup` (optional) |
| git-cliff 2.14.2 (release notes) | `.tools/bin/git-cliff` | the release commands, on first use |
| actionlint 1.7.12 (workflow linter) | `.tools/bin/actionlint` | `make release-check` |
| JDK, Android SDK, Gradle caches | `.tools/jdk/`, `.tools/android-sdk/`, `.tools/gradle/` | `make android-setup` (stage 6.1) |
| Stage worktrees | `../FXM-worktrees/<branch>/` | `make wt-new` |

`scripts/env.sh` redirects into `.tools/` everything a tool would normally write under `$HOME`: npm and pnpm caches, uv, pip, Gradle, Android, gh, Playwright and wrangler logs. It also turns telemetry off. `.tools/` always belongs to the **main checkout**, so every worktree shares one copy.

## Using the tools in your own shell

`make` runs every tool through `scripts/run.sh`, which loads the environment first. You can do the same:

```sh
scripts/run.sh pnpm --filter @fxm/web add some-package   # one command
source scripts/env.sh                                     # or a whole shell session
source .venv/bin/activate   # optional: activate the Python venv (or use `uv run …`)
```

## Commands

| Command | What it does |
|---|---|
| `make setup` | First-time setup: check prerequisites, install pinned pnpm, install deps |
| `make install` | Install or refresh dependencies, and re-resolve the lockfile after a merge (see Troubleshooting) |
| `make doctor` | Check prerequisites; fail if anything would install outside `.tools/` |
| `make py-setup` | Install uv and create `.venv` with the Python from `.python-version` |
| `make gh-setup` | Install the GitHub CLI (only for the PR workflow) |
| `make dev` | Start the web app dev server (Vite) |
| `make lint` / `make format` | Check, or fix, formatting and lint rules (Biome) |
| `make typecheck` | Type-check every package (TypeScript 7) |
| `make test` / `make coverage` | Run all tests (Vitest), optionally with a coverage report |
| `make build` | Build every app |
| `make check` | `lint` + `typecheck` + `test` + `build`: what every stage must pass |
| `make live-smoke` | The live smoke tests against the real services (`FXM_LIVE=1`), from a residential connection: see [Live smoke tests](#live-smoke-tests) |
| `make extension` | Build the FXM Connect browser extension: unpacked folders and zips in `apps/extension/dist/` (`FXM_EXTENSION_DEV=1`: the localhost dev build, in `dist/dev/`) |
| `make dist` | Compose what Cloudflare Pages serves (the site, the web app, `_headers`, the third-party notices) into `dist/pages/`, with its licence, header and privacy checks |
| `make ci` | Reproduce CI locally: setup with a frozen lockfile, then `check` |
| `make wt-new BRANCH=…` / `wt-list` / `wt-remove BRANCH=…` | Stage worktrees, see [WORKFLOW.md](WORKFLOW.md) |
| `make release-pr VERSION=x.y.z` | Open the release pull request from `develop` into `main` (`DRY_RUN=1`: only show the checks, the plan and the notes), see [Releases](#releases) |
| `make release-notes` / `release-build` / `release-check` | Print the next release's notes, build its files into `dist/release/` (once every package has the release version), or lint the workflows and test the release scripts |
| `make clean` | Remove build output |
| `make nuke` | Remove **all** installed tools, dependencies and caches |

## Monorepo layout and conventions

- **Workspace:** pnpm workspaces over `apps/*` and `packages/*`. Internal packages export their TypeScript source directly (`"exports": "./src/index.ts"`), so there is no build step between packages. Vite, Vitest and wrangler compile them on the fly.
- **TypeScript:** `tsconfig.base.json` is strict (including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). Each package picks its runtime libraries: `core` has none (pure ES), `sources` gets `webworker` (fetch, no DOM), `player` and `web` get the DOM.
- **Style:** Biome formats and lints: 2 spaces, single quotes, no semicolons, 100 columns. Run `make format` before committing. The VS Code settings in `.vscode/` format on save with the Biome extension.
- **Tests:** `*.test.ts(x)` next to the code, run by Vitest across all packages.
- **New dependencies:** `minimumReleaseAge` in `pnpm-workspace.yaml` makes pnpm install only versions that have been public for at least 14 days, transitive dependencies included. Dependabot uses the same 14-day cooldown, and GitHub Actions are pinned to commit SHAs.

## FXM Connect browser extension

`apps/extension` is FXM Connect, the optional companion extension that lets the web app reach YouTube, Spotify and Last.fm from the user's browser (Manifest V3, Chromium and Firefox). `make build` includes it; `make extension` builds only it. Its end-to-end test loads the built extension into Playwright's Chromium against a local HTTPS mock on port 5240. It is not part of `make test`; run it with `scripts/run.sh pnpm --filter @fxm/extension test:e2e`. The first run installs Chromium into `.tools/playwright`. Permissions, privacy, installation and the page protocol are in [apps/extension/README.md](../apps/extension/README.md).

## Releases

A release goes from `develop` to `main` through a pull request, and a workflow publishes it. [WORKFLOW.md](WORKFLOW.md#8-releases) describes the whole flow; these are the commands:

| Command | What it does |
|---|---|
| `make release-pr VERSION=x.y.z DRY_RUN=1` | Run every check and print the plan and the release notes. Changes, commits and pushes nothing. One check makes the release commit's changes in a temporary worktree and runs `make lint` and the release script tests there, which takes a minute or two |
| `make release-pr VERSION=x.y.z` | On a clean `develop` equal to `origin/develop`, with the release's summary in `docs/releases/vX.Y.Z.md`: set the version, regenerate `CHANGELOG.md`, commit `chore(release): vX.Y.Z`, push `develop` and open the pull request "Release vX.Y.Z" into `main`. It prints the URL and never merges. Run again with the version `develop` already has, it updates that release: `CHANGELOG.md`, the pull request's notes, or the pull request itself if it was closed |
| `make release-notes` | Print the notes of the changes since the last release (`VERSION=x.y.z`: the notes of that release, its summary first) |
| `make release-build` | Build what a release ships into `dist/release/`, with `SHA256SUMS`: the web zip, which is `make dist`'s `dist/pages/` (what Cloudflare Pages serves), and the FXM Connect zips. Every package must have the release version, as on `main` and on `develop` after `make release-pr`. To try it before then, run `scripts/release-version.sh x.y.z` and the build in a throwaway worktree (`make wt-new`), and never commit that change. Needs `zip` (preinstalled on macOS; `sudo apt install zip` on Debian and Ubuntu) |
| `make release-check` | Lint the GitHub workflows with actionlint and run the release scripts' offline tests (the tests of `release-build.sh` need `zip` and `unzip`, and are skipped without them). CI runs it after `make check`; run it yourself after changing `.github/workflows/`, `cliff.toml`, `cliff.notes.toml` or `scripts/release-*.sh` |

The scripts behind them work on their own too:

- `scripts/release-version.sh x.y.z` sets the version: the root and every workspace `package.json` (FXM Connect's manifest and the Android `versionName` come from theirs) and `APP_VERSION` in `packages/core/src/index.ts`. `--dry-run` shows the changes, `--check` fails unless every package agrees.
- `scripts/release-notes.sh [x.y.z]` prints release notes: the version's summary (`docs/releases/vX.Y.Z.md`), then its features, fixes and performance changes (`cliff.notes.toml`). `--changelog x.y.z` regenerates `CHANGELOG.md`, which has every change (`cliff.toml`). git-cliff runs offline.
- `release.yml` runs the rest: `release-plan.sh` decides whether to release, `release-collect.sh` gathers the artifact jobs' files and refuses any that `fxm_release_catalog` in `scripts/release-lib.sh` doesn't list for that job, and `release-publish.sh` tags and publishes. `deploy.yml` runs `release-wait.sh`, which holds the production deploy of a release until its GitHub Release is out.

git-cliff and actionlint are pinned, checksum-verified binaries in `.tools/bin`, installed on first use. `.github/workflows/release.yml` runs on every push to `main` and publishes a release when the version has none yet. Like `ci.yml`, it pins its actions to commit SHAs, and it builds without caches.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It uses the same isolated layout as your machine (`make ci-setup`, `make doctor`, `make check`, then `make release-check`) and caches `.tools/` between runs. A stage is merged into `develop` only when `make check` passes locally and CI is green on its branch.

`.github/workflows/deploy.yml` runs `make dist` on every push, then deploys `develop` to the preview (`https://develop.fxmusic.pages.dev`) and `main` to production (`https://fxmusic.pages.dev`, once a candidate of it passed the checks, and for a release once its GitHub Release is out), the Cloudflare Pages project `fxmusic`, and checks each deployment's headers. How it works, and what a stage that contacts a new service changes, is in [scripts/build-dist/README.md](../scripts/build-dist/README.md). Its Cloudflare secrets are repository secrets for now; the recommended setup that moves them into environments limited to `develop` and `main` is in [Deploying](../scripts/build-dist/README.md#deploying).

## Live smoke tests

Offline tests replay recorded answers, so they can't notice when YouTube or another service changes. `make live-smoke` runs every `live.test.ts` against the real services, one file at a time, with a few requests each (about 20 to YouTube in all, fewer than 30 per service). Run it from a residential connection: GitHub's runners use datacenter addresses that meet YouTube's bot checks, so CI's live runs are only advisory. Run it before every release.

It never runs code it downloads. The signed-updates check verifies the signature, size and SHA-256 of what FXM's site publishes and reads the config as data, but never imports the module: code imported there would run with your rights, unattended, with access to your files, keys and GitHub credentials. The YouTube module it runs is the one built from your checkout.

To run it every day on the owner's Mac, save this as `~/Library/LaunchAgents/io.github.pratyayops.fxm.live-smoke.plist` (it assumes the checkout in `~/Documents/Code/FXM` and Node from nvm; adjust both if needed):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.pratyayops.fxm.live-smoke</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$HOME/Documents/Code/FXM" &amp;&amp; source "$HOME/.nvm/nvm.sh" &amp;&amp; nvm use --silent &amp;&amp; { date; make live-smoke; } &gt;&gt; .tools/live-smoke.log 2&gt;&amp;1 || osascript -e 'display notification "See .tools/live-smoke.log" with title "FXM live smoke tests failed"'</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
</dict>
</plist>
```

Then load it, and run it once to check:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.pratyayops.fxm.live-smoke.plist
launchctl kickstart gui/$(id -u)/io.github.pratyayops.fxm.live-smoke
tail .tools/live-smoke.log
```

It runs at 10:30 every day, or when the Mac wakes if it was asleep then, tests whatever branch the checkout is on, appends to `.tools/live-smoke.log` (removed by `make nuke`) and shows a notification when something fails. To stop it: `launchctl bootout gui/$(id -u)/io.github.pratyayops.fxm.live-smoke`, then delete the file. On Linux, a cron line does the same: `30 10 * * * cd ~/FXM && make live-smoke >> .tools/live-smoke.log 2>&1`.

## Android app

`apps/mobile` wraps the web app in a [Capacitor](https://capacitorjs.com) 8 shell. Building it needs a JDK and the Android SDK, and both are installed inside the repository like everything else. `make check` needs neither. How the app is put together is in [apps/mobile/README.md](../apps/mobile/README.md).

```sh
make android-setup   # once: JDK, Android SDK and its licenses (about 500 MB of downloads)
make apk             # builds the debug APK
make android-test    # runs the native unit tests (JVM, offline, no device needed)
```

Release APKs are signed by the release workflow, and only there: FXM's key never goes into a shell on a computer that builds ([apps/mobile/RELEASING.md](../apps/mobile/RELEASING.md)). `make apk-release` builds them into `dist/android/release/` and signs them with a throwaway key made for the run, a dry run, and `make apk-sign-test` tests the signing offline.

`make apk` builds the web app with base `/` (`build:mobile`), copies it into the native project (`cap sync android`) and runs Gradle's `assembleDebug`, without a Gradle daemon left running. The APK lands in **`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`**. The first build downloads Gradle and the Android libraries; later builds take about half a minute.

> **Android SDK licenses.** `make android-setup` accepts the Android SDK licenses for you (`yes | sdkmanager --licenses`) and prints a line saying so. Read the [terms](https://developer.android.com/studio/terms) before you run it.

**Where it goes**

| What | Where | Size |
|---|---|---|
| Eclipse Temurin JDK 21 | `.tools/jdk/` | 340 MB |
| Android command-line tools, platform-tools, SDK platform 36, build tools 35 | `.tools/android-sdk/` | 530 MB |
| Gradle and the libraries the build downloads | `.tools/gradle/` | 700 MB after the first build |
| Android settings, the debug signing key, adb's key | `.tools/android-user/` | under 1 MB |
| Build output | `apps/mobile/android/{app/build,build,.gradle}`, `apps/web/dist-mobile/` in each checkout | 20 MB |

Android tools normally write to `~/.android`, `~/.gradle` and `~/.m2`. `scripts/env.sh` points them into `.tools/` (`ANDROID_USER_HOME`, plus `ANDROID_PREFS_ROOT` for the Android Gradle plugin's analytics, and `GRADLE_USER_HOME`). adb ignores those variables, so `make android-setup` puts an `adb` wrapper first on the PATH that gives it a home in `.tools/android-user`. Both `make android-setup` and `make apk` fail if `~/.android`, `~/.gradle`, `~/.m2` or `~/Library/Android` appears while they run. Run other Capacitor commands as `scripts/run.sh pnpm --filter @fxm/mobile cap <command>`. The script sets `CI=1`, because in a terminal the Capacitor CLI switches on its telemetry and stores a machine ID in your home folder. It also turns on Node's type stripping, so the CLI can load `capacitor.config.ts` on Node 22 releases before 22.18.

**Installing on a phone**

1. On the phone, open *Settings → About phone* and tap *Build number* seven times, then turn on *Developer options → USB debugging*.
2. Connect it over USB and run:

   ```sh
   scripts/run.sh adb devices    # accept the prompt on the phone
   scripts/run.sh adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
   scripts/run.sh adb kill-server   # optional: adb otherwise keeps a server running
   ```

   You can also copy the APK to the phone and open it there, after allowing your file manager to install unknown apps.

Use the repo-local `adb` through `scripts/run.sh` (or after `source scripts/env.sh`). `./gradlew installDebug` and Android Studio start adb without the wrapper, which creates `~/.android`. Every machine, and every CI run, signs debug builds with its own key in `.tools/android-user`, and `make nuke` deletes it. Android refuses to update an app with a different signature, so run `scripts/run.sh adb uninstall io.github.pratyayops.fxm` first, which also deletes the app's data.

From 2027, Google plans to require developer verification for apps installed outside the Play Store on certified Android devices: USD 25 and an ID for the publisher (Limited Distribution, for up to 20 devices, is free), or an ADB or "advanced" install flow for unverified apps. Debug builds installed with adb keep working: ADB installs need no verification. FXM stays unregistered for now (an owner decision, 2026-10-25) and revisits verification before the rollout. [apps/mobile/INSTALL.md](../apps/mobile/INSTALL.md) describes the install flow for the release APKs, and [RELEASING.md](../apps/mobile/RELEASING.md#android-developer-verification-from-2027) what registering would take.

**Cleaning up.** `make android-clean` removes this checkout's Android build output, and `make clean` does the same in every checkout. `make nuke` first stops the Gradle daemons running from `.tools/` and the adb server, which adb restarts whenever it next needs it. Then it deletes the JDK, the SDK, the Gradle caches and the keys with the rest of `.tools/`.

**CI.** `.github/workflows/android.yml` runs `make android-setup`, `make apk` and `make android-test` on ubuntu-latest, on demand and for pushes and pull requests that touch the app or anything its build uses: `apps/mobile/`, `apps/web/`, `packages/`, `scripts/`, the `Makefile`, `.nvmrc`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json` or the workflow itself. It fails when the build changes the committed project in `apps/mobile/android`. After a Capacitor upgrade, for example, `cap sync` rewrites `capacitor.settings.gradle`, so commit what `make apk` regenerated. It also runs `make apk-sign-test`. The workflow caches the JDK, the SDK and the Gradle home, and uploads `app-debug.apk` as a workflow artifact for 14 days. Run by hand with `release` (`scripts/run.sh gh workflow run android.yml --ref <branch> -f release=true`), it is a dry run of the release job: it also builds the release APKs, signs them with a throwaway key and uploads them as `fxm-android-dry-run`.

**Upgrading**

| What | Edit | Where the version and hash come from |
|---|---|---|
| JDK | `JDK_VERSION` and the hashes in `scripts/android-setup.sh` | A Temurin 21 release at least two weeks old; its `.sha256.txt` files on [the GitHub release](https://github.com/adoptium/temurin21-binaries/releases) |
| Command-line tools | `CMDLINE_TOOLS_*` and the hashes in `scripts/android-setup.sh` | The SHA-256 column on [developer.android.com/studio](https://developer.android.com/studio#command-line-tools-only) |
| SDK platform, build tools | `SDK_PLATFORM`, `SDK_BUILD_TOOLS` in `scripts/android-setup.sh` | `compileSdkVersion` in `apps/mobile/android/variables.gradle` (a test keeps them equal), and the Android Gradle plugin's default build tools |
| Gradle | `apps/mobile/android/gradle/wrapper/gradle-wrapper.properties` | `distributionSha256Sum` from `https://services.gradle.org/distributions/gradle-<version>-bin.zip.sha256` |
| Capacitor | `apps/mobile/package.json` through `scripts/run.sh pnpm --filter @fxm/mobile add …` | See [apps/mobile/README.md](../apps/mobile/README.md#upgrading-capacitor) |

## Desktop app

The desktop app (`apps/desktop`, see its [README](../apps/desktop/README.md)) wraps the web app in Tauri 2. Rust is installed inside the repository like every other tool, and `make check` never needs it.

### Prerequisites

Tauri compiles against each operating system's native toolchain and webview. These can't live in the repository, so install them once. `make doctor` reports them on its `desktop` line.

| OS | Install | `make doctor` checks |
|---|---|---|
| macOS | Xcode Command Line Tools: `xcode-select --install` | `xcode-select -p` |
| Linux (Debian, Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (other distributions: [Tauri's list](https://v2.tauri.app/start/prerequisites/#linux)) | `pkg-config --exists webkit2gtk-4.1` |
| Windows | Microsoft C++ Build Tools with "Desktop development with C++", and WebView2 (preinstalled on Windows 10 and 11) | Nothing: it only prints a note. The `make` targets need bash, so CI builds the Windows installers |

### Commands

| Command | What it does |
|---|---|
| `make desktop-setup` | `make rust-setup`, then `make install` |
| `make rust-setup` | Install the pinned rustup (checksum-verified) and the Rust release from `apps/desktop/src-tauri/rust-toolchain.toml` into `.tools/`. Re-running it removes toolchains that no checkout pins any more (about 500 MB each). Worktrees share `.tools/`, so a toolchain another worktree still pins stays installed |
| `make desktop-dev` | Start the web dev server on port 5260 (base `/`, strict port) and open the app with hot reload |
| `make desktop-build` | Release build into `apps/desktop/src-tauri/target/release/bundle/`. On macOS only `FXM.app`, because the DMG step can drive Finder windows. On Linux the `.deb`, `.rpm` and AppImage |
| `make desktop-dmg` | macOS: `FXM.app` plus the `.dmg`, built as CI builds it (`CI=true` skips the Finder layout step, so no windows open) |
| `make desktop-check` | rustfmt, clippy (warnings fail) and `cargo test` |

The first build compiles about 300 crates and takes a few minutes. Release builds use link-time optimization for a small app (`FXM.app` is about 7.5 MB), so even a rebuild takes a few minutes. Use `make desktop-dev` while working.

The content security policy only applies to release builds: `make desktop-dev` loads the Vite dev server directly. It has no `'unsafe-eval'`, and stage 7.2 added none: YouTube deciphering runs in a separate, hidden evaluator webview with its own policy (stage 1.11). Only if that webview can't work may 1.11 add `'unsafe-eval'` here, recorded in the app's README.

### Where things are installed

| What | Where | Size |
|---|---|---|
| rustup 1.29.1 and its proxies (`cargo`, `rustc`, …) | `.tools/cargo/bin` | 11 MB |
| Rust 1.98.1 with clippy and rustfmt | `.tools/rustup` | 470 MB |
| Cargo's registry (index and crate sources) | `.tools/cargo/registry` | about 800 MB |
| Build output | `apps/desktop/src-tauri/target/` in each checkout | about 1 GB after `desktop-build`, 3.5 GB after `desktop-check` or `desktop-dev` too |
| The web build the app embeds | `apps/web/dist-desktop/` in each checkout | under 1 MB |
| AppImage, WiX and NSIS tools, when a bundle needs them | `apps/desktop/src-tauri/target/.tauri/` (`bundle.useLocalToolsDir`) | downloaded on first use |

`scripts/env.sh` sets `RUSTUP_HOME` and `CARGO_HOME` to `.tools/` and puts `.tools/cargo/bin` on `PATH`. rustup is installed with `--no-modify-path`, so nothing goes into `~/.cargo`, `~/.rustup` or your shell profile. To use rust-analyzer, start your editor from a shell that sourced `scripts/env.sh`.

`env.sh` also clears the variables a Rust setup of your own may export (`CARGO_TARGET_DIR`, `RUSTUP_TOOLCHAIN`, `RUSTC_WRAPPER` and their Cargo equivalents), so builds use the pinned toolchain and stay in the repository. Cargo still reads `.cargo/config.toml` in every folder above the checkout, so also `~/.cargo/config.toml` when the checkout is in your home folder. `make doctor` warns when one of those sets `target-dir` or a rustc wrapper such as sccache.

Running the app stores its own data where every installed app does, for example `~/Library/Application Support/io.github.pratyayops.fxm`, `~/Library/Caches/io.github.pratyayops.fxm` and `~/Library/WebKit/io.github.pratyayops.fxm` on macOS: the window position, the webview's caches, the web app's storage and the hosts you approved in Settings (`user-hosts.json`). That is user data, not tooling, so `make nuke` keeps it. Delete those folders to reset the app. tauri-plugin-http adds no cookie file there: it is built without its `cookies` feature (see the app's README).

### Removing it

`make clean` deletes `apps/desktop/src-tauri/target/` and `apps/web/dist-desktop/` in every checkout. `make nuke` also deletes `.tools/`, which holds rustup, the toolchain and Cargo's registry.

## Removing everything

```sh
make nuke
```

This deletes `.tools/` and the `node_modules/` and `.venv/` folders of the main checkout and of every worktree.

- Tracked files and uncommitted work are never touched. Worktree folders themselves are kept because they hold work; remove each with `make wt-remove`.
- If you logged in to gh **without** `--insecure-storage`, run `gh auth logout` first so the token also leaves your keychain.
- `make setup` brings everything back.

## Upgrading pinned tools

Prefer releases that are at least two weeks old, and update the version and its hashes together:

| Tool | Edit | Where the hashes come from |
|---|---|---|
| pnpm | `scripts/install-pnpm.sh` **and** `"packageManager"` in `package.json` | `dist.integrity` of `https://registry.npmjs.org/@pnpm/exe.<platform>/<version>` |
| uv | `scripts/install-uv.sh` | `uv-<target>.tar.gz.sha256` files on the GitHub release |
| gh | `scripts/install-gh.sh` | `gh_<version>_checksums.txt` on the GitHub release |
| git-cliff | `scripts/install-git-cliff.sh` | The SHA-256 digest GitHub shows for each `git-cliff-<version>-<target>.tar.gz`, checked against the `.sha512` files on the release |
| actionlint | `scripts/install-actionlint.sh` | `actionlint_<version>_checksums.txt` on the GitHub release |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node 22 is required` | `nvm install && nvm use` in the repo folder |
| `pnpm: command not found` in your shell | `source scripts/env.sh`, or run it through `make` |
| Merge conflict in `pnpm-lock.yaml` | pnpm 12 doesn't repair conflict markers. Restore the target branch's lockfile (`git show origin/develop:pnpm-lock.yaml > pnpm-lock.yaml`), run `make install`, check with `scripts/run.sh pnpm install --frozen-lockfile`, then `git add pnpm-lock.yaml` and continue |
| `make doctor` says the store is outside `.tools/` | You ran pnpm without the environment: `source scripts/env.sh` |
| Tests time out when several worktrees run `make check` at once | Each check spreads across every CPU core: Vitest workers, TypeScript 7 and Rust tool threads, and several packages at once. Cap them in `.tools/env.local.sh`, which `scripts/env.sh` loads in every checkout and which is never committed: `export VITEST_MAX_WORKERS=2 GOMAXPROCS=2 RAYON_NUM_THREADS=2 pnpm_config_workspace_concurrency=2` |
