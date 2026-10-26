# YouTube streams: the experimental rungs (`youtube/stream/advanced/`)

Stage 1.11 adds three kinds of rungs to the stream ladder of [`../README.md`](../README.md), between VISIONOS and itag 18. They decipher signatures or mint attestation tokens, which VISIONOS and itag 18 don't, so **every one of them ships off** in `youtube-config.json` ([ARCHITECTURE.md §10](../../../../../../docs/ARCHITECTURE.md#10-youtube)). A remote config can switch one on (`"enabled": true`); the ladder then tries it only where it can work (below).

| Rung | Kind | Client | What it does |
|---|---|---|---|
| `tv-samsung` | `deciphered` | TVHTML5 5.20260707 with a Samsung TV's device fields and user agent | Ciphered audio URLs, deciphered with the player script in the isolated evaluator |
| `mweb` | `attested` | MWEB | The same, plus a web PO token as each URL's `pot` |
| `web-remix` | `attested` | WEB_REMIX (YouTube Music) | The same as `mweb` |
| `web-sabr` | `sabr` | WEB | No URLs: one SABR session per audio format, for `@fxm/player`'s MediaSource engine, with a web PO token |

```ts
import { createAdvancedRungs, createYouTubeAudioSource } from '@fxm/sources/youtube'

const advanced = createAdvancedRungs({ evaluator }) // the platform's isolated evaluator
const audio = createYouTubeAudioSource({ session, advanced, streamConfig })
```

The resolver keeps everything the rungs share: the ladder and its health, bot checks, playability, wrong-video checks, and the end-of-file probe, which deciphered URLs pass like any other. The hook (`hook.ts`, `createAdvancedRungs()` in `rungs.ts`) adds a rung's extra `/player` fields and turns its answer into stream options.

## What each rung needs

| | `tv-samsung` | `mweb`, `web-remix` | `web-sabr` |
|---|---|---|---|
| The full tier (`capabilities.youtube: 'full'`): the player script and BotGuard's challenge are YouTube pages | Yes | Yes | Yes |
| The isolated evaluator of `@fxm/platform` | For deciphering | For deciphering and BotGuard | For deciphering and BotGuard |
| An evaluator document at `https://www.youtube.com` (`ATTESTATION_ORIGIN`) | No | Yes | Yes |
| Its TV's `User-Agent` on the `/player` request (`sendsUserAgent`) | Yes | No | No |
| Media bytes, and not Android (no MediaSource engine there) | No | No | Yes |

`canRun()` decides which rungs a context can try at once, without a request and without starting the evaluator, whose `origin` is known before it starts; the resolver leaves the others out of the ladder. So a switched-on rung costs nothing where it can't work, and VISIONOS never waits for the evaluator. An evaluator whose document could not start, or is gone, is left alone for 10 minutes (`EVALUATOR_RETRY_MS`): meanwhile no rung that needs it is tried, so no resolution waits for it again.

### Where they can run today

| Platform | Rungs | Why not the others |
|---|---|---|
| Web with FXM Connect | None | A page can't set `User-Agent`, and the web's `eval.html` has an opaque origin, so BotGuard's attestation fails there (`GenerateIT` answers no integrity token for a document that isn't at YouTube's origin, measured below) |
| Desktop | None yet | The evaluator webview is at `fxm-eval://localhost`, so attestation fails; stage 7.2's transport replaces a request's `User-Agent` on InnerTube calls |
| Android | `mweb`, `web-remix`, once stage 6.2's transport exists | The evaluator WebView loads `eval.html` with `https://www.youtube.com/` as its base URL. SABR needs a MediaSource engine; the TV rung needs its user agent, which 6.2's transport replaces too |

## How they work

