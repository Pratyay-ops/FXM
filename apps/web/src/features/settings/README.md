# Settings (`features/settings`)

The Settings page and the stores behind it. Each store is a Zustand store persisted to `localStorage` under its own versioned key. Invalid or unreadable data falls back to the defaults, blocked storage only loses persistence, and other open tabs follow changes (`App` starts the cross-tab sync).

| Store | Key | What it holds |
|---|---|---|
| `useSettingsStore` (`settings-store.ts`) | `fxm.settings.v1` | Catalog mode and theme (stage 2.1) |
| `useQualityStore` (`quality-store.ts`) | `fxm.quality.v1` | Audio quality (stage 4.3): `prefs` (`QualityPrefs` from `@fxm/core`: the tier ceilings on Wi-Fi and on mobile data, the download format and MP3 bitrate) and `streaming` (`StreamingSettings`: which connection's ceiling applies, the data saver) |

`settings-layout.tsx` has the page's building blocks, `SettingsSection` and `SettingRow`, for any feature that adds a section.

## Audio quality

`QualitySection` (`quality-section.tsx`) shows:

| Setting | Choices | Default |
|---|---|---|
| Streaming on Wi-Fi | Lossless, High, Normal, Low | High |
| Streaming on mobile data | Lossless, High, Normal, Low | Normal |
| Connection | Automatic (only where the browser reports its connection), Wi-Fi, Mobile data | Automatic, which works as Wi-Fi where the browser can't tell |
| Data saver | On, Off | Off |
| Download format | Original, FLAC, ALAC, WAV, MP3, AAC, Opus (`DOWNLOAD_FORMATS`) | Original |
| MP3 bitrate, for MP3 downloads | 128, 192, 256, 320 kbps (`MP3_BITRATES`) | 320 kbps (`DEFAULT_MP3_KBPS`) |

- **Tiers are ceilings.** Playback streams the best stream at or below the tier, and a song with nothing that low plays at the next quality up (`pickStream`).
- **Which connection.** `use-connection.ts` reads the Network Information API's `type`, which only Chromium on Android and ChromeOS and Android's WebView (the Android app) report. Where the browser can't tell (desktop browsers, Safari, Firefox), Settings offers Wi-Fi or Mobile data instead of Automatic, and a phone's hotspot, which looks like Wi-Fi, can be set to Mobile data by hand.
- **The data saver** streams at Low on every connection, puts audio-only streams before a muxed video (YouTube's itag 18), and asks the YouTube ladder to probe only the stream that will play, one 64 KB end-of-file probe instead of one per format (`probeStreams`). It disables the three streaming rows while it is on.
- **Honest labels.** The help texts never call YouTube audio lossless: Lossless says YouTube songs play at High, and the download format shows `describeConversion`'s labels for a YouTube song in Opus and for a lossless source, e.g. "FLAC (converted from Opus, same quality as the source)".

## Who reads it

- **Playback.** `lifecycleQualityOptions()` gives the stream lifecycle (`StreamLifecycle` in `@fxm/player`) both parts, read afresh for every stream: `new StreamLifecycle({ ...lifecycleQualityOptions(), network: createBrowserNetworkMonitor(), … })`. `streamingProfile` from `@fxm/core` combines them with the network monitor, so a change applies from the next stream on.
- **Downloads** (stages 4.1 and 4.2) read `useQualityStore.getState().prefs.download`, and label each conversion with `describeConversion`.
