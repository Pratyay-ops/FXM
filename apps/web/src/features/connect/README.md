# Tiers, onboarding and install guides (stage 2.7)

How FXM reaches music on this device, told to the user: the tier and why, what each tier plays, what this one is missing, how to get everything, and Settings → Diagnostics with a "resolve and play one song" self-test. Everything here builds on `@fxm/platform` (detection, FXM Connect's client, the Lite tier, the request budget) and `@fxm/core`; nothing talks to a server of FXM's, because there is none.

## The tiers

The tier follows from the platform's `NetworkCapabilities` alone (`tierOf` in `tiers.ts`), so the pages always agree with what the providers can reach ([ARCHITECTURE.md §8](../../../../../docs/ARCHITECTURE.md#8-platforms-and-network-transports)):

| Tier | `youtube` | Where | Adds |
|---|---|---|---|
| **Free only** | `none` | Any browser | Internet Archive and Jamendo (FLAC where offered), the library, lyrics, local files |
| **Lite** (experimental) | `simple` | A browser without FXM Connect that passes the Lite self-test, while the kill switch is off | YouTube Music: search, browse and ad-free audio |
| **Full** | `full` | FXM Connect, the desktop app, the Android app | Spotify (switchable), the Spotify account sync and downloads |

`RELEASED` in `config.ts` marks what isn't out yet ("Coming soon"), like the landing page's `AVAILABLE`: the stage that ships one of those flips its flag here too (R.2 for the Firefox and Edge add-ons, 7.5 for the desktop app, 6.6 for the APK; downloads, 4.2's conversions, 3.5's Spotify account sync, local files and 5.2's embeddable player, whose flag turned on with the site's `AVAILABLE.embed` and brings the app's Share entry to production builds, are out), and the pages follow. Nothing here offers an app that isn't out: where the copy names one, it says "coming soon", and its guide has no steps, only where to follow its release. The app's other sentences that name the apps are built the same way (`connectOrApps`, `connectExtensionOrApps`, `appsReachSentence`, `appsSentence` in `explain.ts`): search's entry point and states, the Spotify setting, Home's notes, the downloads panel and its errors, the playback problems and the imports' notice.

**What a device can get** (`device.ts`, `explain.ts`): FXM Connect can be added in Chromium browsers and Firefox on a computer (`canAddConnect`). Safari on a Mac is pointed to another browser on the same Mac; on iPhone and iPad there is nothing to install; on Android, the Android app once it is out (coming soon until then). `howToGetMore(device, wanted)` says it in one or two sentences, which the notices use, and the Lite line ("…so YouTube Music needs FXM Connect here" or "…isn't available in this browser") follows the same rules. The pages that offer FXM Connect elsewhere follow them too: `reachSentence(what)` (search's entry point and states), `howToGetMore(device, 'youtube')` (Home's notes, the imports' notice, the playback problems) and `howToGetMore(device, 'youtube-downloads')` (the downloads panel) say FXM Connect where this browser can add it and what the device can do instead elsewhere, and their buttons say "Get FXM Connect" only where something can be installed, "See your options" otherwise (`getMoreLabel`). The guides don't cover Firefox for Android yet: whoever flips `RELEASED.firefoxAddon` adds its steps (R.2's site copy has them).

## What the user sees

- **The onboarding page** (`/connect`, `connect-page.tsx`), in this order:
  - the status card, "This browser" (a heading): the tier and why (`explain.ts`), "What you're missing" in a line per tier above it (`MissingPanel`, `missingSummary`), and the main button, the install this device can do now ("Add FXM Connect to Chrome", `guideAction`), which opens its guide. No button where nothing can be installed (iPhone, iPad, Safari, Android until the app is out);
  - when FXM Connect is out of date or doesn't answer, what to do (warning panels, with the steps for the zip, the temporary Firefox add-on or, once `RELEASED` says so, the signed add-on and Edge Add-ons);
  - below Full, the install guides ("Get everything", or "Other devices and apps" where nothing can be installed), then the three tiers side by side with the current one marked (`tier-overview.tsx`); in Full, the tiers first and the guides for "Other browsers and apps".

  The guide that fits the device comes first, marked "For this device" (`device.ts`): Chromium browsers get FXM Connect's zip, Firefox its temporary add-on until Mozilla signs it, Android what plays there now and the Android app (coming soon), Safari, iPhone and iPad what works without an install (free sources, and Lite, unverified there), and Safari on a Mac the other browsers on it. It starts open unless FXM already has full access, decided once when the page renders (before detection is done, FXM Connect's marker on `<html>` is the guess), so a guide never opens or closes under the reader. The Chromium guide says that Developer mode must stay on, that updates are manual and that managed browsers may block it. Pages can't link to `chrome://` or `about:` addresses, so those come with a copy button. The status card, the panels and the guides keep their lines short (`max-w-3xl`); the tier cards take the page's width.
- **The upgrade prompt.** FXM Connect older than `MIN_CONNECT_VERSION` (`outdated`) isn't used; a notice links to the update steps (`/connect#update`).
- **"Isn't answering".** FXM Connect that worked in this browser before and doesn't answer now (`missing`: turned off, removed, or blocked by the browser or by Mozilla) gets a notice that links to what to do (`/connect#missing`). "I removed it" forgets it (`ConnectClient.forget`) and keeps the first-visit introduction away too (`removedOnPurpose`).
- **A first-visit introduction** without FXM Connect: what plays here (Free only, or "Try YouTube Music here without an install (experimental)" where Lite's check passed) and how this device gets more.

  Notices (`connect-notice.tsx`, `notices.ts`) float above the bottom bars: above the mini player on phones, in the corner above the player bar from 768 px. They never push the page down when detection finishes after the page painted. `--connect-notice-space` on `<html>` holds the room they take: the page adds it to the room at its end (`pb-shell`) and to its `scroll-padding-bottom` (`styles/index.css`), so its last part scrolls clear and keyboard focus never lands behind a notice, and other floating layers use it too: the app's toasts (`FeedbackToast`, and the installable app's `UpdateToast`) rise above them by that much, and they rise above the cards SponsorBlock stacks over the bars (`--shell-cards`), so no layer hides another. They come after the page in the document, in a polite live region. The introduction shows on the tab pages only (Home, Search, Library); the warnings on every page but Now playing and `/connect`, which says the same in place. Warnings have their own tone (the danger colour), the introduction the accent. Dismissing a notice, or "I removed it", moves keyboard focus to `<main>`; on `/connect`, "I removed it on purpose" moves it to the status card. A dismissed notice stays away for the same state and version (`fxm.connect.notices.v1` in `localStorage`).
- **Settings → FXM Connect** (`settings-entry.tsx`): in a browser, a lasting way back to `/connect`, also once the introduction is dismissed.
- **Settings → Diagnostics** (`diagnostics.tsx`, `#diagnostics`): the tier and why; FXM Connect's version and state, the Lite self-test, what YouTube and Spotify allow and the request budget's hour; **Check again**, which pings FXM Connect and re-runs the Lite self-test when FXM Connect gives no full access (one budget slot); the song self-test; the YouTube audio check after it; and **Copy report**.

## The song self-test

`runSongSelfTest` (`self-test.ts`) resolves Radiohead's "Creep" (`SELF_TEST_SONG`, a YouTube Music song stage 1.4's live tests resolve) and plays it for 3 seconds in a media element (`playback-probe.ts`). It walks the ladder as the playback policy (stage 2.3) does: the best stream the browser decodes under the default Wi-Fi ceiling (`pickStream`); when its first request fails, the last-resort rung (itag 18). In Lite the media element's first request is the probe: a media error, or a stall before the first `playing`, fails it. It reports each failure to the resolver once, so a test never cools a rung down more than a real failed play would, and it doesn't use the player, so a failure points at the resolver or the stream. The click primes the media element with a silent sound, so browsers that allow sound only after a tap let it play after the resolution.

## The YouTube audio check

Playing a song doesn't show that FXM can read its audio: a media element plays googlevideo without CORS, while YouTube downloads and the equalizer read the bytes through FXM Connect's CORS rule. They can come apart, as on an office laptop whose traffic went through a corporate proxy: googlevideo answered `302` to another of its servers (`cms_redirect`), the browser then sent `Origin: null`, which FXM Connect 0.2.0's `Access-Control-Allow-Origin` (FXM's origin) doesn't match, and its `302` carried no CORS header at all. Songs played; downloads and the equalizer couldn't read a byte.

The "YouTube audio" row (`audio-check.ts`) shows that on any machine. With FXM Connect, in the Full tier, it runs after the song self-test on the stream the self-test ended on (the one that played, or the last one tried), so it makes no YouTube API call of its own, and it sends at most two `fetch`es to googlevideo (one that follows a redirect also reaches the server it points to), each with a 10 s limit:

1. a CORS `GET` of the first kilobyte (`Range: bytes=0-1023`) with `redirect: 'manual'`, without cookies or the HTTP cache: an answer the page can read is the result; an `opaqueredirect` means googlevideo redirected; a network error means the answer couldn't be read;
2. after a redirect, the same request following it; after a network error, a `no-cors` request, which tells an answer the browser hid from the page from no answer at all (it can't carry `Range`, so it stops once its headers arrive).

Asking with `redirect: 'manual'` first keeps the check to two requests. Chromium applies the CORS check to the redirect itself, so a `302` without `Access-Control-Allow-Origin` reads as refused rather than redirected.

| Result | What the row says | What to do |
|---|---|---|
| Readable | FXM Connect can read YouTube audio here, so YouTube downloads and the equalizer work. (After a redirect: "…, also after YouTube sent the request on to another server, …") | — |
| Redirected to another server and not readable | YouTube sent the request on to another server, and the browser wouldn't let FXM Connect read the audio from there, so YouTube downloads and the equalizer don't work. | FXM Connect older than 0.2.1 (`CONNECT_REDIRECT_FIX_VERSION`): "Update FXM Connect to the latest version." 0.2.1 or later: "This browser or network stops FXM Connect from reading YouTube audio." |
| Refused (CORS) | YouTube's audio server answered, but the browser wouldn't let FXM Connect read the audio, so YouTube downloads and the equalizer don't work. | As above |
| Unreachable | The browser couldn't get anything from YouTube's audio server on this page, so YouTube downloads and the equalizer don't work. | "This browser or network stops FXM Connect from reading YouTube audio." |
| HTTP error 403 (any status outside 200–299) | YouTube's audio server refused the request (5xx: had a problem with the request). | Run the self-test again. If the error stays, YouTube may be refusing audio to this network. (5xx: Try again in a few minutes.) |
| Timed out | YouTube's audio server didn't answer within 10 s. | Check the connection and run the self-test again. |
| Not tested | Without FXM Connect: "Without FXM Connect, this browser can't read YouTube audio, so YouTube downloads and the equalizer aren't available here." In Lite: "In Lite, YouTube songs play, but this browser can't read their audio, so YouTube downloads and the equalizer aren't available here." It also says why in the apps, when the self-test found no stream, and when its stream isn't on googlevideo (the development fakes). | — |

The self-test's **Stop** stops the check too. The results keep googlevideo's host name only, never the URL.

**Verified in a browser (2026-10-28).** Headless Chromium 1248 (Playwright 1.64.0, `--mute-audio`) against a local HTTPS server answering for FXM's page and two googlevideo host names (mapped to 127.0.0.1, so nothing left the machine): a `206` with FXM's origin in `Access-Control-Allow-Origin` read as readable; a `302` without CORS headers, as refused (the office laptop's case); a `302` with FXM's origin, to a server answering FXM's origin, as redirected (the second server saw `Origin: null`); a `302` and a second server both with `*` (FXM Connect 0.2.1's fix), as readable after a redirect; a `206` or `403` without CORS headers, as refused; a `403` with them, as HTTP error 403; a dropped connection, as unreachable; no answer, as timed out.

## The copied report

**Copy report** (`diagnostics-report.ts`) puts the section on the clipboard as plain text for a bug report: FXM's version, the platform, the system, the browser and its major version (User-Agent Client Hints' brands where the browser has them, else the `User-Agent` string; never the string itself), the tier, FXM Connect's version and features, each check's result in the page's words, and the host name of YouTube's audio server (`rr3---sn-….googlevideo.com`). It is built from those values, never from a URL, so it holds no full URLs, query strings, signatures, IP addresses, tokens or cookies, and a last pass (`redactReport`) removes anything that looks like one anyway. Where the browser refuses the clipboard, the report shows in a field to copy by hand.

## Touch-points with other stages

Each one is one small seam here, and the swap is a line or two:

| Stage | Seam | Until it is wired in | To wire it in |
|---|---|---|---|
| 1.4 stream resolver (built in parallel) | `SongResolver` (`resolver.ts`) | `unavailableResolver` until YouTube's code has loaded | Wired by the composition root (stage 2.9, `src/app/services/index.ts`): `setSongResolver(fromAudioSource(youtube.audio))` once YouTube's code has loaded, unless the fake mode set a resolver. That can be after Settings rendered, so the resolver is a store: Diagnostics reads it with `useSongResolver()` and renders again when it arrives |
| 1.3 / 1.13 remote config | `setKillSwitchSource()` (`kill-switches.ts`) | No kill switches until YouTube's code has loaded | Wired by the composition root (2.9, 2.9b): the kill switches of the YouTube config in use, the bundled one or a newer signed one from the site, and `recheckConnection()` whenever the Lite switch changes |
| 2.4 search | `ONBOARDING_URL` in `features/search/onboarding.tsx` | — | Wired (2.9b): `/connect`, in the app. Home's "Get FXM Connect" (`GET_FXM_URL`) and the imports' notice link there too |
| Every provider user (2.4 sources, the player) | `getAppPlatform()` (`app-platform.ts`) | — | Wired by the composition root (2.9), which creates its services on it and puts it in the sources registry: one platform for the whole app. It is created with `reportLoginRequired: false`, since the stream ladder reports the bot checks itself |
| 2.2/2.3 player | The self-test plays in its own media element | — | Pause the main player before the self-test plays |
| 2.4 Settings → Sources (on `develop`) | `ConnectSettingsEntry` | Its own section before Diagnostics | Move it into Sources if that reads better |

`getAppPlatform()` is the app's one `createPlatform()`: with the Lite tier's sandbox documents in a browser, the kill switches, and the hosts outside the platform's table: those the composition root passes (`setAppUserHosts`: the Spotify secret's) and those of the plugins that are on (stage 8.3, `pluginUserHosts`), which a browser reaches through the sandbox's user-host document. The desktop and Android apps pick their native transport inside `createPlatform`. `startConnect()` (called once from `main.tsx`) loads it in a chunk of its own, beside the first render, and binds the connection store (`connection.ts`), which every component here reads with `useConnection`.

