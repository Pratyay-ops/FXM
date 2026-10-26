# The stream lifecycle (`@fxm/player`)

`StreamLifecycle` is the player's real `StreamResolver` (stage 2.3). It applies the playback policy from [`@fxm/core`](../../../core/src/playback-policy/README.md) and keeps the state around it: the URL cache, what it learned from failed streams, the prefetch, the matching decisions and the items that need review.

```ts
import { createBrowserNetworkMonitor, DirectAudioEngine, fromAudioSource, Player, StreamLifecycle } from '@fxm/player'

const lifecycle = new StreamLifecycle({
  sources: [youtubeLadder, fromAudioSource(archive), fromAudioSource(jamendo)],
  matcher, // the matching engine with its searches (1.7)
  matches, // the match cache (2.6); in memory by default
  // Read afresh each time, since the tier can change. `fetch` draws on the request budget (1.2).
  context: (priority) => ({ ...providerContext, fetch: transport.withPriority(priority) }),
  settings: () => settings.playback, // "prefer lossless", "Play best guesses", Invidious
  qualityPrefs: () => settings.quality, // the tier ceilings per connection
  streaming: () => settings.streaming, // which connection's ceiling applies, the data saver
  network: createBrowserNetworkMonitor(),
})
const player = new Player({ engine: new DirectAudioEngine(), resolver: lifecycle })
lifecycle.attach(player)
```

The player says on every request whether the user asked for the item (`request.explicit`: a tap, a jump, "previous", play on it, a version pick) and in which catalog mode the queue is (`request.mode`). `attach` lets the lifecycle prefetch the next tracks whenever the player announces `preload`, and lets Smart Replace check the next tracks; for a player that does not say, it also works out which item the user asked for. Without it, the lifecycle warns once.

## What it does

