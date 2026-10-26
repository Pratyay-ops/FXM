# Downloads in the Android app (`@fxm/downloads`)

The Android app's side of the download manager (stage 6.4), over `FxmDownloads`, the Capacitor plugin in [`apps/mobile/android/fxm-downloads`](../../../../apps/mobile/android/fxm-downloads/README.md). The manager itself is the same as everywhere: it runs in the WebView, resolves through the playback policy, downloads YouTube audio only from URLs that passed the end-of-file probe, resolves afresh when a URL is refused or about to expire, and fetches through the platform's `fetch`, which in the app is `FxmHttp` (the shared OkHttp client). What this folder adds:

| Piece | What it is |
|---|---|
| `createNativeDownloadStorage({ plugin })` | The `DownloadStorage` in the app's own storage (`files/downloads`): one writer per file, bytes written at their offset in base64, a full phone as `storageFullError`, a storage that can't work as `storageUnavailableError`, every call settled within a minute. `probe()` says whether it works. A file's playback URL is the WebView URL Capacitor serves it at (`webViewFileUrl` from `@fxm/player`), which the native engine plays from the device and an `<audio>` element can load |
| `connectBackgroundDownloads({ plugin, store, network })` | Reports the queue (`downloading`, `queued`, `online`, a song's title) on every change, so the app runs a `dataSync` foreground service while the queue has work: Android freezes the JavaScript of a cached app, and the queue lives there. Its stop reports an empty queue |
| `exportDownloadToMusic(plugin, record)`, `canExportToMusic(record)` | Saves a copy of a finished download to Music/FXM through MediaStore, named `Artist - Title`, as an `FxmError` that says what went wrong otherwise. A video file (YouTube's itag 18) isn't saved: its audio must be taken out first (stage 4.2) |
| `findFxmDownloadsPlugin()` | The plugin on the Capacitor bridge, in the Android app only |
| `createFakeFxmDownloads()` (in `@fxm/downloads/testing`) | The plugin in memory, for tests: files, one writer per file, a full storage, coded errors, queue reports, saved songs |

## Using it

The web app does this in `apps/web/src/features/downloads/runtime.ts`:

```ts
const plugin = findFxmDownloadsPlugin() // undefined outside the Android app
const storage = plugin ? createNativeDownloadStorage({ plugin }) : createBrowserOpfsStorage(…)
const manager = new DownloadManager({ store, storage, resolver, context, network })
// In the one place that runs the queue:
await manager.start()
const stop = plugin && connectBackgroundDownloads({ plugin, store, network })
```

## Tests

`native.test.ts` runs the real manager over the storage and the fake plugin: a download landing in the app's storage and playing offline from there (the native engine can play the offline stream), only probe-verified YouTube URLs, a fresh resolution after a refused URL and before an expiring one continuing the same file, the queue pausing on a full phone, the queue reports, saving to Music and its refusals, and the plugin lookup.
