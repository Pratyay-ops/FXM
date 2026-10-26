# The composition root (stage 2.9)

The one place where the web app builds the real pieces of the earlier stages and plugs them into the seams its pages use. Stages 2.3 to 2.6, and the stages after them, were built in parallel against fakes behind small adapters; this folder is what replaces the fakes. Everything runs on the user's device: FXM has no servers.

**The first render waits for nothing.** `main.tsx` renders the shell at once and loads this folder beside it, in a chunk of its own (`import('./app/services')`, then `startAppServices()`), so the app's first bundle carries none of the platform, the stream lifecycle, the providers, the library or local files (on 2026-10-26, after stages 2.5, 2.6, 4.1, 4.3, 4.4 and 8.7 merged: the first bundle 474 KB, 150 KB gzipped, with the app's player and the shell; this folder's chunk 52 KB, 18 KB gzipped, the lifecycle 24 KB beside it). The pages follow the sources registry as the platform detects the tier and the providers register.

**The app's player** is stage 2.5's (`features/now-playing/playback.ts`), created with the first render, which the player bars, Now playing, the queue and the system media controls show, and which records each play as a listening signal (stage 3.1). It plays through `createAppPolicy()` (`features/now-playing/playback-policy.ts`), which follows whichever policy is connected and makes what the player asks before then wait for it. `startAppServices()` connects this folder's `policy` (with local files in front, `withLocalFilesFirst` from stage 4.4, so they never reach the lifecycle) and the player (`connectPlayer`) first: the policy's resolver waits for the platform itself, so the play buttons work while FXM Connect answers. Where the services don't run (the development fake catalog) or can't start, it connects the stand-in instead (`createPendingPolicy()`), which plays local files only and stops on anything else with a reason rather than wait.

**While FXM Connect answers** (`connecting.ts`): its content script marks `<html>` before FXM's code runs, but answers the ping only once its service worker is up, which can take a second or two. So `main.tsx` calls `markConnecting(appSources)` before the first render: while the marker is on the page, the registry's snapshot says `detecting`, and the pages show "Connecting to FXM Connect…" instead of the Free tier's install pitch. The composition root ends that as soon as FXM Connect answers, even after the platform's 800 ms wait (its client still hears a late answer), and the grace period of 5 s at the latest: an FXM Connect that never answers is as good as none.

## What it builds

| Piece | Stage | Here |
|---|---|---|
| Platform: transports, capabilities, the shared request budget | 1.2 | `createPlatform`, through the `createPlatform` option (tests pass one over a fake network); in the desktop and Android apps it picks their native HTTP itself (stages 7.2 and 6.2) |
| YouTube session and metadata providers | 1.3 | `youtube.ts`: loaded on first use, one session for the device |
| YouTube audio source: VISIONOS, then itag 18 | 1.4 | `youtube.ts`: the playback policy's `ytm` stream source |
| Spotify, behind the Spotify switch | 1.5 | a lazy provider, registered only where its secret can be fetched (below); on while the switch is |
| Internet Archive, Jamendo, MusicBrainz | 1.6 | lazy providers and stream sources; MusicBrainz finds a Spotify track's ISRC when Spotify can't |
| Matching engine and its searches | 1.7 | `matcher.ts`, loaded with the first track that needs it |
| Lyrics (LRCLIB) | 1.8 | `lyrics()`; Now playing still uses its own (`features/lyrics/lyrics-source.ts`, below) |
| Player | 2.2, 2.5 | 2.5's player, connected in `index.ts` (`connectPlayer`, `connectAppPolicy`) |
| Playback policy and stream lifecycle | 2.3 | `lifecycle`, and `policy` in 2.5's `PlaybackPolicy` shape (`policy.ts`) |
| Search and browse | 2.4 | the sources registry (`setPlatform`, `register`) and the actions store (`playback`, `library`) |
| Library | 2.6 | `library.ts`: "Add to playlist" and the match cache, over `getLibrary()` (`lazyLibrary`), opened on first use |
| Audio quality | 4.3 | the lifecycle reads Settings' tier ceilings and data saver for every stream (`lifecycleQualityOptions()`); Settings describes the tier the platform reaches |
| Local files | 4.4 | in front of the policy (`withLocalFilesFirst`): they play through the app's player, from the device |

**Lazy loading.** `@fxm/sources/youtube` (its providers about 25 KB gzipped), Spotify, Internet Archive, Jamendo, MusicBrainz, LRCLIB and the matching engine are each imported the first time something needs them (`lazy-provider.ts`), and the YouTube session imports youtubei.js (about 165 KB gzipped, a chunk of its own) on its first InnerTube call. The sources registry still lists them at once: a lazy provider has the members of the real one and loads it on its first call. YouTube's providers start loading in the background as soon as the platform reaches YouTube, so the first search doesn't wait for their chunk; it still waits for youtubei.js. A load that fails is tried again next time, and its error says what helps:

- a chunk that didn't download while the browser is offline is a `Network` error: "Couldn't reach …" with "Try again";
- one that didn't download while online is an `AppUpdatedError` (`lib/app-update.ts`): the build names its files after their content, so a tab opened before a deploy asks for files that are gone. The pages say "FXM was updated. Reload to get the new version." with a Reload button, and never reload by themselves, which would stop the music;
- an error while building a provider is a bug: it passes on as it is and is logged, rather than posing as a network problem with a "Try again" that can never work.

**The device's state.** The YouTube session's server-issued visitorData and the stream ladder's rung health live in IndexedDB, in a database of their own (`fxm-device`, `device-store.ts`), so a reload keeps the session and a rung that keeps failing on this IP address stays cooled down. They belong to this browser, so library backups don't carry them. Without IndexedDB (some private windows), they stay in memory for the session.

**The request budget.** The platform's transport draws one slot for every InnerTube call, at the priority of the context it came from: `interactive` for what the pages ask, `current-track` and `prefetch` for the player, as the lifecycle sets them. The stream ladder therefore takes no slot of its own (`platformStreamBudget`); it reports the `LOGIN_REQUIRED` bot checks it tells apart from age gates, and the platform is created with `reportLoginRequired: false`, so each counts once. The transport reports HTTP 429 itself. Errors of the metadata providers and of the matcher's searches go to `platform.report`, so a bot check one of them noticed pauses bulk work too.

**Tiers.** The platform decides: Full with FXM Connect, and in the desktop and Android apps through their native HTTP (stages 7.2 and 6.2), Lite with the sandbox documents of stage 1.10 (the `sandbox` option), Free only otherwise. Pages read the tier from the sources registry, and every provider call gets a context with the current capabilities, so nothing here branches on the tier, with one exception: **Spotify** is registered only where its anonymous token's TOTP secret can be fetched. Its hosts are outside the platform's table: the desktop and Android apps reach them directly, the web app only through the sandbox's user-host document (1.10), without which every Spotify call would fail at once. Without a Spotify provider the search page has no Spotify chip, a Spotify link says "This version of FXM can't read Spotify yet", Settings says the same, and the matching engine asks MusicBrainz's exact path for a Spotify track's ISRC instead.

| | Free | Lite (1.10) | Full |
|---|---|---|---|
| YouTube Music search and pages | Onboarding instead, with "Search Internet Archive instead" | Through the sandbox | Through the page |
| YouTube playback | Stops, with "needs FXM Connect" | VISIONOS, unprobed: the media element's first request is the probe, and the ladder hears which rung played | VISIONOS with the end-of-file probe, then itag 18 |
| Spotify | Not offered | Not offered | While its switch is on, in a browser only with 1.10's user-host document; in the desktop and Android apps through their native HTTP |
| Internet Archive | Yes | Yes | Yes |
| Jamendo | When a `client_id` is configured | The same | The same |

**Language and region.** The pages' provider calls and the services' (the lifecycle, the ladder, the matcher) take their context from one place, the sources registry, so search and playback ask YouTube alike: no `hl` or `gl`, which leaves YouTube's default language, the one whose labels the matching engine bundles, and the region of the IP address that streams play from. A region the user picks in Settings would be passed there, for both.

**The ladder hears which URL played** (`reportPlaybackStarts`): on the media element's first `playing` event, which the player reports as `playing` without `buffering`. The player says `playing` with `buffering` as soon as it asks the engine to play, before a byte arrived, so that alone never counts a rung as working.

**Jamendo** needs a `client_id`. The public one comes from the build (`VITE_FXM_JAMENDO_CLIENT_ID`); without it Jamendo isn't offered, since its API refuses every call. Whether one ID may be shared by every user is open ([the Jamendo README](../../../../../packages/sources/src/jamendo/README.md)).

**The Auto band** of the matching engine stays off (`autoMatch`) until stage 1.12's held-out report allows it, so matches are best guesses that play after a tap and wait for review.

## Where the other stages plug in

