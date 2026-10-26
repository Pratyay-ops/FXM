# Settings (`features/settings`)

The Settings page and the stores behind it. Each store is a Zustand store persisted to `localStorage` under its own versioned key. Invalid or unreadable data falls back to the defaults, blocked storage only loses persistence, and other open tabs follow changes (`App` starts the cross-tab sync).

| Store | Key | What it holds |
|---|---|---|
| `useSettingsStore` (`settings-store.ts`) | `fxm.settings.v1` | Catalog mode and theme (stage 2.1) |
| `useQualityStore` (`quality-store.ts`) | `fxm.quality.v1` | Audio quality (stage 4.3): `prefs` (`QualityPrefs` from `@fxm/core`: the tier ceilings on Wi-Fi and on mobile data, the download format and MP3 bitrate) and `streaming` (`StreamingSettings`: which connection's ceiling applies, the data saver) |
| `useMatchingStore` (`matching-store.ts`) | `fxm.matching.v1` | The Auto setting (stage 1.12): whether a match the engine is sure of plays without asking. It counts, and Settings → Playback shows its switch (`AutoMatchSetting`), only while the matching config makes the band available (`isAutoMatchAvailable()`), which it doesn't in this release; `appMatchOptions(mode)` gives the options every match runs with (`matchingOptions`) |

`settings-layout.tsx` has the page's building blocks, `SettingsSection` and `SettingRow` (with an optional `badge` beside the label), for any feature that adds a section. `setting-select.tsx` is the native select for settings with many choices, and `setting-switch.tsx` the switch for on/off settings.

## Audio quality

`QualitySection` (`quality-section.tsx`) shows, in this order:

| Setting | Choices | Default |
|---|---|---|
| Data saver | A switch | Off |
| Streaming on Wi-Fi | Lossless, High, Normal, Low | High |
| Streaming on mobile data | Lossless, High, Normal, Low | Normal |
| Quality to use | Automatic (only where the browser reports its connection), Wi-Fi quality, Mobile data quality | Automatic, which works as Wi-Fi quality where the browser can't tell |
| Download format | Original; FLAC, ALAC, WAV, MP3, AAC and Opus (`DOWNLOAD_FORMATS`) once conversions ship (stage 4.2, `RELEASED.conversions`): until then they are listed as coming soon and can't be chosen, and downloads keep the original file whatever was stored | Original |
| MP3 bitrate, for MP3 downloads | 128, 192, 256, 320 kbps (`MP3_BITRATES`), only once conversions ship | 320 kbps (`DEFAULT_MP3_KBPS`) |

- **The data saver comes first**, since it overrides the three rows after it. It streams at Low on every connection and puts audio-only streams before a muxed video (YouTube's itag 18); downloads ignore it. While it is on, those rows are disabled and say "Not used while Data saver is on."
- **Tiers are ceilings.** Playback streams the best stream at or below the tier, and a song with nothing that low plays at the next quality up (`pickStream`).
- **Which quality applies.** `use-connection.ts` reads the Network Information API's `type`, which only Chromium on Android and ChromeOS and Android's WebView (the Android app) report. Where the browser can't tell (Safari, Firefox, desktop Chromium, the desktop app), Quality to use offers the Wi-Fi or the mobile data quality instead of Automatic, and the mobile data row says it applies only once chosen there. A phone's hotspot, which looks like Wi-Fi, can be set to the mobile data quality too. The streaming row that applies now is tagged "In use", from `streamingProfile` as the stream lifecycle works it out, except while the data saver is on.
- **Honest labels.** The help texts never call YouTube audio lossless: Lossless says YouTube songs play at High, and the download format shows `describeConversion`'s labels, e.g. "FLAC (converted from Opus, same quality as the source)".
- **The words follow the tier and the browser.** `tierDescription` and `downloadFormatHelp` (`quality-options.ts`) take the platform's `NetworkCapabilities`, which `SettingsPage` reads from the sources registry (`useSourcesSnapshot().capabilities`, kept current by the composition root of stage 2.9). Without YouTube (Free only), the tiers are described in MP3 bitrates. Where YouTube's bytes can't be read (Lite, Free only), downloads cover Internet Archive and Jamendo, and the help says that YouTube songs download with FXM Connect, the desktop app or the Android app. `youtube-codecs.ts` asks this browser's `canPlayType` as the player's engine does, so where it can't play Opus, Normal says it plays YouTube songs at Low: YouTube has no AAC stream at Normal.
- **Announcements.** Only help that the row's own control changes is an `aria-live` region: a streaming row's tier, the quality to use, the download format. What another setting changes (the data saver's override, the mobile data hint, the "In use" tag) is mounted in place instead, which screen readers don't announce, so one toggle never reads out several paragraphs.

### Pending

- **Probing only the chosen stream.** With the data saver on, the lifecycle asks every source to probe only the stream it will play (`request.probe`, scope `chosen`), but 1.4's YouTube ladder doesn't read it yet and probes as by default: the best URL of each codec and media, two ranged GETs on VISIONOS. Once it calls `probeChosenStream`, that is one ranged GET on the URL that plays, and the data saver's help can add that it makes fewer requests before a song starts.
- **"Prefer lossless" and the ceiling** need an owner decision before playback settings reach Settings: under the default Wi-Fi ceiling of High, a lossless match plays its best lossy file, not its FLAC (see [the playback policy](../../../../../packages/core/src/playback-policy/README.md#connection-data-saver-and-probing)).

## Playback and About

- **Catalog mode** says what each mode plays (`CATALOG_MODE_DESCRIPTIONS`): Music is songs only, from any source (YouTube Music's album audio, Internet Archive, Jamendo and the user's own files); Music + Video also any YouTube video, played as music.
- **About** has the version, the source link, the one-line non-affiliation notice (`NON_AFFILIATION`, as in R.4's notices) and links to the site's privacy page, disclaimer and third-party notices (`LEGAL_LINKS`), and SponsorBlock's credit.

## Who reads it

- **Playback.** `lifecycleQualityOptions()` gives the stream lifecycle (`StreamLifecycle` in `@fxm/player`) both parts, read afresh for every stream: the app's composition root (`src/app/services`, stage 2.9) creates it with `new StreamLifecycle({ ...lifecycleQualityOptions(), network: createBrowserNetworkMonitor(), … })`. `streamingProfile` from `@fxm/core` combines them with the network monitor, so a change applies from the next stream on.
- **Downloads** (stages 4.1 and 4.2) read `useQualityStore.getState().prefs.download`, and label each conversion with `describeConversion`.
