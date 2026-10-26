# F-Droid

F-Droid builds the apps it lists from their source, signs them and publishes them in its own repository. FXM's Android app can be listed there: it is free software, builds with free tools and has no proprietary libraries. Nothing here submits anything: the owner opens the merge request at F-Droid, following [Submitting](#submitting). What is ready:

| File | What it is |
|---|---|
| [`recipe.ts`](recipe.ts) | FXM's build metadata for [fdroiddata](https://gitlab.com/fdroid/fdroiddata), `metadata/io.github.pratyayops.fxm.yml` there. `channels fdroid <x.y.z>` prints it |
| [`build.sh`](build.sh) | What the recipe's build step runs: the web app as an F-Droid build, copied into the Android project, with the APK's third-party notices |
| [`version.txt`](version.txt) | FXM's Android version name and code, which F-Droid's update check reads at each release tag. `scripts/release-version.sh` sets it with every other version |
| [`fastlane.ts`](fastlane.ts) | The store listing in `fastlane/metadata/android/en-US/`, which F-Droid reads from the repository at each release: the title, both descriptions, the icon, and each release's changelog (`channels changelog <x.y.z>`) |

## Before submitting

F-Droid can't build a useful FXM yet. These must hold first:

1. **Stage 6.6 has merged, and a release carries it.** Until then `app/build.gradle` gives every build the version code 1, while the recipe names the code that 6.6's formula gives (major × 1,000,000 + minor × 1,000 + patch), so F-Droid's build would fail its check. `build.sh` also writes the APK's third-party notices with 6.6's writer; in a checkout without that writer it skips them, with a warning.
2. **Three months of development.** F-Droid's inclusion policy asks that an app "should have been actively developed for at least 3 months" unless it has proven users or its author maintains other F-Droid apps (Quality Control, item 6). FXM's first commit is from 2026-10-25, so submit from late January 2027.
3. **Decide how F-Droid signs FXM** ([Signing](#signing-f-droids-key-or-reproducible-builds)). It can't change later without every F-Droid user reinstalling.
4. **Screenshots** for the listing, which F-Droid recommends: phone screenshots in `fastlane/metadata/android/en-US/images/phoneScreenshots/` (1.png, 2.png, …), taken from the released app.

## The recipe

`scripts/run.sh pnpm --filter @fxm/packaging --silent channels fdroid <x.y.z>` prints the recipe for a release, with the commit its tag points at (`--commit <sha>` names another). The fields come in the order `fdroid rewritemeta` keeps, so F-Droid's tools leave the file as it is (checked with fdroidserver's `lint` and `rewritemeta` on 2026-10-26). The parts that matter:

- **`AntiFeatures: NonFreeNet`**, "Uses YouTube Music, Spotify and Last.fm: non-free network services." F-Droid applies NonFreeNet to "apps that promote or depend entirely on a proprietary network service", as for NewPipe ("Depends on Youtube for videos") and Spotube ("App depends on Spotify, which is non-free"). No other anti-feature applies (see [Questions F-Droid may ask](#questions-f-droid-may-ask)).
- **`Categories`**: Internet, Multimedia and Online Media Player, as NewPipe's and Spotube's.
- **The build**: `subdir: apps/mobile/android/app`, `gradle: [yes]` (F-Droid runs `assembleRelease` itself, which builds one unsigned APK for every processor), and a `build` step that goes back to the repository's root and runs `packaging/fdroid/build.sh`.
- **No `Binaries` and no `AllowedAPKSigningKeys`**: F-Droid signs the APK with its own key. [Signing](#signing-f-droids-key-or-reproducible-builds) says what changes for reproducible builds.
- **Updates**: `AutoUpdateMode: Version` with `UpdateCheckMode: Tags ^v\d+\.\d+\.\d+$` and `UpdateCheckData: packaging/fdroid/version.txt|versionCode=(\d+)|.|versionName=(\d+\.\d+\.\d+)`. F-Droid reads version codes only with a regular expression and "won't run the Gradle code" (its Quick Start Guide), and FXM's are computed in `app/build.gradle`, so `version.txt` repeats them. `scripts/release-version.sh` writes it in every release commit, and `--check` fails while it names another version. Once the recipe is in fdroiddata, F-Droid's checkupdates bot finds each new release tag by itself.

### The build

F-Droid's build server runs Debian trixie with its default JDK, OpenJDK 21, which the Android build needs (its Kotlin modules target Java 21), so the recipe needs no `sudo` step (fdroidserver's `buildserver/Dockerfile` and `provision-apt-get-install`, read 2026-10-26). `build.sh` runs after F-Droid's source scan, in this order:

1. **Node.js 22.** The one on the PATH when it is 22.13 or a later 22.x, else Node.js's own Linux build, pinned and checked against its SHA-256 (`NODE_VERSION` in the script, a release at least two weeks old). Debian's stable and testing suites have no Node.js 22 (trixie has 20, forky 24; sources.debian.org, 2026-10-26), and the inclusion policy accepts "prebuilt FLOSS binaries from … Node.js (current versions)".
2. **pnpm**, pinned and checked against the npm registry's integrity hash (`scripts/install-pnpm.sh`).
3. **The npm packages**, exactly as `pnpm-lock.yaml` has them (`--frozen-lockfile`): those of the Android app and the web app, and those of `make dist` for step 6.
4. **The web app as an F-Droid build**: `FXM_DISTRIBUTION=fdroid` and `VITE_FXM_DISTRIBUTION=fdroid` (stage 6.6 reads the first, stage 8.3 the second, until they agree on one name). [What the F-Droid build does differently](#what-the-f-droid-build-does-differently) has the effect.
5. **`cap sync android`**, which copies it into the Android project.
6. **The APK's third-party notices**, which Settings → About shows, as the GitHub APK's build writes them (stage 6.6, `release-apk.sh build`): `make dist`'s notices of the web code and the Android libraries that Gradle resolves for the release build (`fxmLibraryReport`), joined into `assets/public/third-party-notices.txt`. Gradle runs with the wrapper where the checkout has its JAR, else with `gradlew-fdroid`, which F-Droid's build server provides after its scan removed the JAR; the Android SDK is F-Droid's (`ANDROID_HOME`) when the checkout has none in `.tools`.

The npm packages are installed in the build step, after the scan, rather than in `prebuild` with `scandelete: [node_modules]` as some Node-based recipes do, because the scan would delete files the build needs: fdroidserver's scanner flags archives and extensionless binaries (`scanner.py`, read 2026-10-26), such as `@capacitor/cli/assets/capacitor-cordova-android-plugins.tar.gz`, which `cap sync` unpacks. Some packages are build tools that ship prebuilt native binaries, all under free licences:

| Package | Licence | Used by |
|---|---|---|
| Rolldown, Rollup | MIT | Vite and the PWA plugin's service worker build |
| Lightning CSS | MPL-2.0 | Vite and Tailwind CSS |
| Tailwind CSS's Oxide | MIT | Tailwind CSS |
| TypeScript 7's compiler | Apache-2.0 | Installed with the web app's tools; the build doesn't run it |
| Astro's compiler and Markdown parser (satteri) | MIT | `make dist` (the site, for the notices) |
| sharp and libvips | Apache-2.0; LGPL-3.0-or-later | `make dist` (the site's images, for the notices) |

To try the recipe's first half on a Linux or macOS checkout: `packaging/fdroid/build.sh`, then `scripts/run.sh bash -c 'cd apps/mobile/android && ./gradlew --no-daemon assembleRelease'`.

## What the F-Droid build does differently

F-Droid's inclusion policy, item 5 of Security & Legal Compliance (read 2026-10-26): "Applications must not download additional executable binary files (e.g. add-ons, auto-updates, etc.) without explicit user consent. Consent means it needs to be opt-in (it must not be harder to decline than to accept or presented in a way users are likely to press accept without reading) and structured in a way that clearly explains to users that they're choosing to bypass F-Droid's checks if they activate it." So a build with `FXM_DISTRIBUTION=fdroid`:

| | Standard build (GitHub Releases) | F-Droid build |
|---|---|---|
| FXM's own check for new app versions (stage 6.6) | Once a day, can be turned off | Never: only a build marked `standard` checks (`isGitHubReleasesBuild` in stage 6.6's `apps/web/src/features/app-update/`), and F-Droid updates the app |
| The signed YouTube resolver module from fxmusic.pages.dev (stage 1.13) | Downloaded and loaded after its signature checks | Only after the user turns it on in **Settings → Sources**, with `CODE_UPDATES_CONSENT` of `@fxm/platform`: "Download YouTube fixes from FXM?", three short paragraphs that say the code comes from FXM and not from F-Droid and that turning it on bypasses F-Droid's checks, and two equal buttons, "Turn on" and "Not now", neither preselected. Turning it off again goes back to the module the app came with, at once (`apps/web/src/features/youtube-updates/`, `apps/web/src/app/services/updates.ts`) |
| The signed YouTube config (stage 1.13) | Fetched at start | Fetched at start: it is data (client versions, search parameters, kill switches), not code |
| Plugins (stage 8.3, not merged yet) | Added from a URL or file the user picks | Off until the user turns them on, with the opt-in F-Droid's policy asks for (`PLUGINS_CONSENT` of `@fxm/plugins`) |

The app's listing says the same in its description (`FDROID_BUILD_NOTE` in [`fastlane.ts`](fastlane.ts)).

## Signing: F-Droid's key or reproducible builds

F-Droid's Quick Start Guide (read 2026-10-26): reproducible builds "are not a requirement", but "one can't easily switch to them later because Android doesn't allow updates with a different signing key, meaning users would have to reinstall. So we mainly encourage their use for new apps." Decide before the first submission.

**F-Droid's key (the default, what the recipe does).** F-Droid builds FXM and signs it with a key it makes for the app. F-Droid's FXM then has another certificate than the GitHub APK, so Android treats them as different sources: people move between them only by reinstalling, after exporting their library. If FXM ever registers for Android's developer verification, F-Droid's key must be registered for the package too: stage 6.6's `apps/mobile/RELEASING.md`, section "F-Droid's re-signing key", has the steps (F-Droid publishes each app's signer in `https://f-droid.org/repo/signer-index.json`).

**Reproducible builds.** F-Droid publishes FXM's own signed APK once its build of the same commit is identical apart from the signature (the recipe then names it with `Binaries` and `AllowedAPKSigningKeys`, F-Droid's Reproducible Builds page). One key for both sources and for developer verification, and people can move between F-Droid, GitHub and Obtainium without reinstalling. What it needs:

1. **An APK of the F-Droid build on GitHub.** The GitHub APKs are standard builds (`FXM_DISTRIBUTION=standard`), which differ from F-Droid's by design, so the release workflow would also build `FXM_DISTRIBUTION=fdroid`, the same way `build.sh` does, and sign it with FXM's key: a third APK, for example `fxm-android-fdroid-<version>.apk` (a change to stage 6.6's release jobs).
2. **apksigner from build-tools 34.** F-Droid copies the signature with apksigcopier, and "apksigner from build-tools >= 35.0.0-rc1 outputs unverifiable APKs" (fdroiddata issue #3299). Stage 6.6 signs with build-tools 35.0.0.
3. **The same inputs and outputs.** The same Node.js and pnpm (both pinned), the same lockfile, a deterministic web build and notices file, and Gradle's output without timestamps. FXM has no native code, which avoids the usual causes (build paths, NDK differences); baseline profiles and PNG crunching are the ones to watch (Reproducible Builds page).

Recommended: try reproducible builds before the first submission, since FXM is new and has no native code; if the builds don't match, submit with F-Droid's key.

## Submitting

The owner does this, by hand. F-Droid's merge request needs a GitLab account.

1. Check [Before submitting](#before-submitting).
2. Print the recipe for the newest release: `scripts/run.sh pnpm --filter @fxm/packaging --silent channels fdroid <x.y.z> > io.github.pratyayops.fxm.yml` (in a folder outside the repository).
3. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) on GitLab, clone it, create a branch named `io.github.pratyayops.fxm`, and copy the file to `metadata/io.github.pratyayops.fxm.yml`.
4. Optional, to catch problems first: in F-Droid's build container (the Quick Start Guide's "Build environment"), run `fdroid readmeta`, `fdroid rewritemeta io.github.pratyayops.fxm`, `fdroid lint io.github.pratyayops.fxm` and `fdroid build io.github.pratyayops.fxm`. Pushing the branch also runs fdroiddata's CI on it, which builds the app.
5. Commit with the message `New App: io.github.pratyayops.fxm`, push, and open a merge request at fdroiddata. Fill in its template yourself, and answer the reviewers' questions; [Questions F-Droid may ask](#questions-f-droid-may-ask) has prepared answers.
6. After the merge, F-Droid builds and publishes FXM within a day or two. Later releases need nothing from you: checkupdates reads `version.txt` at each new `vX.Y.Z` tag.

For each release, `channels changelog <x.y.z>` (before `make release-pr`) writes F-Droid's "What's new" text from the release's summary, `fastlane/metadata/android/en-US/changelogs/<version code>.txt`; commit it with the summary. Without it, F-Droid shows no "What's new" for that version.

## Questions F-Droid may ask

**Prebuilt binaries in npm packages.** Some build tools ship them ([The build](#the-build)); all are free software, as the policy requires for prebuilt binaries it accepts. If the reviewers want them built from source, the candidates are Rolldown and Lightning CSS (Rust) and Tailwind CSS's Oxide (Rust); `make dist` (only for the notices) could also be replaced by notices computed from the web app's own build.

**Tracking.** The Anti-Features page applies Tracking to apps that check "for updates without your knowledge or permission". F-Droid's build never checks for app updates. It does fetch the signed YouTube config from `https://fxmusic.pages.dev/updates/` at start: a static file on Cloudflare Pages, requested without cookies or identifiers, which keeps YouTube working and holds the kill switches; the privacy page names it. If F-Droid counts it as an update check, put the config under the same opt-in as the module: in `apps/web/src/app/services/updates.ts`, leave the config artifact out while an F-Droid build's user hasn't opted in.

**TetheredNet** ("depend entirely on a service which is impossible (or not easy) to replace"). FXM depends on no service run by its developer: there is no FXM server, and the config and module are optional and fall back to the copies the app ships. Internet Archive and the music files on the device play without YouTube or Spotify.

**NonFreeAdd.** FXM promotes no non-free apps or plugins; plugins are whatever the user adds, off until they opt in.

**A website in a wrapper** (Quality Control, item 3: an app that wraps a website "should provide native features"). The Android app has native networking (an OkHttp plugin), a native Media3 player with background playback, a notification and lock-screen controls, and an isolated evaluator WebView.

**The application ID.** `io.github.pratyayops.fxm` is stage 6.1's, and can't change once APKs are out. F-Droid advises an ID from a domain the developer owns; the owner's GitHub Pages domain is `pratyay-ops.github.io` (an ID can't hold the dash), and no GitHub account named `pratyayops` existed on 2026-10-26. Creating that account would reserve the name.

**AI.** F-Droid had no rule about apps written with AI tools on 2026-10-26: its inclusion policy doesn't mention them, an interim policy for contributions to F-Droid itself is under discussion ([fdroid/admin#699](https://gitlab.com/fdroid/admin/-/work_items/699)), and so is an anti-feature for apps that use AI or LLMs ([fdroid/admin#641](https://gitlab.com/fdroid/admin/-/work_items/641)). Check both again before submitting, and answer truthfully if asked how FXM was written.

## Sources

Read 2026-10-26: F-Droid's [Inclusion Policy](https://f-droid.org/docs/Inclusion_Policy/) (news up to 2026-10-16), [Anti-Features](https://f-droid.org/docs/Anti-Features/), [Build Metadata Reference](https://f-droid.org/docs/Build_Metadata_Reference/), [Submitting to F-Droid Quick Start Guide](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/), [Reproducible Builds](https://f-droid.org/docs/Reproducible_Builds/) and [All About Descriptions, Graphics, and Screenshots](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/); fdroidserver's `metadata.py` (field order), `checkupdates.py` (`UpdateCheckData`), `scanner.py` and `common.py` (`gradlew-fdroid`, `local.properties`, `ANDROID_HOME`) on [its master branch](https://gitlab.com/fdroid/fdroidserver); fdroiddata's `config/categories.yml` and the recipes of NewPipe (`org.schabi.newpipe`), Spotube (`oss.krtirtho.spotube`), Tutanota and Acode; [sources.debian.org](https://sources.debian.org/src/nodejs/) for Debian's Node.js versions.
