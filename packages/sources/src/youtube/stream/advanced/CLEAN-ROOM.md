# Clean-room log: YouTube streams (experimental rungs)

The protocol facts the experimental rungs in this folder rely on, each with where it came from and when, as [docs/LEGAL.md](../../../../../../docs/LEGAL.md#clean-room-rule) asks. It extends the log of the direct rungs, [`../CLEAN-ROOM.md`](../CLEAN-ROOM.md).

**Captured** means a request this stage made on 2026-10-26 from a residential connection: InnerTube calls from Node 22 in the CORS-simple shape of `../../request.ts`, and BotGuard run in Playwright's Chromium 156 (full build, headless, without the automation flag) or in happy-dom 20, with the integrity-token request sent from Node. The sanitized `/player` answers are the fixtures in `fixtures/`. **yt-dlp** is `yt_dlp/extractor/youtube/_base.py`, `_video.py` and `pot/utils.py` on its `master` branch (Unlicense), read on 2026-10-26, and its wiki's PO Token Guide. **youtubei.js** is version 18.1.0, **bgutils-js** 4.0.3 with the `examples/index-innertube.ts` of its repository, **googlevideo** 4.1.1, all MIT, read on 2026-10-26. No code was copied from them, and none was read from GPL or AGPL projects: NewPipe's PoTokenWebView pattern is known only from FXM's plan, and the Android evaluator follows Android's own documentation.

## Clients and `/player`

| Fact | Source | Date |
|---|---|---|
| The tv_samsung client: `clientName` TVHTML5, `clientVersion` 5.20260707, `deviceMake` Samsung, `deviceModel` UKS9800, `osName` Tizen, `osVersion` 2.4.0, and a Tizen 2.4.0 TV Safari user agent | yt-dlp, `INNERTUBE_CLIENTS['tv_samsung']` | 2026-10-26 |
| The MWEB client 2.20260708.05.00; WEB_REMIX on music.youtube.com; WEB | yt-dlp, `INNERTUBE_CLIENTS` (FXM's WEB_REMIX and WEB requests use the versions of its metadata config) | 2026-10-26 |
| A `/player` call that needs the player script sends `playbackContext.contentPlaybackContext` with `html5Preference: HTML5_PREF_WANTS` and the player's `signatureTimestamp` | yt-dlp, `_generate_player_context` | 2026-10-26 |
| TVHTML5 5.20260707 with those device fields and the `signatureTimestamp` answers `OK` with `signatureCipher` audio (139 absent; 140, 249, 250, 251), but only when the request's `User-Agent` header is the TV's user agent: with Node's or a desktop Chrome's it answers `UNPLAYABLE`, "The page needs to be reloaded." | Captured: "Creep" (`zFYEYRcjK2g`) | 2026-10-26 |
| The TV's deciphered Opus 251 and AAC 140 URLs answered 206 for their last 64 KiB in a first run; in a second run an hour later, 403 there (capped). A third TV call minutes later met `LOGIN_REQUIRED`, "Sign in to confirm you’re not a bot" | Captured | 2026-10-26 |
| MWEB and WEB_REMIX answer `OK` with `signatureCipher` audio (MWEB also with a `serverAbrStreamingUrl`), with a desktop browser's user agent or MWEB's iPad one alike | Captured | 2026-10-26 |
| WEB answers `OK` with no URL at all: adaptive formats with `lastModified`, `streamingData.serverAbrStreamingUrl` (with an `n` parameter and `sabr=1`) and `playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig` | Captured | 2026-10-26 |
| MWEB, WEB_REMIX and WEB need a GVS PO token for their HTTPS and SABR formats; the TV clients need none | yt-dlp, `GVS_PO_TOKEN_POLICY` of each client, and its PO Token Guide | 2026-10-26 |
| A GVS PO token goes in a URL's `pot` parameter | yt-dlp, `_video.py`; youtubei.js `Player.decipher` | 2026-10-26 |
| Web GVS and player PO tokens are now bound to the video ID | yt-dlp's PO Token Guide ("YouTube now binds PO Tokens to the video ID"), and captured: a token bound to the video ID made MWEB's and WEB_REMIX's URLs whole | 2026-10-26 |
| InnerTube's numeric client IDs: WEB 1, MWEB 2, TVHTML5 7, WEB_REMIX 67 | yt-dlp, `INNERTUBE_CONTEXT_CLIENT_NAME` | 2026-10-26 |

## The player script

| Fact | Source | Date |
|---|---|---|
| `https://www.youtube.com/iframe_api` names the current player as `\/s\/player\/<id>\/` | youtubei.js `Player.create`; captured (`cbcfbf2f`) | 2026-10-26 |
| The player script is `/s/player/<id>/player_es6.vflset/en_US/base.js` | youtubei.js `Player.create` | 2026-10-26 |
| youtubei.js's `JsAnalyzer` and `JsExtractor` extract a script (about 178 KB for `cbcfbf2f`) that defines `exportedVars.nsigFunction(url, sp, s)` and the `signatureTimestamp` (20746) | youtubei.js; captured | 2026-10-26 |
| The extract is driven by building its URL object from a stand-in URL with the `n` value, calling every method of its prototype except `constructor`, `clone`, `set` and `get`, then reading `get(sp)` (the signature) and `get('n')`; a result starting `enhanced_except_` means the `n` function failed | youtubei.js `getNsigProcessorFn` and `Player.decipher`; captured: FXM's own driver gives the same signature and `n` as youtubei.js's for the recorded TV answer | 2026-10-26 |
| youtubei.js also sets a `cver` parameter on deciphered URLs of some clients (TVHTML5: its own TV version); yt-dlp does not | youtubei.js `Player.decipher`; yt-dlp `_video.py` | 2026-10-26 |

## BotGuard and web PO tokens

| Fact | Source | Date |
|---|---|---|
| Google's generic challenge: `POST https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/Create` with `[requestKey]`; the integrity token: `GenerateIT` with `[requestKey, botguardResponse]`, both with `content-type: application/json+protobuf`, `x-goog-api-key` and `x-user-agent: grpc-web-javascript/0.1`; YouTube's own host serves both under `https://www.youtube.com/api/jnn/v1/` | bgutils-js (`ChallengeFetcher`, `helpers`, `constants`) | 2026-10-26 |
| YouTube's web player uses the request key `O43z0dpjhgX20SCx4KAo` | bgutils-js's examples | 2026-10-26 |
| `GenerateIT` answers `[integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken]`; the TTL was 43200 s (12 hours) | bgutils-js's examples; captured | 2026-10-26 |
| YouTube's home page carries an initial attestation, `window.ytAtN({'R': '…'})`, whose `R` is a response with `bgChallenge` (`interpreterUrl` on `//www.google.com/js/th/…`, `program`, `globalName`), and BotGuard reads the page's `EVENT_ID` as `yt.config_` | bgutils-js, `examples/index-innertube.ts`; captured | 2026-10-26 |
| The interpreter script sends `Cross-Origin-Resource-Policy: cross-origin` and no `Access-Control-Allow-Origin`, so a page's `fetch` can't read it | Captured | 2026-10-26 |
| With the home page's challenge, BotGuard in Chromium with its document at `https://www.youtube.com/` gets an integrity token from `www.youtube.com/api/jnn/v1/GenerateIT`; with only `{ EVENT_ID }` as `yt.config_` too. At `about:blank` in Chromium, and in happy-dom, `GenerateIT` answers `[null, 43200, null, <fallback token>]` | Captured | 2026-10-26 |
| A token minted from that integrity token, bound to the video ID, makes MWEB's and WEB_REMIX's deciphered Opus 251 URLs answer 206 for their last 64 KiB | Captured (`live.test.ts`) | 2026-10-26 |
| Tokens from the generic `Create` challenge get an integrity token everywhere tried (happy-dom; headless Chromium at `about:blank` or at a youtube.com URL), but googlevideo refused their `pot` (403 for the last 64 KiB) whether bound to the visitorData, the visitor ID or the video ID | Captured | 2026-10-26 |
| BotGuard's snapshot fills a "signal output" array whose first function, given the integrity token, returns the minter of tokens for a content binding | bgutils-js `BotGuardClient`, `WebPoMinter` | 2026-10-26 |
| The visitorData of `sw.js_data` is now 444 characters: its protobuf holds the 11-character visitor ID (field 1), a timestamp (field 5), region data (field 6) and a nested blob (field 12) | Captured | 2026-10-26 |

## SABR

| Fact | Source | Date |
|---|---|---|
| A SABR session takes the server ABR streaming URL (its `n` deciphered), the ustreamer config (base64), client info with the numeric client name and version, a PO token (as bytes in the request) and the formats by itag and `lastModified`; it names a video format even when only audio is wanted, and an audio-only session marks the video format as fully buffered | googlevideo `SabrStream` | 2026-10-26 |
| With the WEB answer's session and a video-bound token, `SabrStream` got 256 KiB of the song's Opus audio | Captured (`live.test.ts`) | 2026-10-26 |
| SABR requests are `POST`s with `content-type: application/x-protobuf` and `accept: application/vnd.yt-ump`; answers are UMP | googlevideo `SabrStream` | 2026-10-26 |

## Android's evaluator WebView

| Fact | Source | Date |
|---|---|---|
| `WebView.loadDataWithBaseURL(baseUrl, …)` gives the document that URL as its location and origin, without loading anything from it | Android API reference, `android.webkit.WebView` | 2026-10-26 |
| `WebSettings.setBlockNetworkLoads(true)` stops a WebView from loading network resources | Android API reference, `android.webkit.WebSettings` | 2026-10-26 |
| `WebView.evaluateJavascript(script, callback)` hands the callback the script's value as JSON | Android API reference, `android.webkit.WebView` | 2026-10-26 |
