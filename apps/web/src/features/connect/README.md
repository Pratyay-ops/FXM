# Tiers, onboarding and install guides (stage 2.7)

How FXM reaches music on this device, told to the user: the tier and why, what each tier plays, what this one is missing, how to get everything, and Settings → Diagnostics with a "resolve and play one song" self-test. Everything here builds on `@fxm/platform` (detection, FXM Connect's client, the Lite tier, the request budget) and `@fxm/core`; nothing talks to a server of FXM's, because there is none.

## The tiers

The tier follows from the platform's `NetworkCapabilities` alone (`tierOf` in `tiers.ts`), so the pages always agree with what the providers can reach ([ARCHITECTURE.md §8](../../../../../docs/ARCHITECTURE.md#8-platforms-and-network-transports)):

| Tier | `youtube` | Where | Adds |
|---|---|---|---|
| **Free only** | `none` | Any browser | Internet Archive and Jamendo (FLAC where offered), the library, lyrics, local files |
| **Lite** (experimental) | `simple` | A browser without FXM Connect that passes the Lite self-test, while the kill switch is off | YouTube Music: search, browse and ad-free audio |
| **Full** | `full` | FXM Connect, the desktop app, the Android app | Spotify (switchable), and later the Spotify account sync and downloads |

`RELEASED` in `config.ts` marks what isn't out yet ("Coming soon"), like the landing page's `AVAILABLE`: the stage that ships one of those flips its flag here too (R.2 for the Firefox and Edge add-ons, 7.5 for the desktop app, 6.6 for the APK, 3.5, 4.1, 4.4), and the pages follow. Nothing here offers an app that isn't out: where the copy names one, it says "coming soon", and its guide has no steps, only where to follow its release.

**What a device can get** (`device.ts`, `explain.ts`): FXM Connect can be added in Chromium browsers and Firefox on a computer (`canAddConnect`). Safari on a Mac is pointed to another browser on the same Mac; on iPhone and iPad there is nothing to install; on Android, the Android app once it is out (coming soon until then). `howToGetMore(device, wanted)` says it in one or two sentences, which the notices use, and the Lite line ("…so YouTube Music needs FXM Connect here" or "…isn't available in this browser") follows the same rules. The guides don't cover Firefox for Android yet: whoever flips `RELEASED.firefoxAddon` adds its steps (R.2's site copy has them).

## What the user sees

- **The onboarding page** (`/connect`, `connect-page.tsx`), in this order:
  - the status card, "This browser" (a heading): the tier and why (`explain.ts`), "What you're missing" in a line per tier above it (`MissingPanel`, `missingSummary`), and the main button, the install this device can do now ("Add FXM Connect to Chrome", `guideAction`), which opens its guide. No button where nothing can be installed (iPhone, iPad, Safari, Android until the app is out);
  - when FXM Connect is out of date or doesn't answer, what to do (warning panels, with the steps for the zip, the temporary Firefox add-on or, once `RELEASED` says so, the signed add-on and Edge Add-ons);
  - below Full, the install guides ("Get everything", or "Other devices and apps" where nothing can be installed), then the three tiers side by side with the current one marked (`tier-overview.tsx`); in Full, the tiers first and the guides for "Other browsers and apps".

  The guide that fits the device comes first, marked "For this device" (`device.ts`): Chromium browsers get FXM Connect's zip, Firefox its temporary add-on until Mozilla signs it, Android what plays there now and the Android app (coming soon), Safari, iPhone and iPad what works without an install (free sources, and Lite, unverified there), and Safari on a Mac the other browsers on it. It starts open unless FXM already has full access, decided once when the page renders (before detection is done, FXM Connect's marker on `<html>` is the guess), so a guide never opens or closes under the reader. The Chromium guide says that Developer mode must stay on, that updates are manual and that managed browsers may block it. Pages can't link to `chrome://` or `about:` addresses, so those come with a copy button. The status card, the panels and the guides keep their lines short (`max-w-3xl`); the tier cards take the page's width.
