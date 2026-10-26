# App updates (`features/app-update`)

The Android app's check for new versions of itself (stage 6.6). The APKs on GitHub Releases can't update themselves, so the app asks GitHub whether a new version is out and offers its download. It only finds out and offers: the browser downloads the APK, and Android's installer asks the user before it updates FXM. Releasing the APKs is described in [apps/mobile/RELEASING.md](../../../../mobile/RELEASING.md).

## Which builds check

`buildAppUpdateSupport()` (`support.ts`) decides once, from the build:

| Build | Checks? | Why |
|---|---|---|
| The Android app from GitHub Releases | Yes | Nothing else tells its users about a new version |
| The web app, the PWA | No | It updates itself by redeploy and its service worker (`features/pwa`) |
| The desktop app | No | It gets the Tauri updater (stage 7.5) |
| F-Droid builds (`FXM_DISTRIBUTION=fdroid`) | No | F-Droid updates them, and its inclusion policy forbids self-updates without an opt-in: `updatePolicy('fdroid').appUpdateCheck` of `@fxm/platform` is `false` |
| A build of 0.0.0 (development) | No | No released version to compare with, and a debug build's key couldn't take a release APK anyway |

`FXM_DISTRIBUTION` is a build flag: `vite.config.ts` builds it in as `import.meta.env.FXM_DISTRIBUTION`, and fails the build for any value but `standard`, `fdroid` (or `f-droid`) or none, so a typo can't turn an F-Droid build into one that checks (`distribution-flag.ts`, kept in step with `parseDistribution` by a test). `release-apk.sh` builds the GitHub APKs with `standard`; stage R.3's F-Droid recipe sets `fdroid`.

## The check

`checkForAppUpdate()` (`checks.ts`) sends one GET request to GitHub's API, `https://api.github.com/repos/Pratyay-ops/FXM/releases/latest`: the newest release that is neither a draft nor a pre-release. `fetchLatestRelease` (`releases.ts`) sends it without cookies, a `Referer` or the HTTP cache, follows no redirect and gives up after 15 s. It reads the release's tag (`vX.Y.Z`) and whether the universal APK, `fxm-android-universal-<version>.apk`, is among its uploaded files. The links it offers are built from the version (`apkDownloadUrl`, `releasePageUrl`), never taken from the answer. A version is newer when its x.y.z numbers are higher than the app's `APP_VERSION`.

It runs ten seconds after the app starts, then whenever one is due (looked at every 15 minutes while the app is in the foreground, when it comes back to it and when the device goes online): a day after the last successful check, an hour after a failed one, or later if GitHub's rate limit says so (60 requests an hour per address without a token). Offline, it asks nothing. One check runs at a time, and "Check now" in Settings joins the one under way. `CLEAN-ROOM.md` lists the facts about GitHub's API this relies on.

**The request.** It goes through the WebView's own `fetch` (`webUpdateFetch`, with `unpatchedFetch` from `@fxm/platform`), which GitHub's API allows from any origin. So GitHub sees the app's IP address and the WebView's `User-Agent`, as for any download from GitHub. The check takes any `UpdateFetch`: once the app's composition (stage 2.9) wires the native HTTP and `api.github.com` is on its host list, `updateFetchFromNative` of `@fxm/platform` sends it with the native client's reduced `User-Agent` and no `Origin`. The site's privacy page names the check.

## What the user sees

- **The toast** (`app-update-toast.tsx`): "FXM 0.6.0 is out." with **Not now** and **Download**, where the installable web app shows its own update toast (the two never show in the same build), above the player, or on a phone's Now Playing below the top bar. It keeps room for the app's confirmations (`useSpaceAbovePlayer` of `features/pwa/update-toast.tsx`). **Download** is a link to the APK, which the Android app hands to the browser (Capacitor opens links to other sites with the system), and either answer puts the offer away until a newer version is out; Escape works like **Not now**, and focus goes back to where it came from. The toast also starts the checks, so builds that don't check neither ask nor show anything.
- **Settings → About → Updates** (`app-update-setting.tsx`): what the last check found ("FXM 0.6.0 is out." with **Download the APK** and **What's new**, "You have the latest version. Checked 2 hours ago.", or why a check failed), what the check does, a link to [INSTALL.md](../../../../mobile/INSTALL.md#updates), and **Check now**, which stays enabled so it keeps focus. The result is announced in a polite live region. F-Droid builds say that F-Droid updates them; the web and desktop apps show nothing.

**Never installs by itself.** The app doesn't hold Android's `REQUEST_INSTALL_PACKAGES` permission (a test in `apps/mobile` keeps it that way), never downloads the APK, and offers it only as a link.

## State

`useAppUpdateStore` (`app-update-store.ts`) keeps, under `fxm.app-update.v1` in `localStorage`: the release the last successful check found (version, publication date, whether it has the APK), when the last check succeeded, when the next is due, and the version whose offer the user answered. Invalid stored values fall back to "never checked".

## Tests

`releases.test.ts` (parsing, versions, links, the request, 404 before the first release, rate limits, errors, the time limit), `checks.test.ts` (the schedule with fake timers, offline, failures, one check at a time, the stored state), `support.test.ts` (which builds check, the build flag), `app-update-toast.test.tsx` and `app-update-setting.test.tsx` (each state, focus, Escape, the web app showing neither). `testing.ts` has the fakes: GitHub's answers, a fake `UpdateFetch` and a store of its own.

```sh
scripts/run.sh pnpm vitest run apps/web/src/features/app-update
```
