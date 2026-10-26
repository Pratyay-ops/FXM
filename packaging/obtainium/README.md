# Obtainium

[Obtainium](https://github.com/ImranR98/Obtainium) installs Android apps straight from their releases on GitHub and keeps them up to date. It needs nothing from FXM but its GitHub releases with the APK (stage 6.6): there is nothing to submit and nobody to ask. These links add FXM to it.

<!-- channels sync: links -->

| Link | What it does |
|---|---|
| [Add FXM to Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fapp%2F%257B%2522id%2522%253A%2522io.github.pratyayops.fxm%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fgithub.com%252FPratyay-ops%252FFXM%2522%252C%2522author%2522%253A%2522Pratyay-ops%2522%252C%2522name%2522%253A%2522FXM%2522%252C%2522preferredApkIndex%2522%253A0%252C%2522additionalSettings%2522%253A%2522%257B%255C%2522includePrereleases%255C%2522%253Afalse%252C%255C%2522apkFilterRegEx%255C%2522%253A%255C%2522%255Efxm-android-universal-%255C%255C%255C%255Cd%252B%255C%255C%255C%255C.%255C%255C%255C%255Cd%252B%255C%255C%255C%255C.%255C%255C%255C%255Cd%252B%255C%255C%255C%255C.apk%2524%255C%2522%252C%255C%2522invertAPKFilter%255C%2522%253Afalse%252C%255C%2522autoApkFilterByArch%255C%2522%253Afalse%257D%2522%257D) | Imports FXM with its settings: releases only, and always the universal APK, `fxm-android-universal-<version>.apk`. Obtainium shows the settings before it adds anything |
| [Open FXM's repository in Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fadd%2Fhttps%3A%2F%2Fgithub.com%2FPratyay-ops%2FFXM) | Opens Obtainium's Add App screen with `https://github.com/Pratyay-ops/FXM` filled in, as `obtainium://add/https://github.com/Pratyay-ops/FXM`. Obtainium then asks which APK to install when a release has more than one |

<!-- /channels sync: links -->

Both go through Obtainium's own web page, `apps.obtainium.imranr.dev/redirect`, which opens the `obtainium://` link on the phone and offers Obtainium when it isn't installed. GitHub's Markdown, like many pages, doesn't let `obtainium://` links be clicked. The links work once a release carries the APK.

## For people using it

Each FXM release has two APKs, a universal one and one for 64-bit ARM phones; while FXM has no native code they hold the same app. The import picks the universal one, so Obtainium never has to guess from the phone's processor. Android itself checks that every update is signed with the same key as the FXM you installed.

To check the first install as well, Obtainium can hold FXM's release certificate. Once stage 6.6 pins it in `apps/mobile/release-certificate.txt`, the import link above sets it for you. Otherwise, set it yourself: open FXM in Obtainium, then **App settings** → **Expected signing certificate hashes**, and paste the SHA-256 fingerprint that the release notes quote. Obtainium then refuses an APK signed with any other key.

Updates of FXM's F-Droid build come from F-Droid instead: F-Droid signs it with its own key, so Obtainium can't update it with a GitHub APK, unless F-Droid publishes FXM's own APKs through reproducible builds ([F-Droid](../fdroid/README.md#signing-f-droids-key-or-reproducible-builds)).

## For the owner

`channels sync` writes the table above from [`obtainium.ts`](obtainium.ts), and `scripts/run.sh pnpm --filter @fxm/packaging --silent channels obtainium` prints the same links. Both pin FXM's release certificate once `apps/mobile/release-certificate.txt` pins it (stage 6.6): from that commit on, the tests fail until `channels sync` has written the pinned link here, so the table never offers an import without the certificate once there is one.

The links work from the first release that carries the APK (stage 6.6). Then put the import link where people install FXM: in `apps/mobile/INSTALL.md` (stage 6.6) and on the site's Android download card, next to the APK. Copy it from this table or from `channels obtainium` after the certificate is pinned, and copy it again if the certificate ever changes.

[apps.obtainium.imranr.dev](https://apps.obtainium.imranr.dev) also lists configurations that people contribute through pull requests to [its repository](https://github.com/ImranR98/apps.obtainium.imranr.dev). FXM doesn't need one, and FXM's tools never open pull requests in other repositories.

Sources, read 2026-10-26: Obtainium's [deep links](https://wiki.obtainium.imranr.dev/deep_links/) (`obtainium://add/<url>`, `obtainium://app/<json>` and the redirect page), its configurations' settings (`apps.obtainium.imranr.dev`'s data), the defaults it fills in for settings an import leaves out (`appJSONCompatibilityModifiers`, `lib/providers/app_json_migration.dart`) and its certificate check (`allowedSigningCertHashes`, `lib/utils/signing_cert_utils.dart`).
