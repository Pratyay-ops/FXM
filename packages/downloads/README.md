# @fxm/downloads

The download manager (stage 4.1): a queue that downloads tracks for offline playback, with concurrency, progress, pause, resume, retry, cancel and delete, and transfers that continue from the bytes already stored. It is runtime-agnostic: it fetches with the platform's injected `fetch`, keeps bytes in a `DownloadStorage` and records in a `DownloadStore` that each platform implements, and plays downloads offline through the stream lifecycle's `OfflineStore` (stage 2.3). The web app's storage (the Origin Private File System) and records (IndexedDB) are in [`apps/web/src/features/downloads`](../../apps/web/src/features/downloads/README.md).

Downloads keep the **original bytes** of the stream (WebM/Opus, M4A/AAC, FLAC, MP3, or YouTube's itag 18 as the MP4 it is). Converting, tagging and "Save to device" are stage 4.2.

| Piece | What it is |
|---|---|
| `DownloadManager` | The queue: commands (`enqueue`, `enqueueAll`, `pause`, `resume`, `retry`, `remove`, `pauseAll`, `resumeAll`, `removeAll`), reading (`list`, `get`, `availability`), events (`completed`, `failed`, `removed`), and `start`/`stop` for the one manager that runs the queue |
| `downloadAvailability`, `isDownloadableStream` | Where a track may be downloaded, and which streams |
| `createPolicyDownloadResolver` | Finds what to download for a track, from the playback policy's pieces (`planPlayback`, the sources' `StreamSource`s, the matching engine, the match cache) |
| `transfer` | Fetches a file with single-range GETs and writes it as it arrives |
| `classifyDownloadFailure` | What to do after a failure: one pure decision per error |
| `createOfflineStore` | The stream lifecycle's `OfflineStore`, backed by completed downloads |
| `DownloadStore`, `createMemoryDownloadStore` | Where records live: the interface and an in-memory store |
| `DownloadStorage`, `createMemoryDownloadStorage` | Where bytes live: the interface and an in-memory storage |
| `DownloadRecord`, `isDownloadRecord`, `downloadId` | The record of one download, its guard, and its ID (`entityKey` of the track, so both YouTube prefixes share a download) |

## Using it

