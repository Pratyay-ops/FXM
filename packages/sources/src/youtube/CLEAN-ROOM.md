# YouTube clean-room log

The YouTube Music and YouTube providers in this folder talk to InnerTube, an API YouTube does not document. The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact the code relies on be recorded here, with where it came from and when. This log covers stage 1.3, the metadata providers. Stage 1.4 adds the stream facts it relies on, under their own heading.

**Nothing here came from a GPL, AGPL or unlicensed project.** No code, fixture or translated logic was taken from Bloomee, bloom-factory, NewPipeExtractor, Spotube or any other such project, and nobody worked from their implementations while writing this folder. The code was written from the facts below. Where the research memo describes how one of those projects behaves (for example that Bloomee read bylines by position), that is a description of its failure, not a protocol fact this code relies on.

## Sources

| Key | Source |
|---|---|
| **Memo** | FXM's research memo, [`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md): live verification runs from a residential connection on 2026-10-25, with the section named |
| **Rec-25** | FXM's own requests, through these providers, recorded by [`fixtures/record.live.test.ts`](fixtures/record.live.test.ts) on 2026-10-25 UTC: YouTube's answers, sanitized, are the fixtures named |
| **Rec-26** | FXM's own requests on 2026-10-26 while answering the first review: the same recorder (`search-top.json`, `next-web-creep.json`), and one-off probes from Node whose answers were read and not kept |
| **1.4-26** | FXM's own `player` calls recorded by stage 1.4 on 2026-10-26 (its `stream/fixtures/`) |
| **Eval-25** | FXM's own requests through these providers by the matching evaluation's recorder (stage 1.12, [`../eval/`](../eval/README.md)) on 2026-10-25 UTC: the answers, reduced to what the labelled set keeps, are the groups in `packages/core/src/matching/eval/fixtures/groups/` |
| **youtubei.js** | youtubei.js 18.1.0 (MIT, by LuanRT), as installed in `node_modules/youtubei.js/dist/src/`, file named; read on 2026-10-25 and 2026-10-26 |
| **Docs** | Public documentation, linked |

## Transport and request shape

