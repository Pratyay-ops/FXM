# Clean-room log: YouTube streams (direct rungs)

The protocol facts the stream resolver in this folder relies on, each with where it came from and when, as [docs/LEGAL.md](../../../../../docs/LEGAL.md#clean-room-rule) asks. It extends the YouTube log of stage 1.3 (`../CLEAN-ROOM.md`, once that exists), which covers the metadata calls, the CORS-simple request shape and visitorData.

**Captured** means a request this stage made from Node 22 on a residential connection, in the CORS-simple shape of `../request.ts` (a `text/plain` POST whose `context.client` holds only the client's name and version, its fields from the config, `hl`, `gl` and the visitorData), with Node's own User-Agent. The sanitized responses are the fixtures in `fixtures/`. **Research** is the user-side memo of 2026-10-25 ([docs/research/2026-10-25-userside-memo.md](../../../../../docs/research/2026-10-25-userside-memo.md), section 4). No code was taken from any other project.

## Clients

| Fact | Source | Date |
|---|---|---|
| VISIONOS 1.02 (`clientName` and `clientVersion` only) answers `/player` with `OK` and direct URLs for adaptive audio itags 139, 140, 249, 250 and 251, plus `hlsManifestUrl` and `serverAbrStreamingUrl`, and no muxed `formats`. No signature cipher, no `n` parameter | Captured: "Creep" (`zFYEYRcjK2g`) | 2026-10-26 |
| VISIONOS answers a `/player` call that carries no visitorData with `LOGIN_REQUIRED`, reason "Sign in to confirm you’re not a bot", no `videoDetails`, and issues a visitorData in `responseContext` | Captured | 2026-10-26 |
| VISIONOS needs a server-issued visitorData: locally generated sessions got bot checks 3 times in 4 | Research, section 4.1 | 2026-10-25 |
| ANDROID 21.26.364 and 21.03.36 (name and version only) answer `/player` with `OK`: the muxed itag 18 in `formats` has a direct URL (`c=ANDROID`); adaptive formats come without URLs (SABR only) | Captured: "Creep", "Baby Shark Dance" (`XqZsoesa55w`), Radiohead's "Creep" video (`XFkzRNyygfk`) | 2026-10-26 |
| itag 18's URL has no `clen` parameter, and its format has no `contentLength` | Captured: the same three videos | 2026-10-26 |
| IOS 20.11.6 with `deviceMake` Apple, `deviceModel` iPhone10,4, `osName` iOS and `osVersion` 16.7.7.20H330 answers `/player` with direct URLs for AAC 139 and 140 | Captured: "Creep" | 2026-10-26 |
| ANDROID_VR 1.65.10 gives direct URLs that return 403 from about 1 MiB; IOS URLs return 403 from roughly 0.4–2 MiB | Research, section 4.1 | 2026-10-25 |
| The device fields of the ANDROID_VR and IOS clients (make, model, OS name and version, SDK version) | youtubei.js 18.1.0 (MIT), `dist/src/utils/Constants.js` | 2026-10-26 |
| A `/player` response's URLs expire with the URL's `expire` parameter (epoch seconds), and `streamingData.expiresInSeconds` is 21540 | Captured | 2026-10-26 |
| Stream URLs carry `ip` and list it in `sparams`; a URL from another IP address gets 403 | Captured (the parameters); research, section 4.4 (the 403) | 2026-10-26, 2026-10-25 |
| Formats give `mimeType` with codecs (`audio/webm; codecs="opus"`, `audio/mp4; codecs="mp4a.40.2"`, `video/mp4; codecs="avc1.42001E, mp4a.40.2"`), `bitrate` (peak), `averageBitrate`, `contentLength`, `audioSampleRate` and `audioChannels` | Captured | 2026-10-26 |
| Audio formats may come as alternative tracks (`audioTrack.audioIsDefault`), dubbed ones (an `acont` tag in the base64 `xtags`), or a dynamic-range-compressed copy (`isDrc`) | None of the captured videos had them; FXM skips them defensively, so the original audio is used | 2026-10-26 |

## googlevideo

| Fact | Source | Date |
|---|---|---|
| A ranged GET of the last 64 KiB of a VISIONOS URL (251, 140) and of an ANDROID itag 18 URL answers 206 with `Content-Range: bytes first-last/length` and all 65,536 bytes: they serve the whole file | Captured: "Creep" and "Baby Shark Dance" | 2026-10-26 |
| The IOS URL of AAC 140 answers 206 for `bytes=0-65535`, and 403 (`text/plain`, empty) from `bytes=1048576-` and for the last 64 KiB: it is capped | Captured: "Creep" | 2026-10-26 |
| googlevideo answers these requests with `Cross-Origin-Resource-Policy: cross-origin` and no `Access-Control-Allow-Origin` | Captured | 2026-10-26 |
| itag 18's MP4 starts with its `moov` box. Its AAC track is AAC-LC, 44.1 kHz, stereo, at 128.0 kbps on average (the `stsz` sample sizes over the `mdhd` duration); the `esds` box declares no bitrate | Captured: the first 256–320 KiB of the itag 18 files of "Creep", "Baby Shark Dance" and the "Creep" video | 2026-10-26 |
| A `Range` header with one range that has a start (`bytes=first-last`) is a CORS-safelisted request-header; a suffix range (`bytes=-500`) is not | Fetch Living Standard, "CORS-safelisted request-header" (fetch.spec.whatwg.org) | 2026-10-26 |

## Playability

| Fact | Source | Date |
|---|---|---|
| An age-restricted video: VISIONOS answers `LOGIN_REQUIRED`, "Sign in to confirm your age", `desktopLegacyAgeGateReason: 1`, with `videoDetails`; ANDROID answers `LOGIN_REQUIRED`, "This video may be inappropriate for some users.", `desktopLegacyAgeGateReason: 1` and a sign-in dialog | Captured: `HtVdAasjOgU` | 2026-10-26 |
| A video made for kids: VISIONOS answers `UNPLAYABLE`, "This video is not available", with `videoDetails`; ANDROID answers `OK`, and its itag 18 serves the whole file | Captured: `XqZsoesa55w` (both clients), `e_04ZrNroTo` (VISIONOS) | 2026-10-26 |
| VISIONOS can't play videos made for kids | Research, section 4.1 (yt-dlp issue 17871) | 2026-10-25 |
| A live stream: VISIONOS answers `OK` with `liveStreamability`, `videoDetails.isLive` and `isLiveContent`, `lengthSeconds` "0", AAC 139 and 140 URLs without `clen`, and an HLS manifest | Captured: `rFZHOHl-L8A` | 2026-10-26 |
| A past live stream whose recording is not available: `UNPLAYABLE`, "This live stream recording is not available.", `isLiveContent` and `isPostLiveDvr` | Captured: `jfKfPfyJRdk` | 2026-10-26 |
| A scheduled live stream: `LIVE_STREAM_OFFLINE`, "This live event will begin in 3 days.", `isUpcoming` and `isLiveContent`, and an offline slate whose main text reads "Live in 3 days" | Captured: `hv867HnY4j4` | 2026-10-26 |
| That slate's `subtitleText` gives the start in local time with a UTC offset, though the request sent no time zone; the offset was not the one of the request's `gl`, so it most likely follows the IP address. FXM doesn't read it, and the fixtures drop it as location data | Captured: `hv867HnY4j4` (the offset); inference (where it comes from) | 2026-10-26 |
| A stream that has just ended may still answer `OK` from the live DVR (`isPostLiveDvr`) | Not captured: FXM labels such an answer `live`, as there is no fixed file to probe yet | 2026-10-26 |
| A premiere is uploaded content, not live content, and YouTube's texts call it a premiere | Not captured: no upcoming premiere could be found on 2026-10-26. FXM labels an upcoming or airing video a premiere when `isLiveContent` is false or its texts say "premiere", and a live stream otherwise | 2026-10-26 |
| `videoDetails.videoId` names the video a `/player` response is about | Captured | 2026-10-26 |
| Sending `contentCheckOk` and `racyCheckOk` in the payload is accepted by both clients | Captured | 2026-10-26 |

## Sessions

| Fact | Source | Date |
|---|---|---|
| `music/get_search_suggestions` with an empty `input` and no visitorData answers 200 (about 600 bytes) and issues a visitorData in `responseContext` | Captured | 2026-10-26 |
| A visitorData issued that way lets VISIONOS answer `/player` with streams | Captured (`live.test.ts`) | 2026-10-26 |
