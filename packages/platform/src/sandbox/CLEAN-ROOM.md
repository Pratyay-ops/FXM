# Clean-room log: the Lite tier's sandbox (stage 1.10)

The sandbox documents in this folder send requests to InnerTube, an API YouTube does not document, and the tests here play YouTube's media. The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact the code relies on be recorded with where it came from and when. These are YouTube facts, whose home is the YouTube log (`packages/sources/src/youtube/CLEAN-ROOM.md`, stage 1.3); 1.3 had not merged when this stage was written, so they are kept here until the two logs are merged.

**Nothing here came from a GPL, AGPL or unlicensed project.** No code, fixture or translated logic was taken from such a project, and nobody worked from one while writing this folder.

## Sources

| Key | Source |
|---|---|
| **Memo** | FXM's research memo, [`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md): live verification runs from a residential connection on 2026-10-25, section named |
| **Live-26** | This stage's live browser test ([`e2e/live.e2e.ts`](e2e/live.e2e.ts), `FXM_LIVE=1`) on 2026-10-26, 02:40 IST (2026-10-25 21:10 UTC), from a residential connection in India: Playwright's Chromium 156.0.8078.4 and Firefox 157.0 on macOS 15.5, one run each. The answers were read and summarised, not kept |
| **Full-26** | The same test with `FXM_FULL_PLAYBACK=1`, 2026-10-26, 02:40–02:45 IST (21:10–21:15 UTC the day before), one run per browser |
| **youtubei.js** | youtubei.js 18.1.0 (MIT, by LuanRT), as installed for stage 1.3, `dist/src/utils/Constants.js`; read on 2026-10-26 |
| **1.3 config** | Stage 1.3's `youtube-config.json` (branch `feat/1.3-youtube`, revision 1, 2026-10-25) |
| **Standards** | The [Fetch standard](https://fetch.spec.whatwg.org/) (CORS-safelisted request headers, the CORS check), the [HTML standard](https://html.spec.whatwg.org/) (sandboxed documents, `postMessage`) and [CSP Level 3](https://www.w3.org/TR/CSP3/) (the `sandbox` directive) |
| **E2E-26** | This stage's browser tests against the mocks ([`e2e/sandbox.e2e.ts`](e2e/sandbox.e2e.ts)), in the same two browsers, 2026-10-26 |

## InnerTube and opaque origins

| Fact | Source | Date |
|---|---|---|
| InnerTube answers CORS-simple `POST`s sent with `Origin: null` with 200 and `Access-Control-Allow-Origin: null`, on `search`, `next`, `browse` and `player`; it answers preflights from `null` with 403, and named foreign origins with 403 and no CORS headers | Memo §2.4 and §3 (five verification runs; in browsers only `search` and `player`) | 2026-10-25 |
| From a document served with `sandbox allow-scripts` and framed with `sandbox="allow-scripts"`, in Chromium 156 and Firefox 157: `music/get_search_suggestions`, `search`, `next` and `browse` on `music.youtube.com`, and `player` on `www.youtube.com`, answered 200 to CORS-simple `POST`s, and the document could read each answer, so its `Access-Control-Allow-Origin` allowed `null` | Live-26 | 2026-10-26 |
| `youtubei.googleapis.com` was not called from a browser by this stage; the memo's curl and Node runs are the evidence for it | Memo §2.4 | 2026-10-25 |
| Request bodies are the payload as JSON, labelled `text/plain;charset=UTF-8`, with the client in `context.client` and `prettyPrint=false` in the URL; no other header | Memo §2.3; Live-26 (every call in this shape) | 2026-10-26 |
| A search sent without visitorData is answered with a server-issued one in `responseContext.visitorData` | Live-26 (in both browsers) | 2026-10-26 |
| YouTube Music's web client `WEB_REMIX`, version `1.20261020.10.00`, and the songs filter `params` `EgWKAQIIAWoQEBAQCRAEEAMQBRAKEBUQEQ%3D%3D` (the self-test and the live search use them) | 1.3 config; Live-26 (accepted) | 2026-10-26 |
| `music/get_search_suggestions` takes `{ input }`; `next` with `videoId`, `playlistId: RDAMVM<videoId>` and `params: wAEB` is a song's radio; `browse` with `browseId: FEmusic_home` is YouTube Music's home | 1.3 config (`radio.params`); Live-26 (all answered 200) | 2026-10-26 |

## VISIONOS through the sandbox

| Fact | Source | Date |
|---|---|---|
| The VISIONOS client: `clientName: VISIONOS`, `clientVersion: 1.02`, `deviceMake: Apple`, `deviceModel: RealityDevice17,1`, `osName: visionOS`, `osVersion: 26.5.23O471` | youtubei.js `utils/Constants.js` (`CLIENTS.VISIONOS`) | 2026-10-26 |
| A VISIONOS `player` call from the sandbox, with the search's visitorData, `contentCheckOk` and `racyCheckOk`, and the browser's own User-Agent, answered `playabilityStatus.status: OK` with direct `url`s (no `signatureCipher`) in `streamingData.adaptiveFormats`, Opus itag 251 among them | Live-26 (both browsers) | 2026-10-26 |
| `<audio src>` on the FXM page played that itag 251 URL: `playing` after 0.7 s in Chromium and 0.1 s in Firefox | Live-26 | 2026-10-26 |
| The same URL played to its end in both browsers: "Blitzkrieg Bop (2016 Remaster)", `lengthSeconds` 134, `duration` 134.481 s, `ended` at 134.481 s after 135 s of wall time, with no stall | Full-26 | 2026-10-26 |
| VISIONOS URLs are served in full to `<audio>`; ANDROID_VR and IOS URLs are capped at roughly 0.4–2 MiB and fail `bytes=0-` | Memo §3 (the cap); Full-26 (VISIONOS in full) | 2026-10-26 |

## Browser behaviour the documents rely on

| Fact | Source | Date |
|---|---|---|
| A document served with a CSP `sandbox` directive without `allow-same-origin` has an opaque origin (`self.origin === 'null'`) however it is loaded: at top level, or framed without the `sandbox` attribute | Standards (CSP3 `sandbox`); E2E-26 (both browsers) | 2026-10-26 |
| A sandboxed document still knows its own URL (`location.href`), so it knows the origin it was served from | Standards (HTML, `Location`); E2E-26 | 2026-10-26 |
| Messages from a sandboxed document arrive with `origin` `'null'`; `postMessage` with a target origin other than the recipient's delivers nothing (Firefox logs an error, Chromium logs nothing the page can see) | Standards (HTML, `postMessage`); E2E-26 | 2026-10-26 |
| A fetch from an opaque origin carries `Origin: null`; with `credentials: 'omit'` it carries no cookie, and with `referrerPolicy: 'no-referrer'` no `Referer` | Standards (Fetch); E2E-26 (the mock's request log) | 2026-10-26 |
| A header outside the CORS safelist (`Content-Type: application/json`, any `X-…`), or a method other than `GET`, `HEAD` and `POST`, makes the browser send a preflight first | Standards (Fetch, "CORS-safelisted request-header"); E2E-26 (the mock saw the `OPTIONS`) | 2026-10-26 |
| Chromium and Firefox ask for a media URL's whole file in their first request (`Range: bytes=0-`), so a URL capped below the file's size fails that request and `<audio>` reports a media error | Memo §3; E2E-26 (both browsers sent `bytes=0-` first and fired `error`) | 2026-10-26 |
