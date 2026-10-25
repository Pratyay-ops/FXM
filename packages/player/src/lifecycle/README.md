# The stream lifecycle (`@fxm/player`)

`StreamLifecycle` is the player's real `StreamResolver` (stage 2.3). It applies the playback policy from [`@fxm/core`](../../../core/src/playback-policy/README.md) and keeps the state around it: the URL cache, what it learned from failed streams, the prefetch, the matches and the items that need review.

```ts
import { createBrowserNetworkMonitor, DirectAudioEngine, fromAudioSource, Player, StreamLifecycle } from '@fxm/player'

const lifecycle = new StreamLifecycle({
  sources: [youtubeLadder, fromAudioSource(archive), fromAudioSource(jamendo)],
  matcher, // the matching engine with its searches (1.7)
  matches, // the match cache (2.6); in memory by default
  context: () => providerContext, // read afresh each time: the tier can change
  settings: () => settings.playback, // "prefer lossless", "Play best guesses", Invidious
  qualityPrefs: () => settings.quality, // the tier ceilings per connection
  streaming: () => settings.streaming, // which connection's ceiling applies, the data saver
  network: createBrowserNetworkMonitor(),
})
const player = new Player({ engine: new DirectAudioEngine(), resolver: lifecycle })
lifecycle.attach(player)
```

`attach` matters: it tells the lifecycle which item the user asked for, so that its Suggest-band guess may play, and it prefetches the next tracks whenever the player announces `preload`.

## What it does

