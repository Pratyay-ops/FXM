# Installing FXM on Android

FXM for Android is an APK, the file Android installs apps from. It is published on [GitHub Releases](https://github.com/Pratyay-ops/FXM/releases/latest), not in Google Play. You need Android 7.0 or later, with Android System WebView (or Chrome) kept up to date from the Play Store.

## Which file

Each release has two APKs:

| File | For |
|---|---|
| `fxm-android-universal-<version>.apk` | Every phone and tablet. Pick this one if you aren't sure |
| `fxm-android-arm64-v8a-<version>.apk` | Phones with a 64-bit ARM processor, which most phones of the last few years have. While FXM has no native code it is the same app as the universal one |

## Install it

1. On your phone, open the [latest release](https://github.com/Pratyay-ops/FXM/releases/latest) in your browser and tap the universal APK to download it.
2. Open the file when the download finishes, from the browser's notification or the **Files** app.
3. The first time, Android asks whether your browser may install apps. Tap **Settings**, turn on **Allow from this source**, and go back. On Android 7, turn on **Unknown sources** in **Settings → Security** instead.
4. Tap **Install**, then **Open**.

If Google Play Protect warns that it doesn't know the app, you can still install it: tap **More details**, then **Install anyway**.

## Check the APK first (optional)

Every FXM release is signed with the same key. The release notes give the SHA-256 fingerprint of its certificate, and [`release-certificate.txt`](release-certificate.txt) in this folder has it too. Before the first install, you can check that your download carries it:

- **On a computer** with the Android SDK's build tools (FXM's checkout has them after `make android-setup`):

  ```sh
  apksigner verify --print-certs fxm-android-universal-<version>.apk
  ```

  The line `Signer #1 certificate SHA-256 digest:` must show the fingerprint, in lower case and without colons.
- **The checksums and the build provenance**: the release notes show how to compare a download with `SHA256SUMS` and check that FXM's release workflow built it (`gh attestation verify`).

After that, Android checks the signature of every update itself: it refuses an update signed with another key.

## Updates

The Android app from GitHub Releases asks GitHub once a day whether a new version is out. When one is, it says so ("FXM 0.6.0 is out") with a **Download** button, and **Settings → About → Updates** shows it too, with **Check now**. To stop the daily check, turn off **Check for new versions** there; FXM then asks GitHub only when you tap **Check now**. FXM never downloads or installs anything by itself:

1. Tap **Download**. Your browser downloads the APK.
2. Open the file. Android asks **Do you want to update this app?** Tap **Update**.

Your library and settings stay, because the update is signed with the same key. Apps that follow GitHub releases, such as Obtainium, work too.

## From 2027: Android's developer verification

Google is rolling out developer verification for apps installed on certified Android devices: an app installs the usual way only when its developer has registered it with Google. FXM isn't registered for now. Checked on 2026-10-26 in [Google's FAQ](https://developer.android.com/developer-verification/guides/faq) (updated 2026-09-30):

- **Today**, it applies only to apps from a few participating app stores in Brazil, Indonesia, Singapore and Thailand (since 2026-09-30). Installing FXM from GitHub works as described above.
- **From 2027**, it reaches every certified device, worldwide. Installing an app of an unregistered developer, such as FXM, then needs Android's *advanced flow*, set up once:
  1. Turn on developer options: in **Settings → About phone**, tap **Build number** seven times.
  2. Turn on installing apps from unverified developers, and confirm that nobody is talking you into it.
  3. Restart the phone and sign in to it again.
  4. Come back after the one-day wait and confirm with your fingerprint, face or PIN, then choose to allow such apps for 7 days or indefinitely.

  Each install of such an app then warns that it comes from an unverified developer; tap **Install anyway**. You don't need to keep developer options on.
- **Updates** of an unregistered app fail while the advanced flow is off, so keep it on (indefinitely) to update FXM.
- **Installing with ADB** from a computer needs no verification and no waiting period: `adb install -r fxm-android-universal-<version>.apk`.

The exact screens may differ between phones. If FXM registers before the rollout, none of this will be needed.

## F-Droid

FXM isn't on F-Droid yet. When it is, F-Droid's builds will be signed with F-Droid's own key, so Android treats them as a different app source: to switch between F-Droid's build and the one from GitHub, export your library, uninstall FXM and install the other. F-Droid updates its builds itself, and they don't check GitHub for new versions.

Uninstall only to switch on purpose, with an APK you got from F-Droid or from FXM's GitHub Releases yourself. If an APK that claims to be an FXM update won't install over your FXM (see the table below), don't uninstall FXM to make room for it: it isn't signed with the key of the FXM you have.

## Uninstalling

**Settings → Apps → FXM → Uninstall** removes FXM with its library and settings. Export a backup in FXM's library first if you want to keep them.

## If something goes wrong

| What Android says | Why, and what to do |
|---|---|
| "App not installed as package conflicts with an existing package" | The APK and the FXM on your phone are signed with different keys. **Don't uninstall FXM to get past this.** If your FXM came from GitHub Releases, the APK isn't signed with FXM's key: it may be a changed copy, from an APK site or a link someone sent. Check its certificate ([Check the APK first](#check-the-apk-first-optional)) against the release notes and [`release-certificate.txt`](release-certificate.txt), and download it again from the [release page](https://github.com/Pratyay-ops/FXM/releases/latest). Only when you know the FXM on your phone is a development build or an F-Droid build, export your library, uninstall it and install the APK |
| "There was a problem parsing the package" | The download is incomplete, or the phone runs Android 6 or older. Download it again |
| The update fails although it installed before | From 2027: the advanced flow is off (see above) |
