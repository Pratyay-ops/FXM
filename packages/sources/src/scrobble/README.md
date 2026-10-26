# Scrobbling: ListenBrainz and Last.fm

`@fxm/sources/scrobble` adds the songs the user plays to their own profile on [ListenBrainz](https://listenbrainz.org) or [Last.fm](https://www.last.fm), opt-in, with an offline queue. It runs on the user's device and uses only the injected `ctx.fetch`. Where each protocol fact comes from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

```ts
import {
  createMemoryScrobbleStore,
  LastfmScrobbleClient,
  lastfmTarget,
  ListenBrainzScrobbleClient,
  listenBrainzTarget,
  Scrobbler,
} from '@fxm/sources/scrobble'

const scrobbler = new Scrobbler({
  store: createMemoryScrobbleStore(),            // the web app keeps it in IndexedDB
  targets: () => [
    listenBrainzTarget(new ListenBrainzScrobbleClient(token)),
    lastfmTarget(new LastfmScrobbleClient({ apiKey, secret }), sessionKey),
  ],
  context: () => ({ fetch }),
  onRefused: (service) => markRefused(service), // pause it until the user connects again
})

scrobbler.playStarted({ track, context })                        // "now playing", after 3 s
await scrobbler.playEnded({ track, at, playedMs, durationMs })   // queued, then sent
```

The web app's wiring (accounts in Settings, the queue in IndexedDB, plays from the play recorder) is in [`apps/web/src/features/scrobble`](../../../../apps/web/src/features/scrobble/README.md).

## Works everywhere, without FXM Connect

Both APIs answer any origin with `Access-Control-Allow-Origin: *` (checked 2026-10-26). Last.fm's calls are form-encoded `POST`s, which need no preflight; ListenBrainz's preflights allow `Authorization` and `Content-Type`. So every tier scrobbles straight from the browser, and the desktop and Android apps from their webviews. The hosts are `ws.audioscrobbler.com` and `api.listenbrainz.org`.

## When a play counts

| | ListenBrainz | Last.fm |
|---|---|---|
| Heard for | half the track or 4 minutes, whichever is less | the same |
| Track longer than | (no minimum) | 30 seconds |
| Length unknown | 4 minutes heard | 4 minutes heard |

`qualifiesForScrobble(play, rules)` decides, with `LISTENBRAINZ_RULES` or `LASTFM_RULES`. "Heard" is `playedMs`, the listening time the play recorder measures (stage 3.1): pauses and the parts skipped with a seek never count, so seeking to the end of a song doesn't scrobble it. The length is the one the player knew, else the track's metadata's.

**What is scrobbled** (`scrobbleTrackOf`): songs and official music videos, from any source (YouTube Music, Spotify-matched tracks, Internet Archive, Jamendo, local files). Never other videos or episodes: their artist is a channel and their title free text, and Last.fm asks for "meta data from well-structured sources" only. A track needs a title and a real artist ("Unknown Artist" and "Various Artists" don't count). A YouTube channel's " - Topic" and "VEVO" are dropped from artist names, and a music video's title loses its presentation noise ("(Official Video)") and an "Artist - " prefix, with the core text helpers.

## What is sent

| | ListenBrainz (`POST /1/submit-listens`) | Last.fm (`track.scrobble`, `track.updateNowPlaying`) |
|---|---|---|
| Artist | every credited artist, joined with ", " | the main (first) artist |
| Title, album | `track_name`, `release_name` | `track`, `album` |
| Start | `listened_at`, Unix seconds | `timestamp`, Unix seconds |
| Length, position | `duration_ms`, `tracknumber` | `duration` (seconds), `trackNumber` |
| Also | `duration_played`, `isrc`, `spotify_id` (as a URL) when known; `media_player` and `submission_client` "FXM" with its version | `chosenByUser=0` for plays from a radio, which FXM chose; nothing otherwise, as Last.fm asks when in doubt |
| Credentials | the user token in `Authorization: Token …` | `api_key`, `sk` and `api_sig` in the body |

Nothing else goes out: no `music_service` or `origin_url`, which would publish where FXM got the audio. Every request uses `credentials: 'omit'` and `redirect: 'error'`: neither API redirects, and a redirect must never resend a token, a session key or a listen to another address. A redirect fails the request as a temporary network error.

**Credentials never appear in URLs or messages.** The token travels only in the `Authorization` header; Last.fm's session key, signature and key only in `POST` bodies, and its shared secret never leaves the device: it only signs. Error messages are FXM's own words with the service's error code, never the service's text, which could echo a parameter. The one token in a URL is Last.fm's one-time request token, in the address of its authorization page, as its protocol requires: it expires within an hour and is used up once the session exists.

## Signing Last.fm calls

`lastfmSignature(params, secret)`: every parameter but `format` and `callback`, ordered by name in code-unit (ASCII) order, so `artist[10]` comes before `artist[1]`, written as name then value, then the secret, hashed with MD5 over UTF-8. WebCrypto has no MD5, so `md5.ts` implements RFC 1321 (checked against the RFC's test suite and Last.fm's own example). It is a request checksum, never used for security.

## Connecting

- **ListenBrainz:** the user pastes their token from <https://listenbrainz.org/settings/>. `validateToken()` (`GET /1/validate-token`) says whether it is valid and whose it is.
- **Last.fm:** FXM ships no API key or secret. The user creates an API account of their own (<https://www.last.fm/api/account/create>) and enters its key and shared secret. Then the desktop flow, which needs no callback URL: `getToken()` → the user allows it on `authorizeUrl(token)` in a browser tab → `getSession(token)` gives the session key, which doesn't expire. Until the user allows it, `getSession` rejects with `serviceCode` 14; an expired token gives 15. The web flow would put the token in a URL on FXM's own host, and the mobile flow sends the user's password, so FXM uses neither.

## The scrobbler and its queue

`Scrobbler` keeps one first-in, first-out queue per service in a `ScrobbleStore` (`createMemoryScrobbleStore()` here; the web app's survives restarts in IndexedDB, as Last.fm asks).

- **Now playing:** sent after a play has run for 3 seconds (`nowPlayingDelayMs`), so skipping through a queue sends nothing; never retried, as Last.fm asks, and never queued.
- **Scrobbles:** queued for each service whose rules the play meets, then sent oldest first: up to 50 per request to Last.fm (its limit), 100 to ListenBrainz as one `single` listen or an `import`. Each queue keeps at most 5,000 (`maxQueued`); the oldest go first.
- **Users:** each scrobble is queued for the user connected to its service (`target.user`, e.g. their name there), and only ever sent to that user: a target of anyone else drops it. So when one person disconnects and another connects on the same device, no play of the first reaches the second's profile, even one still on its way to the queue. A play is also never queued for a service that was disconnected, or connected for someone else, while it was being queued for another one.
- **Requests** of one client go one at a time: at least 1 s apart on ListenBrainz ("never make more than ONE call per second"), 250 ms on Last.fm. When ListenBrainz's `X-RateLimit-Remaining` reaches 0, the next request waits for `X-RateLimit-Reset-In`.
- **Offline** (`online()` says so), nothing is sent; `retryNow()` sends at once, e.g. on the browser's `online` event.
- **Tabs** share the queue; `exclusive` runs each flush under a lock (a Web Lock in the web app), so no entry is sent twice.
- **Storage** may hold anything: entries that `sanitizeScrobble` refuses are dropped. A scrobble the store can't save (storage blocked or full) waits in memory instead and is sent like the others, but lost if the program ends first; `status` says so (`storageError`, `unsaved`) until the store saves one again. A store that fails to read is tried again at the next flush, without holding up what waits in memory.
- **Retries:** one timer flushes again when the earliest wait ends. A wait that ended while another service's queue was still being sent is tried as soon as that flush is over, and a rate limit that asks for no wait at all gets a second.

### Failures

Every failure is a `ScrobbleError` (an `FxmError`) whose `failure` says what the queue does:

| `failure` | When | The queue |
|---|---|---|
| `temporary` | Network errors, timeouts and redirects (`Network`), HTTP 5xx and other statuses, an unreadable answer (`Parse`), Last.fm errors 8, 11 and 16, and any other Last.fm error that comes with HTTP 500 or more | keeps the scrobbles and tries again after 30 s, doubling to at most an hour, plus up to 30 % jitter |
| `rate-limited` | HTTP 429, Last.fm error 29 | keeps them and waits as long as the service asked (`retryAfterMs`); `retryNow` doesn't cut that short |
| `refused` | ListenBrainz HTTP 401; Last.fm errors 4, 9, 10, 13, 14, 15, 26 | keeps them and calls `onRefused(service, error, target)`: the app pauses the service (`target.paused`) until the user connects again. Plays keep joining its queue meanwhile |
| `rejected` | ListenBrainz HTTP 400 and 413; every other Last.fm error ("should not be retried") | sends the batch again one scrobble at a time, and drops only the ones still rejected. The third rejection in a row (`MAX_REJECTIONS_IN_A_ROW`) stops that: a service that rejects every scrobble is failing (an outage, a change of its API), so the rest stay, and it waits as after a temporary failure |

Filtered scrobbles are not failures: Last.fm takes them but leaves them out ("ignored", with a code: 1 artist, 2 track, 3 too old, 4 too new, 5 daily limit), and they count as done. An answer without an error that FXM can't read counts a batch as accepted, so it is never sent twice.

Last.fm's list of error codes says to try again on 8 ("Most likely the backend service failed"), which its scrobbling guide counts among the codes not to retry; FXM keeps the scrobbles (see CLEAN-ROOM.md).

`status(service)` reports, for this program, what was sent, ignored and dropped, what waits in memory, when the next try is due, the last error and a failing store; `subscribe` signals every change. `forget(service)` empties a queue and what waits in memory, e.g. on disconnecting; it rejects when the store can't empty the queue.

## Tests

- **Offline** (`*.test.ts` except `live.test.ts`): the rules, the track cleanup, MD5, signing, both clients' requests and every error path, the gate, the memory store and the scrobbler's queue, batches, retries, refusals, isolation of rejected scrobbles and a service that rejects everything, users, a store that fails, now playing, offline and locks, on fake clocks. `fixtures/` holds the services' answers to made-up credentials, recorded on 2026-10-26, and `.synthetic` answers built from the documented samples, because recording successful ones needs an account (see CLEAN-ROOM.md).
- **Live** (`live.test.ts`), only with `FXM_LIVE=1`: five requests with made-up credentials, which write nothing anywhere: both services' CORS headers, their answers to unknown credentials, and that they answer without a redirect. With credentials of your own in the environment (never commit them), it also validates a ListenBrainz token (`FXM_LISTENBRAINZ_TOKEN`) and gets a Last.fm request token (`FXM_LASTFM_API_KEY`, `FXM_LASTFM_SECRET`), and announces a track as playing now (with `FXM_LASTFM_SESSION_KEY` for Last.fm), which adds nothing to the profile's history. It never submits a listen.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/scrobble/live.test.ts
  ```
