# YouTube streams: the direct rungs (`youtube/stream/`)

YouTube's audio source for FXM: `resolve` turns a `ytm` candidate (a videoId) into stream URLs, walking a ladder of InnerTube clients until one yields a URL that plays the whole file. Stage 1.4 implements the direct rungs, which need no deciphering, PO token or SABR; stage 1.11 adds the experimental ones in `stream/advanced/`, through the [rung kinds](#rung-kinds) seam.

```ts
import { createYouTubeAudioSource, createYouTubeProviders } from '@fxm/sources/youtube'

const { session, music } = createYouTubeProviders({ visitorDataStore }) // one visitorData
const audio = createYouTubeAudioSource({ session, healthStore })

const [candidate] = await audio.match(track, ctx) // a YouTube track's own audio
const options = await audio.resolve(candidate, ctx, prefs) // best first
// The playback policy drops what the player can't decode, then picks under the tier ceiling:
const stream = pickStream(options.filter(decodable), prefs.streaming.wifi)
```

It is also exported from `@fxm/sources/youtube/stream`. Everything runs on the user's device through `ctx.fetch`; FXM has no servers.

## The ladder

| Rung | Client | Formats | Shipped |
|---|---|---|---|
| `visionos` | VISIONOS 1.02 | Opus 251, AAC 140, Opus 250 and 249, AAC 139 | On |
| `ios` | IOS 20.11.6, with its device fields | AAC 140, 139 | Off: its URLs are capped (403 from 1 MiB, measured 2026-10-26) |
| `android-vr` | ANDROID_VR 1.65.10, with its device fields | Opus and AAC | Off: its URLs are capped (403 from about 1 MiB, measured 2026-10-25) |
| `android-muxed` | ANDROID 21.26.364 | itag 18, a 360p H.264 video with an AAC track: "AAC from 360p video" (`media: 'muxed-video'`) | On, the last resort (`fallback`), and opts in to videos made for kids |

The first rung that yields a playable URL wins. Rung order, on/off flags, clients, formats, opt-ins, where each rung may run and which one is the last resort all come from the `streams` section of `../youtube-config.json` (below), so a config can change them without new code. ANDROID's adaptive formats are SABR-only; its muxed itag 18 is a direct URL served to the last byte. Never the YouTube embed or IFrame player.

