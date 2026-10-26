# The MediaSource engine (`engines/mse/`)

Stage 1.11's engine for YouTube's SABR streams (`protocol: 'sabr'`), which the experimental `web-sabr` rung of `@fxm/sources` returns. An `<audio src>` can't play them: a SABR session is a series of protobuf `POST`s to a googlevideo URL whose answers (UMP) carry the media. The engine runs the session with googlevideo's `SabrStream` (MIT) and feeds the audio into a `MediaSource` attached to its own audio element.

```ts
import { MseEngine } from '@fxm/player'

const engine = new MseEngine({ fetch: platform.transport.withPriority('current-track') })
engine.canPlay(stream) // 'probably' for a SABR session whose codec MediaSource takes
await engine.load({ stream }, startAtMs)
await engine.play()
```

It implements stage 2.2's engine contract, so the player facade drives it like the direct audio engine: `load`, `play`, `pause`, `seek`, `setVolume`, `setMuted`, `canPlay`, `unlock`, `on` and `destroy`, with the same events and `EngineError` class (`engine-contract.ts` re-exports the contract of `../../engine`).

## Where it runs

| Platform | Session requests | Notes |
|---|---|---|
| Web with FXM Connect | The page's `fetch` (the platform transport), with FXM Connect's googlevideo rules: CORS for the FXM origin, and a YouTube origin on the `POST`'s preflight | After a cross-host redirect, googlevideo's answers stay unreadable to the page: the session ends with a `network` error and the playback policy re-resolves |
| Desktop | The native `fetch` of stage 7.2 | No CORS |
| Android | Not used | The native player (stage 6.3) plays the queue |

The SABR rung itself needs a web PO token, which no FXM web build can mint today (see the [rungs' README](../../../../sources/src/youtube/stream/advanced/README.md)), so the engine has nothing to play on the web until that changes.

## How it plays

- **The session** (`sabr-feed.ts`) is audio only: it names the session's smallest video format as fully buffered, so the server sends none. It downloads the song as fast as the server lets it (a few megabytes), and tries a failed request 3 times (after 0.5, 1 and 2 s) before the session fails.
- **googlevideo only.** `SabrStream` follows the server's redirects wherever they point and posts the session's PO token there, so the feed wraps the `fetch` it is given (`googleVideoOnly`): a request to anything but `https://*.googlevideo.com` on the default port is refused before it leaves, whatever that `fetch` would allow (the page's own `fetch`, or a native one whose scope also covers other hosts). A stream whose URL is not on googlevideo is refused before any session starts.
- **The source buffer** takes the audio format's MIME type (`audio/webm; codecs="opus"`, `audio/mp4; codecs="mp4a.40.2"`), and the media source's duration comes from the session. The engine appends each chunk as the buffer takes it, and ends the stream when the session finishes.
- **A full buffer** (`QuotaExceededError`): the engine removes what lies more than 10 s behind the playhead, or waits for playback to move on, then appends again.
- **Seeking** within what is buffered moves the element. A seek into audio already removed starts the session again from the beginning, at that position. `load(source, startAtMs)` applies the start position once the first audio is in, and reports no position before that.
- **Failures**, as `EngineError`s, one per failure: a session the server ends (`network`), one that needs attestation it lacks or asks for a reload (`unsupported`), a codec the source buffer refuses (`unsupported`), a session past its `expiresAt` (`expired`), a refused `play()` (`autoplay-blocked`), and the element's `MediaError`s (`decode`, `unsupported`, `network`). Data the source buffer refuses ends the stream with a decode error (MSE's append error), so the element reports that one; the session's own report is left out whenever the element has failed.
- **What it refuses**, with an `unsupported` error and without a media source: streams that are not SABR, capped ones, sessions not on googlevideo, sessions in another format than `youtube-sabr/1` (`sabr-playback.ts` checks the JSON, since the player depends on no source), codecs MediaSource doesn't take, and platforms without `MediaSource`.

## Tests

The tests run in Node with stand-ins for the audio element, the media source and its buffer (`testing.ts`). `sabr-feed.test.ts` runs googlevideo's real `SabrStream` against a fake server that answers with UMP built by googlevideo's own writer, and checks the request it posts (client, PO token, ustreamer config, the video format marked buffered), the bytes it hands out, and that a `SABR_REDIRECT` to another host is never followed.

```sh
scripts/run.sh pnpm vitest run packages/player/src/engines/mse
```

Live, 30 s of MediaSource playback in Chromium with FXM Connect is still to do: it needs a PO token from an FXM web build, which can't mint one today. The session itself was checked live from Node (the rungs' `live.test.ts`).
