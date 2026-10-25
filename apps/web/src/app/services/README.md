# The composition root (stage 2.9)

The one place where the web app builds the real pieces of the earlier stages and plugs them into the seams its pages use. Stages 2.3 to 2.6 were built in parallel against fakes behind small adapters; this folder is what replaces the fakes. Everything runs on the user's device: FXM has no servers.

`main.tsx` calls `startAppServices()` once, then renders. Creating the platform waits for FXM Connect's answer (a few milliseconds, at most 800), so the first render already shows the right tier and its sources rather than the Free tier for a moment.

## What it builds

| Piece | Stage | Here |
|---|---|---|
| Platform: transports, capabilities, the shared request budget | 1.2 | `createPlatform`, through the `createPlatform` option (tests pass one over a fake network, desktop and Android their native HTTP) |
| YouTube session and metadata providers | 1.3 | `youtube.ts`: loaded on first use, one session for the device |
| YouTube audio source: VISIONOS, then itag 18 | 1.4 | `youtube.ts`: the playback policy's `ytm` stream source |
| Spotify, behind the Spotify switch | 1.5 | a lazy provider, on while the switch is; reachable with FXM Connect |
| Internet Archive, Jamendo, MusicBrainz | 1.6 | lazy providers and stream sources; MusicBrainz finds a Spotify track's ISRC when Spotify can't |
| Matching engine and its searches | 1.7 | `matcher.ts`, loaded with the first track that needs it |
| Lyrics (LRCLIB) | 1.8 | `lyrics()`, for Now playing |
| Player | 2.2 | `connectPlayer(player)`; `player.ts` until stage 2.5's lands |
| Playback policy and stream lifecycle | 2.3 | `lifecycle`, and `policy` in 2.5's `PlaybackPolicy` shape (`policy.ts`) |
| Search and browse | 2.4 | the sources registry (`setPlatform`, `register`) and the actions store (`playback`) |
| Library | 2.6 | `library.ts`, once the repository is passed in |

**Lazy loading.** `@fxm/sources/youtube` (its providers about 25 KB gzipped, youtubei.js another 165 KB in its own chunk), Spotify, Internet Archive, Jamendo, MusicBrainz, LRCLIB and the matching engine are each imported the first time something needs them (`lazy-provider.ts`). The sources registry still lists them at once: a lazy provider has the members of the real one and loads it on its first call. YouTube starts loading in the background as soon as the platform reaches it, so the first search doesn't wait for the chunk. A chunk that fails to download is tried again next time, and its error is a `Network` error, which the pages offer to retry.

**The device's state.** The YouTube session's server-issued visitorData and the stream ladder's rung health live in IndexedDB, in a database of their own (`fxm-device`, `device-store.ts`), so a reload keeps the session and a rung that keeps failing on this IP address stays cooled down. They belong to this browser, so library backups don't carry them. Without IndexedDB (some private windows), they stay in memory for the session.

**The request budget.** The platform's transport draws one slot for every InnerTube call, at the priority of the context it came from: `interactive` for what the pages ask, `current-track` and `prefetch` for the player, as the lifecycle sets them. The stream ladder therefore takes no slot of its own (`platformStreamBudget`); it reports the `LOGIN_REQUIRED` bot checks it tells apart from age gates, and the platform is created with `reportLoginRequired: false`, so each counts once. The transport reports HTTP 429 itself. Errors of the metadata providers and of the matcher's searches go to `platform.report`, so a bot check one of them noticed pauses bulk work too.

**Tiers.** The platform decides: Full with FXM Connect (and in the desktop and Android apps once their native HTTP exists), Lite with the sandbox documents of stage 1.10 (the `sandbox` option), Free only otherwise. Pages read the tier from the sources registry, and every provider call gets a context with the current capabilities, so nothing here branches on the tier.