`resolve(candidate, ctx, prefs, { rungs: 'fallback' })` tries only the last-resort rung, e.g. after the URLs of the top of the ladder failed their probe in the player; `audio.hasFallback` says whether the config has one. A rung that failed for a reason of its own goes to the back of the ladder for a while (see [Health and memory](#health-and-memory)), so while VISIONOS cools down, a `rungs: 'all'` resolution starts on itag 18: each option says its `rung`.

## Every rung's rules

- **Request shape.** One `/player` POST in the CORS-simple shape of `../request.ts` (`toSimpleInnerTubeRequest`): a `text/plain` body, no custom headers, `credentials: 'omit'`, the client's name, version and fields plus `hl`, `gl` and the visitorData in `context.client`, `prettyPrint=false`. The stream client is named explicitly, so a rung whose client shares its name with a metadata client (`WEB_REMIX`, `WEB`) keeps its own version, host and fields. It asks for English (`hl=en`), because the ladder reads YouTube's reasons; `gl` follows `ctx.region`. The payload also says `contentCheckOk` and `racyCheckOk`, as the official clients do once the user has accepted a content warning.
- **visitorData.** Always server-issued, from the session shared with the metadata providers: `sw.js_data` in the `full` tier. VISIONOS answers a call without one with a bot check, so in the Lite tier (`simple`), where `sw.js_data` can't be read, a session's first stream call is preceded by the lightest call that gets one issued: search suggestions for an empty input.
- **Bot checks.** On `LOGIN_REQUIRED` that is not an age gate ("Sign in to confirm you're not a bot"), or a bot check page: report it to the request budget, refresh the visitorData once per resolution, count a failure for the rung, and move to the next rung. HTTP 429 is reported too, and stops the ladder (`RateLimited`). A bot check answered to a call sent **without** a visitorData (when YouTube issued none to the first call) is FXM's own doing and says nothing about the IP address: the rung tries once more with the visitorData YouTube issued with that answer, nothing is reported, and the rung counts no failure.
- **Wrong video.** A response whose `videoDetails.videoId` is not the requested one, or a playable one that names no video, is never used: the rung counts a failure and the ladder moves on.
- **URLs.** Only HTTPS googlevideo URLs are taken (a response can't make FXM fetch another host), and only the video's own audio: not a dubbed, descriptive or dynamic-range-compressed copy.

### Probing

YouTube caps the URLs of most of its clients: googlevideo answers 403 once a request reaches past a cut-off of about 0.4–2 MiB. Players ask for the whole file on their first request, so a capped URL fails at once.

| Where | What `resolve` does | `fullLength` |
|---|---|---|
| Bytes readable: FXM Connect, desktop, Android (`capabilities.mediaBytes`) | A ranged GET of the last 64 KiB of the best URL of each codec and media (Opus 251, AAC 140, itag 18), and of the next one of that codec when it is capped, before accepting them. A rung whose URLs are all capped counts as failed, and the ladder moves on | `verified` (206 with all the bytes), `capped` (403) or `unverified` (anything else, e.g. a CORS failure after a googlevideo redirect, a timeout, an unreadable answer; and the URLs not probed) |
| Lite | No probe: googlevideo's bytes can't be read there | `unverified`: the player's first request is the probe (see [Playback reports](#playback-reports-and-the-lite-tier)) |

Caps belong to a client, not a format, so one URL per codec answers the probe's question: two ranged GETs on VISIONOS instead of five, for every resolution, the prefetched ones included. `resolve`'s `probe` option changes that: `all` probes every URL (e.g. for a download in a lower format), `none` none (probe one later with `probeEndOfFile`).

The `Range` header is a single `bytes=first-last` range, which the Fetch standard counts as CORS-safelisted, so a probe needs no preflight; a suffix range (`bytes=-65536`) would not be. itag 18's length is not in its URL or format, so its probe first asks for one byte to read the length from `Content-Range`. Capped options stay in the list, after every other option, so the caller can tell why nothing plays; `pickStream` never picks one.

`audio.checkStatus(option, ctx)` reads the status a URL answers now with a one-byte ranged GET, where the bytes are readable: e.g. 403 when the device's IP address changed since it was resolved.

### Unavailable states

A video the default rungs can't play gets a labelled state instead of a silent failure: a `YouTubeUnplayableError` (an `FxmError` with code `Unavailable`) whose `state` is one of these. `unavailableStateOf(error)` reads it.

| `state` | What YouTube answers (measured 2026-10-26) | Rungs that may try it |
|---|---|---|
| `age-restricted` | `LOGIN_REQUIRED` with `desktopLegacyAgeGateReason`: "Sign in to confirm your age" (VISIONOS), "This video may be inappropriate for some users." (ANDROID) | None |
| `made-for-kids` | VISIONOS: `UNPLAYABLE`, "This video is not available", with the video's details (two videos). ANDROID plays them | `android-muxed`: its itag 18 served such a video to the last byte (`live.test.ts`) |
| `live` | A live stream (`isLive`), a scheduled one (`LIVE_STREAM_OFFLINE`, `isUpcoming`), one that has just ended and still plays from the live DVR (`isPostLiveDvr`), or a past one without a recording (`UNPLAYABLE`, "This live stream recording is not available.") | None |
| `premiere` | The same, for content that is not live content (`isLiveContent: false`), or whose texts say "Premiere" | None |

Once a video is in one of these states, only rungs that list the state in `tries` are tried. A past stream's own reasons come first: a recording blocked in the region is `GeoBlocked`, and one made for kids is `made-for-kids`, which itag 18 may play. Other video-level answers stop the ladder at once: `ERROR` (`NotFound`), a private video (`Unavailable`) and region blocks (`GeoBlocked`). Any other `UNPLAYABLE` answer lets the next rung try, and if none can, fails with `Unavailable` without a state.

**Verdicts.** Every `YouTubeUnplayableError` carries the playback policy's playability verdict as its `cause`: `{ type: 'playability', source: 'ytm', ref: videoId, status, reason }`, with `status` `ERROR` for YouTube's `ERROR` and `UNPLAYABLE` for every other answer (an age gate, a private video, a region block, a live stream, a video made for kids, any other reason). Stage 2.3's `playabilityVerdictOf(error)` reads it, and Smart Replace acts on it. Its `videoId`, `state`, `status` and `reason` are there too, for labels and logs. Bot checks, rate limits, network failures and capped URLs never carry a verdict: they say nothing about the video.

## Stream options

Every `StreamOption` from the ladder is a `YouTubeStreamOption` (`isYouTubeStreamOption`), which adds its `videoId`, `rung`, `itag`, a `label` and, when known, the file's `contentLength` and the format's `peakBitrateKbps`.

| Field | From |
|---|---|
| `codec`, `container`, `media` | The format's MIME type: Opus in WebM, AAC in M4A, or itag 18's MP4 (`muxed-video`) |
| `bitrateKbps` | The file's average (`averageBitrate`). For itag 18, the AAC track's bitrate from the config (`muxedAudioKbps`): YouTube gives only the whole file's |
| `peakBitrateKbps` | The format's nominal (peak) bitrate, YouTube's `bitrate`, for audio-only formats |
| `tier` | `tierOf` at the nominal (peak) bitrate, so Opus 251 is `high` like AAC 140 even for a quiet song whose average dips below 120 kbps (ARCHITECTURE.md §7.3; core's `StreamOption.tier` allows this). `tierOf` of the average alone would say `normal` there, so read the tier from the option. itag 18's 128 kbps track is `high` |
| `sampleRateHz` | `audioSampleRate` |
| `protocol` | `progressive` |
| `expiresAt` | The URL's `expire` (about 6 hours), else `streamingData.expiresInSeconds` |
| `ipBound` | Whether the URL carries the IP address it was resolved from (`ip`, or `ip` in `sparams`): true for YouTube |
| `fullLength` | The probe (above) |
| `label` | The codec (`Opus`, `AAC`), or for a muxed video where the audio comes from: `AAC from 360p video` for itag 18 (its `qualityLabel`) |

**Order.** Best first by core's `compareStreams`: tier, audio before muxed video, then the higher **average** bitrate. Only options of exactly equal rank are then ordered by the codec `prefs.download.format` needs no conversion for (Opus or AAC), then by the rung's own order (Opus 251, then AAC 140, ...); with real bitrates that almost never happens. Choosing what the player can decode (`canPlayType`, e.g. AAC on older Macs) is the playback policy's job, before `pickStream`.

**Pending: Opus 251 before AAC 140.** The plan prefers Opus 251 (where playable) to AAC 140, but core ranks options of one tier by average bitrate, and a quiet song's Opus 251 averages less than AAC 140: 111.7 kbps against 129.6 for "Baby Shark Dance", 107 kbps for one of three songs in the research memo. So for such songs AAC 140 comes first and `pickStream` takes it (`resolver.test.ts` records this). That needs a decision in core or the playback policy, outside this folder: either the playback policy picks from the Opus options of the top tier first where `canPlayType('audio/webm; codecs="opus"')` says `probably`, or core's `RankedQuality` gains an optional source preference that `compareStreams` compares after the media and before the bitrate, which the ladder would set from the rung's `itags` order.

## Health and memory

The ladder keeps each rung's health per platform and tier (`web/full`, `web/simple`, `desktop/full`, `android/full`): successes, failures, the failures in a row, and the last working rung (`audio.health(ctx)`, for Diagnostics). A rung counts a success only when one of its URLs is known to play: one that passed the probe, or, where nothing is probed, one the player reports playing (`reportPlaybackSuccess`). Resolving URLs nobody checked counts nothing.

A rung that fails for a reason of its own (a bot check, capped URLs, no direct formats, a wrong video, an unreadable answer, a URL that failed its first request in the player) cools down for 5 minutes, doubling with each failure in a row up to an hour. Cooling rungs are tried after the others, so while VISIONOS is flagged on this IP, songs start on the rung that worked last instead of spending a call on VISIONOS each time, and VISIONOS gets another chance when its cool-down ends. A video's own state never counts against a rung, and neither does a bot check FXM caused by calling without a visitorData.

Pass a `healthStore` (`load`, `save`) to keep this across restarts. Saves wait for the stored state to load, so a report made before the first resolution never overwrites it. What is read back is checked entry by entry: a malformed entry is dropped, and so is a time ahead of the clock, which would otherwise cool a rung down until then. Rungs the config no longer lists are forgotten.

## Playback reports and the Lite tier

In Lite, `resolve` returns `unverified` URLs, and the media element's first request is the probe: a media error, or a stall before the first `playing` event, counts as a failed probe. The same goes for a Connect probe that failed CORS after a googlevideo redirect, which leaves the URL `unverified`. The player tells the ladder what happened:

- `audio.reportPlaybackSuccess(option, ctx)` on the first `playing` event: the rung counts a success and becomes the last working rung. A `verified` URL counted when it was resolved, so it is ignored.
- `audio.reportPlaybackFailure(option, ctx, reason)` after a failure, with the reason of the playback policy's recovery plan (2.3's `RecoveryReason`). Only `probe-failed`, `fallback-failed` (an `unverified` URL failed its first request) and `forbidden-again` (a fresh URL answered 403 again) count against the rung, and cool it down. `expired`, `unauthorized`, `ip-changed`, `forbidden` (a first 403), `first-request` (a `verified` URL failed before it played), `mid-play` and `decode` say nothing about the rung.

Which rung to resolve the failed item on next is the caller's choice: `rungs: 'fallback'` for itag 18, then `rungs: 'all'` again. The ladder keeps no memory per video, so the playback policy stays the one owner of that choice. Options the ladder did not resolve (another source, a rung the config doesn't list, a malformed videoId) are ignored.

## Wiring into the playback policy (2.3)

Stage 2.3's `StreamSource` for `ytm` wraps this source:

| 2.3 | The ladder |
|---|---|
| `id` | `'ytm'` |
| `hasFallback` | `audio.hasFallback` |
| `resolve(candidate, { rung: 'top', priority, ctx, prefs, signal })` | `audio.resolve(candidate, { ...ctx, signal }, prefs, { rungs: 'all', priority })` |
| `rung: 'fallback'` | `{ rungs: 'fallback' }` |
| `priority: 'playback'` / `'prefetch'` | `'current-track'` / `'prefetch'` |
| `checkStatus(stream, { ctx })` | `audio.checkStatus(stream, ctx)` |
| A playability verdict (`playabilityVerdictOf`) | The `cause` of every `YouTubeUnplayableError` (above) |
| The first `playing` event of a stream | `audio.reportPlaybackSuccess(stream, ctx)`: not in 2.3's `StreamSource` yet |
| A failed stream, after `planStreamRecovery` | `audio.reportPlaybackFailure(stream, ctx, recovery.reason)`: not in 2.3's `StreamSource` yet |

The last two need a hook in 2.3's lifecycle, e.g. an optional `reportPlayback` on `StreamSource`; until then the Lite tier's rung health learns nothing from the player.

## Config

The `streams` section of `../youtube-config.json`, read by `parseStreamConfig(document)`, next to the metadata config that `parseYouTubeConfig` reads from the same document (it ignores this section):

```jsonc
"streams": {
  "rungs": [                         // ladder order, 1 to 16 rungs
    {
      "id": "android-muxed",         // stable name for health and diagnostics
      "kind": "direct",              // how the rung works (see Rung kinds)
      "enabled": true,
      "fallback": true,              // the last resort; at most one rung
      "client": { "name": "ANDROID", "version": "21.26.364", "host": "www.youtube.com", "fields": {} },
      "itags": [18],                 // most preferred first
      "tries": ["made-for-kids"],    // unavailable states this rung may still try
      "requires": {                  // where it may run; anywhere when absent (every bundled rung)
        "platforms": ["web", "desktop", "android"],
        "fullAccess": false,         // needs `full` YouTube access (not Lite)
        "mediaBytes": false          // needs googlevideo's bytes
      },
      "settings": {}                 // the kind's own settings; none for `direct`
    }
  ],
  "muxedAudioKbps": { "18": 128 }    // the audio track of muxed formats
}
```

The parser checks every field it reads: the document's `schema` must be the one this build reads, hosts must be InnerTube hosts (`INNERTUBE_HOSTS`), client field values must be short texts or small numbers, rung IDs are unique and at most one rung is the last resort. A newer document of the same schema still loads: a rung this build can't run (a kind, a client field outside `deviceMake`, `deviceModel`, `osName`, `osVersion`, `platform`, `androidSdkVersion` and `userAgent`, or a requirement it doesn't know) is left out, states in `tries` it doesn't know are ignored, and so are fields it doesn't read. Malformed values and foreign hosts refuse the whole document.

`pickYouTubeConfigs(candidate, current)` decides on both parts of a new document at once, so they never come from different documents: it takes the candidate only when its metadata part and its `streams` part are both valid and its `revision` is newer, and otherwise keeps the current ones and says why. Create a new session with the new metadata config, and pass the source a function (`streamConfig: () => current.streams`) to switch the ladder without losing its health. It checks no signature, so give it only trusted documents: a config from the network comes through [`youtube/module`](../module/README.md)'s host and `@fxm/platform`'s updater, which verify it first.

## Rung kinds

How the ladder runs the rungs of one `kind` is a `StreamRungKind` (`kinds.ts`): `DIRECT_RUNGS` is built in. A kind reads its rungs' `settings` (`parseSettings`), may say whether a rung can run in a context (`canRun`, e.g. whether an evaluator started), asks YouTube for the video as its rung's client (`call`, usually one `callPlayer`, which takes extra payload fields such as a `playbackContext`) and turns a playable answer into stream options (`options`). The ladder does the rest for every kind: order and health, `requires`, bot checks and the visitorData, playability and wrong videos, probing progressive URLs, errors.

Stage 1.11 hands its kinds to both `parseStreamConfig(document, { kinds })` and `createYouTubeAudioSource({ rungKinds })`, and marks its rungs `requires: { fullAccess: true }` (deciphering and PO tokens need the player JS, which Lite can't read) and, for SABR, `{ mediaBytes: true, platforms: ['web', 'desktop'] }`. Rungs of a kind a build doesn't run are left out of its config.

## The request budget

`StreamBudget` (`budget.ts`) is the one touch-point with stage 1.2's shared request budget: `acquire(priority)` before every InnerTube call (`current-track` by default, or `resolve`'s `priority` option), and `reportBotCheck(cause)` for every bot check. It has the same names and values as `@fxm/platform`'s `RequestBudget`, which can be passed as it is. But 1.2's transports already draw a slot for each InnerTube call and report `LOGIN_REQUIRED` and 429 themselves, so with a `ctx.fetch` from one of them, leave `budget` out (the default counts nothing) or pass one whose `acquire` does nothing, so that no call is counted twice.

Every slot is taken **before** the session's visitorData lease: a lease without a visitorData (the call that asks YouTube for one) holds back every other InnerTube call of the device until its answer arrives, so a call that waits for the budget while holding one (a `bulk` call during a bot-check pause) would hold back the track about to play. An `acquire` inside `ctx.fetch` would run inside that lease, in 1.3's adapter as well, which the 1.2 integration must keep in mind.

## Errors

| What happens | `resolve` rejects with |
|---|---|
| No YouTube access (`capabilities.youtube` is `none`), a candidate of another source, no rung on that can run here, or `rungs: 'fallback'` without a last-resort rung | `Unsupported`, before any request |
| A malformed videoId | `NotFound` |
| A labelled state, a private video, or an `UNPLAYABLE` answer from every rung that tried | `YouTubeUnplayableError`, `Unavailable`, with a verdict |
| A removed video (`ERROR`) / a region block | `YouTubeUnplayableError`, `NotFound` / `GeoBlocked`, with a verdict |
| A bot check on every rung tried | `BotCheck` |
| Wrong videos, no direct formats or unreadable answers on every rung | `Parse` |
| HTTP 429, or the budget's refusal | `RateLimited` |
| A failed request or timeout (`playerTimeoutMs`, 20 s) | `Network`, without trying another rung |
| The caller's cancellation | The signal's reason |

When every URL found was capped, `resolve` returns those capped options instead.

## Requests per resolution

A song that plays on VISIONOS: one `/player` call, plus two ranged GETs (Opus 251, AAC 140) where bytes are readable. itag 18 adds one `/player` call and two ranged GETs (its length, then its end). A bot check adds the visitorData refresh (`sw.js_data`, or the empty suggestions call in Lite). The first call of a Lite session without a stored visitorData adds the suggestions call.

## Tests

Offline tests replay real `/player` responses and googlevideo answers recorded on 2026-10-26 from Node on a residential connection (`fixtures/`), through the fake InnerTube of `../fixtures/testing.ts` and a fake googlevideo that answers ranged GETs as the recorded probes did. `fixtures/sanitize.ts` keeps only the fields the resolver reads, replaces the IP address, the googlevideo host and every signature, session and event value in the stream URLs, drops the local start time of a scheduled stream, and `fixtures/sanitize.test.ts` checks every fixture for leftovers. The fixtures cover each client's answer for a song (IOS's URL is the capped one: 206 for its first 64 KiB, 403 from 1 MiB), a bot check, an age gate, a video made for kids, a live stream, a past one and a scheduled one. No upcoming premiere could be found to record, so the premiere tests change the scheduled stream's response in the two ways a premiere differs; the mismatched-ID tests serve one video's response for another.

To record the fixtures again (12 requests to YouTube and 16 ranged GETs to googlevideo; first check that the live and scheduled streams in `fixtures/testing.ts` still are):

```sh
FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/fixtures/record -u
make format
```

`fixtures/record.test.ts` replays the recorder offline against the fixtures, which must come back unchanged.

The live test (7 requests to YouTube, 6 ranged GETs) resolves "Creep" to VISIONOS URLs whose best Opus and AAC pass the end-of-file probe, and to a passing itag 18 URL with VISIONOS switched off; plays "Baby Shark Dance", made for kids, through itag 18 after VISIONOS refuses it; and checks that a Lite-style session gets a visitorData before its first `/player` call:

```sh
FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/live.test.ts
```

Where each protocol fact came from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).
