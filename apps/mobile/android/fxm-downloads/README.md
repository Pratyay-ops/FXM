# fxm-downloads: downloads and the device's music on Android

The Android app's side of downloads and of the device's own music (stage 6.4). Two Capacitor plugins:

- **`FxmDownloads`**, the native side of `packages/downloads/src/native` ([its README](../../../../packages/downloads/src/native/README.md)): the files of the web app's downloads in the app's own storage, the `dataSync` foreground service that keeps downloads going in the background, and a copy of a finished download in the device's Music/FXM folder.
- **`FxmDeviceMusic`**, the native side of `apps/web/src/features/local-files/device-music.ts`: the songs MediaStore knows, with their album covers, for the web app's local files, behind the permission the user gives when they open their music.

The native player ([`fxm-player`](../fxm-player/README.md)) plays both from the device: an offline copy from the downloads folder, a song of the device's from its MediaStore URI. Those are the only files on the device the player and the app's page may read ([below](#what-the-page-may-read)).

## Why the downloads run in the web app

The download manager of stage 4.1 (`@fxm/downloads`) runs in the WebView, as it does in a browser: the queue, the resolution through the playback policy, the end-of-file probe that every YouTube URL must pass, the fresh resolution when a URL is refused or about to expire, and every recovery are the same code on every platform. It fetches through the app's native HTTP (`FxmHttp`, [fxm-http](../fxm-http/README.md)'s shared OkHttp client, so the WebView's cookies never reach a service), and writes through this module. Only where the bytes go is Android's.

**Background.** Android freezes the JavaScript of an app it has cached: one in the background without a foreground service (from Android 14, ten seconds after it is cached). So while the queue has work the web app reports it (`setBackground`), and [`BackgroundDownloads`](src/main/kotlin/io/github/pratyayops/fxm/downloads/BackgroundDownloads.kt) runs [`DownloadService`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DownloadService.kt), a `dataSync` foreground service, which keeps the process, and with it the page and the queue, running, also with the screen off:

- It starts with the first download, from the user's tap (an app in the background may not start one from Android 12 on), and stops five seconds after the queue runs dry, so back-to-back downloads keep one notification.
- While the device is online it holds a partial wake lock (renewed every five minutes, lapsing after ten) and a Wi-Fi lock, so the CPU and the radio stay up with the screen off; while the queue waits for a network it holds neither.
- Its notification uses the system's download icon, names the song or counts the songs, shows the megabytes written so far and opens the app. On Android 13 and later it shows only with the notification permission, which the web app asks for once, from the first download; without it the service runs all the same, listed in Android's running apps.
- A page that goes away (a reload, a renderer that died) has a minute for its successor to report the queue; otherwise the service stops, and the report of the page that is gone never starts it again. Android 15 stops `dataSync` services after six hours a day (`onTimeout`): the queue then runs while FXM is on screen.
- Each start is numbered, and the service says which start it ran for when it ends: a service the controller stopped may only be destroyed after the next download started it again, and that end must not leave the new one running unwatched.

Why a service of its own: the player's `mediaPlayback` service runs only while Media3 plays, and a download is not media playback, which that type declares. WorkManager would run the work as a foreground service as well (`setForeground` for long work), and what it adds, running work while the app is gone and restarting it later, doesn't fit work that lives in the web app: the queue, its records and every resolution (YouTube's included) are JavaScript, so a worker started without the page could only wait for it. One small `dataSync` service keeps the page alive instead, and the download manager continues every file from its size whenever the app was stopped anyway.

## The files

[`DownloadFiles`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DownloadFiles.kt) keeps the files in `files/downloads` of the app's internal storage: no other app can read them, they need no permission, they leave with the app, and backups leave them out (`allowBackup="false"`, `data_extraction_rules.xml`).

- **Names** are the download manager's opaque ones (`isSafeFileName`: 1 to 64 letters, digits, `-` and `_`, never a Windows device name). Any other name is refused before the file system is touched.
- **One writer per file.** Bytes are written at their offset and in order, so a file is always a prefix of the real one, and the manager continues a download from its size after a pause, a crash or a reload. A file whose page is gone is closed at the next page start; a writer a stale page left open is taken over by the next page's.
- **Room for the rest of the phone.** A write that would leave less free space than Android's own low-storage threshold (5 % of the storage, at most 500 MiB) fails with `NO_SPACE`, as does a full disk (`ENOSPC`): the manager pauses the queue then, instead of the phone running out of space.
- File work runs on one worker thread, never on Capacitor's plugin thread, which every plugin shares.

Offline copies play from the device: the web app's playback URL of a file is the WebView URL Capacitor's local server serves it at (`https://localhost/_capacitor_file_/…`), which the native engine turns back into the `file:` URI and hands Media3 as a `file` source ([fxm-player](../fxm-player/README.md#slots-and-sources)), and which an `<audio>` element can load too.

## Saving to Music

[`MusicExporter`](src/main/kotlin/io/github/pratyayops/fxm/downloads/MusicExporter.kt) copies a finished download to Music/FXM, where every music app finds it; the download stays and keeps playing offline in FXM.

- **Android 10 and later** ([`MediaStoreMusicFolder`](src/main/kotlin/io/github/pratyayops/fxm/downloads/MusicFolders.kt)): the app adds its own file to MediaStore's audio collection without any permission. The item stays pending (hidden from other apps) while its bytes are written, and a copy that fails is deleted.
- **Android 9 and older** (`LegacyMusicFolder`): MediaStore needs `WRITE_EXTERNAL_STORAGE` (declared up to API 28 only), which the plugin asks for at that moment; the file is written to the shared Music folder and handed to the media scanner.
- **Names and types** ([`ExportFormats`](src/main/kotlin/io/github/pratyayops/fxm/downloads/ExportFormats.kt)): `Artist, Other artist - Title.ext`, without the characters file systems refuse, cut to 200 bytes. The extension makes the media scanner file the song as audio: Opus or Vorbis in WebM is saved as `.mka` (WebM is Matroska; as `.webm` the scanner would list it among the videos), AAC or ALAC in MP4 as `.m4a`, FLAC in Ogg as `.oga`, and so on. A name another song took gets a number, `Name (1).ext`, as MediaStore numbers copies. A song saved before is not saved twice: a file of the same size under its name, or under a numbered one, is that song.
- **Failures.** A shared storage that is full fails the save with `NO_SPACE`, any other failure with `IO`, also when MediaStore makes no item or Music/FXM can't be created; a copy that fails halfway is deleted. Every plugin call settles, whatever fails: an exception that escaped the worker thread would end the app.
- **No video files.** YouTube's itag 18 is an MP4 video. Saving it would put a video among the songs, the trap [ARCHITECTURE.md §14](../../../../docs/ARCHITECTURE.md#14-downloads-and-formats) names: it waits for stage 4.2 to take its audio out. Tags and cover art in the saved file are 4.2's too; until then music apps show the file's name as the title.

## The device's music

[`DeviceMusicQuery`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DeviceMusicQuery.kt) reads MediaStore's audio collection on every external volume: songs only, as far as MediaStore can tell (below), in pages of up to 500 by `_ID`, with the columns each Android version has (see [CLEAN-ROOM.md](CLEAN-ROOM.md)); [`DeviceAudio`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DeviceAudio.kt) turns each row into the web app's item: its content URI, its volume and its path there (on Android 9 and older from the file's absolute path, so a song keeps its place when the phone moves to Android 10), its tags, MIME type, size and modification time. Covers come from MediaStore's own thumbnails, per album, as small JPEGs. It reads MediaStore's columns, never the files.

**Songs, not voice notes.** MediaStore's `IS_MUSIC` says only where a file is: any audio outside a `Ringtones`, `Notifications`, `Alarms`, `Podcasts` or `Audiobooks` folder, and from Android 12 a `Recordings` one, is music to it ([CLEAN-ROOM.md](CLEAN-ROOM.md)). Played, a song enters the listening history that later stages sync and scrobble, so the listing also leaves out apps' own media folders (`Android/media/<package>/`, indexed from Android 11), where messaging apps keep voice notes, and from Android 12 anything MediaStore marks as a recording (`IS_RECORDING`). Recorders that write to a folder of their own, and recordings before Android 12, still show up: hiding a folder from "This device" is a follow-up.

**Permission.** Reading another app's songs needs `READ_MEDIA_AUDIO` on Android 13 and later and `READ_EXTERNAL_STORAGE` before (declared up to API 32); the web app sees either as `music`. The plugin asks only when the web app calls `requestAccess`, which it does when the user opens the device's music or allows it again from their songs, never on its own. FXM never asks for `MANAGE_EXTERNAL_STORAGE`. After a refusal for good, `openSettings` opens the app's page in Android's settings.

## What the page may read

[`DeviceFiles`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DeviceFiles.kt) is the one list of the device's files that FXM's native player and its page may read: the offline copies in `files/downloads`, and MediaStore's audio items as `content://media/<volume>/audio/media/<id>`. A `file:` path counts by its canonical form (so neither `..` nor a symbolic link leads out of the folder); a content URI must be exactly a MediaStore audio item, without a query.

- **The player** checks every file source against it before Media3 opens anything ([fxm-player](../fxm-player/README.md#slots-and-sources)).
- **The page.** The web app plays these files from the URLs Capacitor's local server serves them at (`/_capacitor_file_<path>`, `/_capacitor_content_/<authority>/<path>`, made by `webViewFileUrl` in `@fxm/player`). That server serves any file the app can read, and opens any content URI, for any script in the page; once FXM may read the device's music, that would include every photo and video MediaStore lists on Android 12 and older, any file on the shared storage on Android 9 and older, and every audio item (voice notes and call recordings too) on every version. So `MainActivity` replaces Capacitor's WebView client, once the bridge exists and before the page can run a script, with [`DeviceFileFilter`](src/main/kotlin/io/github/pratyayops/fxm/downloads/DeviceFileFilter.kt): Capacitor's own client, except that a request for any other device file gets a 404 before the local server sees it. The same rule covers service workers' requests, which Capacitor answers too. To decide, `DeviceFiles.webViewAllows` works out the file the server would open exactly as it does (Capacitor 8.5.3: the decoded path tested for the content prefix first; every `/_capacitor_file_` taken out of a file path; every `<scheme>://<host>[:<port>]/_capacitor_content_` in the URL replaced by `content:/`), and `apps/mobile/android-project.test.ts` fails when Capacitor's handlers stop doing that.

## The bridge protocols

`FxmDownloads` (`packages/downloads/src/native/plugin.ts` speaks it). Errors carry a code: `BAD_REQUEST`, `NOT_FOUND`, `BUSY`, `NO_SPACE`, `DENIED`, `UNAVAILABLE`, `IO`.

| Method | Takes | Resolves with |
|---|---|---|
| `info` | — | `available`, `freeBytes` (what downloads may still take), `reserveBytes` |
| `open` | `file` | `handle`, `size` |
| `write` | `handle`, `offset`, `data` (base64) | `size` |
| `truncate` | `handle`, `size` | `size` |
| `flush`, `close` | `handle` | — |
| `size` | `handle` | `size` |
| `stat` | `file` | `size` and `uri` (`file:`), both `null` when it doesn't exist |
| `read` | `file`, `offset`, `length` (at most 1 MiB) | `data` (base64) and `size`, `null` when gone |
| `remove` | `file` | — |
| `list` | — | `files` |
| `exportToMusic` | `file`, `codec`, `container`, `media`, `title`, `artists`, `album` | `uri`, `path` (e.g. `Music/FXM/A - B.m4a`) |
| `setBackground` | `downloading`, `queued`, `online`, `title` | `running`, `notifications` (a permission state) |
| `requestNotifications` | — | `notifications` |

`FxmDeviceMusic` (`apps/web/src/features/local-files/device-music.ts` speaks it). `scan` and `artwork` reject with `DENIED` without the permission.

| Method | Takes | Resolves with |
|---|---|---|
| `checkAccess`, `requestAccess` | — | `music`: `granted`, `denied`, `prompt` or `prompt-with-rationale` |
| `openSettings` | — | — |
| `scan` | `after` (a MediaStore id), `limit` (at most 500) | `items`, `next` (`null` at the end), `total` on the first page |
| `artwork` | `albums` (`{ volume, id, track }`, at most 24), `size` (pixels) | `pictures`: `{ volume, id, data, width, height }`, JPEG in base64 |

## Tests

```sh
make android-test   # the JVM tests of fxm-http, fxm-player and fxm-downloads, offline, no device
```

The logic is plain Kotlin and tested on the JVM: [`DownloadFiles`](src/test/kotlin/io/github/pratyayops/fxm/downloads/DownloadFilesTest.kt) on a temporary folder (writes at offsets, resuming, one writer per file and per page, refused names, the low-storage reserve, a full disk, reads in chunks, the error code of every failure), the export's names, formats and copies ([`ExportTest`](src/test/kotlin/io/github/pratyayops/fxm/downloads/ExportTest.kt), with a Music folder in memory and the Android 9 folder on a temporary one: saved once, also under the number it got, a failed copy deleted, a copy that can't be made, video files refused), the files the player and the page may read ([`DeviceFilesTest`](src/test/kotlin/io/github/pratyayops/fxm/downloads/DeviceFilesTest.kt): downloads and MediaStore's songs, and no photo, video, other provider, `..`, link, relative path or other spelling of a URL), MediaStore's rows ([`DeviceAudioTest`](src/test/kotlin/io/github/pratyayops/fxm/downloads/DeviceAudioTest.kt): both API generations, memory cards, track and disc numbers, `<unknown>` tags) and the service's decisions ([`BackgroundDownloadsTest`](src/test/kotlin/io/github/pratyayops/fxm/downloads/BackgroundDownloadsTest.kt), on fake timers: starting, stopping after the queue, the wake lock and the network, a refused start, a page that went away and its report, the late end of a stopped service, Android's time limit). The Android glue (`DownloadService`, `DeviceFileFilter`, `MediaStoreMusicFolder`, `DeviceMusicQuery`, the plugins) is compiled by `make apk` and checked on a device. `apps/mobile/android-project.test.ts` checks the service declaration, the permissions (never `MANAGE_EXTERNAL_STORAGE`), the registration, the WebView's client (installed by `MainActivity`, and in step with Capacitor's handlers) and that both sides speak the same messages; the web app's side has its own tests against fakes of both plugins (`createFakeFxmDownloads` in `@fxm/downloads/testing`, `createFakeDeviceMusic` in the local files' `testing`).

## Checks on a device

What only a device shows, for the owner, in a debug APK (`make apk`). The web app's composition root (stage 2.9b) runs the downloads on the app's own platform, Android's native HTTP, so all of them can be checked there.

1. **A download in the background.** Download an album, lock the phone and leave it: the notification names the song and counts up the megabytes, and the downloads finish with the screen off. `scripts/run.sh adb shell dumpsys activity services io.github.pratyayops.fxm` lists `DownloadService` as a foreground service while they run, and not a few seconds after.
2. **A YouTube song, end to end.** A YouTube Music song downloads (its URL passed the end-of-file probe: `fullLength: 'verified'`), plays offline in flight mode, and its file is in `files/downloads` (`scripts/run.sh adb shell run-as io.github.pratyayops.fxm ls -l files/downloads`).
3. **An expired URL.** Pause a long download for more than six hours, resume it: it resolves afresh and continues from where the file ends.
4. **A reload in the middle.** While downloading, kill the WebView's renderer (`Capacitor.Plugins.FxmPlayer.crashRendererForTesting()` from `chrome://inspect`, debug builds): the page comes back and the download continues from its file's size.
5. **A full phone.** With less free space than Android's reserve (or 500 MiB), a download stops as "no room left" and the queue pauses.
6. **Save to Music.** From a downloaded song's menu, "Save to Music folder": the song appears in Music/FXM and in another music app (Opus as `.mka`, AAC as `.m4a`), and in FXM's own "This device" as a song it plays. Saving it again makes no second copy; another song of the same name is saved as `Name (1)`, and saving that one again makes no `Name (2)`. On Android 9 and older, the app asks to write to the shared storage first. A download of a video file (itag 18) says it can't be saved yet. With the shared storage full, the save says there's no room, and the app keeps running.
7. **The notification permission.** On Android 13 and later, the first download asks to show notifications, once; refused, downloads still run.
8. **The device's music.** In Library, Local files, "Music on this device" is the only way to add music (no "Choose files"): Android asks for "Music and audio" (13 and later) or "Files and media"; the phone's songs appear with covers, in search too ("On this device"), and play. Seeking within one works, and they play on Media3 through the app's player, also with the screen off. Nothing asks before the button is pressed. A WhatsApp or Telegram voice note (in `Android/media/…`) and, on Android 12 and later, a voice recording in `Recordings/` are not listed.
9. **Asking only when the user acts.** With the songs listed, take the permission back in Android's settings, then play a playlist that mixes streams and phone songs, and lock the phone: no permission dialog appears while the first song plays or when the queue reaches a phone song, which stops with "Allow FXM to see the music on this device". Tapping Play asks once; allowed, the song plays.
10. **What the page may read.** From `chrome://inspect`, in the app's console, with the music permission granted: `(await fetch('/_capacitor_content_/media/external/images/media/1')).status` and `(await fetch('/_capacitor_file_/proc/self/status')).status` are 404, as is `/_capacitor_file_` plus the path of `files/../shared_prefs`; a downloaded song and a phone song still play (their `/_capacitor_file_/…/files/downloads/…` and `/_capacitor_content_/media/…/audio/media/…` URLs answer 200 or 206).
11. **Refusing it.** Refuse twice, then press the button again: FXM says to allow it in Android's settings, and the folder's "Open settings" opens the app's page there. Allowing it there and coming back lists the songs.
12. **Changes on the device.** Add, retag, move and delete songs with another app, reopen FXM: the list follows, and a moved song keeps its likes and playlist places.
13. **Android 15's time limit.** `scripts/run.sh adb shell device_config put activity_manager data_sync_fgs_timeout_duration 60000`, then download a long list in the background: after a minute the notification goes and the app doesn't crash; opening FXM lets the service start again. `scripts/run.sh adb shell device_config delete activity_manager data_sync_fgs_timeout_duration` restores the limit.
