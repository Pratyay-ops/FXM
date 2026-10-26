# @fxm/downloads

The download manager (stage 4.1): a queue that downloads tracks for offline playback, with concurrency, progress, pause, resume, retry, cancel and delete, and transfers that continue from the bytes already stored. It is runtime-agnostic: it fetches with the platform's injected `fetch`, keeps bytes in a `DownloadStorage` and records in a `DownloadStore` that each platform implements, and plays downloads offline through the stream lifecycle's `OfflineStore` (stage 2.3). The web app's storage (the Origin Private File System) and records (IndexedDB) are in [`apps/web/src/features/downloads`](../../apps/web/src/features/downloads/README.md).

Downloads keep the **original bytes** of the stream (WebM/Opus, M4A/AAC, FLAC, MP3, or YouTube's itag 18 as the MP4 it is). Converting, tagging and "Save to device" are stage 4.2: [`@fxm/convert`](../convert/README.md) saves a copy of a completed download (`storage.read`) in the format the user picks, and the stored original keeps playing offline.

| Piece | What it is |
|---|---|
| `DownloadManager` | The queue: commands (`enqueue`, `enqueueAll`, `pause`, `resume`, `retry`, `remove`, `removeMany`, `pauseAll`, `resumeAll`, `removeAll`), reading (`list`, `get`, `availability`), events (`completed`, `failed`, `removed`), and `start`/`stop` for the one manager that runs the queue |
| `downloadAvailability`, `isDownloadableStream`, `downloadLane` | Where a track may be downloaded, which streams, and which downloads wait together when a source says slow down |
| `createPolicyDownloadResolver` | Finds what to download for a track, from the playback policy's pieces (`planPlayback`, the sources' `StreamSource`s, the matching engine, the match cache), and says which tracks it can resolve at all (`canResolve`) |
| `transfer` | Fetches a file with single-range GETs and writes it as it arrives |
| `maxDownloadBytes` | The largest file a download of a format and duration may be |
| `classifyDownloadFailure` | What to do after a failure: one pure decision per error |
| `createOfflineStore` | The stream lifecycle's `OfflineStore`, backed by completed downloads |
| `DownloadStore`, `createMemoryDownloadStore` | Where records live: the interface and an in-memory store |
| `DownloadStorage`, `createMemoryDownloadStorage`, `isSafeFileName` | Where bytes live: the interface, an in-memory storage, and the file names a storage accepts |
| `DownloadRecord`, `isDownloadRecord`, `downloadId` | The record of one download, its guard, and its ID (`entityKey` of the track, so both YouTube prefixes share a download) |

## Using it

```ts
import { createOfflineStore, createPolicyDownloadResolver, DownloadManager } from '@fxm/downloads'

const manager = new DownloadManager({
  store, // records, shared by every tab (IndexedDB in the web app)
  storage, // files (the Origin Private File System in the web app)
  resolver: createPolicyDownloadResolver({ sources, matcher, matches, settings, canPlay }),
  // Read afresh each attempt: fetch, capabilities, catalog mode. Downloads are background work,
  // so the fetch draws on the request budget at the bulk priority (stage 1.2).
  context: () => platform.context({ mode, priority: 'bulk' }),
  network, // online or not; default: always online
})
manager.on('completed', (record) => library.addDownload(record.track))
manager.on('removed', (record) => library.removeDownload(record.track.id))
await manager.start() // in the one tab (or app) that runs the queue

await manager.enqueue(track) // anywhere, from a click

// The player plays downloads first (stage 2.3):
const lifecycle = new StreamLifecycle({ sources, offline: createOfflineStore({ store, storage }), … })
```

## Where downloads are offered