`createPlatform` resolves after its first detection, the Lite self-test included, which takes up to 10 s when the sandbox is slow. So `startConnect()` also asks FXM Connect on its own (`previewConnect()` in `preview.ts`, a short-lived `createConnectClient()`: at once without the marker, one more ping with it), and the store shows that answer until the platform is bound: phase `detecting`, with `connect` set and Lite `checking`. The pages then name the tier and the notices warn right away, and only the introduction waits for Lite's verdict. The store's first `platform` comes from the globals the apps put in place (`detectEnvironment()`), so the apps' pages never start as a browser's.

The sandbox documents live at `/sandbox/` on the FXM origin. `make dev` and `vite preview` don't serve them yet (stage 2.8 composes them into the deployed site), so locally the Lite self-test times out after 10 s and the page shows Free only.

## Tests

- **Unit tests** (`*.test.ts(x)`, part of `make test`): the tier rules, device detection, the sentences, the notices, the probe on a fake media element and a fake clock, the self-test with the fake resolver, the YouTube audio check with a fake `fetch` (each result, the time limit, Stop), the copied report (its lines, the browser and system names, and that it never holds a URL, a query string, a signature, an IP address, a token or a cookie), the Diagnostics rows and Copy report with a fake clipboard, and the connection store on the **real platform** from `@fxm/platform`, on its own happy-dom page with `installFakeConnect` and `createFakeSandbox` (`testing.ts`): Full, Lite, Free only, the kill switch, an outdated FXM Connect, one that goes missing, a re-check. The pages render with `renderApp` and a state put into the store, or the real platform.
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
| `diagnostics.tsx`, `diagnostics-text.ts`, `self-test.ts`, `playback-probe.ts`, `resolver.ts`, `wav.ts` | Settings → Diagnostics, its sentences and the song self-test |
| `audio-check.ts`, `diagnostics-report.ts` | The YouTube audio check and the copied report |
| `fake-resolver.ts`, `dev-fakes.ts`, `testing.ts` | Fakes and test helpers |