```ts
import { createOfflineStore, createPolicyDownloadResolver, DownloadManager } from '@fxm/downloads'

const manager = new DownloadManager({
  store, // records, shared by every tab (IndexedDB in the web app)
  storage, // files (the Origin Private File System in the web app)
  resolver: createPolicyDownloadResolver({ sources, matcher, matches, settings, canPlay }),
  context: () => providerContext, // read afresh each attempt: fetch, capabilities, catalog mode
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

`enqueue` refuses a track that isn't offered (an `Unsupported` `FxmError`), and a queued download whose bytes became unreadable (FXM Connect went away) fails as `unsupported`.

## Which stream is downloaded

`createPolicyDownloadResolver` follows the playback policy's order of preference (`planPlayback`): the user's pin, the track's own audio, its linked song or its match, and with "prefer lossless" an ISRC-verified or Auto lossless match first. It differs from playback where a download must:

- **Only downloadable streams:** progressive and not capped, and for YouTube only URLs that **passed the end-of-file probe** (`fullLength: 'verified'`). When the top rung has none, it asks the fallback rung (itag 18).
- **The best quality:** `lossless` as the ceiling, audio only before a muxed video, and streams this device can play first (`canPlay`, `canPlayType` in a browser), so the copy plays offline here.
- **No best guesses:** a Suggest-band match is never downloaded, because the offline copy would then play without review from then on. Only a pin, an Auto match or "Play best guesses" let it through; otherwise the download fails as `needs-review`.
- **Fresh every time:** nothing is cached, so every call is a fresh resolution. Resolutions draw on the request budget at the `prefetch` priority through the sources.

The manager checks `isDownloadableStream` again whatever the resolver, so no unverified YouTube URL is ever fetched.

## The queue

Every command is a change to a record in the `DownloadStore`, and only a **started** manager fetches. The app starts one manager at a time (the web app: the tab holding a Web Lock), so two tabs never write the same file, while every tab can queue, pause or delete and sees the progress. The started manager follows the store (`subscribe`), so a pause from another tab stops the transfer at once.

| Status | Meaning | Next |
|---|---|---|
| `queued` | Waiting for a slot (2 at a time by default, oldest first) or for the network | `downloading`, `paused`, `removing` |
| `downloading` | Being fetched; `bytesDone` is saved every 500 ms | `completed`, `failed`, `paused`, `removing` |
| `paused` | Stopped by the user; the partial file stays | `queued` (`resume`) |
| `failed` | Stopped on an error (`error.code`, below) | `queued` (`retry` or `resume`) |
| `completed` | The whole file is stored and plays offline | `removing` |
| `removing` | Cancelled or deleted: hidden at once; the running manager deletes the file, then the record, and announces `removed` | gone |

**Resumable ranges.** Bytes are written in order as they arrive, so the stored file is always a prefix of the real one, and a resume continues from its size (`Range: bytes=<size>-…`) after a pause, a failure, a crash or a closed tab. A resume asks the resolver for the same audio and format; if it gets another one (VISIONOS gave way to itag 18), or the server's `Last-Modified`/`ETag` or size changed, the file starts over.

**Starting** tidies up after a manager that stopped without warning: downloads left `downloading` are queued again, completed downloads whose file is gone fail as `file-missing`, and files no record names are deleted.

## Transfers

`transfer()` asks for one bounded range at a time (4 MiB by default) with a single-range `Range` header, which is CORS-safelisted, so a page needs no preflight. It sends `cache: 'no-store'` so the browser's HTTP cache doesn't keep a second copy.

- **`206`**: checked against the range asked for. `Content-Range`, when readable, gives the size. Many hosts don't expose it to pages (Internet Archive doesn't, see [CLEAN-ROOM.md](CLEAN-ROOM.md)), so the end is where the server says there is nothing more: a `416` (or an empty answer) to the range after the last byte. A chunk shorter than asked for is not enough on its own, since a server may cap its answers; it costs one more request per file.
- **`200`**: the server ignored the range; the bytes already stored are skipped.
- The validator is `Last-Modified` (readable by pages) or else `ETag`; only validators of the same kind are compared.

## Failures

`classifyDownloadFailure` decides what each failure means; the manager counts per run:

| Failure | Next | Limit, then fails as |
|---|---|---|
| HTTP 401, 403, 410, 404; an expired URL; a page instead of the file | Resolve afresh, continue from the stored bytes, never hand out the failed URL again | 3 fresh resolutions: `server` or `unavailable` |
| **No answer from a signed, IP-bound URL:** on the web, what a googlevideo redirect to another host looks like (its bytes are unreadable) | Resolve afresh | 3: `unverified` |
| No stream passed the end-of-file probe | Resolve afresh | 3: `unverified` |
| No answer, offline | Wait for the network without counting, then resolve afresh (a new IP address invalidates signed URLs) | none |
| No answer otherwise, an answer that broke off, HTTP 408/425/429/5xx, `Network`/`RateLimited`/`Parse` from the resolver | Wait 1 s, 3 s, 10 s, 30 s (or `Retry-After`) and retry the same URL | 5 attempts: `network`, `server` |
| HTTP 416 mid-file, a file that changed on the server | Start the file over | 2 restarts |
| The storage is full (`QuotaExceededError`) | Fail, and pause the queued downloads instead of failing them one by one | `storage-full` |
| `Unsupported`, `AuthRequired`, `BotCheck`, nothing to download, a match that needs review | Fail at once | `unsupported`, `bot-check`, `unavailable`, `needs-review` |

## Offline playback

`createOfflineStore({ store, storage })` is the stream lifecycle's `OfflineStore`. For a track with a completed download whose audio may play in the catalog mode, it returns a `verified`, not IP-bound stream of the stored file at the storage's playback URL (a `blob:` URL in a browser). The same file keeps its URL, so a copy that failed to play is skipped. The mode rule is the playback policy's: a download of an official video's own audio (made in Music + Video mode) never plays in Music mode, while a downloaded song stands in for its music video there.

## Storage contract

A `DownloadStorage` (see `storage.ts`) opens one writer per file (`size`, `write(offset, bytes)`, `truncate`, `flush`, `close`), removes, lists and sizes files, reads one as a `Blob`, and hands out a playback URL per complete file until it is removed. A full storage rejects with an error named `QuotaExceededError`. File names are opaque (random UUIDs). The web app implements it on the Origin Private File System; desktop (7.4) and Android (6.4) implement it on the file system.

## Touch-points with other stages

| Touch-point | Implemented by | Status when 4.1 was built |
|---|---|---|
| The `ytm` `StreamSource` given to `createPolicyDownloadResolver` | The YouTube ladder (1.4): VISIONOS, then itag 18, with the end-of-file probe where bytes are readable | Not merged: tests use `FakeStreamSource` from `@fxm/player/testing` and `FakeDownloadResolver` |
| `StreamSource`s for `archive`, `jamendo` | 1.6 through `fromAudioSource` | Merged on `develop`, not in this stage's base |
| `TrackMatcher`, `MatchStore` | 1.7 and the match cache (2.6) | As for the stream lifecycle |
| `ProviderContext` | 1.2 (transports, capability detection) | Merged on `develop`, not in this stage's base |
| A `bulk` budget priority for large batches | 1.2's request budget | Downloads resolve at `prefetch`; see the follow-ups in the stage report |

## Testing

`@fxm/downloads/testing` has `FakeMediaServer` (a `fetch` that serves files with ranges and misbehaves on request: capped URLs, statuses, dropped requests, hidden headers, bodies that break off or hold), `FakeDownloadResolver` and `FakeNetwork`. The tests run offline in Node: the queue, the transfers and their failures, the policy resolver against the lifecycle's fakes, and offline playback through the real `Player` and `StreamLifecycle`. A live check of the transfer against Internet Archive runs with `FXM_LIVE=1` (9 requests):

```sh
FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/downloads/src/live.test.ts
```