| Stage | What changes | Where |
|---|---|---|
| 1.10 Lite tier, through 2.7 | Stage 1.10 has merged; stage 2.7 creates the app's one platform with its sandbox documents (`getAppPlatform()`). Its integration passes that platform in (`createPlatform`) with what the services give the platform today (`killSwitches`, `userHosts`, `reportLoginRequired: false`), and the sandbox as `sandbox`, which the services read too (the Lite tier's kill switch, Spotify's user-host document), so the app has one platform. The Lite tier then waits, switched off, until the YouTube config (loaded in the background) says whether its kill switch is set, and runs its self-test then. Add the Lite tier to `e2e/playback.spec.ts`, whose preview must then serve `/sandbox/` as the deploy does | `index.ts` |
| 1.12 Matching evaluation | Pass `autoMatch: () => <the Auto setting>` once the report allows Auto | `index.ts` |
| 1.2 platform, for lyrics and SponsorBlock | Now playing's lyrics (`lyricsContext()`, its own LRCLIB provider) and SponsorBlock (`sponsorBlockContext()`) still use the page's `fetch`, which reaches both on every tier. Use `getAppServices().context({ priority: 'interactive' })` (and `lyrics()`), so that the desktop and Android apps send these requests through their native HTTP too, as they do the providers' | `features/lyrics/`, `features/sponsorblock/` |
| 2.4 browse links | Now playing and the queue name artists, albums and playlists as plain text (`entityPath()` in `features/now-playing/browse-links.ts`): link the ones whose source has the page, with `albumPath`, `artistPath` and the library's `playlistPath` | `features/now-playing/` |
| 2.6 library playlists | Their big play button is still a placeholder, and their rows don't play: play the playlist through `getPlayer()`, with Pause only while the queue's `context` is that page's | `features/library/`, `features/player/controls.tsx` |
| 3.5 Spotify account | `isAccountEnabled` for the Spotify provider | `app-services.ts` |
| 4.1 Downloads | Two seams: the download environment (`createAppDownloadEnvironment()` in `features/downloads/environment.ts`: this folder's context at the `bulk` priority, and `createPolicyDownloadResolver` over the same stream sources, matcher and match cache), until which nothing is offered for download; and the lifecycle's `offline` store (`getOfflineStore()`), so downloads play first. Also the catalog pages' `downloads` actions | `app-services.ts`, `features/downloads/` |
| 4.4 Local files | Register `createLocalAudioSource()`'s ISRC match as an offline copy for catalog tracks, and `createLocalMetadataProvider()` with the sources registry (see [the local files README](../../features/local-files/README.md#until-other-stages-merge)) | `app-services.ts` |
| 6.3 Native player | On Android, 6.3's `NativeEngine` (Media3) in place of the direct audio engine, its `wrapResolver` around the policy's resolver, its network monitor for the lifecycle, and `connect` before 2.5's restore of the saved queue ([its README](../../../../../packages/player/src/native/README.md)) | `features/now-playing/playback.ts`, `app-services.ts` |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/app/services                # unit and tier tests
scripts/run.sh pnpm --filter @fxm/web exec playwright test playback      # in Chromium (FXM_E2E_PORT to move it off 4173)
```

Nothing but the network is fake (`testing/fake-network.ts`): a `fetch` that answers from the providers' own recorded, sanitized fixtures (a YouTube Music songs search, a VISIONOS `/player` answer rewritten for each video with URLs valid for six hours, googlevideo ranges, an Internet Archive search and item). `testing/tiers.ts` puts the real services on each tier: a page with a fake FXM Connect, a page whose InnerTube calls go through a fake sandbox, and a page with neither.

- **`app-services.test.ts`**: search, play and the next track on the Full, Lite and Free tiers; the quality chosen in Settings; the end-of-file probe in Full and none in Lite; the rung that played reported to the ladder, and only once the engine played; a Spotify track playing its matched song after a tap and waiting for review; Spotify registered only with the user-host document, behind its switch, and not even loaded while switched off; a video played as music in Music + Video mode; the library's playlists and match cache; FXM Connect answering at once and late, never leaving the Free tier showing as settled in between; the Lite tier's self-test waiting for the kill switch, with the platform created at once; YouTube never called in the Free tier, and playback stopping there for an action instead of skipping through the queue; the play buttons kept for a player connected later; the saved visitorData and rung health.
- **`index.test.ts`**: `startAppServices()` once however often it is called, the app's player (stage 2.5) connected and playing through the services' policy, the library's playlists offered, the play buttons before the platform is ready, the stand-in under the fake catalog and when the services can't start, and `stopAppServices()`; **`connecting.test.ts`**: the detecting flag and its grace period.
- **`e2e/playback.spec.ts`** (Playwright, Chromium, the production build; not part of `make check`): a YouTube Music song plays real audio (short WAV tones) through `<audio>`, Next in the player bar plays the next one, and the one after starts when that ends, without the install pitch ever showing; with an FXM Connect that answers after 1.5 s, the shell paints at once, says it is connecting and never offers the install; without FXM Connect, at phone width, "Search Internet Archive instead" is on the screen, and Internet Archive tracks play the same way while nothing contacts YouTube.
- One test file per module for the adapters: the YouTube stream source and budget, the matcher (ISRC, text, excluded candidates, skipped pages, official videos, lossless copies, and what it reads about a Spotify track), the policy, the library adapters (also over stage 2.6's real repository, on `fake-indexeddb`), the lazy providers (and what a failed load becomes) and the device store (on `fake-indexeddb`). `features/now-playing/playback-policy.test.ts` covers how the app's policy follows the one connected, and `features/local-files/player.test.ts` local files in front of it.
