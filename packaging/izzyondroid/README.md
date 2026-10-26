# IzzyOnDroid

[IzzyOnDroid](https://izzyondroid.org) is an F-Droid-compatible repository that publishes the APKs developers attach to their releases, after its own checks. It needs nothing from FXM beyond what F-Droid already reads: the fastlane listing in `fastlane/metadata/android/en-US/` (shared with [F-Droid](../fdroid/README.md)) and signed APKs on GitHub Releases (stage 6.6). There is no metadata file to write here, and nothing has been submitted.

**Don't apply for now.** IzzyOnDroid's AI policy rejects FXM's kind of app: "We are strongly opposed to apps which are fully or in part created by generative AI tools", "Vibe-coded apps will be rejected", and while "Readme, Changelogs and similar documentation files are allowed to include LLM-generated texts", "the code itself should be free of it". FXM's code is written with AI tools. Apply only if that policy changes.

## FXM against its requirements

IzzyOnDroid's [App Inclusion Policy](https://izzyondroid.org/docs/general/AppInclusionPolicy/), read 2026-10-26:

| Requirement | FXM |
|---|---|
| Free licence (OSI or FSF approved), source openly accessible on a forge | Apache-2.0, on GitHub |
| No proprietary components; no trackers (ads, analytics) | None |
| `android:usesCleartextTraffic` avoided unless necessary | Not set |
| Targets end users | Yes |
| No download of "additional executable binary files (e.g. addons, auto-updates, etc.)" without opt-in consent that "clearly explains to users that they're choosing to bypass the checks performed in this repo" | **Not met by the APK IzzyOnDroid would ship.** The GitHub APKs are standard builds: they download FXM's signed YouTube resolver module without asking (stage 1.13). An F-Droid build asks first (`VITE_FXM_DISTRIBUTION=fdroid`, which `packaging/fdroid/build.sh` sets with `FXM_DISTRIBUTION=fdroid`), but its opt-in names F-Droid. IzzyOnDroid would need a release APK built with an opt-in that names the repository it came from. The standard build's daily update check only links to the new APK on GitHub; IzzyOnDroid may still ask for it to be off |
| Its own package name and display name | `io.github.pratyayops.fxm`, "FXM" |
| Fastlane metadata in the repository: short and full description, icon and some screenshots | Descriptions and icon are there (`channels sync`); **screenshots are missing** |
| A stable package name | Fixed since stage 6.1 |
| No controversial topics in the name, description or graphics | None |
| APKs signed with the developer's release key, not `debuggable` or `testOnly` | Stage 6.6's release APKs |
| APKs attached to tagged releases on GitHub (or Codeberg, GitLab) | Stage 6.6 attaches `fxm-android-universal-<version>.apk` and `fxm-android-arm64-v8a-<version>.apk` |
| Up to about 30 MB per app, the size limit for one APK | To check against 6.6's first release APK |
| No app "only launching a website inside a webview" | Native networking, Media3 playback and background audio |
| AI policy | **Not met** (above) |

## If the policy changes

1. Make the APK meet the self-updater rule: a release APK built with the module's opt-in (and FXM's update check off), for example the F-Droid build that [reproducible builds](../fdroid/README.md#signing-f-droids-key-or-reproducible-builds) would add to each release, with wording that names IzzyOnDroid's checks rather than only F-Droid's.
2. Add phone screenshots to `fastlane/metadata/android/en-US/images/phoneScreenshots/`.
3. The owner opens an issue with the "App Inclusion Request" template at IzzyOnDroid's tracker on Codeberg, `https://codeberg.org/IzzyOnDroid/repodata/issues` (checked 2026-10-26), naming the repository and the APK to pick (`fxm-android-universal-<version>.apk`).