- **Order of preference** (`planPlayback`): an offline copy; the user's choice, that is the version picked for this queue item, else the track's pin; or the candidate recorded on the queue item; with "prefer lossless", an ISRC-verified or Auto lossless match; the track's own audio, its linked song or its matched song; Invidious (opt-in); "Unavailable" with alternatives.
- **The user's choices.** `pinMatch(track, candidate)` pins a version for the track ("Not the right version?", or a confirmed guess): it plays first from now on and clears the review. Choosing the track's own audio removes another version's pin instead. `unpinMatch(track)` removes a pin ("reset to automatic"). Nothing else adds or removes a pin. `Player.setCandidate` only records a version on one queue item: on the current item it plays at once (reason `replace`) and wins over a pin while that item keeps it, retries included, and Smart Replace never swaps it.
- **Suggest-band guesses** play only for an explicit request, or with "Play best guesses" on. When a queue reaches one by itself (the track before ended or failed, or "next"), the lifecycle rejects with a `needs-review` problem: the player skips it, and `reviews()` lists it. A guess is never recorded on the queue item by the lifecycle, and one the app records there is still a guess: a match recorded on an item plays unasked only while a fresh stored decision confirms it (a pin, an `auto` song, an `auto` or ISRC-verified lossless copy).
- **Matching decisions** go to the match store, also "nothing came close" (`none`, kept a day, so an unmatched track costs one search a day, not one per play) and lossless misses (under a key of their own). Engine decisions count 30 days. An outcome the matcher could not complete (`incomplete`) plays as decided but is not kept. A stored decision whose audio the catalog mode does not let play is matched again.
- **The URL cache** keeps each resolution per network, per audio candidate (for YouTube, per videoId) and per rung, until 10 minutes before its URLs expire (an hour for URLs without expiry), and at most 256 resolutions. Every network change flushes it (the `NetworkMonitor`: `online`, `offline` and a change of the Network Information API's connection `type` in browsers; native callbacks later on desktop and Android). So does a 403 on a cached URL, a probable IP change. A resolution still in flight when a flush comes is handed to the callers waiting for it, but never cached or counted as proof, and a stream resolved before a flush teaches nothing when it fails. Memory only.
- **Probing.** Where bytes are readable, the ladder's end-of-file probe marks capped URLs, and the ladder falls through to itag 18 itself; the lifecycle never plays a capped URL, and asks for the fallback rung when nothing from the top is playable. In Lite, and after a CORS failure following a googlevideo redirect, URLs are `unverified`, and the media element's first request is the probe: a media error or a stall before the first `play` event falls back to itag 18, then resolves again from the top. The source hears of every failed rung (`reportFailure`), and says which rung an option came from (`rungOf`). The lifecycle remembers the working rung per video and network.
- **Re-resolution** on expiry, 401, 403 and 410 where a status is readable, and on a stall or a media error everywhere. A 403 is resolved again once on the same rung before changing rung; 403s count per failure episode (10 minutes), so one hours later starts over. A stream the player refuses before it plays although its URL works (`verified`, or a readable 2xx status) gets another format of the same resolution. Statuses come from the engine's error (`httpStatusOf`) or, where bytes are readable, from the source's `checkStatus`. A failed signed URL is never handed out again on that network. The player resumes at the same position.
- **Prefetch** of the next 3 tracks (the next one included) on the player's `preload` event, one after another, at the budget's `prefetch` priority. Resolutions and matches in flight are shared, so the player's own preload and the prefetch make one request; when the track is played while it is still being prefetched, the shared work's `ctx.fetch` rises to `current-track`.
- **Smart Replace** only on a playability verdict (`UNPLAYABLE`, `ERROR`) for that very video while other videos resolve: another video resolved on this network within 30 minutes, or, failing that, the next track in the queue resolves now, afresh rather than from the cache. The dead video is excluded, the matching engine runs again, and the new match is stored and recorded. The user's choices (pins and picked versions) are never swapped or deleted. Matches survive everything else.
- **"Unavailable" says why.** When a source refused the audio, the problem carries its code (`NotFound`, `GeoBlocked`, `Unavailable`), its labelled state (a verdict's `state`, or `StreamSource.stateOf`, e.g. 1.4's `age-restricted`) and its words (`detail`).
- **Format choice** per the engine's `canPlay` (`canPlayType`), at the tier ceiling of the connection.
- **Quality settings** (stage 4.3): `streamingProfile` from `@fxm/core` picks the ceiling for every stream from `qualityPrefs`, the `streaming` settings and the network monitor's `cellular`: the connection the user chose, else the detected one, else Wi-Fi. On mobile data, and everywhere with the data saver on, audio-only streams come before a muxed video. Every resolution carries a `ProbePlan` (`request.probe`) whose `choose` picks as the lifecycle will, without the URLs and formats that failed since. Its scope is `default` (the source probes as it always does), or `chosen` with the data saver on, which streams at `low` on every connection: a source that probes then checks only the stream the lifecycle will choose (`probeChosenStream`).

The player does the retries with backoff (0 s, 1 s, 3 s) and stops after 4 failed tracks; the lifecycle makes every retry resolve fresh audio. A failure a retry may fix (`Parse`, `Network`, `RateLimited`) on YouTube audio first goes to the user's Invidious instance, when it is on, and is rethrown if that cannot play it either.

## Events and reading

| API | What |
|---|---|
| `on('reviewchange', reviews)` | The list of tracks whose match needs review changed. The queue panel (2.5) shows the ones in the queue |
| `on('smartreplace', { track, from, to })` | Smart Replace swapped a match |
| `on('flush', { reason, dropped })` | Every cached URL was dropped: `network`, `ip-changed` or `manual` |
| `reviews()` | The tracks that need review, with their guess and alternatives |
| `pinMatch(track, candidate)`, `unpinMatch(track)` | Pins a version for the track, or removes the pin, in the current catalog mode |
| `flush()` | Drops every cached URL, e.g. on a native network callback |
| `prefetch(items)` | Resolves items ahead, e.g. after a queue edit |

The errors it rejects with follow the player's classes: `Unsupported`, `BotCheck` and `AuthRequired` stop the player (the user must act); `Unavailable` with a `PlaybackProblem` (`playbackProblemOf`) skips the item; `Network`, `RateLimited` and the like are retried.

## Touch-points with other stages

Each one is an interface in `adapters.ts`, with a fake in `./testing` (also exported from `@fxm/player/testing`). Wiring a real implementation in is a few lines in the app:

| Interface | Implemented by | What the real one must do |
|---|---|---|
| `StreamSource` for `ytm` | The YouTube ladder (1.4): `createYouTubeAudioSource` from `@fxm/sources/youtube/stream` | `resolve(candidate, { ctx, prefs, rung, priority })` is `audio.resolve(candidate, ctx, prefs, { priority, rungs: rung === 'fallback' ? 'fallback' : 'all' })` (`ctx` carries the signal); `hasFallback` is `audio.hasFallback`; `rungOf(option)` is `fallback` for the config's last-resort rung (`option.rung === 'android-muxed'`, itag 18, in the bundled config), else `top`; `reportFailure(stream, { recovery }, { ctx })` calls `audio.reportPlaybackFailure(stream, ctx, recovery.reason)`, whose reason is always `probe-failed`, `fallback-failed` or `forbidden-again` (1.4's `PlaybackFailureReason` lacks only `unsupported`, so narrow the type); `checkStatus(stream, { ctx })` is `audio.checkStatus(stream, ctx)`; `stateOf` is `unavailableStateOf`. A `YouTubeUnplayableError` passes through as it is: its `cause` is the verdict `playabilityVerdictOf` reads. The lifecycle has no hook yet for 1.4's `reportPlaybackSuccess` (a stream's first `playing` event), so in Lite the ladder's rung health learns only from failures until one is added. Leave 1.4's own `budget` out when `ctx.fetch` comes from 1.2's transport, which draws on the budget itself. Probe as `request.probe` says (stage 4.3): the ladder's default (`probe: 'best'`, one URL per codec and media) for `default` or no plan, and for `chosen` (the data saver) only the URL playback would choose, with `probeChosenStream(found, plan.choose, probe)` from `@fxm/core`. A `chosen` rung counts as capped only when its `outcome` is `capped`; `nothing-chosen` never counts against it (the ladder's usual check applies). 1.4's ladder has no mode for `chosen` yet, so it probes as by default |
| `StreamSource` for `archive`, `jamendo` | The free sources (1.6) | `fromAudioSource(audioSource)` |
| `StreamSource` for a `plugin.<name>` | A runtime plugin's resolver (8.3), added and removed as plugins come and go: `lifecycle.addSource(fromAudioSource(audio))` returns the function that removes it. A removed source's tracks stop at once (`no-source`), its cached URLs included. `addSource` refuses (`RangeError`) the ID of a source the lifecycle was created with, so it never replaces a built-in one | `fromAudioSource(audioSource)` |
| `TrackMatcher` | The matching engine (1.7) with the YouTube Music, Internet Archive and Jamendo searches | `match(track, { target, exclude })` runs `runMatch` with the Auto setting (`MatchOptions.auto`) and returns `{ band, best, alternatives: candidates without best, evidence, incomplete }` from its `MatchResult`, never a candidate in `exclude`. `target: 'song'` searches YouTube Music; `'lossless'` Internet Archive and Jamendo (only while "prefer lossless" is on, for Jamendo's quota) |
| `MatchStore` | The match cache (2.6) | The song decision is 2.6's record under `matchKey(sourceTrackId, mode)`; keep lossless decisions apart, e.g. under `<matchKey>\|lossless` (`matchKeyString` gives both). The fields are 2.6's `MatchCacheRecord`'s (`band`, `candidate`, `alternatives`, `signals`, `evidence`, `userPinned`, `decidedAt`). `put` of a pin is `pinMatch`, of an engine decision `recordMatch`; `delete` is `unpinMatch` or `forgetMatch`. The lifecycle checks what it reads with `sanitizeStoredMatch` |
| `context(priority)` | The platform's transport (1.2) | `{ ...ctx, fetch: transport.withPriority(priority) }`: `current-track` or `prefetch`, the budget's own names |
| `OfflineStore` | Downloads (4.1) | `find(track)` returns a `verified` stream of the downloaded file |
| `NetworkMonitor` | `createBrowserNetworkMonitor` on the web; native callbacks on desktop (7.3) and Android (6.3) | A new `id` and a call to the listeners on every network change |
| `invidious` | Not planned yet | A `StreamSource` resolving `ytm` candidates through the user's instance (`userhost.html` on the web) |

The browser monitor counts a Network Information API `change` only when the connection `type` changes: per the WICG specification, `change` also fires when only the `downlink` or `rtt` estimates move, and per MDN's compatibility data Chrome has `type` on Android and ChromeOS only, so desktop Chrome and Edge change network on `online` and `offline` alone (both checked 2026-10-26).

## Tests

They run offline in happy-dom with fake timers, which also drive `Date.now`: the real `Player` and `FakeEngine` with the lifecycle, a fake ladder (`FakeStreamSource`, which falls through to itag 18 past a capped top rung like 1.4's, or with `fallThrough = false` leaves that to the lifecycle), a fake matching engine (`FakeMatcher`) and a fake network (`FakeNetworkMonitor`). `test-harness.ts` wires them up. They cover:

- the capped-URL fallback on both probe paths, "then resolve again", the reports to the source and the format choice (`probing.test.ts`);
- re-resolving and resuming at expiry, the cache, the flush on a network change and on a 403 for a cached URL, work that a flush overtook, and 403 episodes (`url-lifecycle.test.ts`);
- the Smart Replace triggers and the protection of pins and picked versions (`smart-replace.test.ts`);
- queues skipping Suggest items, guesses the app records, and what lets them play (`suggest.test.ts`);
- the order of preference, stored decisions, prefetching, shared resolutions and their priority, retries and the circuit breaker, the request's `explicit` and `mode` (`policy.test.ts`), and the edge cases, pins and malformed stored data included (`edges.test.ts`);
- the quality settings: the connection the user chose, the data saver's ceiling and audio-only preference, and the probe plan it passes the ladder, which follows a change of setting and skips what failed (`quality.test.ts`).
