# The composition root (stage 2.9)

The one place where the web app builds the real pieces of the earlier stages and plugs them into the seams its pages use. Stages 2.3 to 2.6 were built in parallel against fakes behind small adapters; this folder is what replaces the fakes. Everything runs on the user's device: FXM has no servers.

**The first render waits for nothing.** `main.tsx` renders the shell at once and loads this folder beside it, in a chunk of its own (`import('./app/services')`, then `startAppServices()`), so the app's first bundle carries none of the platform, the player or the lifecycle (on 2026-10-26: the first bundle 263 KB, 82 KB gzipped; this folder's chunk 105 KB, 35 KB gzipped). The pages follow the sources registry as the platform detects the tier and the providers register. The player connects first: its resolver waits for the platform itself, so the play buttons work while FXM Connect answers.

**While FXM Connect answers** (`connecting.ts`): its content script marks `<html>` before FXM's code runs, but answers the ping only once its service worker is up, which can take a second or two. So `main.tsx` calls `markConnecting(appSources)` before the first render: while the marker is on the page, the registry's snapshot says `detecting`, and the pages show "Connecting to FXM Connect…" instead of the Free tier's install pitch. The composition root ends that as soon as FXM Connect answers, even after the platform's 800 ms wait (its client still hears a late answer), and the grace period of 5 s at the latest: an FXM Connect that never answers is as good as none.

## What it builds

| Piece | Stage | Here |
|---|---|---|
| Platform: transports, capabilities, the shared request budget | 1.2 | `createPlatform`, through the `createPlatform` option (tests pass one over a fake network, desktop and Android their native HTTP) |
| YouTube session and metadata providers | 1.3 | `youtube.ts`: loaded on first use, one session for the device |
| YouTube audio source: VISIONOS, then itag 18 | 1.4 | `youtube.ts`: the playback policy's `ytm` stream source |
| Spotify, behind the Spotify switch | 1.5 | a lazy provider, registered only where its secret can be fetched (below); on while the switch is |
| Internet Archive, Jamendo, MusicBrainz | 1.6 | lazy providers and stream sources; MusicBrainz finds a Spotify track's ISRC when Spotify can't |
| Matching engine and its searches | 1.7 | `matcher.ts`, loaded with the first track that needs it |
| Lyrics (LRCLIB) | 1.8 | `lyrics()`, for Now playing |
| Player | 2.2 | `connectPlayer(player)`; `player.ts` until stage 2.5's lands |
| Playback policy and stream lifecycle | 2.3 | `lifecycle`, and `policy` in 2.5's `PlaybackPolicy` shape (`policy.ts`) |
| Search and browse | 2.4 | the sources registry (`setPlatform`, `register`) and the actions store (`playback`) |
| Library | 2.6 | `library.ts`, once the repository is passed in |

**Lazy loading.** `@fxm/sources/youtube` (its providers about 25 KB gzipped), Spotify, Internet Archive, Jamendo, MusicBrainz, LRCLIB and the matching engine are each imported the first time something needs them (`lazy-provider.ts`), and the YouTube session imports youtubei.js (about 165 KB gzipped, a chunk of its own) on its first InnerTube call. The sources registry still lists them at once: a lazy provider has the members of the real one and loads it on its first call. YouTube's providers start loading in the background as soon as the platform reaches YouTube, so the first search doesn't wait for their chunk; it still waits for youtubei.js. A load that fails is tried again next time, and its error says what helps:

- a chunk that didn't download while the browser is offline is a `Network` error: "Couldn't reach …" with "Try again";
- one that didn't download while online is an `AppUpdatedError` (`lib/app-update.ts`): the build names its files after their content, so a tab opened before a deploy asks for files that are gone. The pages say "FXM was updated. Reload to get the new version." with a Reload button, and never reload by themselves, which would stop the music;
- an error while building a provider is a bug: it passes on as it is and is logged, rather than posing as a network problem with a "Try again" that can never work.

**The device's state.** The YouTube session's server-issued visitorData and the stream ladder's rung health live in IndexedDB, in a database of their own (`fxm-device`, `device-store.ts`), so a reload keeps the session and a rung that keeps failing on this IP address stays cooled down. They belong to this browser, so library backups don't carry them. Without IndexedDB (some private windows), they stay in memory for the session.

**The request budget.** The platform's transport draws one slot for every InnerTube call, at the priority of the context it came from: `interactive` for what the pages ask, `current-track` and `prefetch` for the player, as the lifecycle sets them. The stream ladder therefore takes no slot of its own (`platformStreamBudget`); it reports the `LOGIN_REQUIRED` bot checks it tells apart from age gates, and the platform is created with `reportLoginRequired: false`, so each counts once. The transport reports HTTP 429 itself. Errors of the metadata providers and of the matcher's searches go to `platform.report`, so a bot check one of them noticed pauses bulk work too.

**Tiers.** The platform decides: Full with FXM Connect (and in the desktop and Android apps once their native HTTP exists), Lite with the sandbox documents of stage 1.10 (the `sandbox` option), Free only otherwise. Pages read the tier from the sources registry, and every provider call gets a context with the current capabilities, so nothing here branches on the tier, with one exception: **Spotify** is registered only where its anonymous token's TOTP secret can be fetched. Its hosts are outside the platform's table: the desktop and Android apps reach them directly, the web app only through the sandbox's user-host document (1.10), without which every Spotify call would fail at once. Without a Spotify provider the search page has no Spotify chip, a Spotify link says "This version of FXM can't read Spotify yet", Settings says the same, and the matching engine asks MusicBrainz's exact path for a Spotify track's ISRC instead.

