# Releasing the Android app

Stage 6.6. Every FXM release on GitHub carries the Android app as two signed APKs, built and signed by the release workflow ([docs/WORKFLOW.md, Releases](../../docs/WORKFLOW.md#8-releases)). This page is for the maintainer: the signing key, the release jobs, version codes, the in-app update check, and what Android's developer verification and F-Droid mean for FXM. People installing FXM read [INSTALL.md](INSTALL.md).

## What a release does

`.github/workflows/release.yml` runs two Android jobs next to the others, on the release commit of `main`:

| Job | What it does | Key |
|---|---|---|
| `android` | `apps/mobile/scripts/release-apk.sh build`: the web app with base `/` (`FXM_DISTRIBUTION=standard`), `cap sync android`, then Gradle's `assembleRelease` with `-PfxmReleaseApks`, which makes an APK for arm64-v8a and a universal one ([app/build.gradle](android/app/build.gradle)). Both unsigned, as the artifact `android-unsigned` | None |
| `android-sign` | `release-apk.sh sign`, in the `android-release` environment: the JDK and the Android SDK only, then apksigner signs both APKs and the script checks them. Uploads `release-android` | The four secrets below |

The publish job attaches `fxm-android-universal-<version>.apk` and `fxm-android-arm64-v8a-<version>.apk` to the release (they are listed for `release-android` in `fxm_release_catalog`, `scripts/release-lib.sh`), with their checksums and build provenance. The notes quote the signing certificate's SHA-256 fingerprint and link [INSTALL.md](INSTALL.md).

**It fails closed.** Without the four secrets, with a key whose certificate isn't the one pinned in [`release-certificate.txt`](release-certificate.txt), or while that file holds no fingerprint, `android-sign` fails, and with it the whole release: nothing is tagged or published. A release never carries an APK signed with another key, which phones would refuse as an update, or no APK at all. Fix the cause and re-run the failed jobs (WORKFLOW.md, "When something fails").

**What signing checks.** apksigner signs with APK Signature Scheme v2 and v3 (v1, the JAR scheme, isn't needed from Android 7, FXM's minimum, and v4 files aren't made) and refuses debuggable APKs. Then the script checks that each APK verifies with exactly one signer, that its certificate is the pinned one, that it is `io.github.pratyayops.fxm` with the release's version name and version code, and that the arm64-v8a APK holds no other processor's native code. The key goes into a temporary folder only for the two `apksigner sign` calls, and the passwords leave the environment before anything else runs.

**Why two jobs.** The build runs hundreds of npm packages, Gradle and its plugins. None of them ever sees the key: it reaches only the signing job, which runs nothing but the pinned JDK, Google's SDK tools and FXM's own script.

**Pull requests and `develop`** build only the debug APK (`.github/workflows/android.yml`), signed with each machine's own debug key.

## Version codes

Android installs an update only when its version code is at least the installed app's. `app/build.gradle` makes it from FXM's version: major × 1,000,000 + minor × 1,000 + patch, so 0.5.0 is 5000 and 1.2.3 is 1002003. Minor and patch must stay below 1,000 and major below 2,100 (Android's highest code is 2,100,000,000); the build fails otherwise. 0.0.0, the version before the first release, gets 1. Both APKs of a release share its code, so switching between them is a reinstall, not a downgrade.

## The signing key

### Create it, once

```sh
scripts/make-android-keystore.sh ~/fxm-android-key
```

It runs keytool from the JDK in `.tools` (`make android-setup`) and writes, into a folder that must be outside every git checkout:

- `fxm-android.p12`: a PKCS12 keystore with one RSA 4096 key under the alias `fxm`, and a self-signed certificate named only `CN=FXM`, valid for about 30 years;
- `fxm-android-password.txt`: a random 48-digit password, the keystore's and the key's (PKCS12 keeps one password);
- `README.txt`: what the files are and the certificate's fingerprint.

Everything is readable by you alone, the password never appears on a command line, and the script never replaces a key. It prints the fingerprint, the secrets and the commands below.

### Secrets

The key lives in the GitHub environment `android-release`, which only runs on `main` can use, like the store keys in `stores`. Create it once (from the repository folder, with the GitHub CLI, `make gh-setup`):

```sh
scripts/run.sh gh api -X PUT 'repos/{owner}/{repo}/environments/android-release' --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
scripts/run.sh gh api -X POST 'repos/{owner}/{repo}/environments/android-release/deployment-branch-policies' \
  -f name=main -f type=branch
```

Then set the four secrets, as the script prints them:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The keystore, Base64 on one line: `openssl base64 -A -in fxm-android.p12` |
| `ANDROID_KEYSTORE_PASSWORD` | The password in `fxm-android-password.txt` |
| `ANDROID_KEY_ALIAS` | `fxm` |
| `ANDROID_KEY_PASSWORD` | The same password |

### Pin the certificate

Replace the placeholder line in [`release-certificate.txt`](release-certificate.txt) with the fingerprint the script printed (`AB:CD:…`, with or without colons), and commit it to `develop`. From then on a release signs only with that key, and the release notes quote it.

### Keep an offline copy

Android never lets an update replace an app signed with another key. If the key is lost, no FXM update can ever install over the copies on people's phones. Keep `fxm-android.p12` and `fxm-android-password.txt` in two offline places that you control, such as an encrypted USB drive and a password manager entry, then delete the folder from the computer. Once a year, check that a copy still opens: `keytool -list -keystore fxm-android.p12 -storetype PKCS12` with the password.

### If the key is lost or leaks

- **Lost, or the secrets are gone:** restore the secrets from the offline copy. Without any copy, FXM can only start again: make a new key, pin its certificate, and tell people to export their library, uninstall FXM and install the new APK.
- **Leaked:** someone could sign APKs that phones accept as FXM updates. Make a new key and rotate to it with APK Signature Scheme v3's key rotation (`apksigner rotate`, which needs the old key too), sign later releases with the rotation's lineage (`apksigner sign --lineage`, which `release-apk.sh` would need to pass), pin the new certificate, replace the secrets and warn people in the release notes. Android 9 and later follow a rotation; Android 7 and 8 keep checking the old key.

### Dry runs

- **On a branch:** `scripts/run.sh gh workflow run android.yml --ref <branch> -f release=true` builds the release APKs as the release job does and signs them with a throwaway key made in the run's temporary folder, then uploads them as the artifact `fxm-android-dry-run`. It never uses FXM's key, tags or publishes anything.
- **Locally:** `make apk-release DRY_RUN=1` with a throwaway key in the environment:

  ```sh
  scripts/make-android-keystore.sh /tmp/fxm-throwaway-key
  export ANDROID_KEYSTORE_FILE=/tmp/fxm-throwaway-key/fxm-android.p12 ANDROID_KEY_ALIAS=fxm
  export ANDROID_KEYSTORE_PASSWORD="$(cat /tmp/fxm-throwaway-key/fxm-android-password.txt)"
  export ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
  make apk-release DRY_RUN=1   # dist/android/release
  ```

  `ANDROID_KEYSTORE_FILE` takes the place of `ANDROID_KEYSTORE_BASE64` for local builds. Without `DRY_RUN=1` the pinned certificate is checked, as in a release.
- **The signing scripts' tests:** `make apk-sign-test` (the Android workflow runs it) checks `make-android-keystore.sh` and `release-apk.sh sign` offline, with a throwaway key and small APKs that aapt2 links from a bare manifest.

## The in-app update check

The APKs from GitHub Releases ask GitHub's API once a day for the latest release, compare its version with their own, and offer the APK's download link in a toast and in Settings → About → Updates. They never download or install anything themselves, and the app doesn't hold Android's permission to install apps: the browser downloads the APK, and Android's installer asks before it updates FXM. F-Droid builds (`FXM_DISTRIBUTION=fdroid`) don't check, as F-Droid's inclusion policy requires. Details: [apps/web/src/features/app-update/README.md](../web/src/features/app-update/README.md).

Fewer APK updates are needed than YouTube changes suggest: the signed YouTube config and resolver module of stage 1.13 are built to reach the desktop and Android apps from FXM's website between app releases. That matters more from 2027, when each update of an unregistered app needs the advanced flow (below).

## Android developer verification (from 2027)

FXM is unregistered for now (Decision 3, option B, 2026-10-25), and the owner revisits verification before the global rollout. The facts, as Google's pages stated them on 2026-10-26:

| Fact | Source |
|---|---|
| Since 2026-09-30, apps from participating app stores install on certified devices in Brazil, Indonesia, Singapore and Thailand only when their developer registered them. It expands to all certified devices worldwide in 2027 (no month given). Sideloading from elsewhere isn't affected before that | [Overview](https://developer.android.com/developer-verification); [FAQ](https://developer.android.com/developer-verification/guides/faq) (updated 2026-09-30) |
| Unregistered apps then install through the *advanced flow*: developer options on, a check that nobody is coaching the user, a restart and sign-in, a one-time one-day wait, confirmation with biometrics or the PIN, then permission for 7 days or indefinitely. Each install warns, with "Install Anyway" | FAQ |
| "If the advanced flow is disabled updates to unregistered apps will fail." ADB installs need no verification and skip the wait | FAQ |
| A full distribution account costs USD 25 once; an individual submits a government-issued photo ID and a proof of address, and an e-mail address and a phone number verified by one-time codes | FAQ (entry of 2026-03-25); [Full distribution](https://developer.android.com/developer-verification/guides/full-distribution) (updated 2026-08-18) |
| A limited distribution account is free, needs no government ID (a Google payments profile with the legal name and address, and 2-step verification), and shares apps with up to 20 devices whose users authorize them by QR code or link | [Limited distribution](https://developer.android.com/developer-verification/guides/limited-distribution) (updated 2026-10-23) |
| Registering an app: its package name and its signing certificate's SHA-256; for an existing package, proof of ownership by uploading an APK signed with the key that holds the console's snippet in `assets/adi-registration.properties`. One package can have several keys. "If you lose your signing key you won't be able to register your packages" | [Android Developer Console](https://developer.android.com/developer-verification/guides/android-developer-console) (updated 2026-09-30); [Open-source apps](https://developer.android.com/developer-verification/guides/open-source-app-registration) (updated 2026-10-23); FAQ |

To decide before the rollout: register with a full account (FXM installs and updates as usual for everyone), with a limited account (up to 20 devices: personal use), or stay unregistered (people use the advanced flow or ADB). Registering would mean, for this repository:

1. Register `io.github.pratyayops.fxm` with the fingerprint in `release-certificate.txt`.
2. Put the console's snippet into `android/app/src/main/assets/adi-registration.properties` (outside the `public/` folder that `cap sync` writes) and commit it.
3. Release a version and upload its universal APK to the console.

INSTALL.md describes the advanced flow for users; update it when FXM registers.

## F-Droid's re-signing key (stage R.3)

F-Droid builds the apps it lists from source and signs each with a key of its own, which it generates per app and keeps on an air-gapped machine ([Security Model](https://f-droid.org/docs/Security_Model/), read 2026-10-26). So F-Droid's FXM will carry another certificate than the GitHub APKs: Android treats them as different sources, and people switch between them only by reinstalling. F-Droid publishes the SHA-256 of every app's signer in [`signer-index.json`](https://f-droid.org/repo/signer-index.json), "the source of truth for determining the official f-droid.org signer for any given APK" ([All our APIs](https://f-droid.org/docs/All_our_APIs/), read 2026-10-26).

If FXM registers for developer verification, F-Droid's key must be registered for the same package too, or F-Droid's builds stop installing the usual way. Google's steps for apps that a repository re-signs ([Open-source apps](https://developer.android.com/developer-verification/guides/open-source-app-registration), updated 2026-10-23):

1. Download F-Droid's APK of FXM and read its certificate's SHA-256: `apksigner verify --print-certs <apk>`. Check it against FXM's entry in `signer-index.json`.
2. In the Android Developer Console, open the registered package name and add the key: **Select key** and pick that fingerprint from the eligible ones, or, while the app has fewer than 50 known installs, **Add key** and enter it. If it isn't listed, **Show another way to register**, then **Show fingerprints for other keys**.
3. If the console asks to verify ownership: copy its snippet into `assets/adi-registration.properties`, release a version through F-Droid, download F-Droid's APK of it and upload that to the console.

A repository that uses the Android Developer Console's API can register keys on the developer's behalf; whether F-Droid will is open.

**The alternative: reproducible builds.** If F-Droid's build of FXM is byte-for-byte the same as FXM's own, apart from the signature, F-Droid publishes FXM's signed APK instead of signing its own (`Binaries` and `AllowedAPKSigningKeys` in F-Droid's metadata, checked with apksigcopier). There is then one key to register, and people can move between F-Droid and GitHub without reinstalling. F-Droid's [Reproducible Builds](https://f-droid.org/docs/Reproducible_Builds/) page (read 2026-10-26) warns that v2 and v3 signatures need identical APKs and that apksigner from build tools 34 is known to work with apksigcopier while newer versions may not; FXM signs with build tools 35.0.0, so R.3 checks this first.

F-Droid builds set `FXM_DISTRIBUTION=fdroid` when they build the web app: FXM's own update check is then off, and stage 1.13's downloaded YouTube code waits for the user's opt-in.