- **The upgrade prompt.** FXM Connect older than `MIN_CONNECT_VERSION` (`outdated`) isn't used; a notice links to the update steps (`/connect#update`).
- **"Isn't answering".** FXM Connect that worked in this browser before and doesn't answer now (`missing`: turned off, removed, or blocked by the browser or by Mozilla) gets a notice that links to what to do (`/connect#missing`). "I removed it" forgets it (`ConnectClient.forget`) and keeps the first-visit introduction away too (`removedOnPurpose`).
- **A first-visit introduction** without FXM Connect: what plays here (Free only, or "Try YouTube Music here without an install (experimental)" where Lite's check passed) and how this device gets more.

  Notices (`connect-notice.tsx`, `notices.ts`) float above the bottom bars: above the mini player on phones, in the corner above the player bar from 768 px. They never push the page down when detection finishes after the page painted; a spacer of their height at the end of the page keeps its last part reachable, and `--connect-notice-space` on `<html>` holds the room they take, for other floating layers: the app's toast (`FeedbackToast`) rises above them by that much, and they rise above the cards SponsorBlock stacks over the bars (`--shell-cards`), so no layer hides another. They come after the page in the document, in a polite live region. The introduction shows on the tab pages only (Home, Search, Library); the warnings on every page but Now playing and `/connect`, which says the same in place. Warnings have their own tone (the danger colour), the introduction the accent. Dismissing a notice, or "I removed it", moves keyboard focus to `<main>`; on `/connect`, "I removed it on purpose" moves it to the status card. A dismissed notice stays away for the same state and version (`fxm.connect.notices.v1` in `localStorage`).
- **Settings → FXM Connect** (`settings-entry.tsx`): in a browser, a lasting way back to `/connect`, also once the introduction is dismissed.
- **Settings → Diagnostics** (`diagnostics.tsx`, `#diagnostics`): the tier and why; FXM Connect's version and state, the Lite self-test, what YouTube and Spotify allow and the request budget's hour; **Check again**, which pings FXM Connect and re-runs the Lite self-test when FXM Connect gives no full access (one budget slot); and the song self-test.

## The song self-test

`runSongSelfTest` (`self-test.ts`) resolves Radiohead's "Creep" (`SELF_TEST_SONG`, a YouTube Music song stage 1.4's live tests resolve) and plays it for 3 seconds in a media element (`playback-probe.ts`). It walks the ladder as the playback policy (stage 2.3) does: the best stream the browser decodes under the default Wi-Fi ceiling (`pickStream`); when its first request fails, the last-resort rung (itag 18). In Lite the media element's first request is the probe: a media error, or a stall before the first `playing`, fails it. It reports each failure to the resolver once, so a test never cools a rung down more than a real failed play would, and it doesn't use the player, so a failure points at the resolver or the stream. The click primes the media element with a silent sound, so browsers that allow sound only after a tap let it play after the resolution.

## Touch-points with other stages

Each one is one small seam here, and the swap is a line or two:

| Stage | Seam | Until it is wired in | To wire it in |
|---|---|---|---|
| 1.4 stream resolver (built in parallel) | `SongResolver` (`resolver.ts`) | `unavailableResolver`: the self-test says this build can't resolve songs yet | `setSongResolver(fromAudioSource(createYouTubeAudioSource({ session, healthStore })))` where the app creates its YouTube providers |
| 1.3 / 1.13 remote config | `setKillSwitchSource()` (`kill-switches.ts`) | No kill switches | `setKillSwitchSource(() => config.killSwitches)`, then `recheckConnection()` when the config changes |
| 2.4 search | `ONBOARDING_URL` in `features/search/onboarding.tsx` | The landing page's "Get FXM" section | Point it at `/connect` |
| Every provider user (2.4 sources, the player) | `getAppPlatform()` (`app-platform.ts`) | — | `appSources.setPlatform(await getAppPlatform())`: one platform for the whole app |
| 2.2/2.3 player | The self-test plays in its own media element | — | Pause the main player before the self-test plays |
| 2.4 Settings → Sources (on `develop`) | `ConnectSettingsEntry` | Its own section before Diagnostics | Move it into Sources if that reads better |

`getAppPlatform()` is the app's one `createPlatform()`: with the Lite tier's sandbox documents in a browser, and the kill switches. The desktop and Android apps pick their native transport inside `createPlatform`. `startConnect()` (called once from `main.tsx`) loads it in a chunk of its own, beside the first render, and binds the connection store (`connection.ts`), which every component here reads with `useConnection`.