On by default for every track wherever its bytes are readable (Decision 2, option A; [ARCHITECTURE.md §14](../../docs/ARCHITECTURE.md#14-downloads-and-formats)). `downloadAvailability(track, ctx)` decides:

| Track | Offered when |
|---|---|
| YouTube Music or YouTube audio, and the matched song of a Spotify track or of a music video in Music mode | `capabilities.mediaBytes`: FXM Connect, the desktop app, the Android app. **Never in the Lite tier**, where googlevideo's bytes are unreadable |
| Internet Archive, Jamendo | Everywhere: their files carry CORS headers any page may read |
| A local file | Never: it is on the device already |
| A track the catalog mode hides, a plugin source | Never |

With a resolver, `downloadAvailability` also asks `canResolve`: a track whose audio no stream source here can resolve (an app whose sources aren't wired in yet) is not offered (`no-source`), rather than offered and then failed.

`enqueue` refuses a track that isn't offered (an `Unsupported` `FxmError`), and a queued download whose bytes became unreadable (FXM Connect went away) fails as `unsupported`.

## Which stream is downloaded

`createPolicyDownloadResolver` follows the playback policy's order of preference (`planPlayback`): the user's pin, the track's own audio, its linked song or its match, and with "prefer lossless" an ISRC-verified or Auto lossless match first. It differs from playback where a download must:

- **Only downloadable streams:** progressive and not capped, and for YouTube only URLs that **passed the end-of-file probe** (`fullLength: 'verified'`). When the top rung has none, it asks the fallback rung (itag 18).
- **The best quality:** `lossless` as the ceiling, audio only before a muxed video, and only streams this device can play (`canPlay`, `canPlayType` in a browser), so the copy plays offline here. Quality comes before how sure the browser is: Firefox and Safari answer `maybe` for a type without codecs (`audio/flac`, `audio/mpeg`) and `probably` for `audio/ogg; codecs="vorbis"`, and an Internet Archive download there is still the item's FLAC or 320 kbps MP3 original, not its lossy Vorbis derivative. Among streams of the same quality, the one the browser is surest of wins, so a browser unsure of Opus in WebM downloads YouTube's AAC.
- **No best guesses:** a Suggest-band match is never downloaded, because the offline copy would then play without review from then on. Only a pin, an Auto match or "Play best guesses" let it through; otherwise the download fails as `needs-review`.
- **Fresh every time:** nothing is cached, so every call is a fresh resolution.
- **Background work:** sources and the matcher are asked at the request budget's `bulk` priority (`priority` changes it), and the provider context's `fetch` must draw at the same one. The budget (1.2) then spaces the calls out, stops them while it keeps the last 100 calls of the hour for search and playback, and pauses them after a bot check, so "Download all" on a long playlist never blocks searching.

Matching decisions come from the match cache and go back to it as the stream lifecycle keeps them (`sanitizeStoredMatch` from `@fxm/player`): a pin always stands, an engine's decision for 30 days (`maxMatchAgeMs`), and one that nothing came close for a day (`maxMissAgeMs`), so the engine isn't asked again; an outcome some pages were missing from is not stored.

The manager checks `isDownloadableStream` again whatever the resolver, so no unverified YouTube URL is ever fetched.

## The queue

Every command is a change to a record in the `DownloadStore`, and only a **started** manager fetches. The app starts one manager at a time (the web app: the tab holding a Web Lock), so two tabs never write the same file, while every tab can queue, pause or delete and sees the progress. The started manager follows the store (`subscribe`), so a pause from another tab stops the transfer at once.

| Status | Meaning | Next |
|---|---|---|
| `queued` | Waiting for a slot (2 at a time by default, oldest first), for the network, or for a wait a server or the request budget asked for | `downloading`, `paused`, `removing` |
| `downloading` | Being fetched; `bytesDone` is saved every 500 ms | `completed`, `failed`, `paused`, `queued` (to wait), `removing` |
| `paused` | Stopped by the user, or by the manager after the storage filled up or YouTube asked for a bot check (`error` says which); the partial file stays | `queued` (`resume`) |
| `failed` | Stopped on an error (`error.code`, below) | `queued` (`retry` or `resume`) |
| `completed` | The whole file is stored and plays offline | `removing` |
| `removing` | Cancelled or deleted: hidden at once; the running manager deletes the file, then the record, and announces `removed` | gone |

**Resumable ranges.** Bytes are written in order as they arrive, so the stored file is always a prefix of the real one, and a resume continues from its size (`Range: bytes=<size>-…`) after a pause, a failure, a crash or a closed tab. A resume asks the resolver for the same audio and format; if it gets another one (VISIONOS gave way to itag 18), or the server's `Last-Modified`/`ETag` or size changed, the file starts over.

**Waiting without holding a slot.** When the request budget or a source refuses (`RateLimited`), the download goes back to the queue, and every download of its *lane* waits with it (`downloadLane`: everything that needs YouTube shares one lane; Internet Archive and Jamendo have their own), for `retryAfterMs` (1 s to 15 min; 1 min when none is given). Nothing counts as a failed attempt, so a long bot-check pause of the budget only delays the downloads, while the other lanes go on. A server's `Retry-After` longer than 30 s gives the slot back the same way, for that download; longer than 10 minutes fails it as `server`.

**Stopping the queue on its own.** With the storage full, the queued downloads are paused, and after a bot check the queued YouTube downloads, each with the reason in `error`, so none of them spends a resolution (or asks YouTube again) to fail the same way.

**Starting** tidies up after a manager that stopped without warning: downloads left `downloading` are queued again, completed downloads whose file is gone fail as `file-missing`, and files that no stored row names are deleted. Rows this version can't read (a newer FXM's, or damaged) still protect their files; "remove all" deletes those rows too, and their files go at the next start.

**Many at once.** `enqueueAll`, `removeMany`, `removeAll`, `pauseAll` and `resumeAll` are one change to the store (`updateMany`), so every tab hears about a long list once. The running manager follows only status changes (`subscribe`), and each pass reads only the downloads on their way, so progress saves and thousands of completed downloads cost it nothing.

## Transfers

`transfer()` asks for one bounded range at a time (4 MiB by default) with a single-range `Range` header, which is CORS-safelisted, so a page needs no preflight. It sends `cache: 'no-store'` so the browser's HTTP cache doesn't keep a second copy.

- **`206`**: checked against the range asked for. `Content-Range`, when readable, gives the size. Many hosts don't expose it to pages (Internet Archive doesn't, see [CLEAN-ROOM.md](CLEAN-ROOM.md)), so the end is where the server says there is nothing more: a `416` (or an empty answer) to the range after the last byte. A chunk shorter than asked for is not enough on its own, since a server may cap its answers; it costs one more request per file.
- **`200`**: the server ignored the range; the bytes already stored are skipped.
- The validator is `Last-Modified` (readable by pages) or else `ETag`; only validators of the same kind are compared.

## Failures

`classifyDownloadFailure` decides what each failure means. The manager counts failures in a row: an attempt that stores new bytes starts the counts of attempts and fresh resolutions over, so a long file on a flaky connection keeps going.

| Failure | Next | Limit, then fails as |
|---|---|---|
| HTTP 401, 403, 410, 404; an expired URL; a page (text, JSON, HTML, XML) or an empty file instead of the file | Resolve afresh, continue from the stored bytes, never hand out the failed URL again | 3 fresh resolutions: `server` or `unavailable` |
| **On the web, a request to a signed, IP-bound URL that gets no answer:** what a googlevideo redirect to another host looks like (its bytes are unreadable). Native HTTP on desktop and Android follows redirects | Resolve afresh | 3: `unverified` |
| No stream passed the end-of-file probe | Resolve afresh | 3: `unverified` |
| No answer, offline | Wait for the network without counting, then resolve afresh (a new IP address invalidates signed URLs) | none |
| `RateLimited` from the resolver: the request budget refused, or a source asks to slow down | Queue it again and hold its lane for the wait, without counting (see above) | none |
| No answer otherwise; an answer that broke off or ended short (the URL works, even a signed one); HTTP 408/425/429/5xx; `Network`/`Parse` from the resolver | Wait 1 s, 3 s, 10 s, 30 s (or `Retry-After`, up to 10 minutes) and retry the same URL | 5 attempts: `network`, `server` |
| HTTP 416 mid-file, a file that changed on the server | Start the file over | 2 restarts |
| A file larger than `maxDownloadBytes` (announced, or arriving) | Fail at once, keeping none of it | `too-large` |
| The storage is full (`QuotaExceededError`) | Fail, and pause the queued downloads instead of failing them one by one | `storage-full` |
| The storage can't work here (`SecurityError`, `NotAllowedError`, `NotSupportedError`: a private window, a missing feature, a worker that failed or stopped answering) | Fail at once | `storage` |
| `BotCheck` | Fail at once, and pause the queued YouTube downloads | `bot-check` |
| `Unsupported`, `AuthRequired`, nothing to download, a match that needs review | Fail at once | `unsupported`, `unavailable`, `needs-review` |

**How large a file may be.** `maxDownloadBytes(format, durationMs)` allows the duration at the format's peak bitrate (lossy: 512 kbps or its own if higher; lossless: uncompressed stereo at its sample rate and depth; a muxed video: 2,000 kbps), half as much again, plus 4 MiB; never more than 2 GiB, which is also the limit for an unknown duration. A 4-minute Opus song may take about 27 MB, a 4-minute CD-quality FLAC about 68 MB, so no real file comes near it, while a mislabelled multi-gigabyte upload can't fill the storage the library shares.

## Offline playback

`createOfflineStore({ store, storage })` is the stream lifecycle's `OfflineStore`. For a track with a completed download whose audio may play in the catalog mode, it returns a `verified`, not IP-bound stream of the stored file at the storage's playback URL (a `blob:` URL in a browser), with the loudness the stream had when it was downloaded (`format.loudness`, e.g. YouTube's `loudnessDb`; stage 8.1), so loudness normalization plays the copy at the stream's level; a malformed value is dropped (`sanitizeStreamLoudness`) without making the record invalid. The same file keeps its URL, so a copy that failed to play is skipped. The mode rule is the playback policy's: a download of an official video's own audio (made in Music + Video mode) never plays in Music mode, while a downloaded song stands in for its music video there.

## Storage contract

A `DownloadStorage` (see `storage.ts`) opens one writer per file (`size`, `write(offset, bytes)`, `truncate`, `flush`, `close`), removes, lists and sizes files, reads one as a `Blob`, and hands out a playback URL per complete file until it is removed. The web app implements it on the Origin Private File System; desktop (7.4) and Android (6.4) implement it on the file system.

- **Names** are opaque: 1 to 64 ASCII letters, digits, `-` and `_` (the manager uses random UUIDs). A storage must refuse any other name (`isSafeFileName`, Windows device names included) before it touches the file system, so a damaged or tampered record can never name a path outside the downloads folder; `isDownloadRecord` refuses such records too.
- **Errors:** a full storage rejects with an error named `QuotaExceededError` (`storageFullError`); one that can't work here at all with `SecurityError`, `NotAllowedError` or `NotSupportedError` (`storageUnavailableError`); anything else counts as passing.
- **Every call settles.** A storage whose backend can hang (a worker) rejects after a timeout. The manager also gives up on a slow call when the download is paused or cancelled, and waits at most 30 s for a file to close or be deleted (the file is then left for the next start's tidy-up).

## Record store contract

A `DownloadStore` (see `store.ts`) gets, lists (all records, or those of some statuses, which the queue reads on every pass) and changes records atomically, one (`update`) or many in one transaction (`updateMany`). `rows()` lists every stored row's ID and file name, also of rows that fail `isDownloadRecord`, for housekeeping. `subscribe` must report records added or deleted and status changes, from every tab; it need not report progress (the web app's store doesn't).

## Touch-points with other stages

| Touch-point | Implemented by | Status when 4.1 was built |
|---|---|---|
| The `ytm` `StreamSource` given to `createPolicyDownloadResolver` | The YouTube ladder (1.4): VISIONOS, then itag 18, with the end-of-file probe where bytes are readable | Not merged: tests use `FakeStreamSource` from `@fxm/player/testing` and `FakeDownloadResolver` |
| `StreamSource`s for `archive`, `jamendo` | 1.6 through `fromAudioSource` | Merged on `develop`, not in this stage's base |
| `TrackMatcher`, `MatchStore` | 1.7 and the match cache (2.6) | As for the stream lifecycle |
| `ProviderContext`, its `fetch` at the `bulk` priority | 1.2 (transports, capability detection, request budget): `platform.context({ mode, priority: 'bulk' })` | Merged on `develop`, not in this stage's base |
| `ResolvePriority` `'bulk'` | 2.3's `StreamSourceRequest` and `TrackMatchRequest`: 4.1 added `bulk`, so the type is `'current-track' \| 'prefetch' \| 'bulk'`, in the request budget's words | Added in this stage |

## Testing

`@fxm/downloads/testing` has `FakeMediaServer` (a `fetch` that serves files with ranges and misbehaves on request: capped URLs, statuses, dropped requests, hidden headers, bodies that break off once or every few bytes or hold, a size it claims), `FakeDownloadResolver` and `FakeNetwork`. The tests run offline in Node: the queue, the transfers and their failures, the policy resolver against the lifecycle's fakes, and offline playback through the real `Player` and `StreamLifecycle`. A live check of the transfer against Internet Archive runs with `FXM_LIVE=1` (9 requests):

```sh
FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/downloads/src/live.test.ts
```