- **Order of preference** (`planPlayback`): an offline copy; a pin, or the candidate recorded on the queue item; with "prefer lossless", an ISRC-verified or Auto lossless match; the track's own audio, its linked song or its matched song; Invidious (opt-in); "Unavailable" with alternatives.
- **Suggest-band guesses** play only when the user asked for the item: a tap (a new queue's start item), a jump, "previous", a restored queue, play on a paused or stopped item, or a version pick. When a queue reaches one by itself (the track before ended or failed, or "next"), the lifecycle rejects with a `needs-review` problem: the player skips it, and `reviews()` lists it. "Play best guesses" lets them play. A guess is never recorded on the queue item, so it never plays unattended later. `confirmMatch(track, candidate)` pins a version.
- **The URL cache** keeps each resolution per network, per audio candidate (for YouTube, per videoId) and per rung, until 10 minutes before its URLs expire (an hour for URLs without expiry), and at most 256 resolutions. Every network change flushes it (the `NetworkMonitor`: `online`, `offline` and the Network Information API's `change` in browsers; native callbacks later on desktop and Android). So does a 403 on a cached URL, a probable IP change. Memory only.
- **Probing.** Where bytes are readable, the ladder's end-of-file probe marks capped URLs, and the lifecycle asks for the fallback rung (itag 18). In Lite, and after a CORS failure following a googlevideo redirect, URLs are `unverified`, and the media element's first request is the probe: a media error or a stall before the first `play` event falls back to itag 18, then resolves again from the top. It remembers the working rung per video and network.
- **Re-resolution** on expiry, 401, 403 (once on the same rung before changing rung) and 410 where a status is readable, and on a stall or a media error everywhere. Statuses come from the engine's error (`httpStatusOf`) or, where bytes are readable, from the source's `checkStatus`. A failed signed URL is never handed out again on that network. The player resumes at the same position.
- **Prefetch** of the next 3 tracks (the next one included) on the player's `preload` event, one after another, at the budget's prefetch priority. Resolutions and matches in flight are shared, so the player's own preload and the prefetch make one request.
- **Smart Replace** only on a playability verdict (`UNPLAYABLE`, `ERROR`) for that very video while other videos resolve: another video resolved on this network within 30 minutes, or, failing that, the next track in the queue resolves now. The dead video is excluded, the matching engine runs again, and the new match is stored and recorded. Pins are never swapped or deleted. Matches survive everything else.
- **Format choice** per the engine's `canPlay` (`canPlayType`), at the tier ceiling of the connection.
- **Quality settings** (stage 4.3): `streamingProfile` from `@fxm/core` picks the ceiling for every stream from `qualityPrefs`, the `streaming` settings and the network monitor's `cellular`: the connection the user chose, else the detected one, else Wi-Fi. On mobile data, and everywhere with the data saver on, audio-only streams come before a muxed video. Every resolution carries a `ProbePlan` (`request.probe`) whose `choose` picks as the lifecycle will, without the URLs and formats that failed since. Its scope is `default` (the source probes as it always does), or `chosen` with the data saver on, which streams at `low` on every connection: a source that probes then checks only the stream the lifecycle will choose (`probeChosenStream`).

The player does the retries with backoff (0 s, 1 s, 3 s) and stops after 4 failed tracks; the lifecycle makes every retry resolve fresh audio.

## Events and reading

| API | What |
|---|---|
| `on('reviewchange', reviews)` | The list of tracks whose match needs review changed. The queue panel (2.5) shows the ones in the queue |
| `on('smartreplace', { track, from, to })` | Smart Replace swapped a match |
| `on('flush', { reason, dropped })` | Every cached URL was dropped: `network`, `ip-changed` or `manual` |
| `reviews()` | The tracks that need review, with their guess and alternatives |
| `flush()` | Drops every cached URL, e.g. on a native network callback |
| `prefetch(items)` | Resolves items ahead, e.g. after a queue edit |

The errors it rejects with follow the player's classes: `Unsupported`, `BotCheck` and `AuthRequired` stop the player (the user must act); `Unavailable` with a `PlaybackProblem` (`playbackProblemOf`) skips the item; `Network`, `RateLimited` and the like are retried.

## Touch-points with other stages

Each one is an interface in `adapters.ts`, with a fake in `./testing` (also exported from `@fxm/player/testing`). Wiring a real implementation in is a few lines in the app:

| Interface | Implemented by | What the real one must do |
|---|---|---|
| `StreamSource` for `ytm` | The YouTube ladder (1.4, not merged when 2.3 was built) | `resolve(candidate, { rung: 'top' })` runs the ladder; `rung: 'fallback'` resolves only itag 18; `hasFallback: true`. Probe where `ctx.capabilities.mediaBytes` and report `fullLength`; return `unverified` URLs otherwise. Probe as `request.probe` says: the ladder's default (`probe: 'best'`, one URL per codec and media) for `default` or no plan, and for `chosen` (the data saver) only the URL playback would choose, with `probeChosenStream(found, plan.choose, probe)` from `@fxm/core`. A `chosen` rung counts as capped only when its `outcome` is `capped`; `nothing-chosen` never counts against it (the ladder's usual check applies). Not wired into 1.4's ladder yet. Report a `playabilityStatus` of `UNPLAYABLE` or `ERROR` with `unplayableError` from `@fxm/core`. Optionally `checkStatus(stream)`: a one-byte ranged GET's status. Draw on the budget at `request.priority` |
| `StreamSource` for `archive`, `jamendo` | The free sources (1.6) | `fromAudioSource(audioSource)` |
| `TrackMatcher` | The matching engine (1.7, not merged) with the YouTube Music, Internet Archive and Jamendo searches | `match(track, { target, exclude })` returns the band and the best candidate, never one in `exclude`. `target: 'song'` searches YouTube Music; `'lossless'` Internet Archive and Jamendo (only while "prefer lossless" is on, for Jamendo's quota) |
| `MatchStore` | The match cache (2.6) | Keyed by track, mode and target (`matchKeyString`); keeps `band`, `candidate`, `alternatives`, `pinned`, `matchedAt`; never expires a pin. The lifecycle checks what it reads with `isStoredMatch` |
| `OfflineStore` | Downloads (4.1) | `find(track)` returns a `verified` stream of the downloaded file |
| `NetworkMonitor` | `createBrowserNetworkMonitor` on the web; native callbacks on desktop (7.3) and Android (6.3) | A new `id` and a call to the listeners on every network change |
| `invidious` | Not planned yet | A `StreamSource` resolving `ytm` candidates through the user's instance (`userhost.html` on the web) |

## Tests

They run offline in happy-dom with fake timers, which also drive `Date.now`: the real `Player` and `FakeEngine` with the lifecycle, a fake ladder (`FakeStreamSource`), a fake matching engine (`FakeMatcher`) and a fake network (`FakeNetworkMonitor`). `test-harness.ts` wires them up. They cover:

- the capped-URL fallback on both probe paths, and "then resolve again" (`probing.test.ts`);
- re-resolving and resuming at expiry, the cache, the flush on a network change and on a 403 for a cached URL (`url-lifecycle.test.ts`);
- the Smart Replace triggers and the protection of pins (`smart-replace.test.ts`);
- queues skipping Suggest items, and what lets them play (`suggest.test.ts`);
- the order of preference, prefetching, shared resolutions, retries and the circuit breaker (`policy.test.ts`), and the edge cases (`edges.test.ts`);
- the quality settings: the connection the user chose, the data saver's ceiling and audio-only preference, and the probe plan it passes the ladder, which follows a change of setting and skips what failed (`quality.test.ts`).