| | Free | Lite (1.10) | Full |
|---|---|---|---|
| YouTube Music search and pages | Onboarding instead, with "Search Internet Archive instead" | Through the sandbox | Through the page |
| YouTube playback | Stops, with "needs FXM Connect" | VISIONOS, unprobed: the media element's first request is the probe, and the ladder hears which rung played | VISIONOS with the end-of-file probe, then itag 18 |
| Spotify | Not offered | Not offered | While its switch is on, in a browser only with 1.10's user-host document; in the desktop and Android apps once their native HTTP exists |
| Internet Archive | Yes | Yes | Yes |
| Jamendo | When a `client_id` is configured | The same | The same |

**Language and region.** The pages' provider calls and the services' (the lifecycle, the ladder, the matcher) take their context from one place, the sources registry, so search and playback ask YouTube alike: no `hl` or `gl`, which leaves YouTube's default language, the one whose labels the matching engine bundles, and the region of the IP address that streams play from. A region the user picks in Settings would be passed there, for both.

**The ladder hears which URL played** (`reportPlaybackStarts`): on the media element's first `playing` event, which the player reports as `playing` without `buffering`. The player says `playing` with `buffering` as soon as it asks the engine to play, before a byte arrived, so that alone never counts a rung as working.

**Jamendo** needs a `client_id`. The public one comes from the build (`VITE_FXM_JAMENDO_CLIENT_ID`); without it Jamendo isn't offered, since its API refuses every call. Whether one ID may be shared by every user is open ([the Jamendo README](../../../../../packages/sources/src/jamendo/README.md)).

**The Auto band** of the matching engine stays off (`autoMatch`) until stage 1.12's held-out report allows it, so matches are best guesses that play after a tap and wait for review.

## Where the other stages plug in

| Stage | What changes | Where |
|---|---|---|
| 1.10 Lite tier | Pass `sandbox: createSandboxTransport()` to `createAppServices()`. The platform is still created at once: the Lite tier waits, switched off, until the YouTube config (loaded in the background) says whether its kill switch is set, and runs its self-test then. The sandbox's user-host document also registers Spotify in the web app (above). Add the Lite tier to `e2e/playback.spec.ts`. Stage 2.7 creates a platform of its own (`getAppPlatform()`): pass it as `createPlatform`, so the app has one | `index.ts` |
| 1.12 Matching evaluation | Pass `autoMatch: () => <the Auto setting>` once the report allows Auto | `index.ts` |
| 2.5 Now playing | Its `createAppPolicy()` returns `getAppServices().policy`; its `createPlayback()` calls `getAppServices().connectPlayer(player)` and keeps the function it returns (a disconnect leaves a player connected after it alone); `lyricsContext()` uses `getAppServices().context({ priority: 'interactive' })` (and may take `lyrics()`). Then delete `player.ts` and its call in `index.ts` | `features/now-playing/` |
| 2.6 Library | Pass `library: getLibrary()`: "Add to playlist" and the match cache then use it (`library.ts`). The like button joins through 2.5's `LikeButton` seam | `index.ts` |
| 3.1 Listening signals | `connectPlayer` also starts its play recorder (`connectPlayRecorder(player)`), which fills the history | `app-services.ts` |
| 3.5 Spotify account | `isAccountEnabled` for the Spotify provider | `app-services.ts` |
| 4.1 Downloads, 4.3 Quality | The lifecycle's `offline` store and `qualityPrefs` | `app-services.ts` |
| 7.2, 6.2 Native HTTP | `createPlatform` with their `nativeHttp`; 6.3's Media3 engine in place of the direct audio engine | `index.ts` |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/app/services                # unit and tier tests
scripts/run.sh pnpm --filter @fxm/web exec playwright test playback      # in Chromium (FXM_E2E_PORT to move it off 4173)
```

Nothing but the network is fake (`testing/fake-network.ts`): a `fetch` that answers from the providers' own recorded, sanitized fixtures (a YouTube Music songs search, a VISIONOS `/player` answer rewritten for each video with URLs valid for six hours, googlevideo ranges, an Internet Archive search and item). `testing/tiers.ts` puts the real services on each tier: a page with a fake FXM Connect, a page whose InnerTube calls go through a fake sandbox, and a page with neither.

- **`app-services.test.ts`**: search, play and the next track on the Full, Lite and Free tiers; the end-of-file probe in Full and none in Lite; the rung that played reported to the ladder, and only once the engine played; a Spotify track playing its matched song after a tap and waiting for review; Spotify registered only with the user-host document, behind its switch, and not even loaded while switched off; a video played as music in Music + Video mode; the library's playlists and match cache; FXM Connect answering at once and late, never leaving the Free tier showing as settled in between; the Lite tier's self-test waiting for the kill switch, with the platform created at once; YouTube never called in the Free tier, and playback stopping there for an action instead of skipping through the queue; the play buttons kept for a player connected later; the saved visitorData and rung health.
- **`index.test.ts`**: `startAppServices()` once however often it is called, with the play buttons before the platform is ready, and `stopAppServices()`; **`connecting.test.ts`**: the detecting flag and its grace period.
- **`e2e/playback.spec.ts`** (Playwright, Chromium, the production build; not part of `make check`): a YouTube Music song plays real audio (short WAV tones) through `<audio>`, Next in the player bar plays the next one, and the one after starts when that ends, without the install pitch ever showing; with an FXM Connect that answers after 1.5 s, the shell paints at once, says it is connecting and never offers the install; without FXM Connect, at phone width, "Search Internet Archive instead" is on the screen, and Internet Archive tracks play the same way while nothing contacts YouTube.
- One test file per module for the adapters: the YouTube stream source and budget, the matcher (ISRC, text, excluded candidates, skipped pages, official videos, lossless copies, and what it reads about a Spotify track), the policy, the library adapters, the lazy providers (and what a failed load becomes), the device store (on `fake-indexeddb`) and the interim player.