| Fact | Source | Date |
|---|---|---|
| InnerTube's API lives at `/youtubei/v1/<endpoint>` on `www.youtube.com`, `music.youtube.com` and `youtubei.googleapis.com` | youtubei.js `utils/Constants.js` (`URLS`); Memo §2.3 | 2026-10-25 |
| FXM's five endpoints: `browse`, `search`, `next`, `player` and `music/get_search_suggestions` | youtubei.js `core/clients/Music.js` (suggestions), `core/Actions.js`; Memo §2.4 (the Lite allowlist) | 2026-10-25 |
| InnerTube accepts the CORS-simple shape: a `POST` whose JSON body is a string sent as `text/plain`, with no custom header, the client name, version, `hl`, `gl` and visitorData read from `context.client`, and `prettyPrint=false` in the URL | Memo §2.3 and §2.4 (five verification runs, `Origin: null` included); Rec-25 (every fixture was requested in this shape); the live smoke test (`live.test.ts`) | 2026-10-25 |
| The headers and fields youtubei.js adds, which the adapter drops: `X-Goog-Visitor-Id`, `X-Youtube-Client-Name` and `-Version`, `Content-Type: application/json`, `alt=json`, `credentials: 'include'`, and its session's `context.client` fields (user agent, operating system, screen, time zone) | youtubei.js `utils/HTTPClient.js`, `core/Session.js` | 2026-10-25 |
| youtubei.js adds `isAudioOnly: true` to `YTMUSIC` payloads | youtubei.js `core/Actions.js` | 2026-10-25 |
| `context.client` takes `hl` as a BCP 47 language tag, written with a region where there is one (`en-GB`), and `gl` as an ISO 3166-1 alpha-2 region (`IN`) | [YouTube Data API `i18nLanguages`](https://developers.google.com/youtube/v3/docs/i18nLanguages) ("a BCP-47 code") and [`i18nRegions`](https://developers.google.com/youtube/v3/docs/i18nRegions); Rec-26 (`sw.js_data` reports `en-GB` and `IN` as its own `hl` and `gl`). Writing Chinese scripts as regions (`zh-Hant` → `zh-TW`, `zh-Hans` → `zh-CN`) is FXM's own choice, not yet checked against an answer: a language YouTube does not know only changes the language of its texts | 2026-10-26 |

## visitorData

| Fact | Source | Date |
|---|---|---|
| `https://www.youtube.com/sw.js_data` answers a JSPB array behind the `)]}'` guard; the device info is at `[0][2][0][0]`, with `hl` at index 0, `gl` at 1, the caller's IP address at 3, the visitorData at 13 and the web client's version at 16 | youtubei.js `core/Session.js` (reads `data[0][2]`, then `device_info[13]`); Rec-26 (read on both `www` and `music.youtube.com`) | 2026-10-26 |
| An answer to a request without visitorData issues one in `responseContext.visitorData` | Memo §4.2; Rec-25 (the simple-tier tests replay it); the live smoke test | 2026-10-25 |
| Locally generated sessions met "Sign in to confirm you're not a bot" in 3 of 4 tries, server-issued ones in none of 4 | Memo §4.1 (F05 verdicts) | 2026-10-25 |

## Clients and versions

| Fact | Source | Date |
|---|---|---|
| YouTube Music's web client is `WEB_REMIX`, version `1.20261020.10.00`, on `music.youtube.com` | Rec-26: `INNERTUBE_CLIENT_NAME` and `INNERTUBE_CLIENT_VERSION` in the `ytcfg` of `https://music.youtube.com/`, and index 16 of `music.youtube.com/sw.js_data` | 2026-10-26 |
| Plain YouTube's web client is `WEB`, version `2.20261023.01.00`, on `www.youtube.com` | Rec-26: index 16 of `www.youtube.com/sw.js_data` | 2026-10-26 |
| youtubei.js names them `YTMUSIC` and `WEB` | youtubei.js `utils/Constants.js` (`CLIENTS`) | 2026-10-25 |

## Search

| Fact | Source | Date |
|---|---|---|
| YouTube Music's filter `params` (`config.search.music`): Songs `EgWKAQIIAWoSEAQQBRADEBAQChAJEBUQDhAR`, Videos `…AQIQ…`, Albums `…AQIY…`, Artists `…AQIg…`, Community playlists `EgeKAQQoAEABahIQBBAFEAMQEBAKEAkQFRAOEBE%3D` | Rec-26: copied from YouTube Music's own filter chips (`chipCloudChipRenderer.navigationEndpoint.searchEndpoint.params`) in its answer to an unfiltered search. The trailing bytes vary between sessions: the 2026-10-25 recordings used other trailing bytes with the same filter prefixes, and both were accepted | 2026-10-26 |
| Plain YouTube's filter `params` (`config.search.web`): Videos `EgIQAQ%3D%3D`, Channels `EgIQAg%3D%3D`, Playlists `EgIQAw%3D%3D` | Rec-26: copied from the search filter dialog (`searchFilterRenderer.navigationEndpoint.searchEndpoint.params`) in YouTube's answer to an unfiltered `WEB` search | 2026-10-26 |
| A YouTube Music search answer: `tabbedSearchResultsRenderer`, its selected tab's `sectionListRenderer`, a `musicShelfRenderer` of `musicResponsiveListItemRenderer` rows for a filtered search; continuations as `musicShelfContinuation` or a trailing `continuationItemRenderer` | Rec-25 (`search-*.json`); youtubei.js `parser/continuations.js` (`musicShelfContinuation`) | 2026-10-25 |
| An unfiltered search answers the top result as a `musicCardShelfRenderer` (its title run links the item: a `watchEndpoint`, or a `browseEndpoint` with a page type; `subtitle` is a byline; `onTap`), followed by one `itemSectionRenderer` per row | Rec-26 (`search-top.json`, and a search for an ISRC) | 2026-10-26 |
| A `WEB` search answer: `twoColumnSearchResultsRenderer`, `itemSectionRenderer`s of `videoRenderer`, `channelRenderer` and `lockupViewModel` (`contentType: LOCKUP_CONTENT_TYPE_PLAYLIST`); continuations as `appendContinuationItemsAction` | Rec-25 (`web-search-*.json`); youtubei.js `parser/parser.js` (`appendContinuationItemsAction`) | 2026-10-25 |
| Suggestions: `music/get_search_suggestions` with `{ input }` answers `searchSuggestionsSectionRenderer`s of `searchSuggestionRenderer`s, each with `navigationEndpoint.searchEndpoint.query` | youtubei.js `core/clients/Music.js`; Rec-25 (`suggest.json`) | 2026-10-25 |
| A Songs-filtered search with an ISRC as the query lists the recording first when YouTube Music has the ISRC, and unrelated filler when it does not; the unfiltered search's top-result card can be the recording too | Eval-25 (the recording first for 6 of 8 ISRCs, filler for the other 2; the card for Vaundy's "しわあわせ"); Memo §6.3 | 2026-10-25 |

