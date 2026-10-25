# Development guide

Everything FXM needs is installed **inside the repository** and can be removed with one command. Nothing is installed globally or written to your home directory.

## Prerequisites

Only these live on your machine:

| Tool | Notes |
|---|---|
| git, make, curl, tar, openssl | Preinstalled on macOS and most Linux distributions |
| Node.js 22 | Version pinned in `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm): `nvm install && nvm use` |
| ffmpeg *(optional)* | Only for the self-hosted server (stage 7.1) |

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
| `make extension` | Build the FXM Connect browser extension: unpacked folders and zips in `apps/extension/dist/` (`FXM_EXTENSION_DEV=1`: the localhost dev build, in `dist/dev/`) |
| `make ci` | Reproduce CI locally: setup with a frozen lockfile, then `check` |
| `make wt-new BRANCH=…` / `wt-list` / `wt-remove BRANCH=…` | Stage worktrees, see [WORKFLOW.md](WORKFLOW.md) |
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

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It uses the same isolated layout as your machine (`make ci-setup`, `make doctor`, `make check`) and caches `.tools/` between runs. A stage is merged into `develop` only when `make check` passes locally and CI is green on its branch.

## Android app

`apps/mobile` wraps the web app in a [Capacitor](https://capacitorjs.com) 8 shell. Building it needs a JDK and the Android SDK, and both are installed inside the repository like everything else. `make check` needs neither. How the app is put together is in [apps/mobile/README.md](../apps/mobile/README.md).

```sh
make android-setup   # once: JDK, Android SDK and its licenses (about 500 MB of downloads)
make apk             # builds the debug APK
```

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

From 2027, Google plans to require developer verification for apps installed outside the Play Store on certified Android devices: USD 25 and an ID for the publisher, or an ADB or "advanced" install flow for unverified apps. Debug builds installed with adb are expected to keep working. Stage 6.6 decides how FXM's release APKs handle it.

**Cleaning up.** `make android-clean` removes this checkout's Android build output, and `make clean` does the same in every checkout. `make nuke` first stops the Gradle daemons running from `.tools/` and the adb server, which adb restarts whenever it next needs it. Then it deletes the JDK, the SDK, the Gradle caches and the keys with the rest of `.tools/`.

**CI.** `.github/workflows/android.yml` runs `make android-setup` and `make apk` on ubuntu-latest for pushes and pull requests that touch `apps/mobile/`, `apps/web/`, `scripts/android-setup.sh` or the workflow itself, and on demand. It caches the JDK, the SDK and the Gradle home, and uploads `app-debug.apk` as a workflow artifact for 14 days.

**Upgrading**

| What | Edit | Where the version and hash come from |
|---|---|---|
| JDK | `JDK_VERSION` and the hashes in `scripts/android-setup.sh` | A Temurin 21 release at least two weeks old; its `.sha256.txt` files on [the GitHub release](https://github.com/adoptium/temurin21-binaries/releases) |
| Command-line tools | `CMDLINE_TOOLS_*` and the hashes in `scripts/android-setup.sh` | The SHA-256 column on [developer.android.com/studio](https://developer.android.com/studio#command-line-tools-only) |
| SDK platform, build tools | `SDK_PLATFORM`, `SDK_BUILD_TOOLS` in `scripts/android-setup.sh` | `compileSdkVersion` in `apps/mobile/android/variables.gradle` (a test keeps them equal), and the Android Gradle plugin's default build tools |
| Gradle | `apps/mobile/android/gradle/wrapper/gradle-wrapper.properties` | `distributionSha256Sum` from `https://services.gradle.org/distributions/gradle-<version>-bin.zip.sha256` |
| Capacitor | `apps/mobile/package.json` through `scripts/run.sh pnpm --filter @fxm/mobile add …` | See [apps/mobile/README.md](../apps/mobile/README.md#upgrading-capacitor) |

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node 22 is required` | `nvm install && nvm use` in the repo folder |
| `pnpm: command not found` in your shell | `source scripts/env.sh`, or run it through `make` |
| Merge conflict in `pnpm-lock.yaml` | pnpm 12 doesn't repair conflict markers. Restore the target branch's lockfile (`git show origin/develop:pnpm-lock.yaml > pnpm-lock.yaml`), run `make install`, check with `scripts/run.sh pnpm install --frozen-lockfile`, then `git add pnpm-lock.yaml` and continue |
| `make doctor` says the store is outside `.tools/` | You ran pnpm without the environment: `source scripts/env.sh` |
