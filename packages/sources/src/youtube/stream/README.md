# YouTube streams: the direct rungs (`youtube/stream/`)

YouTube's audio source for FXM: `resolve` turns a `ytm` candidate (a videoId) into stream URLs, walking a ladder of InnerTube clients until one yields a URL that plays the whole file. Stage 1.4 implements the direct rungs, which need no deciphering, PO token or SABR; stage 1.11 adds the experimental ones in `stream/advanced/`.

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
| `android-muxed` | ANDROID 21.26.364 | itag 18, a 360p H.264 video with an AAC track: "AAC from 360p video" (`media: 'muxed-video'`) | On, and opts in to videos made for kids |

The first rung that yields a playable URL wins. Rung order, on/off flags, clients, formats and opt-ins all come from the `streams` section of `../youtube-config.json` (below), so a config can change them without new code. ANDROID's adaptive formats are SABR-only; its muxed itag 18 is a direct URL served to the last byte. Never the YouTube embed or IFrame player.

A rung that failed for a reason of its own goes to the back of the ladder for a while (see [Health and memory](#health-and-memory)).

## Every rung's rules

- **Request shape.** One `/player` POST in the CORS-simple shape of `../request.ts` (`toSimpleInnerTubeRequest`): a `text/plain` body, no custom headers, `credentials: 'omit'`, the client's name, version and fields plus `hl`, `gl` and the visitorData in `context.client`, `prettyPrint=false`. It asks for English (`hl=en`), because the ladder reads YouTube's reasons; `gl` follows `ctx.region`. The payload also says `contentCheckOk` and `racyCheckOk`, as the official clients do once the user has accepted a content warning.
- **visitorData.** Always server-issued, from the session shared with the metadata providers: `sw.js_data` in the `full` tier. VISIONOS answers a call without one with a bot check, so in the Lite tier (`simple`), where `sw.js_data` can't be read, a session's first stream call is preceded by the lightest call that gets one issued: search suggestions for an empty input.
- **Bot checks.** On `LOGIN_REQUIRED` that is not an age gate ("Sign in to confirm you're not a bot"), or a bot check page: report it to the request budget, refresh the visitorData once per resolution (only if one was sent), count a failure for the rung, and move to the next rung. HTTP 429 is reported too, and stops the ladder (`RateLimited`).
- **Wrong video.** A response whose `videoDetails.videoId` is not the requested one, or a playable one that names no video, is never used: the rung counts a failure and the ladder moves on.
- **URLs.** Only HTTPS googlevideo URLs are taken (a response can't make FXM fetch another host), and only the video's own audio: not a dubbed, descriptive or dynamic-range-compressed copy.

### Probing

YouTube caps the URLs of most of its clients: googlevideo answers 403 once a request reaches past a cut-off of about 0.4–2 MiB. Players ask for the whole file on their first request, so a capped URL fails at once.

| Where | What `resolve` does | `fullLength` |
|---|---|---|
| Bytes readable: FXM Connect, desktop, Android (`capabilities.mediaBytes`) | A ranged GET of the last 64 KiB of every URL (in parallel), before accepting it. A rung whose URLs are all capped counts as failed, and the ladder moves on | `verified` (206 with all the bytes), `capped` (403) or `unverified` (anything else, e.g. a CORS failure after a googlevideo redirect, a timeout, an unreadable answer) |
| Lite | No probe: googlevideo's bytes can't be read there | `unverified`: the player's first request is the probe (see [Lite](#the-lite-tier)) |

The `Range` header is a single `bytes=first-last` range, which the Fetch standard counts as CORS-safelisted, so a probe needs no preflight; a suffix range (`bytes=-65536`) would not be. itag 18's length is not in its URL or format, so its probe first asks for one byte to read the length from `Content-Range`. Capped options stay in the list, after every other option, so the caller can tell why nothing plays; `pickStream` never picks one.

### Unavailable states

A video the default rungs can't play gets a labelled state instead of a silent failure: a `YouTubeUnplayableError` (an `FxmError` with code `Unavailable`) whose `state` is one of these. `unavailableStateOf(error)` reads it.

| `state` | What YouTube answers (measured 2026-10-26) | Rungs that may try it |
|---|---|---|
| `age-restricted` | `LOGIN_REQUIRED` with `desktopLegacyAgeGateReason`: "Sign in to confirm your age" (VISIONOS), "This video may be inappropriate for some users." (ANDROID) | None |
| `made-for-kids` | VISIONOS: `UNPLAYABLE`, "This video is not available", with the video's details (two videos). ANDROID plays them | `android-muxed`: its itag 18 served such a video to the last byte (`live.test.ts`) |
| `live` | A live stream (`isLive`), a scheduled one (`LIVE_STREAM_OFFLINE`, `isUpcoming`), or a past one without a recording (`UNPLAYABLE`, `isPostLiveDvr`) | None |
| `premiere` | The same, for content that is not live content (`isLiveContent: false`), or whose texts say "Premiere" | None |

Once a video is in one of these states, only rungs that list the state in `tries` are tried. Other video-level answers stop the ladder at once: `ERROR` and private videos (`NotFound`), and region blocks (`GeoBlocked`). Any other `UNPLAYABLE` answer lets the next rung try, and if none can, fails with `Unavailable` without a state. Every `YouTubeUnplayableError` carries YouTube's `status` and `reason`, so a playback policy can tell a video-level failure (Smart Replace) from a ladder failure.

## Stream options

Every `StreamOption` from the ladder is a `YouTubeStreamOption` (`isYouTubeStreamOption`), which adds its `videoId`, `rung`, `itag`, a `label` and, when known, the file's `contentLength`.

| Field | From |
|---|---|
| `codec`, `container`, `media` | The format's MIME type: Opus in WebM, AAC in M4A, or itag 18's MP4 (`muxed-video`) |
| `bitrateKbps` | The file's average (`averageBitrate`). For itag 18, the AAC track's bitrate from the config (`muxedAudioKbps`): YouTube gives only the whole file's |
| `tier` | `tierOf` at the format's nominal (peak) `bitrate`, so Opus 251 is `high` like AAC 140 even for a quiet track whose average dips below 120 kbps. itag 18's 128 kbps track is `high` |
| `sampleRateHz` | `audioSampleRate` |
| `protocol` | `progressive` |
| `expiresAt` | The URL's `expire` (about 6 hours), else `streamingData.expiresInSeconds` |
| `ipBound` | Whether the URL carries the IP address it was resolved from (`ip`, or `ip` in `sparams`): true for YouTube |
| `fullLength` | The probe (above) |
| `label` | The codec (`Opus`, `AAC`), or for a muxed video where the audio comes from: `AAC from 360p video` for itag 18 (its `qualityLabel`) |

**Order.** Best first by `compareStreams`; among equals, the codec `prefs.download.format` needs no conversion for (Opus or AAC), then the rung's own order (Opus 251, then AAC 140, ...). So Opus 251 comes first unless core ranks AAC 140 above it by its average bitrate. Choosing what the player can decode (`canPlayType`, e.g. AAC on older Macs) is the playback policy's job, before `pickStream`.

## Health and memory

The ladder keeps each rung's health per platform and tier (`web/full`, `web/simple`, `desktop/full`, `android/full`): successes, failures, the failures in a row, and the last working rung (`audio.health(ctx)`, for Diagnostics). A rung that fails for a reason of its own (a bot check, capped URLs, no direct formats, a wrong video, an unreadable answer, a URL that failed to play) cools down for 5 minutes, doubling with each failure in a row up to an hour. Cooling rungs are tried after the others, so while VISIONOS is flagged on this IP, songs start on the rung that worked last instead of spending a call on VISIONOS each time, and VISIONOS gets another chance when its cool-down ends. A video's own state never counts against a rung. Pass a `healthStore` (`load`, `save`) to keep this across restarts.

## The Lite tier

In Lite, `resolve` returns `unverified` URLs, and the media element's first request is the probe: a media error, or a stall before the first `playing` event, counts as a failed probe. Then:

1. Call `audio.reportPlaybackFailure(option, ctx)`. The rung counts a failure, and for 30 minutes later resolutions of that video skip it.
2. Resolve again: the ladder falls back to itag 18. (`resolve(candidate, ctx, prefs, { skipRungs: ['visionos'] })` does the same explicitly.)
3. If that fails too, report it as well; the next resolution starts over from the top.

The same applies after a Connect probe that fails CORS after a googlevideo redirect, which leaves the URL `unverified`.

## Config

The `streams` section of `../youtube-config.json`, read by `parseStreamConfig(document)`, next to the metadata config that `parseYouTubeConfig` reads from the same document (it ignores this section):

```jsonc
"streams": {
  "rungs": [                         // ladder order, 1 to 16 rungs
    {
      "id": "visionos",              // stable name for health and diagnostics
      "kind": "direct",              // rungs of kinds this build doesn't know are left out
      "enabled": true,
      "client": { "name": "VISIONOS", "version": "1.02", "host": "www.youtube.com", "fields": {} },
      "itags": [251, 140, 250, 249, 139],   // most preferred first
      "tries": []                    // unavailable states this rung may still try
    }
  ],
  "muxedAudioKbps": { "18": 128 }    // the audio track of muxed formats
}
```

The parser checks every field: hosts must be InnerTube hosts (`INNERTUBE_HOSTS`), client fields are limited to `deviceMake`, `deviceModel`, `osName`, `osVersion`, `platform`, `androidSdkVersion` and `userAgent`, and rung IDs are unique. `pickStreamConfig(candidate, current)` takes a newer valid document (a higher `revision`) and otherwise keeps the current one; pass the source a function (`streamConfig: () => current`) to switch without losing its health. Stage 1.13 adds signature checks.

## The request budget

`StreamBudget` (`budget.ts`) is the one touch-point with stage 1.2's shared request budget: `acquire(priority)` before every InnerTube call (`current-track` by default, or `resolve`'s `priority` option), and `reportBotCheck(cause)` for every bot check. It has the same names and values as `@fxm/platform`'s `RequestBudget`, which can be passed as it is. But 1.2's transports already draw a slot for each InnerTube call and report `LOGIN_REQUIRED` and 429 themselves, so with a `ctx.fetch` from one of them, leave `budget` out (the default counts nothing) or pass one whose `acquire` does nothing, so that no call is counted twice.

## Errors

| What happens | `resolve` rejects with |
|---|---|
| No YouTube access (`capabilities.youtube` is `none`), a candidate of another source, every rung switched off | `Unsupported`, before any request |
| Every enabled rung named in `skipRungs` | `Unavailable`, before any request |
| A malformed videoId | `NotFound` |
| A labelled state, or an `UNPLAYABLE` answer from every rung that tried | `YouTubeUnplayableError`, `Unavailable` |
| A removed or private video (`ERROR`) / a region block | `YouTubeUnplayableError`, `NotFound` / `GeoBlocked` |
| A bot check on every rung tried | `BotCheck` |
| Wrong videos, no direct formats or unreadable answers on every rung | `Parse` |
| HTTP 429, or the budget's refusal | `RateLimited` |
| A failed request or timeout (20 s) | `Network`, without trying another rung |
| The caller's cancellation | The signal's reason |

When every URL found was capped, `resolve` returns those capped options instead.

## Requests per resolution

A song that plays on VISIONOS: one `/player` call, plus one ranged GET per format (five) where bytes are readable. itag 18 adds one `/player` call and two ranged GETs. A bot check adds the visitorData refresh (`sw.js_data`, or the empty suggestions call in Lite). The first call of a Lite session without a stored visitorData adds the suggestions call.

## Tests

Offline tests replay real `/player` responses and googlevideo answers recorded on 2026-10-26 from Node on a residential connection (`fixtures/`), through the fake InnerTube of `../fixtures/testing.ts` and a fake googlevideo that answers ranged GETs as the recorded probes did. `fixtures/sanitize.ts` keeps only the fields the resolver reads, replaces the IP address, the googlevideo host and every signature, session and event value in the stream URLs, and `fixtures/sanitize.test.ts` checks every fixture for leftovers. The fixtures cover each client's answer for a song (IOS's URL is the capped one: 206 for its first 64 KiB, 403 from 1 MiB), a bot check, an age gate, a video made for kids, a live stream, a past one and a scheduled one. No upcoming premiere could be found to record, so the premiere tests change the scheduled stream's response in the two ways a premiere differs; the mismatched-ID tests serve one video's response for another.

To record the fixtures again (12 requests to YouTube and 16 ranged GETs to googlevideo; first check that the live and scheduled streams in `fixtures/testing.ts` still are):

```sh
FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/fixtures/record -u
make format
```

`fixtures/record.test.ts` replays the recorder offline against the fixtures, which must come back unchanged.

The live test (7 requests to YouTube, 9 ranged GETs) resolves "Creep" to VISIONOS URLs that pass the end-of-file probe, and to a passing itag 18 URL with VISIONOS switched off; plays "Baby Shark Dance", made for kids, through itag 18 after VISIONOS refuses it; and checks that a Lite-style session gets a visitorData before its first `/player` call:

```sh
FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/live.test.ts
```

Where each protocol fact came from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).