## Classification

| Fact | Source | Date |
|---|---|---|
| `musicVideoType` sits at `watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType` of a row's play button, title run or own endpoint, and of queue items | Rec-25 (search, album, playlist and radio fixtures); youtubei.js `parser/classes/MusicResponsiveListItem.js` | 2026-10-25 |
| `MUSIC_VIDEO_TYPE_ATV` is a catalog song ("art track"), `MUSIC_VIDEO_TYPE_OMV` an official music video, `MUSIC_VIDEO_TYPE_UGC` an upload | Rec-25 (150, 34 and 19 of them in the fixtures); Memo §5 | 2026-10-25 |
| `MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC` is official audio shown as a video | Memo §5 | 2026-10-25 |
| `MUSIC_VIDEO_TYPE_PODCAST_EPISODE` marks podcast episodes, which link `MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE` and `MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE` | Rec-26 (a search with YouTube Music's Episodes filter); youtubei.js `parser/classes/MusicResponsiveListItem.js` | 2026-10-26 |
| Page types FXM reads: `MUSIC_PAGE_TYPE_ARTIST`, `_USER_CHANNEL`, `_ALBUM`, `_PLAYLIST`, `_TRACK_CREDITS`, `_ARTIST_DISCOGRAPHY`, and plain YouTube's `WEB_PAGE_TYPE_CHANNEL`, at `browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType` or `commandMetadata.webCommandMetadata.webPageType` | Rec-25 (all fixtures) | 2026-10-25 |
| A byline's runs: links by page type, `•` separators, durations (`3:59`), years and counts (`2.3B plays`); English item labels (`Song`, `Video`, `Single`, `EP`, `Album`) and track counts (`12 songs`) | Rec-25 (search, album, artist and playlist fixtures) | 2026-10-25 |

## Albums and song links

| Fact | Source | Date |
|---|---|---|
| An album's browseId starts with `MPREb_`; its page is a `twoColumnBrowseResultsRenderer` with a `musicResponsiveHeaderRenderer` and the rows in `secondaryContents`' `musicShelfRenderer` | Rec-25 (`album-pablo-honey.json`) | 2026-10-25 |
| An album's audio playlist (`OLAK5uy_…`) is the `playlistId` of its rows' play buttons and title runs, and `browse VL` + that ID lists the album's songs (`ATV`) in order | Rec-25 (`album-pablo-honey.json`, `playlist-olak-pablo-honey.json`) | 2026-10-25 |
| Anonymous album pages may list a song's official video (`OMV`) in its row, and anonymous `next` over the album's playlist returns the official videos (14 of 14 and 18 of 18) | Memo §5 (rule 3); Rec-25 (Creep's row on Pablo Honey is `XFkzRNyygfk`, an `OMV`) | 2026-10-25 |
| Each album row's "View song credits" menu item is a `browseEndpoint` to `MPTC<videoId of the song>` with page type `MUSIC_PAGE_TYPE_TRACK_CREDITS`, and the page's positions line up with the audio playlist's (40 of 40 rows across 6 releases) | Memo §6.2; Rec-25 (12 such items on Pablo Honey, Creep's naming `MPTCzFYEYRcjK2g`) | 2026-10-25 |
| Search results and `next` carry no song-for-video link | Memo §11.7 and §12 (evidence table) | 2026-10-25 |

## Playlists and artists

| Fact | Source | Date |
|---|---|---|
| A playlist's browseId is `VL` + its playlistId; its rows are a `musicPlaylistShelfRenderer` (or `musicShelfRenderer`), continued through `continuationItemRenderer` and `appendContinuationItemsAction`; its header holds the owner (`straplineTextOne`, `facepile`) and counts (`secondSubtitle`) | youtubei.js `core/clients/Music.js` (`VL`); Rec-25 (`playlist-*.json`) | 2026-10-25 |
| An artist page (`browse UC…`) has a `musicImmersiveHeaderRenderer` or `musicVisualHeaderRenderer` header and `musicShelfRenderer` (top songs) and `musicCarouselShelfRenderer` (albums, singles, videos, related artists) sections; a channel without an artist page has the same layout | Rec-25 (`artist-radiohead.json`, `channel-uploader.json`) | 2026-10-25 |
| The artist's Mix is the header's `startRadioButton`: a `watchEndpoint` with `playlistId: RDEM…`, `videoId` and `params: wAEB` | Rec-25 (`artist-radiohead.json`) | 2026-10-25 |

## Radio, queues and tracks

| Fact | Source | Date |
|---|---|---|
| A song's radio is `next` with `videoId`, `playlistId: RDAMVM<videoId>` and `params: wAEB` | Rec-25: `next` answers name `RDAMVM<videoId>` in their automix item (`automixPreviewVideoRenderer` … `watchPlaylistEndpoint.playlistId`), and `wAEB` is the `params` of YouTube Music's own play and radio buttons (`playlist-b-sides.json`, `artist-radiohead.json`); Memo §5 (rule 2) | 2026-10-25 |
| A radio seeded with a song (`ATV`) returned 50 of 50 songs; one seeded with an official video returned official videos | Memo §5 (rule 2) | 2026-10-25 |
| A queue is `singleColumnMusicWatchNextResultsRenderer` → `tabbedRenderer` → `watchNextTabbedResultsRenderer` → first tab → `musicQueueRenderer` → `playlistPanelRenderer` of `playlistPanelVideoRenderer`s (some inside `playlistPanelVideoWrapperRenderer`), continued by `nextRadioContinuationData` and `playlistPanelContinuation` | Rec-25 (`radio-*.json`, `next-*.json`); youtubei.js `parser/continuations.js` | 2026-10-25 |
| An unknown video's `next` and an unknown album's, playlist's or channel's `browse` answer HTTP 200 with an empty page (no `contents`) | Rec-25 (`next-not-found.json`, `album-not-found.json`); Rec-26 (`VLPL…` and `UC…` IDs that do not exist) | 2026-10-26 |
| Plain YouTube's watch page (`next` with `WEB`) holds the description at `twoColumnWatchNextResults.results.results.contents[].videoSecondaryInfoRenderer.attributedDescription.content`, e.g. a song's "Provided to YouTube by …", ℗ line and "Released on:" | Rec-26 (`next-web-creep.json`); youtubei.js `parser/classes/VideoSecondaryInfo.js` | 2026-10-26 |
| An anonymous `WEB_REMIX` `player` call answered `UNPLAYABLE` ("The page needs to be reloaded") with `videoDetails` but no description, which is why descriptions come from the watch page | Rec-26 | 2026-10-26 |
| The lines YouTube generates for a label upload's description, in order: "Provided to YouTube by <distributor>", "<title> · <artists>", the album, "℗ <year> <label>" (the year may be missing), "Released on: <date>", then credits | Eval-25 (the descriptions of `fsM-eXNNSSo`, `Xay0HJ4LsNc` and `ChdQ3xmTh8s`); Rec-26 (`next-web-creep.json`) | 2026-10-25 |

## Errors and bot checks

| Fact | Source | Date |
|---|---|---|
| A bot check is a `playabilityStatus` of `LOGIN_REQUIRED` with the reason "Sign in to confirm you’re not a bot" | Memo §4.1 and §4.2; 1.4-26 (`visionos-bot-check.json`) | 2026-10-26 |
| An age gate is also `LOGIN_REQUIRED`, with "Sign in to confirm your age" and `desktopLegacyAgeGateReason: 1`, or "This video may be inappropriate for some users." | 1.4-26 (`visionos-age.json`, `android-age.json`) | 2026-10-26 |
| Google's bot check page says "Our systems have detected unusual traffic from your computer network" and asks the visitor "to confirm that you're a person and not a robot" | [Google Search Help: "Unusual traffic from your computer network"](https://support.google.com/websearch/answer/86640) | 2026-10-26 |
| That page's address contains `/sorry/` | FXM's assumption, not yet seen in an answer to FXM: matching it can only label a page a bot check | 2026-10-26 |
| InnerTube's error bodies follow Google's API error model, `{ "error": { "code", "message", "status" } }`; `INVALID_ARGUMENT` and `FAILED_PRECONDITION` come with HTTP 400, `NOT_FOUND` with 404 | [AIP-193: Errors](https://google.aip.dev/193); [`google/rpc/code.proto`](https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto) (Apache-2.0), its "HTTP Mapping" comments; Rec-26 (the answer in the next row) | 2026-10-26 |
| An invalid client version (`WEB_REMIX` `0.1`) gets HTTP 404 with `NOT_FOUND`, "Requested entity was not found."; an old but well-formed version (`1.20230102.01.00`) is still served; invalid `params` on a radio's `next` are ignored (HTTP 200) | Rec-26 | 2026-10-26 |
| `Retry-After` is delta seconds or an HTTP date | [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) | 2026-10-26 |

## Artwork

| Fact | Source | Date |
|---|---|---|
| Thumbnails are `{ url, width, height }` lists; Google image URLs on `*.googleusercontent.com` and `*.ggpht.com` end in a size suffix (`=w120-h120-l90-rj`, `=s88-c-k-…`) and render other sizes on request, up to the 544 px that album pages list | Rec-25 (thumbnail URLs in every fixture); Rec-26 (a 544 px size in a `player` answer's `videoDetails`) | 2026-10-26 |

## The Lite tier: opaque origins (stage 1.10)

The facts the Lite tier's sandbox documents (`packages/platform/src/sandbox/`) rely on; the browser behaviour they rely on is in that folder's own `CLEAN-ROOM.md`. Two more sources:

- **Lite-26a**: stage 1.10's live browser test (`packages/platform/src/sandbox/e2e/live.e2e.ts`, `FXM_LIVE=1`) on 2026-10-26 at 02:40 IST (21:10 UTC the day before), from a residential connection in India, in Playwright's Chromium 156.0.8078.4 and Firefox 157.0 on macOS: the self-test, a YouTube Music search, `next`, `browse` and a hand-built VISIONOS `player` call from the sandbox document, then the same with `FXM_FULL_PLAYBACK=1`, one run each per browser. The answers were read and summarised, not kept
- **Lite-26b**: the same test at 04:06–04:13 IST (22:36–22:43 UTC the day before), with 1.3's search and 1.4's stream resolver sending their requests through the sandbox, one run each per browser

| Fact | Source | Date |
|---|---|---|
| InnerTube answers CORS-simple `POST`s sent with `Origin: null` with 200 and `Access-Control-Allow-Origin: null`, on `search`, `next`, `browse` and `player`; it answers preflights from `null` with 403, and named foreign origins with 403 and no CORS headers | Memo §2.4 and §3 (five verification runs; in browsers only `search` and `player`) | 2026-10-25 |
| From a document served with `sandbox allow-scripts` and framed with `sandbox="allow-scripts"`, in Chromium 156 and Firefox 157, `music/get_search_suggestions`, `search`, `next` and `browse` on `music.youtube.com` and `player` on `www.youtube.com` answered 200 to CORS-simple `POST`s, and the document could read every answer, so each allowed the `null` origin | Lite-26a; Lite-26b (`music/get_search_suggestions`, `search` and `player`) | 2026-10-26 |
| `youtubei.googleapis.com` was not called from a browser by stage 1.10; the memo's curl and Node runs are the evidence for it | Memo §2.4 | 2026-10-25 |
| A search sent from the sandbox without visitorData is answered with a server-issued one, and with it VISIONOS answers `player` from the sandbox with `OK` and direct URLs: Opus 251 among `adaptiveFormats` with no `signatureCipher` (a hand-built call), and five options of the `visionos` rung through 1.4's resolver | Lite-26a; Lite-26b | 2026-10-26 |
| `<audio src>` on the FXM page played a VISIONOS URL resolved through the sandbox: `playing` after 0.7 s (Opus 251) and 0.8 s (AAC 140) in Chromium, and 0.1 s and 0.7 s in Firefox | Lite-26a; Lite-26b | 2026-10-26 |
| VISIONOS URLs resolved through the sandbox are served in full to `<audio>`: "Blitzkrieg Bop (2016 Remaster)" (Opus 251, 134.481 s) and "Blitzkrieg Bop" (AAC 140, 134.467 s) played to `ended` in both browsers, without a stall, in 135–136 s of wall time | Lite-26a; Lite-26b | 2026-10-26 |

## Cover images for saved files (stage 4.2)

The facts `fetchCover` in `packages/convert` relies on when it embeds a YouTube or YouTube Music track's cover in a file the user saves.

| Fact | Source | Date |
|---|---|---|
| YouTube's and YouTube Music's image hosts answer a request carrying another site's `Origin` with `Access-Control-Allow-Origin: *` (and `Cross-Origin-Resource-Policy: cross-origin`), so a page can read a thumbnail's bytes with `fetch`: `i.ytimg.com` (a video's `hqdefault.jpg`), `lh3.googleusercontent.com` and `yt3.ggpht.com` | FXM's own `curl` requests with `Origin: https://fxmusic.pages.dev`, one per host, the answers read and not kept | 2026-10-26 |
