# More channels

Stage R.3. FXM ships through its own channels: the website and web app at `fxmusic.pages.dev`, and GitHub Releases with FXM Connect, the Android APK (stage 6.6) and the desktop installers (stage 7.5). This folder prepares what other channels need: F-Droid, IzzyOnDroid and Obtainium for the Android app, Flathub and winget for the desktop app, and the reasons for having no Homebrew cask.

**Nothing here submits anything.** No script or workflow submits FXM to a store or opens a pull request in another repository. Each channel's README has the owner's steps, to follow by hand.

## Where each channel stands

On 2026-10-26:

| Channel | Ready | The owner's part | Waiting for |
|---|---|---|---|
| [F-Droid](fdroid/README.md) | The build recipe (`channels fdroid`), the store listing in `fastlane/`, the F-Droid build (FXM's update check off, YouTube code and plugins opt-in) and `version.txt` for F-Droid's update check, kept by `scripts/release-version.sh` | Decide how F-Droid signs FXM, then open a merge request at fdroiddata | Stage 6.6 in a release (version codes, the APK's notices); three months of development, so late January 2027 |
| [IzzyOnDroid](izzyondroid/README.md) | Its requirements, checked against FXM | Nothing for now | Its AI policy, which rejects apps written with AI tools ("vibe-coded apps"), FXM included |
| [Obtainium](obtainium/README.md) | Links that add FXM to Obtainium, with its settings | Put the import link where people install FXM | A release with the APK (stage 6.6) |
| [Flathub](flatpak/README.md) | The metainfo and desktop entry, a Flatpak manifest for each release that repackages its `.deb` (for building a Flatpak yourself) and a submission checklist | Decide whether to write a Flathub manifest by hand | Flathub's generative AI policy: manifests must not contain AI-generated content, and AI-written apps are judged case by case; Flathub also builds from source |
| [winget](winget/README.md) | Manifests for each release, written by the channels workflow | Open a pull request at microsoft/winget-pkgs for each release | A release with the Windows installer (stage 7.5) |
| Homebrew | Nothing, on purpose ([below](#homebrew)) | Nothing | Notarization, which FXM doesn't plan |

## Each release

1. **Before `make release-pr`** (optional): `scripts/run.sh pnpm --filter @fxm/packaging --silent channels changelog <x.y.z>` writes F-Droid's "What's new" for the release from its summary, `docs/releases/vX.Y.Z.md`. Commit it with the summary.
2. **The release commit**: `make release-pr` sets the version in `packaging/fdroid/version.txt` with every other version (`scripts/release-version.sh`), so F-Droid's update check finds the release at its tag. Nothing to do.
3. **After the release**: the channels workflow writes the winget manifests and the Flatpak manifest of a release that has the desktop installers, as the artifact `channels-vX.Y.Z`. Submit the winget manifests ([winget](winget/README.md#submitting)). Once FXM is on F-Droid, F-Droid builds the release by itself.

## Homebrew

No cask, because FXM's macOS app isn't notarized. Homebrew requires casks to pass Gatekeeper: apps "must pass Homebrew's Gatekeeper checks and must not require System Integrity Protection or Gatekeeper to be disabled or bypassed" ([Acceptable Casks](https://docs.brew.sh/Acceptable-Casks)), and casks that fail those checks are disabled from September 2026 (Homebrew 5.0.0, 2025-11-12, and 6.0.0, 2026-06-11). FXM's app is signed ad hoc (stage 7.5), which Gatekeeper refuses until the user clicks "Open Anyway" (stage 7.5's `apps/desktop/INSTALL.md`), and notarization needs Apple's Developer Program, which FXM doesn't join (docs/ARCHITECTURE.md §1, Decision 3). A cask in a tap of FXM's own wouldn't help either: Gatekeeper would still stop the app, and Homebrew deprecated `--no-quarantine` in 5.0.0 rather than help bypass it. macOS users download the `.dmg` from GitHub Releases. A cask becomes possible only if the owner ever notarizes the app.

## The files

| Path | What it is |
|---|---|
| [`listing.ts`](listing.ts) | What every listing says, in one place: the app's name and IDs, the summary, the description for the Android and desktop apps, the non-affiliation notice, keywords. Public text, under the trademark rules of `docs/LEGAL.md` |
| [`fdroid/`](fdroid/) | F-Droid: the recipe, the build script, `version.txt` and the fastlane listing |
| [`izzyondroid/`](izzyondroid/) | IzzyOnDroid's requirements, checked |
| [`obtainium/`](obtainium/) | Obtainium's links |
| [`flatpak/`](flatpak/) | The metainfo and desktop entry, the Flatpak manifest and the Flathub checklist |
| [`winget/`](winget/) | The winget manifests and winget's schemas |
| [`artifacts.ts`](artifacts.ts) | The release files the channels point at, named as stages 6.6 and 7.5 name them |
| [`version.ts`](version.ts), [`sums.ts`](sums.ts), [`yaml.ts`](yaml.ts), [`files.ts`](files.ts) | Versions and Android version codes, `SHA256SUMS`, YAML for the generators, and the generated files |
| `../fastlane/metadata/android/en-US/` | F-Droid's and IzzyOnDroid's listing, generated from `listing.ts`: they read it from the repository at each release |
| `../.github/workflows/channels.yml` | After each Release run on `main` that published a release: writes the winget and Flatpak manifests from the release's `SHA256SUMS`, as an artifact. It reads only, installs nothing and runs only Node on `packaging/cli.ts` |

## Commands

The CLI ([`cli.ts`](cli.ts)) needs only Node, so release scripts and workflows run it without installing anything: `node --experimental-strip-types packaging/cli.ts <command>`, or `scripts/run.sh pnpm --filter @fxm/packaging --silent channels <command>`.

| Command | What it does |
|---|---|
| `sync [--check]` | Writes the files generated from `listing.ts`: the fastlane texts and icon, the metainfo and the desktop entry (`--check` fails if one is stale; the tests do the same). Run it after changing `listing.ts` |
| `version <x.y.z> [--dry-run]`, `version --check` | Sets, or checks, F-Droid's `version.txt`. `scripts/release-version.sh` runs it with every other version |
| `changelog <x.y.z>` | Writes a release's F-Droid changelog from its summary |
| `fdroid <x.y.z> [--commit <sha>]` | Prints the recipe for fdroiddata |
| `obtainium` | Prints Obtainium's links |
| `winget <x.y.z> --sums <file> --out <dir> [--date <day>] [--if-present]` | Writes a release's winget manifests |
| `flatpak <x.y.z> --sums <file> --out <dir> [--date <day>] [--if-present]` | Writes a release's Flatpak manifest with the files it installs |

`--if-present` turns a release without the files a command needs (before stage 7.5's installers) into a notice instead of a failure.

## Tests

```sh
scripts/run.sh pnpm vitest run --project packaging
```

They run offline and need none of the channels' tools: the recipe's fields and their order (as `fdroid rewritemeta` keeps them), the F-Droid build script against stand-ins for pnpm, Gradle and stage 6.6's notices writer, `release-version.sh` keeping `version.txt` in step, the store listings' limits and trademark rules, the generated files against `listing.ts`, the winget manifests against winget's JSON schemas, the Flatpak manifest and metainfo, Obtainium's links, and the release file names against stages 6.6 and 7.5 once they have merged. The web app's own tests cover the F-Droid opt-in (`apps/web/src/features/youtube-updates/`, `apps/web/src/app/services/updates.test.ts`).

## Waiting for other stages

Stages 6.6 and 7.5 were reviewed but not merged when this stage was written, and 8.3 was in review. What changes when they merge:

- **Nothing to edit here for the names**: `artifacts.ts` names the APK and the installers as their branches do, and `artifacts.test.ts` compares them with `scripts/release-lib.sh` and `apps/desktop/release/targets.ts` once those have them.
- **The APK's notices**: `fdroid/build.sh` writes them with 6.6's `apps/mobile/scripts/write-notices.ts`, as 6.6's `release-apk.sh build` does; `fdroid/build.test.ts` checks the paths against `release-apk.sh` once it exists. Try `build.sh` on a real checkout then.
- **6.6's Android install guide and the site**: add the Obtainium import link to `apps/mobile/INSTALL.md` and the site's Android card, and say on the privacy page what F-Droid's build does differently once FXM is on F-Droid.
- **7.5's updater in a Flatpak**: it treats the repackaged binary as a `.deb` installation and points to apt. It should recognize a Flatpak (`FLATPAK_ID`, `/.flatpak-info`) and stay quiet there.
- **One distribution flag** (6.6 and 8.3): F-Droid's build sets both `FXM_DISTRIBUTION`, which 6.6 builds into the app and checks, and `VITE_FXM_DISTRIBUTION`, which 8.3's plugins read (`features/plugins/distribution.ts`); `apps/web/src/lib/distribution.ts` reads both. Once both stages have merged, keep one flag and one `BUILD_DISTRIBUTION`, and let `fdroid/build.sh` set that one.
- **Reproducible builds for F-Droid** (if the owner chooses them): a third APK in each release built as F-Droid builds it and signed with apksigner from build-tools 34 ([F-Droid](fdroid/README.md#signing-f-droids-key-or-reproducible-builds)).