| | Free | Lite (1.10) | Full |
|---|---|---|---|
| YouTube Music search and pages | Onboarding instead | Through the sandbox | Through the page |
| YouTube playback | Stops, with "needs FXM Connect" | VISIONOS, unprobed: the media element's first request is the probe, and the ladder hears which rung played | VISIONOS with the end-of-file probe, then itag 18 |
| Spotify | Not offered | Not offered | While its switch is on |
| Internet Archive | Yes | Yes | Yes |
| Jamendo | When a `client_id` is configured | The same | The same |

**Jamendo** needs a `client_id`. The public one comes from the build (`VITE_FXM_JAMENDO_CLIENT_ID`); without it Jamendo isn't offered, since its API refuses every call. Whether one ID may be shared by every user is open ([the Jamendo README](../../../../../packages/sources/src/jamendo/README.md)).

**The Auto band** of the matching engine stays off (`autoMatch`) until stage 1.12's held-out report allows it, so matches are best guesses that play after a tap and wait for review.

## Where the other stages plug in

| Stage | What changes | Where |
|---|---|---|
| 1.10 Lite tier | Pass `sandbox: createSandboxTransport()` to `createAppServices()`; the Spotify secret's hosts then go through its user-host document, and the YouTube config's kill switch applies before the self-test. Add the Lite tier to `e2e/playback.spec.ts` | `index.ts` |
| 1.12 Matching evaluation | Pass `autoMatch: () => <the Auto setting>` once the report allows Auto | `index.ts` |
| 2.5 Now playing | Its `createAppPolicy()` returns `getAppServices().policy`; its `createPlayback()` calls `getAppServices().connectPlayer(player)` and keeps the function it returns; `lyricsContext()` uses `getAppServices().context({ priority: 'interactive' })` (and may take `lyrics()`). Then delete `player.ts` and its call in `index.ts` | `features/now-playing/` |
| 2.6 Library | Pass `library: getLibrary()`: "Add to playlist" and the match cache then use it (`library.ts`). The like button joins through 2.5's `LikeButton` seam | `index.ts` |
| 3.1 Listening signals | `connectPlayer` also starts its play recorder (`connectPlayRecorder(player)`), which fills the history | `app-services.ts` |
| 3.5 Spotify account | `isAccountEnabled` for the Spotify provider | `app-services.ts` |
| 4.1 Downloads, 4.3 Quality | The lifecycle's `offline` store and `qualityPrefs` | `app-services.ts` |
| 7.2, 6.2 Native HTTP | `createPlatform` with their `nativeHttp`; 6.3's Media3 engine in place of the direct audio engine | `index.ts` |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/app/services        # unit and tier tests
FXM_E2E_PORT=6401 scripts/run.sh pnpm --filter @fxm/web exec playwright test playback   # in Chromium
```

Nothing but the network is fake (`testing/fake-network.ts`): a `fetch` that answers from the providers' own recorded, sanitized fixtures (a YouTube Music songs search, a VISIONOS `/player` answer rewritten for each video with URLs valid for six hours, googlevideo ranges, an Internet Archive search and item). `testing/tiers.ts` puts the real services on each tier: a page with a fake FXM Connect, a page whose InnerTube calls go through a fake sandbox, and a page with neither.

- **`app-services.test.ts`**: search, play and the next track on the Full, Lite and Free tiers; the end-of-file probe in Full and none in Lite; the rung that played reported to the ladder; a Spotify track playing its matched song after a tap and waiting for review; Spotify behind its switch; YouTube never called in the Free tier, and playback stopping there for an action instead of skipping through the queue; the saved visitorData and rung health.
- **`e2e/playback.spec.ts`** (Playwright, Chromium, the production build; not part of `make check`): a YouTube Music song plays real audio (short WAV tones) through `<audio>`, Next in the player bar plays the next one, and the one after starts when that ends; without FXM Connect, Internet Archive tracks play the same way and nothing contacts YouTube.
- One test file per module for the adapters: the YouTube stream source and budget, the matcher (ISRC, text, excluded candidates, skipped pages, official videos, lossless copies), the policy, the library adapters, the lazy providers, the device store (on `fake-indexeddb`) and the interim player.
