# Downloads in the web app

The web app's side of stage 4.1: where downloads are stored, which tab runs the queue, the UI, and offline playback. The queue itself is [`@fxm/downloads`](../../../../../packages/downloads/README.md).

| File | What it holds |
|---|---|
| `runtime.ts` | The app's downloads, created on first use (`getDownloads`): the manager over the `fxm-downloads` database and the Origin Private File System, the Downloads playlist kept in step, `startDownloads` (the tab with the Web Lock runs the queue), `getOfflineStore` for the player, `resetDownloads` for tests |
| `download-db.ts` | The `fxm-downloads` IndexedDB database (Dexie) and the `DownloadStore` on it |
| `opfs/` | The `DownloadStorage` on the Origin Private File System: `storage.ts` on the page, `worker.ts` and `handler.ts` in a dedicated worker that writes through sync access handles, `protocol.ts` for their messages |
| `environment.ts` | The one place where downloads meet stages that hadn't merged (the provider context of 1.2; the sources, matching engine and match cache behind the resolver), and the stand-in until then |
| `persistence.ts` | `navigator.storage.estimate()`, `persisted()` and `persist()` for the usage meter |
| `hooks.ts` | Live reads of the downloads, availability per track, storage numbers |
| `actions.ts` | What buttons and menus do, with their confirmations |
| `download-button.tsx` | A download button for any track: download, progress, pause, resume, retry, remove |
| `downloads-panel.tsx` | The download manager in the library's Downloads tab |
| `menu.ts` | The download entry of track-list menus |
| `format.ts`, `progress.tsx` | Sizes, states, errors; the progress ring and bar |
| `testing.ts`, `opfs/fake-opfs.ts` | Test setup: fakes for the network, the resolver and the file system |

## Storage

- **Files** live in the `downloads` folder of the **Origin Private File System**. A dedicated worker writes them through `FileSystemSyncAccessHandle`s: writes land in the file in place, and a flushed write survives a crash, so a download continues where its file ends. Pages list and read files themselves, and play a complete one from a `blob:` URL typed with its MIME type. Browsers without OPFS or workers (and private windows that block it) get no download offers, and the Downloads tab says why.
- **Records** live in their own IndexedDB database, `fxm-downloads`, apart from the library's `fxm`: downloads describe files on this device, so they stay out of library backups. The Downloads playlist (in the library, stage 2.6) holds their order.
- **Persistence.** The first download asks the browser to keep FXM's data when space runs low (`navigator.storage.persist()`), from the click, where Firefox can ask the user and Chromium decides by itself. The Downloads tab shows whether it agreed, with a button to ask again, and a usage meter: what downloads take, what the rest of FXM takes, and what is free for FXM (`navigator.storage.estimate()`).

## One tab runs the queue

`main.tsx` calls `startDownloads()` after the first render (loaded lazily, so Dexie and the manager stay out of the entry chunk). It asks for the `fxm-downloads` Web Lock, which one tab holds at a time; that tab fetches and writes. Every tab can queue, pause, resume and delete downloads: those are changes to records, which Dexie broadcasts, and the running tab reacts. When it closes, the next tab gets the lock and continues where the files end. A browser without Web Locks runs the queue in every tab.

The running tab also keeps the **Downloads playlist** in step: a completed download is added to the top, and a deleted one leaves it (`addDownload`, `removeDownload` from the library repository). When it starts, it adds completed downloads the playlist lacks.

## Offline playback

`getOfflineStore()` is the `offline` option of the player's `StreamLifecycle` (stage 2.3), so the playback policy plays a downloaded track from the device before resolving anything, also without a network (once the app itself is loaded; the offline app shell is stage 5.1). The player is wired in by stage 2.5; until then the store is ready but unused.

## UI

- **The Downloads tab** of the library shows, above the playlist in its custom order: a notice when the browser can't store downloads, or when YouTube songs can't be downloaded here (no FXM Connect, the Lite tier included); the storage card with the usage meter, persistence and "Remove all downloads"; the downloads on their way with a progress bar, a pause/resume/retry button and a cancel button each, and "Pause all"/"Resume all"; and songs in the playlist that aren't downloaded on this device (after restoring a backup from another device), to download or remove.
- **Track lists** (playlists, Liked songs, Downloads) have "Download", "Cancel download" or "Remove download" in each song's menu, and "Download" for a selection. In Downloads, "Remove download" is the only way out of the list. A playlist's menu has "Download all".
- **`DownloadButton`** is ready for the pages that show tracks elsewhere (search, album and artist pages, now playing: stages 2.4 and 2.5).

Nothing is offered where the bytes are unreadable: YouTube audio needs FXM Connect, the desktop app or the Android app, and never the Lite tier.

## Testing

`setupDownloads()` from `testing.ts` gives the app's downloads an in-memory storage, a `FakeMediaServer` as the network and a `FakeDownloadResolver`, for a tier the test picks, and runs the queue; the test setup resets everything after each test. OPFS is tested against `opfs/fake-opfs.ts`, with the worker's handler run in-process and through a fake worker.