`createPlatform` resolves after its first detection, the Lite self-test included, which takes up to 10 s when the sandbox is slow. So `startConnect()` also asks FXM Connect on its own (`previewConnect()` in `preview.ts`, a short-lived `createConnectClient()`: at once without the marker, one more ping with it), and the store shows that answer until the platform is bound: phase `detecting`, with `connect` set and Lite `checking`. The pages then name the tier and the notices warn right away, and only the introduction waits for Lite's verdict. The store's first `platform` comes from the globals the apps put in place (`detectEnvironment()`), so the apps' pages never start as a browser's.

The sandbox documents live at `/sandbox/` on the FXM origin. `make dev` and `vite preview` don't serve them yet (stage 2.8 composes them into the deployed site), so locally the Lite self-test times out after 10 s and the page shows Free only.

## Tests

- **Unit tests** (`*.test.ts(x)`, part of `make test`): the tier rules, device detection, the sentences, the notices, the probe on a fake media element and a fake clock, the self-test with the fake resolver, and the connection store on the **real platform** from `@fxm/platform`, on its own happy-dom page with `installFakeConnect` and `createFakeSandbox` (`testing.ts`): Full, Lite, Free only, the kill switch, an outdated FXM Connect, one that goes missing, a re-check. The pages render with `renderApp` and a state put into the store, or the real platform.
- **Browser tests** (`apps/web/e2e/connect.spec.ts`, Playwright, Chromium, headless): the production build, with a fake FXM Connect that does what its content script does (an init script: the marker, and a pong per ping), and Playwright answering InnerTube in front of the **real** Lite sandbox document (`Access-Control-Allow-Origin: null` when Lite should work, a 403 without CORS headers when it shouldn't). Every other request off the machine is refused. They cover each tier, the upgrade prompt, a disabled FXM Connect, keyboard focus when a notice goes away, that a notice never moves the page (also after a slow Lite check: no layout shift), that SponsorBlock's offer and the app's toast keep clear of a notice on a phone, an Android phone and an iPhone, and the self-test with the fake resolver. `FXM_SCREENSHOTS=1` also saves the page, Home with its notice and Diagnostics in each tier and state (outdated, missing, on Android and iPhone) at 320, 768 and 1280 px in both themes, and the page in forced colors.

```sh
scripts/run.sh pnpm vitest run apps/web/src/features/connect
FXM_E2E_PORT=5710 scripts/run.sh pnpm --filter @fxm/web exec playwright test e2e/connect.spec.ts
```

**The development fake mode** (`dev-fakes.ts`): `make dev`, and builds made with `VITE_FXM_FAKES=on` (the Playwright config sets it), include a fake resolver. Open the app with `?fake-song=plays`, `capped`, `fails`, `bot-check` or `unavailable`; `?fake-song=off` turns it off. Its streams are WAV files made on the device (a soft tone) and a file no browser decodes. Production builds leave it out.

## Files

| File | What |
|---|---|
| `tiers.ts`, `config.ts` | The tiers, what each adds, and what is released |
| `connection.ts`, `app-platform.ts`, `preview.ts`, `kill-switches.ts`, `start.ts` | The connection store, the app's platform, FXM Connect's early answer, the kill switches and start-up |
| `explain.ts` | The sentences: the tier and why, FXM Connect, Lite, YouTube, Spotify, and how this device gets more |
| `device.ts` | Browser and system detection, what the device can add, and the guide that fits |
| `connect-page.tsx`, `tier-overview.tsx`, `install-guides.tsx`, `ui.tsx` | The onboarding page and its parts |
| `connect-notice.tsx`, `notices.ts` | The shell's notices and their dismissals |
| `settings-entry.tsx` | Settings → FXM Connect, the way back to the onboarding page |
| `diagnostics.tsx`, `self-test.ts`, `playback-probe.ts`, `resolver.ts`, `wav.ts` | Settings → Diagnostics and the song self-test |
| `fake-resolver.ts`, `dev-fakes.ts`, `testing.ts` | Fakes and test helpers |
