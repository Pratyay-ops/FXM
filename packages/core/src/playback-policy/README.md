# The playback policy (`@fxm/core`)

The pure rules behind playback (stage 2.3): which audio plays a track, which stream plays, what happens when a stream fails, and when Smart Replace swaps a match. Nothing here keeps state or touches the network. The stream lifecycle in [`@fxm/player`](../../../player/src/lifecycle/README.md) applies these rules with a URL cache, the probes and prefetching.

| Module | What it holds |
|---|---|
| `settings.ts` | `PlaybackSettings` ("prefer lossless", "Play best guesses", Invidious), `DEFAULT_PLAYBACK_SETTINGS` (all off), `sanitizePlaybackSettings`. The matching engine's bands as the policy reads them (`PlaybackBand`: `auto`, `suggest`, `none`), `MatchTarget` (`song`, `lossless`) and `mayPlayMatch` |
| `order.ts` | `planPlayback`, the order of preference, and the candidates built from a track: `ownCandidate`, `linkedSongCandidate`. `candidateKey` and `sameCandidate` compare audio; `canReachAudio` says whether the tier reaches a source's audio |
| `streams.ts` | `choosePlaybackStream`, the format choice; `streamsUsableUntil` and `URL_REFRESH_MARGIN_MS` for the URL cache |
| `quality-settings.ts` | The quality settings beside the tier ceilings (stage 4.3): `StreamingSettings` (which connection's ceiling to follow, the data saver), `DEFAULT_STREAMING_SETTINGS`, `sanitizeStreamingSettings`, `connectionFromType`; `streamingProfile`, the ceiling, audio-only preference and probe scope in effect; `probeStreams` and its `ProbePlan`, how a resolver probes |
| `recovery.ts` | `planStreamRecovery`, what to do after a stream failed, and `httpStatusOf` |
| `problems.ts` | Playability verdicts (`unplayableError`, `playabilityVerdictOf`), playback problems (`playbackProblemError`, `playbackProblemOf`) and `smartReplaceAction` |

## The order of preference

`planPlayback` lists the steps that find audio for one queue item ([ARCHITECTURE.md §7.4](../../../../docs/ARCHITECTURE.md#74-playback-priority)):

1. An offline copy (a download).
2. With a pin, only the pinned candidate, then Invidious. The user's choice always wins, and a pin is never swapped for another version behind the user's back.
3. The candidate recorded on the queue item: a match the policy confirmed earlier, or the version the user picked.
4. With "prefer lossless" on, a lossless match on Internet Archive or Jamendo, for a track that is not itself from a free source.
5. The track's own audio: a YouTube Music song through the resolution ladder, an Internet Archive or Jamendo item, a local file. For an official music video in Music mode, the song its source links (`songForVideo`), then its matched song. A track from a catalog without audio, such as Spotify, gets its matched song.
6. With Invidious on, the YouTube audio found by then, through the instance the user entered.
7. When everything fails, "Unavailable", with alternatives and a manual search.

Within YouTube, the ladder (1.4) tries VISIONOS, any enabled experimental rungs (1.11), then itag 18. A candidate the mode does not let play is left out, and no audio is tried twice.

## When a match may play

`mayPlayMatch` decides:

| Match | Plays |
|---|---|
| A pin | Always |
| `auto` song | Always |
| `suggest` song (a best guess) | Only after an explicit user action (a tap, a jump, "previous", play on it), or with "Play best guesses" on. Otherwise a queue skips it and marks it "needs review" |
| `none` | Never |
| `lossless` match | First only when ISRC-verified or `auto`; otherwise the song plays |

## Choosing a stream

`choosePlaybackStream` leaves out capped streams, excluded ones (URLs that failed on this network, formats that did not decode) and those the player says `no` to. Streams the player is sure of (`probably`) come before `maybe` ones, so Opus 251 plays only where `canPlayType('audio/webm; codecs="opus"')` says "probably", and AAC 140 otherwise. Then `pickStream` applies the tier ceiling: `prefs.streaming.wifi`, or `.cellular` on mobile data, where audio-only streams also come before a muxed video of a higher tier.

## Connection, data saver and probing

The quality settings (stage 4.3) decide which ceiling applies. `streamingProfile(prefs, settings, detected)` works it out for every stream the lifecycle chooses, so a change applies from the next stream on:

| Settings | Connection | Ceiling | Audio only first | Probe |
|---|---|---|---|---|
| `connection: 'auto'`, Wi-Fi or Ethernet detected | `wifi` (`detected`) | `prefs.streaming.wifi` | No | `every` |
| `connection: 'auto'`, mobile data detected | `cellular` (`detected`) | `prefs.streaming.cellular` | Yes | `every` |
| `connection: 'auto'`, the platform can't tell | `wifi` (`assumed`) | `prefs.streaming.wifi` | No | `every` |
| `connection: 'wifi'` or `'cellular'` | That one (`chosen`), whatever is detected | Its ceiling | On `cellular` | `every` |
| `dataSaver: true`, with any of the above | As above | `low` (`DATA_SAVER_CEILING`) | Yes | `chosen` |

`detected` comes from the platform: `connectionFromType` reads the Network Information API's `type` (`wifi` and `ethernet` are Wi-Fi, `cellular` is mobile data), which only Chromium on Android and ChromeOS and Android's WebView report. Elsewhere it is `unknown`, and the user picks the connection by hand. Phones on a hotspot look like Wi-Fi to the laptop using it, which is what `connection: 'cellular'` is for.

**Probing only the chosen stream.** Where bytes are readable, the YouTube ladder probes the end of every URL it found: five formats on VISIONOS, 64 KB each. With the data saver on, the lifecycle passes a `ProbePlan` whose scope is `chosen`, with a `choose` function that picks exactly as `choosePlaybackStream` will afterwards. `probeStreams(options, plan, probe)` then probes only that stream; if the probe finds it capped, it probes the next choice, and it stops at the first stream that is not capped. The others stay `unverified`. A resolver judges a rung by `plan.choose(result)`: `undefined` means nothing playback would choose is left, as when every URL is capped.

## When a stream fails

`planStreamRecovery` decides, and the player resumes at the position where the stream failed:

| Failure | Next |
|---|---|
| Expired, or 410 | The same rung, with a fresh URL |
| 401 | The same rung, fresh |
| 403 on a cached URL | Drop every cached URL (a probable IP change), then the same rung |
| 403 on a fresh URL, the first on this rung | The same rung, fresh: once, before changing rung |
| 403 again | The fallback rung (itag 18); from the fallback rung, the top again |
| Could not decode | Another format of the same resolution |
| An `unverified` URL fails before its first `play` | The fallback rung: a failed probe. From the fallback rung, the top again |
| A `verified` URL fails before its first `play` | The same rung, fresh: the end-of-file probe proved it is not capped |
| A failure or a stall after playing | The same rung, fresh |

So both probe paths end the same way. Where bytes are readable (FXM Connect, desktop, Android), the ladder's end-of-file probe marks a capped URL `capped`, and the policy asks for the fallback rung. In the Lite tier, where they are not, URLs are `unverified` and the media element's first request is the probe: a media error, or a stall before the first `play` event, falls back to itag 18, then resolves again from the top. A probe that failed CORS after a googlevideo redirect returns `unverified` URLs too, so it takes the Lite path.

`httpStatusOf` reads a status that an engine or a resolver could read (`error.status`, or the `status` of its `cause` chain). A browser's media element never can; the lifecycle then asks the source's status check where bytes are readable.

## Smart Replace

`smartReplaceAction` fires only on a verdict on that very item while other items of the source still resolve:

| Failure | Action |
|---|---|
| `UNPLAYABLE` or `ERROR` for the matched video, and another video resolved recently on this network | `replace`: match again without it |
| The same verdict, but nothing else resolves | `keep-match`: the IP address may be flagged |
| Ladder failures, bot checks, network errors, offline periods, 403s after an IP change | `keep-match`: they say nothing about the match |
| Anything, for a pin | `keep-pin`: pins are never swapped or deleted by FXM |
| The track's own video | `not-a-match`: there is no match to replace |

A resolver reports a verdict with `unplayableError({ source, ref, status })`: an `FxmError` coded `NotFound` for `ERROR` and `Unavailable` for `UNPLAYABLE`, carrying a `PlayabilityVerdict` as its `cause`. `playabilityVerdictOf` reads it back and fails closed on anything else. The YouTube ladder (1.4) reports YouTube's `playabilityStatus` this way.

## Playback problems

When nothing plays, the resolver rejects with `playbackProblemError(problem)`: an `FxmError` coded `Unavailable`, which the player skips at once, with a `PlaybackProblem` as its `cause`:

- `needs-review`: a Suggest-band guess was held back, with the guess and the alternatives;
- `unavailable`, with a reason (`no-match`, `unplayable`, `pinned-unplayable`, `no-stream`, `no-source`) and any alternatives.

The app reads it from the player's `trackfailed` event with `playbackProblemOf(error)`, to show "needs review" or "Unavailable" with the alternatives and a manual search.

See [ARCHITECTURE.md §10](../../../../docs/ARCHITECTURE.md#10-youtube) ("Playback and URL lifecycle") and [§12](../../../../docs/ARCHITECTURE.md#12-matching-engine-packagescoresrcmatching) (Smart Replace, bands).