1. **The player script** (`player-script.ts`): the player's ID from `/iframe_api`, then `/s/player/<id>/player_es6.vflset/en_US/base.js` (about 2.6 MB), from which youtubei.js (MIT) extracts the signature and `n` functions without running them. Kept in memory (and an optional store) by player ID; the ID is checked again after 6 hours, and after the functions themselves failed (they threw, answered no JSON, or gave no signature or `n`). The script is fetched again only when the ID changed; a cancelled or timed-out deciphering, or an evaluator that can't be reached, leaves it alone. One fetch serves every caller, each waiting with its own signal.
2. **The `/player` call** sends `playbackContext.contentPlaybackContext.signatureTimestamp` of that player (and `html5Preference: HTML5_PREF_WANTS`), in the same CORS-simple shape as every InnerTube call. The TV rung also sends its user agent where `sendsUserAgent` is set.
3. **Deciphering** (`decipher.ts`): every URL of the answer in one evaluator call. The extract is defined in the evaluator once per player (key `player:<id>`).
4. **Web PO tokens** (`botguard.ts`), for `mweb`, `web-remix` and `web-sabr`: the challenge from YouTube's home page (`window.ytAtN`, plus its `EVENT_ID`), BotGuard's interpreter from `www.google.com/js/th/…`, the snapshot in the evaluator, an integrity token from `www.youtube.com/api/jnn/v1/GenerateIT` (12 hours), then one token per video, minted in the evaluator. The parent makes every request; BotGuard can make none (`connect-src 'none'`). The session is shared by every caller, each waiting with its own signal, so a skipped track never fails another's resolution. A refused attestation is remembered for 30 minutes, and so is a home page that YouTube answers with its cookie consent page (`consent.youtube.com`), as it does for requests without cookies from some regions, the European Union among them: that page carries no challenge, so the PO-token rungs can't run there (not measured: this stage's live runs came from India).
5. **Stream options**: deciphered URLs (with `pot`) go through the same option builder and end-of-file probe as direct URLs. The SABR rung returns one `protocol: 'sabr'` option per audio format, with `playback` = `{ format: 'youtube-sabr/1', videoId, ustreamerConfig, poToken, client, durationMs, audio, video }` (`sabr.ts`), `unverified` because a session has no file to probe.

A failure in the rung's own steps (the player script, deciphering, BotGuard, the evaluator) counts against the rung (`lastFailure: 'error'`, with its cool-down), and the ladder moves on. The resolver's touch-point is `canRun`, `prepare` and `streamOptions` of `hook.ts`; `canRun` is synchronous, like the `canRun` of the rung kinds the merged stage 1.4 has on `develop`, so the integration maps the hook onto those kinds in a few lines.

**Requests**, on top of a direct rung's: `iframe_api` and the player script once per player (6 hours); the home page (about 1 MB), the interpreter (cached by URL) and `GenerateIT` once per 12 hours for the PO-token rungs. They draw on the request budget like any other YouTube page.

## Live results (2026-10-26)

From Node on a residential connection, with BotGuard in Playwright's Chromium (`eval.html` at `https://www.youtube.com/`, as the Android app loads it) and requests in FXM's shape with a desktop browser's user agent (`live.test.ts`):

| Rung | Result | Shipped |
|---|---|---|
| `tv-samsung` | **Failed.** `/player` answers only with the TV's `User-Agent` (with a browser's or Node's: `UNPLAYABLE`, "The page needs to be reloaded."). In a first run its deciphered Opus 251 and AAC 140 URLs answered 206 for their last 64 KiB; an hour later, in the live test, both answered 403 there (capped), and the next `/player` call met a bot check. Unreliable, and no FXM transport sends its user agent | Off |
| `mweb` | **Passed:** 206 for the last 64 KiB of Opus 251 with the PO token. Without a valid token, 206 for the first 64 KiB but 403 for the last | Off |
| `web-remix` | **Passed:** 206 for the last 64 KiB of Opus 251 with the PO token | Off |
| `web-sabr` | **Session passed, playback pending:** googlevideo's `SabrStream` in Node got 256 KiB of the song's Opus audio from the session. The done-when, 30 s of MediaSource playback in Chromium with FXM Connect, can't pass in FXM's web app: its `eval.html` can't attest (above), so no web build gets a valid token | Off |

What BotGuard needs, measured the same day: tokens minted from Google's generic `Create` challenge (`jnn-pa.googleapis.com`) were refused by googlevideo whatever their content binding (visitorData, visitor ID, video ID) and wherever they were minted (happy-dom, headless Chromium at `about:blank` or at a youtube.com URL). The challenge of YouTube's own page earns an integrity token only in a real browser engine whose document is at `https://www.youtube.com`: at `about:blank`, and in happy-dom, `GenerateIT` answered no token (`[null, 43200, null, <fallback>]`). The page's `EVENT_ID` is the only part of its config BotGuard needed.

InnerTube's own challenge (`/youtubei/v1/att/get`, `ENGAGEMENT_TYPE_UNBOUND`), measured once the same day because it would avoid the home page and its cookie consent redirect: it earned an integrity token in the same Chromium document, but googlevideo refused the token minted from it (403 for the last 64 KiB of MWEB's Opus 251). So the rungs keep the home page's challenge, and where YouTube answers that page with its consent page they fail, are remembered for 30 minutes, and say why.

## Tests

Offline tests replay real `/player` answers recorded on 2026-10-26 (`fixtures/`, sanitized by `fixtures/sanitize.ts`, checked by `fixtures/sanitize.test.ts`) with stand-ins for everything else: a made-up player extract (its signature function reverses the signature), a minimal home page with a challenge, the fake BotGuard of `@fxm/platform/testing` and the real evaluator runtime in process. No code of YouTube's or Google's is committed. `rungs.test.ts` covers rung selection: which rungs each tier, platform and evaluator tries, and what each returns.

```sh
scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/advanced
FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/advanced/live.test.ts
```

The live test makes about ten requests to YouTube, one to Google and about six to googlevideo. With `FXM_RECORD=1` it also writes the sanitized `/player` answers into `fixtures/`; run `make format` afterwards.

Where each protocol fact came from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).
