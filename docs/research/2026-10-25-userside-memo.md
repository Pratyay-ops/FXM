# FXM decision memo: running YouTube and Spotify on the user's side with no owner servers

**Date:** 2026-10-25 · **Revision:** 2 · **Status:** proposal. Three owner decisions and four smaller confirmations are open (section 10). · **Baseline:** `docs/ARCHITECTURE.md` and `docs/PLAN.md` on `develop` at `97fe265` (PLAN revision 2), plus the in-progress branches as checked on 2026-10-25 (section 11).

**Inputs.**
- Seven research reports from 2026-10-25: the Spotify plugin, Bloomee, Spotube audio, browser-only playback, matching, native apps, and legal and store risk. Also the adversarial verdicts on their decision-critical claims. Where a verdict corrected a claim, this memo uses the correction.
- A review of revision 1 of this memo. This revision addresses every high and medium point in that review and the low ones.
- Spot checks for this revision, all made on 2026-10-25:
  - Cloudflare's `_headers` docs and its Pages limits;
  - Netlify's headers docs;
  - CORS on a public gist;
  - the size and licence of the ffmpeg.wasm core;
  - Jamendo's API limits;
  - F-Droid's inclusion policy;
  - Mozilla's add-on policies;
  - SponsorBlock's hash-prefix API and its data licence;
  - the code on the in-progress branches.

**Conventions.**
- *Measured* means a live experiment on 2026-10-25 from one residential connection. YouTube's visitorData puts it in India.
- YouTube runs per-session experiments, so every YouTube measurement is a snapshot.
- *64 KB rule:* the research never fetched more than the first 64 KB of a real YouTube stream. No platform has played a full-length YouTube track end to end. That full files are available rests on HEAD and range probes.
- *(inference)* marks a conclusion nobody observed directly.
- *[stale?]* marks a source older than about six months.
- Nothing here is legal advice.

**Baseline correction.** The brief describes plan revision 1: a Cloudflare gateway (stages 1.2 and 1.8, and parts of 2.3, 2.7, 3.2, 3.5 and 5.2), JioSaavn matching, and the YouTube embed as the web's main pipe.
- Revision 2 (commit `10302b1`, merged 2026-10-25) already removed all of that.
- `97fe265` (2026-10-25) then rewrote 2.6 (fully user-ordered playlists and a built-in Downloads playlist) and 4.1 (downloads fill that playlist).

Section 11 is therefore a delta against `97fe265`. It follows from verdicts that overturned five revision 2 assumptions:
- a plain page cannot reach YouTube;
- ANDROID_VR and IOS are usable fallbacks;
- ISRC search reliably returns the right song first;
- the text scorer is safe to auto-play on its own;
- a built-in Spotify integration that the user can switch off is an acceptable legal position.

---

## 1. TL;DR

- **No owner servers are needed on any platform.**
  - Every request runs on the user's device: in the browser (optionally with the FXM Connect extension), the Tauri desktop app or the Android APK.
  - The owner publishes only static files and release files: the site on Cloudflare Pages plus a mirror on a second static host, and binaries on GitHub Releases.
  - Desktop and Android accept only a signed remote config.
- **No platform has yet played a full-length YouTube track end to end.** Each component was verified separately (64 KB rule). Each platform stage now has a full-track "done when".
- **A plain browser can do more than revision 2 assumed, but only as an experiment (the "Lite" tier).** YouTube's InnerTube API answers CORS-simple POSTs from an opaque origin with `Access-Control-Allow-Origin: null`.
  - Only `/search` and `/player` were run from a sandboxed iframe in real browsers: Chrome and Edge 156, and Firefox 158. Radio (`/next`) and `/browse` with `Origin: null` were checked only with curl and Node.
  - A VISIONOS URL resolved in the sandbox played 0.66 s in Edge, within the 64 KB cap. The Chrome run played an IOS URL, which is a capped client. Firefox never reached `playing`. Safari and iOS are untested.
  - Google doesn't document this behaviour. FXM gates it behind a probe and gives it a remote kill switch.
  - In Lite the page can't read stream bytes, so the media element's first request serves as the stream probe.
  - For iOS, Chrome on Android and embed visitors, Lite is the only ad-free path that needs no install, so losing it would hurt them badly.
  - FXM Connect, the desktop app and the APK remain the dependable "Full" tier.
- **YouTube audio depends on one client today.**
  - Only VISIONOS returns full-length direct audio (Opus 251, AAC 140) without a PO token or deciphering.
  - URLs from ANDROID_VR, IOS, MWEB and WEB_REMIX return 403 after roughly the first MiB.
  - The ladder is VISIONOS, then the ANDROID client's muxed itag 18. Experimental rungs sit behind the remote config.
  - The next YouTube fix may need code, not just config. Desktop and Android therefore also load a signed resolver module (new stage 1.13).
- **Spotify: the recommendation changes from "built in, off by default" to "not in FXM at all" (Decision 1, option C).**
  - Both legal verdicts on the Spotify letter risk say FXM must never host or fetch Spotify's TOTP secrets. They also say Spotify belongs in a separate project with a different maintainer.
  - Precedent: there have been four Spotify letters or takedowns since May 2025. The latest letter (2026-10-15, to the Echo player's Spotify extension) demanded that its developer "forever desist" from reverse engineering any Spotify software and from aiding others.
  - Under C, FXM's repository, builds and remote config contain no Spotify code, persisted-query hashes or secret-source URLs.
  - From M2, users can load a provider from an independent maintainer by typing its URL. M1 ships without Spotify, so requirement 1 then depends on a third party.
  - Keeping Spotify built in (option B) does not lower the letter risk, because the letters target whoever publishes the code.
- **Legal exposure, not technology, is the binding constraint.**
  - In 2026, US district courts let §1201 claims over YouTube's "rolling cipher" proceed, and Germany's youtube-dl ruling is now final.
  - Also recommended: YouTube downloads off by default, no brand marks, nothing hosted, and no "ad-free YouTube" wording anywhere. The public `develop` README says "ad-free" today.
- **Matching is fixed before it auto-plays.**
  - An ISRC hit must match artist and duration. It must also match the title, unless it is the first result and the two titles are in different scripts.
  - When a track's ISRC is known but finds no match, the text match is capped at Suggest.
  - A label or release-year conflict demotes a candidate.
  - Auto-play becomes a setting that switches on only if the held-out report (1.12) passes. If it fails, M1 ships with Suggest only.
- **One shared YouTube request budget.**
  - At most 600 InnerTube calls per hour per device, with playback first and bulk work at least 5 s apart.
  - It pauses bulk work at the first bot check.
  - Without it, an import paced at one request per second could break the user's own playback.
- **Distribution can stay free.**
  - Channels: Firefox Add-ons (plus an Edge Add-ons attempt), an unpacked Chromium zip, Tauri installers and the APK on GitHub Releases, and F-Droid.
  - Mozilla can disable FXM Connect. So Connect carries no Spotify parts, and onboarding detects a disabled extension.
  - Apple notarization and Android developer verification remain owner decisions (Decision 3).
- **Plan changes:**
  - Remove 8.6. Under option C, 1.5, 3.5 and 6.5 also leave FXM.
  - Add 1.10 (sandbox transport), 1.11 (experimental rungs), 1.12 (matching evaluation), 1.13 (signed config and resolver module), R.4a (positioning rules) and R.4b (legal readiness).
  - Modify 30 stages, plus 1.5 and 3.5 under option B.

---

## 2. Architecture without owner-hosted servers

### 2.1 Owner requirements against this design

| Requirement (2026-10-25) | Status |
|---|---|
| 1. Spotify metadata and Spotify-quality recommendations, built the way the Spotube plugin works | Technically feasible on the user's side: in the desktop app, in the APK, or in a browser with a bridge extension, but not in a plain page. The legal verdicts don't let FXM ship it itself. Under the recommended Decision 1 (C), FXM ships a provider interface and no Spotify code, so requirement 1 is met only once an independent maintainer publishes a provider. Until then FXM offers YouTube Music radio, Last.fm and ListenBrainz, plus imports from the user's own Spotify data export: the library, and listening history as on-device signals. |
| 2. Ad-free YouTube / YouTube Music audio for practically any song | Designed for every platform with direct googlevideo streams. The components were verified separately; no platform has run a full-length track end to end yet (64 KB rule). It depends on one PO-token-free client (VISIONOS). Exclusions: age-restricted, "made for kids" and live videos (section 4.2). The Lite tier, which needs no install, is an experiment. |
| 3. Music vs Music + Video | Feasible. YouTube Music labels items with `musicVideoType`. The exact rules are in section 5. One owner confirmation is pending: whether non-YouTube sources may play in Music mode (section 10). |
| 4. No owner backend | Met. Only static files (primary host plus a mirror) and release assets. Community services are optional fallbacks. |

### 2.2 What runs where

| Piece | Published as | Runs on | Holds |
|---|---|---|---|
| Landing site | Static files at `fxm-music.pages.dev/` (Cloudflare Pages, free), mirrored on a second static host (Netlify, section 8) | Visitor's browser | Features, install guides, legal notices |
| Web app / PWA | Static files at `/app/` on both hosts | Visitor's browser | All logic: providers, transports, matcher, resolver, recommendations, player, library (IndexedDB, OPFS) |
| Sandbox documents (new) | Static files at `/sandbox/*.html`, outside `/app/`, each served with its own CSP that starts with `sandbox allow-scripts` | An opaque-origin document, however it is framed | `innertube.html`: the Lite tier's InnerTube calls (1.10). `eval.html`: an isolated evaluator for deciphering and BotGuard (1.11). `userhost.html`: GET-only fetches to hosts the user typed in, such as an Invidious instance (1.10) |
| Remote config | Signed static JSON on both hosts, with a copy bundled in each build | Read at start by every platform. Desktop and Android verify the signature and try the hosts in order | Client names and versions, rung order and on/off flags, kill switches. Data only, validated against a schema with an allowlist of hosts. No Spotify data |
| Resolver module (new, 1.13) | A signed, versioned JS module on both hosts | Desktop and Android, after a signature check; the bundled copy is the fallback. Opt-in in F-Droid builds | The YouTube glue: client ladder, request shapes, parsers. The web app gets the same code by redeploy |
| FXM Connect | Chromium zip and signed XPI on GitHub Releases; Firefox Add-ons (AMO); Edge Add-ons if accepted | Visitor's browser | Static declarativeNetRequest (DNR) rules for YouTube, googlevideo and Last.fm, scoped to the FXM origins (primary and mirror), plus a presence handshake. No Spotify rules or session bridge (Decision 1), no logic, no remote code |
| Desktop app | Tauri 2 installers on GitHub Releases, plus the updater's `latest.json` | User's computer | The same web bundle, Rust HTTP through `@tauri-apps/plugin-http`, and a separate evaluator webview for the experimental rungs |
| Android app | Signed APK on GitHub Releases; F-Droid, IzzyOnDroid, Obtainium | User's phone | The same web bundle, an OkHttp-based native fetch plugin, a Media3 foreground playback service, and a separate evaluator WebView |
| Community services (optional) | Run by third parties | — | LRCLIB, MusicBrainz, ListenBrainz, Last.fm, Internet Archive, Jamendo, SponsorBlock (opt-in), and an Invidious instance the user enters |

The owner runs no executable service. GitHub Actions builds artifacts but serves no user traffic. The keys that sign the config and the resolver module stay out of the deploy job (section 2.5).

### 2.3 How each platform makes requests: the injected `fetch`

Providers never call the global `fetch`. They receive `ProviderContext.fetch` from `packages/platform`. Each service has one request shape, so the same provider code runs over every transport.

| Destination | Web, no extension (Lite) | Web + FXM Connect | Desktop (Tauri) | Android |
|---|---|---|---|---|
| InnerTube (`www`/`music.youtube.com`, `youtubei.googleapis.com`) | Calls run in `innertube.html`, CORS-simple POSTs only, and only if the probe passes | Page `fetch`. On the `feat/1.9` branch, Connect sets Origin and Referer to the host's own YouTube origin on every request, sends the *other* YouTube origin on preflights (InnerTube answers same-host preflights with 400), and adds ACAO for the FXM origin | `plugin-http` built with `unsafe-headers`; Origin removed or set to `https://www.youtube.com` | Explicit native fetch (OkHttp plugin) |
| Player JS (`/s/player/…/base.js`), needed only by decipher rungs | Not readable (no ACAO) | Page fetch through the same YouTube rule | `plugin-http` | Native |
| googlevideo playback | `<audio src>` (needs no CORS) | `<audio src>`; MediaSource only for SABR | `<audio src>` in the webview | Media3 over the shared OkHttp client |
| googlevideo bytes (downloads, EQ, MediaSource, the end-of-file probe) | Not readable | Page fetch with a single `Range` GET (no preflight); Connect adds ACAO. After a 302 to another googlevideo node, the request carries `Origin: null` and stays unreadable (documented on `feat/1.9`) | `plugin-http` | Native |
| Last.fm station JSON | Not readable | Connect rule | `plugin-http` | Native |
| Hosts the user typed in (an Invidious instance) | `userhost.html` (GET only, opaque origin) | Same | A Rust command that checks the user-approved list (Tauri documents no way to change plugin-http scopes at runtime) | OkHttp plugin, same list |
| CORS-friendly APIs (section 7.3) | Direct | Direct | Either | Either |
| Spotify (options A and B only; section 3.2) | Impossible | A separate bridge add-on, not FXM Connect | `plugin-http` with a browser User-Agent | OkHttp plugin with a browser User-Agent |

Every transport follows these rules:

- **InnerTube requests are CORS-simple.**
  - Shape: a `POST` whose JSON body is sent as a string labelled `text/plain`. No `Content-Type: application/json`, and no `X-Goog-*` or `X-YouTube-*` headers. Client fields and `visitorData` go inside `context.client`, and `prettyPrint=false` goes in the URL. A wrapper strips the headers youtubei.js adds.
  - Lite requires this shape, because preflights from `null` get 403.
  - Connect doesn't require it: `feat/1.9` makes preflighted requests work with its other-origin preflight rule.
  - FXM still uses one shape everywhere, so the same provider code and fixtures serve every tier.
- **Never send a webview origin to YouTube.**
  - Unless it is built with `unsafe-headers`, Tauri's HTTP plugin forces one of these Origins, and InnerTube answers all of them with 403:
    - `tauri://localhost` on macOS and Linux;
    - `http(s)://tauri.localhost` on Windows and Android;
    - the dev-server origin under `tauri dev`.
  - Pass headers in `init.headers`. The webview strips forbidden headers set on a `Request` object.
- **Use `credentials: 'omit'` everywhere.** Connect's rules also strip `Cookie`, `Set-Cookie` and `Access-Control-Allow-Credentials`.
- **Isolate cookies on Android.**
  - Capacitor installs a process-wide `CookieHandler` backed by the WebView's cookie jar. So every request made through `HttpURLConnection` sends and stores WebView cookies for its domain. That includes both the global patch and `CapacitorHttp.request`.
  - FXM's OkHttp plugin uses OkHttp's own cookie jar, which is empty for YouTube. It is the only native transport: there is no `CapacitorHttp.request` stopgap.
- **Never use the global CapacitorHttp patch.** In Capacitor 8.5.3 (2026-10-07) it:
  - drops Cookie, Origin and Referer on `fetch`;
  - turns `Uint8Array` bodies into U+FFFD text and `ArrayBuffer`/`Blob` bodies into `{}`;
  - buffers non-GET responses.
- **Draw from one request budget.** Every InnerTube call, whether for playback, search, matching or imports, comes out of one hourly budget per device (section 4.4).

### 2.4 Tiers, and what a visitor gets without the extension

| | Free only (any browser) | Lite (no install; experimental) | Full (FXM Connect, desktop app or APK) |
|---|---|---|---|
| Library, playlists, history, backups, local files, lyrics | Yes | Yes | Yes |
| Internet Archive, Jamendo (FLAC where offered) | Yes | Yes | Yes |
| YouTube Music search, albums, artists, radio | No | Yes, anonymous | Yes |
| Ad-free YouTube audio | No (only through an opt-in Invidious instance) | VISIONOS, then itag 18, played with `<audio src>`; no byte probe | All rungs |
| Spotify | No | No | Not in FXM under Decision 1 C or D (section 3) |
| Downloading or EQ on YouTube audio | No | No (bytes unreadable) | Yes (Decision 2) |
| Last.fm stations; decipher and PO-token rungs | No | No | Yes |
| What has been verified | — | In a sandboxed iframe: `/search` and `/player` in Chrome and Edge 156 and Firefox 158; `/next` and `/browse` with `Origin: null` via curl and Node only. Playback, 64 KB cap: VISIONOS played 0.66 s in Edge; an IOS URL played in Chrome; Firefox reached metadata only. Safari, iOS and Android browsers untested | Connect: the DNR mechanics against live InnerTube in Chrome for Testing 156 and Firefox 158, and 64 KB playback. Desktop: components verified separately on macOS 15.5 (section 4.3); WebView2 and WebKitGTK not run. Android: source reading only |

**Detection at start** (`detectCapabilities()`):
1. Honour the remote kill switches.
2. Look for FXM Connect (marker plus ping). If Connect was seen on this device before and is now missing, tell the user it is off or was disabled by the browser, and point to the desktop app or the APK.
3. Otherwise, run a one-request sandbox self-test for Lite.

Visitors on Chrome for Android or an iPhone can't install extensions; Firefox for Android can. They get Lite where it works (untested there), and otherwise the APK or free sources.

**Evidence for Lite.**
- Five verification runs on 2026-10-25 got `200` with `Access-Control-Allow-Origin: null` for simple POSTs sent with `Origin: null` to `/search`, `/next`, `/browse` and `/player` on all three InnerTube hosts. Only `/search` and `/player` were exercised in browsers.
- Preflights from `null` still got 403.
- One Python probe got 403 from `music.youtube.com` with `Origin: null`. This is unexplained.
- None of it is documented.
- The verifiers used `srcdoc` iframes. FXM instead serves each sandbox as a separate static file with its own CSP. The origin is opaque either way, so it should behave the same (inference). Stage 1.10 tests it.

### 2.5 Updating without servers

- **Signed config.**
  - YouTube changes that only need data (client versions, rung order, kill switches) ship as a config change by static redeploy.
  - The config is signed with ed25519, for example with minisign. Every build carries the public key, and it rejects unsigned configs and versions older than the one it already has.
  - Desktop and Android try the primary host, then the mirror.
  - On the web, signing adds little: whoever controls the site controls the app anyway.
- **Signed resolver module (1.13).**
  - Some fixes need code. Adding VISIONOS needed youtubei.js 18.0.0, and stable Spotube stayed broken for months waiting for an app release.
  - Desktop and Android therefore load the YouTube glue as a signed, versioned module from the static hosts, falling back to the bundled copy.
  - The platform transports keep their host allowlists, so even a module can't reach new hosts.
  - F-Droid's inclusion policy forbids downloading executable code without opt-in consent. F-Droid builds therefore load the module only after an explicit opt-in that says it bypasses F-Droid's checks, and they turn off FXM's own update check.
  - This also helps under Android's 2027 rules, where every update of an unregistered APK needs "Install anyway".
- **Keys.**
  - The config and module signing keys are never available to the deploy job. Either the owner signs locally, or CI signs in a GitHub environment that needs the owner's approval for each run.
  - A leaked `CLOUDFLARE_API_TOKEN` or a hijacked site then can't push a config or module that installed apps would accept.
- **Libraries** (youtubei.js 18.3.0, googlevideo 5.0.1, bgutils-js 4.0.3):
  - on the web, they ship by redeploy;
  - on desktop and Android, inside the resolver module where possible, and otherwise through the Tauri updater or the Android update check.
  - MV3 forbids remote code, so FXM Connect stays free of logic.
- **Early warnings:** commits to yt-dlp and NewPipeExtractor, youtubei.js releases, bloom-factory releases.
- **Self-test.**
  - Users can run "resolve and play one song" from Settings > Diagnostics.
  - CI's `FXM_LIVE=1` runs are advisory only. GitHub-hosted runners use datacenter IPs that hit bot checks, so a failure there proves little and a pass proves even less.
  - The real smoke test runs on a residential connection: as a scheduled job on the owner's own machine (not a server), and before each release.

---

## 3. Spotify metadata and recommendations

### 3.1 Position

Recommended (Decision 1, option C): FXM contains no Spotify integration.
- FXM's repository, builds, remote config and FXM Connect carry no Spotify code, no persisted-query hashes and no secret-source URLs.
- From M2, FXM loads metadata and recommendation providers that independent maintainers publish, from a URL the user types (section 10).
- Until such a provider exists, FXM recommends from YouTube Music radio, Last.fm and ListenBrainz. It also imports the user's own Spotify data export, including listening history as on-device signals.

The rest of this section records how Spotify works from the user's side. Its role depends on Decision 1:
- **Options A and B:** it is the spec for FXM's own stage 1.5.
- **Option C:** it describes what FXM's provider interface must allow for (anonymous, credential-free requests to hosts the user approved). FXM does not build it.

If the owner chooses C or D, keep this section's protocol details, and those in ARCHITECTURE §11, out of the public repository.

### 3.2 Auth flows per platform (options A and B only)

| Platform | Anonymous token | Account token (second opt-in) | Where tokens live |
|---|---|---|---|
| Web, no extension | Impossible: `/api/token` and `/api/server-time` send no ACAO for any origin, `null` included | Impossible | — |
| Web + a bridge extension | A **separate** Spotify bridge add-on, not FXM Connect, so a complaint about it can't take down YouTube access. It sets the Origin to `open.spotify.com` for the token endpoints, adds ACAO and strips cookies. Pathfinder and spclient echo any Origin today | The bridge's background script calls `/api/token` with the browser's own `open.spotify.com` cookies and a strict parameter allowlist, and returns only the token JSON. Off by default | Page memory |
| Desktop | `plugin-http` with a browser User-Agent (Spotify accepts the Tauri origin) | A login window; a Rust command reads `sp_dc` from the OS keychain and returns only the token. The cookie never reaches page JavaScript, and Spotify needs no `unsafe-headers` | Rust memory and the OS keychain |
| Android | OkHttp plugin with a browser User-Agent | A login WebView. The cookie is passed explicitly on the token call only, through the OkHttp plugin, whose cookie jar is separate from the WebView's | App-private storage |

Native code must send a browser User-Agent. Pathfinder answers curl, okhttp, Dalvik, python-requests, custom app UAs and `tauri-plugin-http/2.8.3` with `403 Client/request not allowed`.

**Official OAuth is not a substitute.** PKCE from a static page is technically possible, because `accounts.spotify.com/api/token` is CORS-open. But:
- since February/March 2026, Development Mode needs a Premium app owner and caps an app at 5 users;
- the public Web API dropped recommendations and related artists for new apps in November 2024 [stale?];
- whether pathfinder accepts such tokens is untested.

### 3.3 Token and TOTP secret without a server (options A and B only)

- **TOTP:** RFC 6238 (HMAC-SHA1, 6 digits, 30 s), computed with WebCrypto from `/api/server-time`, falling back to the local clock.
- **Secret list (version plus secret):**
  - FXM ships no default secret source and fetches nothing by default. After opting in, the user pastes the secret JSON or a URL to it.
  - Measured: a public `gist.githubusercontent.com` raw file returns `Access-Control-Allow-Origin: *`, also for `Origin: null`. A pasted URL is fetched in `userhost.html`, so no secret host appears in the main CSP or in Connect.
  - The secret is cached on the device. FXM never commits, bundles or mirrors it.
  - Failure handling: if minting fails, re-fetch once (when the user gave a URL). Then pause Spotify and say so: "Spotify is paused: its secret stopped working. Paste a new one in Settings → Spotify."
  - 1.5's fixtures cover a missing secret, malformed JSON, an expired version (HTTP 400) and an unreachable URL.
  - The ecosystem relies on one pseudonymous community gist. It was created 2026-02-20, gets automated daily commits, and has served version 61 since at least 2026-09-26, so there has been no rotation in about 12 months.
  - A similar repository (spotify-secrets) disappeared after a Spotify letter in October 2025.
- **Tokens:**
  - Memory only.
  - One refresh at a time, triggered lazily when the next request finds less than 60 s left. The plugin's background refresh loop caused its issues #16 and #74.
  - Never logged. Plugin issue #77 records a live token and cookies committed to git.
  - Three mints from one machine within about 30 minutes returned an identical anonymous token. Anonymous tokens are probably cached on Spotify's side and may share a rate budget (inference).

### 3.4 Operations (options A and B)

| Need | Call | Anonymous? | Notes |
|---|---|---|---|
| Search | `searchDesktop` and the typed searches | Yes | Hashes ship with the provider, not in FXM's shared remote config |
| Track | `getTrack` | Yes | No ISRC. Playcount can exceed 2^31 (Creep: 3,209,476,167), so store it as a JS number |
| Album | `getAlbum` | Not tested anonymously | 1.5's live smoke test adds it |
| Artist | `queryArtistOverview` | Yes | 10 top tracks, 20 related artists, followers, monthly listeners |
| Related artists | `queryArtistRelated` | Yes | 40 artists |
| Playlist | `fetchPlaylist` | Yes | Use offset 0, limit 50. The plugin passes the limit as the offset (a bug) |
| Radio | spclient `inspiredby-mix/v2/seed_to_playlist/<uri>`, then `fetchPlaylist` | Yes, for track and artist seeds | A 50-track Spotify-owned "… Radio" playlist |
| ISRC, label, date, popularity | spclient `metadata/4/track/<hex gid>?market=from_token` | Yes | Worked for 15 of 15 and 8 of 8 tracks. `Cache-Control: max-age=78237` (about 21.7 h) |
| Home | `home`, `homeSection` | Generic only | Personalized needs an account plus `sp_t` |
| Library | `libraryV3`, `fetchLibraryTracks` | No (account) | Read-only |

**Where the hashes come from.**
- Only five of the plugin's 30 persisted-query hashes were found verbatim in Spotify's main web-player bundle (`web-player.f954508a.js`, fetched 2026-10-25). All five are library or curation operations: `applyCurations`, `fetchLibraryTracks`, `areEntitiesInLibrary`, `libraryV3`, `isCurated`.
- None of the read operations a provider needs has been sourced from Spotify's own files yet: `searchDesktop`, `getTrack`, `fetchPlaylist`, `queryArtistOverview`, `queryArtistRelated`, `home`, `getAlbum`. Their names appear in the bundle; their hashes are probably in lazy-loaded chunks.
- Before any coding, 1.5 records each hash from Spotify's web-player chunks, with the chunk filename and fetch date, in the clean-room log. Otherwise the hashes would come from the AGPL plugin.

Request headers: `Authorization`, `Content-Type`, `Accept`, plus a browser User-Agent from native code. No `client-token`, `App-Platform` or `Spotify-App-Version` header is needed today.

### 3.5 Caching, rate limits and failure handling (options A and B)

- **Caching:**

  | Data | Cache time |
  |---|---|
  | Search | 10 min |
  | Entities | Hours |
  | `metadata/4` | About 20 h |
  | Home | 30 min |
  | Radio playlists | Hours |

- **Rate limits:**
  - Low-volume tests saw no rate-limit headers, and Spotify documents no thresholds.
  - Look up ISRCs only for tracks being played, prefetched or imported.
  - Pace Spotify calls during imports at about one request per second. YouTube calls follow the shared budget (section 4.4).
- **Failures:**

  | Response | Handling |
  |---|---|
  | 401 | Refresh once and retry |
  | `403 Client/request not allowed` | A User-Agent bug: report it, don't retry |
  | 412 "Invalid query hash" | Disable that operation until the provider updates |
  | 429 or 5xx | Honour `Retry-After`, back off exponentially with jitter, and pause the provider for some minutes after repeated failures |
  | GraphQL `errors`, `NotFound` | Map to typed `FxmError` |
  | Anything else | Spotify degrades; FXM keeps playing |

### 3.6 The user's own Spotify login (options A and B)

- **What it adds:** a personalized home (the plugin's fixture shows 21 sections, including "Made For …", top mixes and "Jump back in"), liked songs and saved playlists. All read-only.
- **How it works per platform:** see section 3.2. The desktop cookie stays in Rust; the Android cookie is sent only on the token call.
- **Untested on the web:**
  - Whether the bridge add-on receives `open.spotify.com` cookies when third-party cookies are blocked. Chrome's documentation says the same-site treatment then no longer applies [stale? 2023].
  - Safari omits SameSite cookies on such requests (WebKit bug 260676, open).
- **In-app WebViews:** Google sign-in is blocked inside embedded WebViews, and plugin issues #71, #73 and #78 show WebView logins failing.
- **Account risk, to show in the opt-in:**
  - Spotify's User Guidelines are part of the Terms (updated 2026-09-04). They forbid circumventing Spotify technology and automated access, with suspension or termination as the remedy.
  - There is no public report of a suspension for metadata use. The enforcement on record concerns audio ripping.

### 3.7 What works anonymously (measured 2026-10-25)

- `searchDesktop`, `getTrack`, `fetchPlaylist`, `queryArtistOverview`, `queryArtistRelated` (40 artists).
- Track radio ("Creep Radio") and artist radio ("Radiohead Radio"), each a 50-track playlist owned by Spotify.
- A generic home with five sections: Trending songs, Popular artists, Popular albums and singles, Popular radio, Featured Charts. It was localized to the market: the content was Indian, the same with and without `sp_t`.
- ISRCs and labels through `metadata/4`.

Spotify's anonymous recommendation output is therefore its own seed radio plus related artists. A provider would blend these with FXM's on-device ranking.

### 3.8 Don't use

- `api.spotify.com/v1`: it returns 429 to web-player tokens, even after waiting out `Retry-After`.
- The MIT `spotify-gql-client` as is: unchanged since 2025-12-12 [stale?], built on `/v1`, with no auth flow.
- `clienttoken` (not needed today).
- Any write mutation (stage 8.6 is removed).

### 3.9 Clean room

- Write the provider from a facts-only spec recorded from Spotify's own web player: endpoints, operation names, persisted-query hashes, variable and field paths.
- Every hash used must first be found in Spotify's own web-player files and logged with the chunk filename and fetch date (section 3.4).
- Don't open the AGPL plugin source while implementing. Copying it would put the whole distributed bundle under AGPL §5(c), not just one module.
- Under option C, all of this applies to the independent maintainer, not to FXM.

---

## 4. Ad-free YouTube playback per platform

### 4.1 Client landscape (measured 2026-10-25)

| Client (version) | What `/player` returns | Full-length without a PO token? | Needs player JS? | FXM use |
|---|---|---|---|---|
| VISIONOS 1.02 | Direct 139/140/249/250/251 plus HLS; needs server-issued visitorData | Yes: 200 with no Range, 206 at the end of the file | No (no cipher, no `n`) | Rung 1 everywhere |
| ANDROID 21.26.364 | Adaptive audio is SABR-only; muxed itag 18 (360p H.264 plus AAC) is direct | itag 18 only. Served to the last byte; exempt from PO tokens in yt-dlp | No | Last YouTube rung |
| ANDROID_VR 1.65.10 (youtubei.js) / 1.71.26 | Direct URLs (1.65.10); SABR-only (1.71.26) | No: 403 from about 1 MiB. yt-dlp says every format has returned 403 since 2026-08-17 | No | Off in config |
| IOS 20.10.4 to 20.11.6 (21.26.4) | Direct AAC 139/140 (21.26.4: no URLs) | No: 403 from roughly 0.4–2 MiB, varying by itag and run; `bytes=0-` gets 403 | No | Off in config |
| MWEB, WEB_REMIX | `signatureCipher` with `n` | No: 403 at 2 MiB without a PO token | Yes | Experimental, with a web PO token (1.11) |
| WEB | SABR only | — | Yes | Experimental SABR (1.11) |
| TVHTML5 as youtubei.js sends it | "The page needs to be reloaded", or a bot check | — | — | Not used |
| tv_samsung-style TVHTML5 5.20260707 (device fields plus `signatureTimestamp`) | OK, `signatureCipher` audio | Untested end to end. yt-dlp lists no PO-token requirement, but it needs JS | Yes | Experimental (1.11) |

VISIONOS caveats:
- "Made for kids" videos are unavailable (yt-dlp #17871, 2026-10-20).
- Restricted IPs hit bot checks (#17904, 2026-10-24).
- With locally generated sessions, "Sign in to confirm you're not a bot" came back in 3 of 4 tries. Server-issued visitorData worked 4 of 4.

Other projects:
- NewPipeExtractor has used VISIONOS alone for streams since commit `9ed62db` (2026-08-06). That commit dropped the ANDROID and IOS clients and notes that "made for kids" videos can no longer be played. Its earlier workaround, `82b7e41` (2026-06-07), served kids videos as 360p muxed (itag 18).
- yt-dlp 2026.10.21 uses VISIONOS as its only default client that needs no JavaScript runtime.
- Bloomee's chain plays itag 18 today.
- Spotube's stable app broke for months on older clients. Its VISIONOS fix (PR #3150, opened 2026-10-18) is unmerged.

### 4.2 Resolution ladder

| Rung | Method | Lite | Connect | Desktop | Android | As shipped |
|---|---|---|---|---|---|---|
| 1 | VISIONOS, direct | Yes | Yes | Yes | Yes | On |
| 2 | tv_samsung TVHTML5 with signature and `n` deciphering in the isolated evaluator | No (`base.js` unreadable) | Yes | Yes | Yes | Off until its live test passes |
| 3 | MWEB or WEB_REMIX with a web PO token (bgutils-js) and deciphering | No | Yes | Yes | Yes (separate evaluator WebView) | Off |
| 4 | WEB over SABR (googlevideo plus MediaSource) with a web PO token | No | Yes (Chromium, Firefox) | Yes | No | Off |
| 5 | ANDROID muxed itag 18 | Yes | Yes | Yes | Yes | On |
| 6 | A matched non-YouTube source (Internet Archive, Jamendo) | Yes | Yes | Yes | Yes | On |
| 7 | An Invidious instance the user entered | Yes (`userhost.html`) | Yes | Yes | Yes | Opt-in |

**Rules on every rung:**
- **visitorData.** Always use server-issued visitorData: from `sw.js_data` on native platforms or with Connect, or from `responseContext.visitorData` of a first InnerTube call in Lite.
- **Bot checks.** On `LOGIN_REQUIRED`, refresh visitorData once, then move down the ladder. Also report it to the request budget, which pauses bulk work (section 4.4).
- **Wrong video.** Reject any response whose `videoId` differs from the request.
- **Probe before playing, where bytes are readable** (Connect, desktop, Android).
  - Fetch the last 64 KB of the file with a ranged GET. This replaces revision 2's "probe past 1 MiB", because the cut-off varies between about 0.4 and 2 MiB.
  - Recovery keyed on HTTP 401, 403 and 410 applies only on these platforms.
- **In Lite, the first media request is the probe.**
  - Neither the page nor the opaque-origin sandbox can read a googlevideo response: there is no ACAO for a foreign origin or for `null`, and a no-cors fetch is opaque.
  - `<audio src>` reports only a MediaError or a stall, never a status code.
  - So in Lite the player plays the VISIONOS URL directly. A MediaError, or a stall before the first `playing` event, counts as a failed probe. Capped URLs failed within about 70–300 ms in the verdicts (WebKit and Edge).
  - The player then tries itag 18, then re-resolves.
  - The same fallback covers a Connect probe that fails CORS after a googlevideo redirect.
- **Unavailable states, not silent failures:**
  - **Age-restricted videos.** They generally need a signed-in client, and Bloomee #465 shows its chain failing on one.
  - **"Made for kids" videos.** VISIONOS can't play them. Whether ANDROID's itag 18 can is untested; 1.4 tests it on a known ID before FXM relies on it.
  - **Livestreams and premieres** in Music + Video. There is no fixed file to probe, and they are often HLS-only.

  Each gets a labelled state and a fixture. Only opt-in rungs may try them: tv_samsung once its test passes, and the user's own Invidious instance. The UI and docs say that "practically any song" excludes these.
- **Memory.** Remember the last working rung per platform. The remote config can reorder or disable rungs.

**PO tokens and SABR.**
- Google's BotGuard endpoints are CORS-open, and bgutils-js 4.0.3 minted tokens on a third-party origin in Chrome and Firefox.
- Whether googlevideo accepts such tokens is untested; this was not re-verified.
- These tokens help only the web clients.
- On the web, SABR also needs Connect's googlevideo preflight rule, which is present on `feat/1.9`.

**Legal nuance (inference).**
- Rungs 1 and 5 involve no signature or `n` deciphering and no attestation; rungs 2–4 do.
- The German and US cases turn on the rolling cipher. But the District of Massachusetts also called YouTube's player "a single authorized means to obtain access" (2026-08-18).
- So the difference reduces exposure but does not remove it. Keep rungs 2–4 off by default.

### 4.3 Playback path per platform

| Platform | Default player | When bytes must be read | Background | EQ |
|---|---|---|---|---|
| Web, Lite | `<audio src>` | Never possible | Tab or PWA window | Free sources only. Web Audio outputs silence for cross-origin media without CORS |
| Web + Connect | `<audio src>` | The probe; downloads; EQ through `crossorigin` plus Connect's ACAO; SABR through MediaSource. Each fails after a googlevideo redirect | Tab or PWA | Yes, unless the stream was redirected |
| Desktop | `<audio src>` in the webview | The probe and downloads through Rust; EQ later, through MediaSource or a localhost stream | Measured in a Swift WKWebView harness, not in Tauri: about 7 min hidden, Now Playing, media keys. Windows and Linux need a WebLock workaround | Later |
| Android | A Media3 foreground service holding a queue of resolved URLs | Native | Foreground service | ExoPlayer effects |

**Why the probe matters:** browsers ask for the whole file on the first request.
- Chromium (and therefore WebView2) sends `bytes=0-`.
- WebKit sends WebM with no Range at all, and AAC as `bytes=0-1` followed by `0-(length−1)`.

Capped URLs fail at once: in a WKWebView with the page served from `tauri://localhost`, they raised MediaError 4 within about 300 ms.

**What the desktop verification covered (macOS 15.5):**
- **In the Tauri app:**
  - plugin-http's header behaviour;
  - InnerTube search and `/player` returning 200.

  No stream was resolved through plugin-http: `/player` came back without streaming data. The replication traced that to `LOGIN_REQUIRED` from a locally generated session.
- **In a Swift WKWebView harness serving `tauri://localhost`:**
  - Opus and AAC decoding;
  - the first 64 KB of a real VISIONOS URL playing;
  - Now Playing and media keys;
  - about 7 minutes of hidden playback of local files.
- **Not run:** WebView2 (Windows), WebKitGTK (Linux), and any full-length YouTube track. Stages 7.2 and 7.3 add these.

### 4.4 URL lifecycle and the request budget

- **Expiry:** URLs expire about 6 h after issue (`expire` = issue time + 21,600 s; `expiresInSeconds` = 21,540).
- **IP binding:** URLs are bound to the IP that resolved them (`ip` is in `sparams`). A second-IP test confirmed this: an Invidious instance's URL returned 403 from the test machine, while the machine's own URL returned 206 from the same node.
- **Caching:**
  - Cache per `videoId` and per network until 10 minutes before expiry. Never persist an expired URL.
  - Flush the cache on `online`, `offline` and connection-change events. The Network Information API exists only in Chromium; Android and desktop use native network callbacks.
  - Treat a 403 on a cached URL as a probable IP change, and drop every cached URL.
- **Recovery:**
  - Re-resolve on 401, 403 or 410 where status is readable, and on a stall or a first-request media error everywhere. Resume at the same position.
  - Prefetch the next 2–3 tracks and share in-flight resolutions.
  - Stop with a circuit breaker after 4 consecutive failed tracks.
- **Request budget (shared):**
  - yt-dlp cites about 300 videos, or about 1,000 webpage and player requests, per hour per guest session [stale? 2025-06]. Hitting the limit brings `LOGIN_REQUIRED` for VISIONOS on that IP (#17904).
  - An import paced at one request per second makes 3,600 calls an hour, with up to 4 calls per track. That would break the user's own playback.
  - **The cap:** one budget per device for every InnerTube call, at most 600 per hour. That is half the stale figure (inference).
  - **Priority:** the current track, then prefetch, then interactive search and browse, then bulk work (imports, re-matching, the 1.12 recorder).
  - **Bulk spacing:** bulk calls at least 5 s apart, and only while at least 100 calls of the hour's budget remain for interactive use. At this pace, 1.12's recorder needs about 3 hours.
  - **Bot checks:** at the first `LOGIN_REQUIRED` or 429, pause bulk work for 30 minutes, doubling up to 4 hours, while playback continues. Imports save their progress and resume.
  - **Shared IPs:** carrier-grade NAT addresses, common on Indian mobile networks, can be flagged by other people's traffic, which the budget can't see. So the first bot check counts as "flagged".
  - **Playlists:** never resolve whole playlists eagerly.
- **Address families:** a forum report attributes 403s to playback and resolution using different IP families on dual-stack networks (untested). Re-resolve once on 403 before changing rung.

### 4.5 Downloads

- **Where:** Full tier only. On the web, Connect allows single-range GETs with ACAO; desktop uses Rust; Android is native.
  - Download only URLs that passed the end-of-file probe.
  - On the web, a googlevideo redirect makes the bytes unreadable; the download then retries with a fresh resolution.
- **Default output:** the original container (WebM/Opus or M4A/AAC) without re-encoding.
  - Conversions say what they are, for example "MP3 converted from Opus".
  - YouTube audio is never labelled "lossless".
- **itag 18** is a video file. Extract its AAC track with a JavaScript MP4 remux, not ffmpeg: mp4box.js (BSD-3-Clause; 2.4.1, published 2026-06-19). Spotube issue #3085, where downloads came out as video files, is the trap to avoid.
- **Conversions** use ffmpeg.wasm only in a custom LGPL, audio-only build under 25 MiB, hosted with the site.
  - The stock `@ffmpeg/core` 0.12.10 (the latest release, 2025-01-07 [stale?]) is licensed GPL-2.0-or-later.
  - Its wasm file is 32,232,419 bytes (about 30.7 MiB), over Cloudflare Pages' 25 MiB per-file limit.
  - Loading it from a CDN would break the no-third-party-scripts rule.
- Enabling YouTube downloads is Decision 2.

### 4.6 Format defaults and labels

- **Choice:** Opus 251 when `canPlayType('audio/webm; codecs="opus"')` returns `"probably"`, otherwise AAC 140. Older Macs will usually get AAC: caniuse lists Safari's Opus-in-WebM support as partial and needing macOS 15.4+.
- **Labels:**
  - Opus: about 130–155 kbps peak (measured 155, 137 and 107 kbps for three videos).
  - AAC: about 128–131 kbps.
  - itag 18: "AAC from 360p video" (bitrate not measured).
- No fake 256 kbps tier, which was a Spotube pitfall.

---

## 5. Catalog modes: exact rules

| Item kind (from `musicVideoType`) | Music (default) | Music + Video |
|---|---|---|
| `song` (ATV) | Playable | Playable |
| `music-video` (OMV, OFFICIAL_SOURCE_MUSIC) | Replaced by its song: first YouTube's album-page link, then the matcher's video-to-song rule. Hidden if neither works | Playable as audio |
| `video` (UGC, missing type, every regular-YouTube result) | Hidden; never a match candidate | Playable as audio; at most Suggest, never Auto |
| `episode` (podcast types) | Hidden | Hidden |
| A track from another catalog (an import, or a provider under Decision 1) | Matched to a song. Plays automatically on Auto, otherwise only after the user acts (rule 4) | A song first; video candidates offered as Suggest |
| Free, lossless and local tracks | Playable, pending owner confirmation (section 10) | Playable |

Rules by context:

1. **Search.**
   - Music: YouTube Music songs, albums, artists and playlists, plus provider results under Decision 1.
   - Music + Video adds the YouTube Music videos filter and regular YouTube video search.
2. **Radio.**
   - Music: seed `RDAMVM<ATV id>` and still filter the results to songs. Measured: an ATV seed returned 50 of 50 ATVs; official-video seeds returned official-video radio.
   - Music + Video keeps whatever the seed returns.
3. **Albums in Music mode.** Take track lists and playback from the album's audio playlist (`browse VL` + `OLAK5uy_…`). Anonymous `next` over that playlist returns the official videos instead (measured 14 of 14 and 18 of 18).
4. **Queue and autoplay.**
   - Items that can't play in the current mode are skipped, not deleted. Switching modes re-evaluates the queue.
   - **Suggest-band tracks never play unattended.** A playlist, radio or import queue that reaches one skips it and marks it "needs review".
   - A one-tap batch review lists those tracks with their best guesses.
   - A setting, "Play best guesses" (off by default), lets Suggest items play.
5. **Imports.**
   - Music: songs only; unmatched or Suggest rows go to the review list.
   - Music + Video: songs first, then labelled videos.
6. **Recommendations and home shelves** go through the same `modePolicy`.
7. **Labels everywhere:** Song, Official video, Video. The stream badge names the source, codec and bitrate.
8. **SponsorBlock (Music + Video only).** Skips `music_offtopic` segments on video items.
   - It is a setting, off by default. The first Music + Video session offers it. Settings and the privacy page name the third-party service.
   - It uses the hash-prefix endpoint, `/api/skipSegments/<first 4 hex characters of sha256(videoID)>`, so SponsorBlock can't tell which video plays. Measured: 200 with `Access-Control-Allow-Origin: *`.
   - The data is licensed CC BY-NC-SA 4.0 "unless you have explicit permission". FXM shows the attribution in Settings and About.
9. **Last.fm station items** carry YouTube IDs.
   - In Music mode each ID is classified before it is queued, at the cost of one InnerTube call from the budget: an ATV plays, an official video goes through the video-to-song rule, and anything else is skipped.
   - When the budget is short, station items are used only as artist-and-title seeds for a song search.
   - In Music + Video, IDs play directly.
10. **The embed and the Lite tier** follow the same policy.

---

## 6. Track matching: imported and provider tracks to YouTube Music and YouTube

### 6.1 Steps

0. **Cache (stage 2.6 owns the store).**
   - IndexedDB, keyed by the source track ID and the catalog mode. Each entry stores the band, evidence and structured signals, a `userPinned` flag and a timestamp. Entries are kept about 30 days.
   - User pins always win, and they are never deleted automatically.
   - A Suggest-band guess is never stored as confirmed.
   - **Re-match only on video-level signals** (Smart Replace): an `UNPLAYABLE` or `ERROR` playability status for that video (removed or region-blocked) while other videos still resolve.
   - Keep matches through ladder failures, bot checks, network errors, offline periods and 403s after an IP change. These say nothing about the match, and re-matching on them would pile requests onto an IP that may already be flagged.
   - Spotube #3091 shows the opposite failure: stale matches that are never retried.
1. **Normalize.**
   - Apply NFKC, lowercase, and ASCII dashes and quotes. Strip Latin diacritics only; keep CJK, Devanagari and Hangul.
   - Split the title into a core, qualifiers and featured artists.
   - Strip Spotify-style suffixes (" - Remastered 2011", " - Live", "(feat. …)").
   - Collect version tags from the title and the album, in strong, medium and soft groups (ARCHITECTURE §12).
2. **Get the ISRC.**
   - From the input, if it carries one: an Exportify-style CSV, or a provider under Decision 1 (Spotify's `metadata/4` under A or B).
   - **MusicBrainz, exact path.** When the input has a Spotify track URI (data export, CSV), look the track URL up through MusicBrainz URL relationships: `/ws/2/url?resource=…&inc=recording-rels`, then the recording's ISRCs and length.
     - A hit counts as an ISRC-verified input.
     - Coverage is unmeasured; 1.12 measures it.
   - **MusicBrainz, fuzzy path.** A recording search by title and artist with a duration window, preferring the recording on the most releases.
     - Ties at score 100 put live, compilation and soundtrack versions first.
     - So a fuzzy ISRC is only a hint for ranking. It never makes a match Auto.
   - `/ws/2/isrc/<ISRC>` looks recordings up *by* ISRC. It can't find an ISRC for a title.
   - Otherwise skip this step.
3. **ISRC gate.**
   - Run a YouTube Music songs search with the ISRC as the query and check the **top 5** items. If none passes, also check the top-result card of an unfiltered search.
   - Accept an item only if **all** of these hold:
     - it is an ATV;
     - artist similarity is at least 0.5;
     - \|Δduration\| ≤ max(5 s, 2 %);
     - there is no strong version-tag mismatch;
     - title similarity is at least 0.5. The only exception is item #1 when the two titles are in different scripts (the "Idol" / "アイドル" case).
   - **Why all, not "title or artist":**
     - ISRCs are shared by unrelated tracks: Deezer maps GBAYE0601696 to a Waw\*mart track and QMFMF2447070 to "You and me" by Lil dexxy.
     - A miss returns unrelated ATV filler.
     - With "or" across five slots, a same-title cover or another song by the same artist, at about the right length, would pass and auto-play.
   - Prefer an album match when several items pass. An accepted hit is "ISRC-verified".
   - On a miss, retry once (one verifier saw miss, hit, miss for the same query within 3 minutes), then fall through. A known ISRC that never passes caps the text match at Suggest (section 6.2).
4. **Text search.**
   - Search YouTube Music songs for all artists plus the title, keeping version words. Score every ATV item on the page (about 20).
   - If nothing reaches Auto, run a second query with the album added. Skip it for singles (album name equals the title) and for classical-looking titles.
5. **Music + Video only:** the YouTube Music videos filter, then regular YouTube search for "artists - title".
6. **No-duration mode.**
   - Spotify's "Download your data" export has track, artist and album names and track URIs, but no duration or ISRC.
   - Rows that the MusicBrainz exact path can't fill in are matched without the duration term, and the result is capped at Suggest.

### 6.2 Scoring and bands

**Score = 0.40·title + 0.35·artist + 0.25·duration**, with the existing penalties and caps:
- a version tag on only one side: −0.45 strong, −0.15 medium, −0.03 soft;
- an unexpected featured artist: −0.45;
- duration off by more than 10 s: −0.15; by more than 20 s: −0.35;
- title similarity below 0.5 caps the score at 0.40; an artist score of 0 caps it at 0.45.

**Album, year and label tie-break after the cap.** The cap at 1.0 used to erase the album bonus, so ties between different recordings were decided by YouTube's result order.

**Re-recording guard.** Any of these triggers makes the best candidate Suggest, not Auto:
1. **Rivals.** Two or more candidates share the title core and the artist, fall inside the duration window and come from different releases (different album browse IDs, years, or "Provided to YouTube by" labels). Also, none of them is ISRC-verified or matched to the source's album, label or year. This generalizes the classical guard.
2. **ISRC miss.** The source's ISRC is known, but the gate missed after its retry and top-card check.
   - This suggests YouTube Music lacks that master (Spotify Singles, compilation-only ISRCs).
   - 1.12 measures what this costs in Auto rate.
3. **Conflicting release facts.** When the source gives a label and a release date, a candidate whose album year or "Provided to YouTube by" label contradicts them is demoted.
   - Sources of those facts: a CSV, MusicBrainz, or Spotify's `metadata/4` under A or B.
   - Reading the label needs the candidate's description: one extra `/next` call per candidate, only for the top 2, and only when this check has data.
   - That is at most 2 more calls per track, counted in the budget.
4. **Measured fallback.** If 1.12 still finds wrong Auto plays from text alone, require album or year agreement before any text-only match can auto-play.

Trigger 1 alone would not have caught "The Twist": neither true recording was in the top 5. Triggers 2 and 3 don't depend on rivals.

**Replay test.** 1.7 replays the three held-out failures from recorded fixtures with the ISRC step turned off, and requires Suggest or the right recording:
- The 1975, "The 1975" (2016 recording, GBK3W1500418);
- Chubby Checker, "The Twist" (ABKCO USA171840050 vs TEEC USI4R0502237);
- the Everly Brothers, "Bye Bye Love" (USWB19903261).

| Band | Condition | Behaviour |
|---|---|---|
| Auto | The Auto setting is on (1.12), the input has a duration, and either: the match is ISRC-verified; or the score is at least 0.80, \|Δ\| ≤ max(5 s, 2 %), the margin over the best non-equivalent rival is at least 0.05, the item is official (ATV), and neither the classical nor the re-recording guard fired | Plays without asking |
| Suggest | Score 0.60–0.80; or Auto blocked by a guard, by no-duration mode or by the setting | Plays only after an explicit user action, with "Not the right version?" and the ranked alternatives. Queues skip it and mark it "needs review"; imports send it to the review list |
| None | Score below 0.60 | Doesn't play; shows alternatives and a manual search |

User uploads never reach Auto.

**Video to song (Music mode).**
- First, use YouTube's own link on the album page. The "View song credits" item carries `MPTC` plus the ATV ID, aligned by position with the album's audio playlist. This held for 40 of 40 rows across 6 releases.
- Otherwise, use the matcher without a duration check, with these thresholds:
  - title similarity of at least 0.8;
  - artist similarity of at least 0.5;
  - no strong version mismatch;
  - the song is no longer than the video plus 5 s.
- Anonymous `/next` and search results never carry this link.

### 6.3 What the thresholds rest on

| Parameter | Value | Evidence (2026-10-25) |
|---|---|---|
| Auto duration window | max(5 s, 2 %) | Exact candidates: median \|Δ\| 1 s, maximum 4 s, 50 of 58 within 2 s |
| Auto score / margin | 0.80 / 0.05 | Calibration scores: exact median 1.00 (p10 0.96); covers at most 0.45; different songs at most 0.40 |
| ISRC gate | Top 5, every check on every item, a retry, the top-result card | Original run: 16 of 16 at #1. Fresh runs: 9 of 16 at #1, 6 at #2, 1 missing. Misses (compilation-only, Spotify Singles and made-up ISRCs) return unrelated filler, often ATV songs. ISRCs are shared by unrelated tracks in other catalogues. The index separates masters (remaster vs mix, explicit vs clean, Taylor's Version) but not releases |
| Re-recording guard | Demote to Suggest | Wrong Auto plays on the held-out set: The 1975, "The 1975" (2013 vs 2016 recording, 79.9 s vs 83.0 s); Chubby Checker, "The Twist" (ABKCO vs TEEC); the Everly Brothers, "Bye Bye Love" (1957 vs a 1964 re-recording, probable) |
| Classical guard | Keep | Turning it off produced a wrong Auto play: Yo-Yo Ma's 1983 and 2018 recordings both scored 1.00 |

**Cost:** one InnerTube request on the happy path, up to about seven with the retry, the top-card check, the album query and two description fetches. Bulk imports follow the shared budget (section 4.4).

**Gate (stage 1.12).**
- **The set:** a held-out set of at least 200 tracks plus a calibration split. It covers re-recordings, compilations, Spotify Singles, ISRC squatters, regional and cross-script titles, and a slice that doesn't use Spotify (data-export rows and MusicBrainz inputs).
- **The pass mark:** Auto switches on only if the held-out report shows zero wrong Auto plays and at least 85 % Auto on mainstream tracks. If it fails, M1 ships with Suggest only.
- **What zero wrong means:**
  - Zero wrong out of about 150 Auto plays bounds the wrong-Auto rate below about 2 % (95 % confidence, rule of three).
  - The first revision's evidence, 0 wrong out of about 14, only bounded it below about 19–23 %.

---

## 7. Source priority and the other services

### 7.1 Playback priority for one track

1. An offline copy (a download or a local file).
2. The item's own source: a YouTube Music song through the ladder, or an Internet Archive or Jamendo item.
3. An imported or provider track: its matched song through the ladder (Auto, or Suggest after the user acts).
4. With "prefer lossless" on, and an ISRC-verified or Auto match on Internet Archive or Jamendo: that source first (rare for mainstream catalogue).
5. Within YouTube: VISIONOS, any enabled experimental rungs, then itag 18.
6. An Invidious instance the user entered (opt-in).
7. "Unavailable", with alternatives and a manual search.

In Music mode, steps 2 and 4 include non-YouTube sources only if the owner confirms that (section 10).

### 7.2 Metadata and recommendations

- **Metadata:**
  - YouTube Music, always (Lite or Full).
  - A provider under Decision 1: Spotify under A or B; under C, an external provider from M2.
  - MusicBrainz for ISRCs: the exact path through Spotify URL relationships, and the fuzzy search as a hint.
  - Cover Art Archive and iTunes Search to fill artwork gaps.
  - LRCLIB for lyrics.
- **Recommendations:**
  - YouTube Music radio, always.
  - Spotify radio and related artists only under Decision 1 A or B, or from an external provider under C.
  - Last.fm station JSON (Full tier only; items handled as in section 5, rule 9) and Last.fm similar artists.
  - ListenBrainz's similar artists, which need no key (LB Radio now returns 401 without a user token).
  - The user's Spotify data export: its streaming history becomes on-device listening signals.
  - Ranking happens on the device.

### 7.3 Services with no gateway: CORS and keys (measured 2026-10-25)

| Service | CORS for the FXM origin | Key | Role | Path |
|---|---|---|---|---|
| YouTube InnerTube | 403 for named foreign and extension origins; `ACAO: null` for CORS-simple POSTs from an opaque origin | None | Metadata, radio, stream URLs | Connect, the Lite sandbox, native |
| googlevideo | No ACAO (only YouTube origins get it); `CORP: cross-origin` | None | Audio | `<audio src>`; bytes through Connect or native |
| Spotify token, server-time (A or B only) | No ACAO for any origin | TOTP secret | Tokens | Bridge add-on or native |
| Spotify pathfinder, spclient (A or B only) | Echo any Origin, with credentials | Token | Metadata, radio, ISRC | Page fetch; native with a browser UA |
| GitHub gist raw files | `*` (also for `Origin: null`) | — | Only under B: a secret source the user pastes | `userhost.html` |
| Internet Archive | `*` | None | Free and lossless audio | Direct |
| Jamendo | `*` | Public `client_id`. The non-commercial tier allows up to 35,000 API requests per month (developer.jamendo.com, undated), shared by every FXM user of one ID | Free audio, FLAC where offered | Direct. Called only for explicit Jamendo searches or when "prefer lossless" is on; responses cached; a "Jamendo's quota is used up: add your own client_id" state |
| LRCLIB | `*` | None | Lyrics | Direct |
| MusicBrainz | `*` (also on 503 responses) | None. Its User-Agent policy can't be met from Chromium page JS, so browsers send their own UA; desktop and Android send a descriptive one | ISRCs (exact via URL relationships; fuzzy as a hint), metadata | Direct, at most 1 request/s |
| Cover Art Archive | `*` | None | Artwork | Direct |
| ListenBrainz | `*` | User token for LB Radio and scrobbling | Similar artists, scrobbling | Direct |
| Last.fm API | `*` | API key; shared secret for scrobbling | Similar artists, scrobbling | Direct |
| Last.fm station JSON | None | None | Personal stations with YouTube IDs | Connect or native |
| iTunes Search | `*` | None | Artwork and metadata gaps | Direct |
| SponsorBlock | `*` (hash-prefix endpoint, measured) | None | Opt-in: skip the non-music parts of videos. Data CC BY-NC-SA 4.0, with attribution | Direct |
| Deezer API | No ACAO (JSONP only) | None | Optional ISRC cross-check | Native only; no JSONP in the page (CSP) |
| YouTube Data API v3 | Reflected | Project key; 100 `search.list` calls a day | Not used | — |
| Piped | 27 of 29 known API hosts down; none returned audio-only streams | — | Not used | — |
| Invidious | 1 of 4 official instances exposes the API with CORS; intermittent (one verifier: 4 of 10 calls; another: 5 of 7 attempts) | — | Opt-in user instance (proxied audio; `<audio src>` works) | `userhost.html` on the web; native elsewhere |
| JioSaavn | Not measured in this round | — | Dropped from the default pipeline (catalogue too thin; no Radiohead) | If revived: an opt-in provider. Its DES-encrypted stream URLs raise an unassessed question under India's §65A |

**API keys in clients:**
- Ship only identifiers meant to be public (the Jamendo `client_id`, a Last.fm API key), each overridable in Settings.
- Before shipping, check whether Jamendo's and Last.fm's API terms allow one public key shared by every user. Neither has been checked.
- Never ship secrets. The Last.fm shared secret, used to sign scrobbles, is supplied by the user, as in Bloomee.

---

## 8. Distribution

| Channel | Facts (date) | FXM plan | Cost |
|---|---|---|---|
| Cloudflare Pages | Static files. Cloudflare may remove content without notice (terms updated 2026-09-28). `_headers`: up to 100 rules and 2,000 characters per line; a request inherits the headers of every matching rule, and a header applied twice is joined with commas; `! Header` removes one (docs updated 2026-08-25). 25 MiB per file, 20,000 files on the free plan (docs updated 2026-09-05) | Site and web app. No two header rules match the same path (2.8) | Free |
| Mirror static host | Netlify supports the same `_headers` format, but documents neither how matching rules combine nor a way to remove a header (docs updated 2025-12-01 [stale?]). GitHub Pages can't set response headers, so it can't carry the sandbox CSPs. Codeberg Pages is German | Mirror on Netlify, under a name chosen now and built into FXM Connect before its first release. Same build, same header file, same tests | Free |
| GitHub Releases and Actions | Actions are free for public repos on standard runners. GitHub's DMCA process allows counter-notices, and its Developer Defense Fund helps with §1201 claims | All binaries, extension packages, checksums, attestations. A Git mirror on GitLab.com (US) | Free |
| Firefox Add-ons (AMO) | Hosts YouTube downloaders, two of them "Recommended" (2026-10-25). No remote code; source upload if code is bundled; `data_collection_permissions` required for new add-ons since 2025-11-03 [stale?]; self-distributed add-ons still need AMO signing. The policies apply "regardless of how they are distributed", and Mozilla "may reject or block affected versions or entire add-ons" (updated 2026-04-30). A blocked add-on is disabled and users can't override the block (blocking-process page, 2021 [stale?]). Firefox lacks `externally_connectable` (bug 1319168, NEW) | Primary extension channel: unlisted signing in CI, then a listed submission. Connect has no Spotify parts | Free |
| Edge Add-ons | Same written copyright rule (§2.8, 2026-07-24). But Video DownloadHelper's Edge build advertises YouTube downloads, has a Featured badge and 1.53M installs (2026-10-25) | Submit; acceptance unproven | Free |
| Chrome Web Store | Bans facilitating unauthorized streaming or downloading. Its troubleshooting page (2026-07-20) lists facilitating YouTube downloads as a common rejection reason. Video DownloadHelper's Chrome build disables YouTube | Don't submit by default. Ship an unpacked zip instead. Since Chrome 134 it stays enabled only while Developer mode is on [stale? 2025-03]; updates are manual; managed browsers may block it | USD 5 once, if tried |
| Safari | iOS: App Store only (guideline 5.2.3 names YouTube). macOS: extensions signed with a Developer ID and notarized can be distributed outside the App Store since Safari 18.4 [stale? 2025-03] | Not supported unless Decision 3 buys the Apple program | USD 99/yr |
| macOS app | Free accounts can't notarize, and Gatekeeper rejects ad-hoc builds. Users go to System Settings > Privacy & Security > Open Anyway; the button lasts about an hour and needs the login password (Apple, 2026-05-27) | Ad-hoc DMG plus an install guide | Free, or USD 99/yr |
| Windows app | Unsigned installers get SmartScreen's "Run anyway", and Smart App Control blocks unsigned apps with no per-app override. Free signing exists through SignPath Foundation or OSSign (both discretionary). The Microsoft Store re-signs only MSIX, and Tauri emits MSI/NSIS. Azure Artifact Signing excludes individuals outside the US and Canada | Apply to SignPath and OSSign after the first release; otherwise unsigned, with docs | Free; a Certum open-source certificate (about €49–69) as a paid fallback |
| Linux app | No OS signing. Opus needs GStreamer's base and good plugins; AAC needs gst-libav | AppImage, `.deb`, Flathub | Free |
| Homebrew | Official casks that fail Gatekeeper are disabled from 2026-09-01 | Only with notarization | — |
| winget | Validation doesn't require signing; may skip the SmartScreen prompt (inference) | Yes | Free |
| Android APK | Google Play and the App Store ban such apps (Musi removed 2024 [stale?]). F-Droid lists NewPipe and Spotube with the NonFreeNet anti-feature. F-Droid's inclusion policy forbids downloading executable code without explicit opt-in consent that says it bypasses F-Droid's checks | GitHub Releases, F-Droid, IzzyOnDroid, Obtainium. In F-Droid builds, plugins and the resolver module are opt-in and FXM's own update check is off | Free |
| Android developer verification | Live since 2026-09-30 for apps from 7 participating stores in Brazil, Indonesia, Singapore and Thailand. Sideloading is unaffected until the 2027 global rollout (no month given). After that, installing an unregistered app needs an "advanced flow": developer mode, a one-time 24 h wait, and "Install anyway" on every install; updates fail when the flow is off. ADB stays exempt for now | Decision 3 | USD 25 once, plus government ID and proof of address. Limited Distribution is free for up to 20 devices |

**Required spend: nothing.** Optional: Apple USD 99/yr; Android verification USD 25 once (2027); Chrome Web Store USD 5 once; a Certum certificate about €49–69.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation | Watch |
|---|---|---|---|---|
| YouTube closes VISIONOS, the single client that works | High: ANDROID_VR lost its exemption in July–August 2026 | High: playback falls back to itag 18 | Remote-config ladder; itag 18; 1.11 rungs; matched free sources; signed resolver module (1.13) | yt-dlp, NewPipeExtractor and youtubei.js releases; the residential smoke test |
| A YouTube fix needs code, and desktop and Android users are on old builds | High | Medium–high: desktop and Android break until users update. From 2027, each Android update means "Install anyway" | 1.13's signed module with a bundled fallback; the web redeploys instantly | Module adoption |
| YouTube stops answering opaque-origin requests | Medium–high (undocumented) | High for iOS, Chrome on Android and embed visitors, for whom Lite is the only ad-free path without an install. Low for Connect, desktop and APK users | Probe-gated, with a kill switch; the desktop app, the APK, and Firefox for Android with Connect | 1.10 live test |
| Spotify sends the maintainer a letter | Under C or D: low for FXM, which ships no Spotify code; the independent provider carries the risk. Under A or B: medium and rising, with four actions since May 2025 | High. The Echo letter (2026-10-15) demanded the developer "forever desist" from reverse engineering any Spotify software and from aiding others, citing §1201 and the Lanham Act; that extension also decrypted audio, so the fit is partial. Spotube's letter (2025) demanded an end to distribution and to "aiding or assisting" others | Decision 1 C. B does not lower this risk, because publishing the code is what triggers letters. No "Spot…" names or logos; read-only | Actions against peer projects |
| Spotify breaks technically (TOTP rotation, a secret source vanishes, hash 412s, the UA filter) | High | Medium, only where a Spotify provider is used | Fail-soft providers; FXM works without Spotify | — |
| A user's account is actioned after cookie login | Low (no public cases for metadata use) | Medium for that user | Under A or B: a second opt-in, a notice, read-only. Under C: the provider's responsibility | — |
| Label or Google action over YouTube extraction | Low–medium for streaming only; medium–high with downloads or "ad-free YouTube" marketing | High | Decision 2. The default rung needs no deciphering (inference: helps, doesn't cure). Positioning rules now (R.4a; the public README says "ad-free" today). Mirrors. Indian counsel before launch | Yout v. RIAA (2d Cir.), the Suno and Udio §1201 claims, IFPI watch list |
| Chrome Web Store refuses the extension; Edge removes it later | High (Chrome); medium (Edge) | High for Chromium users (Chrome 65 % and Edge 15 % of desktop, September 2026) | Lite tier; AMO; the Edge attempt; unpacked zip; desktop app | Store emails |
| Mozilla disables or blocks FXM Connect | Low–medium: AMO policies cover self-distributed add-ons, and a complaint from Google or Spotify could prompt a review | High for Firefox users on desktop and Android | No Spotify parts in Connect. Onboarding detects a disabled Connect and points to the desktop app or the APK. Lite as fallback | AMO emails; the blocklist |
| GitHub repo or release takedown | Low | Medium–high | Clean room; no secrets; GitLab mirror; counter-notice | `github/dmca` |
| Cloudflare Pages removal, a site hijack or a leaked deploy token | Low | High: PWA data is tied to the origin, and a hijacked site could push a config to installed apps | Netlify mirror with the same headers, built into Connect; signed config and module, with keys kept away from the deploy job; prominent export | — |
| Android developer verification | High (scheduled for 2027) | Medium–high for APK reach | Decision 3; 1.13 reduces how often the APK must be updated; document the advanced flow and ADB | Google's 2027 date |
| Unsigned desktop builds | High | Low–medium | SignPath or OSSign; install docs; Flathub, winget | — |
| The wrong version auto-plays | Medium | Low–medium | The all-checks ISRC gate; the ISRC-miss cap; demotion on conflicting release facts; the rivals guard; Auto switched on only if 1.12 passes; "Not the right version?" | 1.12 report |
| AGPL or GPL contamination | Medium | Medium | Clean-room log; MIT and BSD libraries; a custom LGPL ffmpeg build (the stock core is GPL-2.0-or-later) | Code review; a CI licence check |
| Guest bot checks and rate limits, including from bulk imports | Medium; higher on shared carrier NAT IPs | Medium: `LOGIN_REQUIRED` on the user's IP breaks their own playback | Shared hourly budget with playback first; pause at the first bot check; resumable imports; server-issued visitorData | `LOGIN_REQUIRED` rate |
| Jamendo quota used up for everyone sharing FXM's `client_id` | Medium once FXM has users (35,000 requests a month) | Low–medium: Jamendo stops working for everyone at once | Call Jamendo only for explicit searches or "prefer lossless"; caching; a field for the user's own `client_id`; check the terms | — |
| The owner's jurisdiction (India, inferred) | Low | High | Short consult (for example SFLC.in) before public launch | — |

---

## 10. Decisions needed from the owner

### Decision 1: How is Spotify shipped?

Requirement 1 conflicts with what the legal verdicts allow. Both verdicts on the Spotify letter risk say:
- FXM must never host or fetch the TOTP secrets itself;
- Spotify belongs outside the FXM core and out of the owner's hands, as an optional plugin in a separate repository with a different maintainer.

The record since May 2025:

| Date | Target | What happened | Fit with FXM |
|---|---|---|---|
| 2025-05-02 | Spotube | A letter objecting to Spotify's data API being used with YouTube for ad-free playback. Spotube removed its built-in Spotify. A separately maintained plugin (sonic-liberation) has run 14 months since with no known action | Exact |
| 2025-10-10 | spotify-secrets | A letter to a TOTP-secret source; the repository now returns 404 | The secret-source role |
| 2026-10-15 | The Echo player's Spotify extension | A letter (copy linked from a fork; not independently verified) demanding the developer "forever desist" from reverse engineering any Spotify software and from aiding others, citing §1201 and the Lanham Act. The extension is gone; the Echo host app remains | Partial: that extension also decrypted audio |
| 2026-10-20 | SpotiFLAC | Repositories removed after a Spotify notice | Spotify catalog plus audio from elsewhere |

Enforcement is selective (spotDL and SimpMusic are untouched), but it targets whoever publishes the code.

- **A. As in revision 2.** Built in, and on by default wherever the platform can reach Spotify. Account sync is opt-in.
- **B. Built in, off by default, hardened.**
  - Official release artifacts are built with the Spotify flag off: the deployed web app, FXM Connect, the desktop app and the APK. The owner enables Spotify in local builds.
  - No pre-filled secret source: the user pastes the secret JSON or a URL, and FXM fetches nothing by default.
  - The web bridge is a separate add-on, not FXM Connect.
  - Provider hashes ship with the provider, not in the shared remote config.
  - Use starts anonymous and read-only; account sync is a second opt-in.
  - **B does not lower the letter risk.** The provider's source would still be published in FXM's repository, and publishing is what the letters target. Default-off and local builds change what users get, not what FXM distributes. It also means requirement 1 reaches only people who build FXM themselves.
- **C. An independent provider, loaded by URL (recommended).**
  - FXM's repository, builds, remote config and FXM Connect contain no Spotify code, persisted-query hashes or secret-source URLs.
  - FXM ships a generic metadata and recommendation provider interface (stage 8.3, moved into M2). A provider loads only from a URL the user types or a file the user picks. FXM lists, links and recommends none.
  - **How plugin code loads:**
    - Only in the isolated evaluator (1.11), never in the main document, so the main app's strict CSP doesn't change.
    - On the web, that evaluator is a sandbox document with an opaque origin, so plugin code can't reach FXM's storage or cookies. On desktop and Android, it is a separate webview.
    - Network requests leave from the plugin document on the web. On desktop and Android they go through the native transport, limited to the host list the user approved when installing.
    - Plugins get no cookies or login access.
    - A plugin updates only when the user approves each update.
    - In F-Droid builds, installing a plugin is an explicit opt-in that says it bypasses F-Droid's checks, as F-Droid's inclusion policy requires.
  - **M1 ships without Spotify.** Requirement 1 is met only once someone other than the owner publishes and maintains a provider, and nothing guarantees that will happen.
  - Until then, FXM offers YouTube Music radio, Last.fm and ListenBrainz, plus the user's own Spotify data export, whose streaming history seeds on-device ranking.
- **D. No Spotify.** As C, but without provider plugins for metadata; 8.3 stays in M7 for sources and resolvers.

**Why C:**
- C and D are the only options consistent with both verdicts, and only C keeps a path to requirement 1.
- C matches the two cases where the host app survived:
  - Spotube's host app next to a separately maintained plugin (14 months untouched);
  - Echo's host app after its Spotify extension was removed.
- Its cost is requirement 1 inside FXM itself.
- If the owner wants Spotify for personal use anyway, C allows a provider the owner keeps private and never publishes. That stays the owner's own terms-of-service exposure, which revision 2 accepted for personal use. It must never go into a public repository or ship as a default.
- If the owner wants FXM itself to deliver requirement 1 to everyone, that is option A, with the risk not reduced. B serves mainly the owner's own builds.

**Plan impact:**
- A: as revision 2 (1.5, 1.9, 3.2, 3.5, 6.5, 7.4).
- B: 1.5, 1.9 (split the bridge out), 2.8 (flag off in CI), 3.2, 3.5, 6.5, 7.4, R.2.
- C:
  - removes 1.5, 3.5 and 6.5, and the Spotify parts of 1.1, 1.9, 3.2, 3.6, 5.3 and 7.4;
  - moves 8.3 into M2;
  - shrinks ARCHITECTURE §11 to a short note.
- D: as C, without moving 8.3.

If the decision is still open when 1.1 and 1.9 merge, they take the C shape. B can add things back later.

### Decision 2: Can FXM download YouTube audio, and how is FXM described?

- **A. As in revision 2 (D15).** Every track downloadable in any format, on by default.
- **B. Off by default (recommended).**
  - Downloads from free, lossless and local sources stay on.
  - Downloading YouTube-sourced audio is a setting, off by default, with a notice.
  - Nothing (the site, the README, extension listings, app strings) says "ad-free YouTube", "free Spotify Premium" or "download any song".
  - The README on the public `develop` branch says "ad-free" and "Download any track" today. R.4a fixes that now, whatever is decided here.
- **C. None in official builds.** YouTube audio is streamed only.

**Why B:**
- Downloads and ripping are what labels, IFPI and Spotify pursue. IFPI asked the EU to list yt-dlp on 2026-09-29, SpotiFLAC fell on 2026-10-20, and the 2026 §1201 rulings involved ripping tools.
- Downloads also rule out the Chrome Web Store.
- B keeps the feature available to the owner.

**Plan impact:** 4.1, 4.2, 6.4, 7.4, and 5.3's site copy.

### Decision 3: Tie the owner's identity to distribution and pay for trust?

- **A. Register everything.**
  - Apple Developer Program (USD 99/yr): a notarized macOS app, a Developer ID Safari extension, Homebrew.
  - Android developer verification before 2027 (USD 25, government ID and proof of address).
  - Chrome Web Store (USD 5 and a trader declaration) for one attempt.
- **B. Stay free and unregistered for now (recommended).**
  - GitHub Releases, AMO, Edge Add-ons, F-Droid, IzzyOnDroid, Obtainium, Flathub, winget.
  - Ad-hoc macOS builds with "Open Anyway".
  - Apply to SignPath and OSSign for Windows.
  - Revisit Android verification once Google announces the 2027 date.
- **C. Hybrid.** Register only for Android verification once the 2027 date is known; skip Apple.

**Why B:**
- Nothing requires these registrations before 2027.
- They cost money, and they bind the owner's legal identity to an ad-free YouTube client while the legal position is unsettled.
- Google's console terms let it terminate access (§6.5), which gives YouTube's owner a lever over the APK.
- Expect to move to C before the 2027 rollout. After it, an unregistered APK needs "Install anyway" on every install, and updates fail when the advanced flow is off. 1.13's resolver module reduces how many APK updates a YouTube fix needs.

**Plan impact:** 6.6, 7.5, 7.6 and R.3.

### Smaller confirmations

1. **Non-YouTube sources in Music mode.** The owner defined Music as "only YouTube Music catalog songs". The plan also plays Internet Archive, Jamendo and local tracks in Music mode, and "prefer lossless" can substitute them. Should that stay, or should they move behind a separate "Free and local sources" toggle?
2. **Mirror host.** Recommended: Netlify, under a name the owner reserves now (for example `fxm-music.netlify.app`; availability unchecked). 1.9 can then build it into FXM Connect before the first release.
3. **The 1.12 hand review.** About 2–3 hours of the owner's time.
4. **Signing keys.** Sign config and module releases locally, or approve each CI signing run.

---

## 11. Plan changes for docs/PLAN.md

**Baseline:** `develop` at `97fe265` (2026-10-25 20:33 +0530), PLAN revision 2. Status there and on the branches, checked on 2026-10-25:
- 0.1–0.4 and 2.1 are done.
- `feat/1.1-core-model`:
  - 9 commits and 3,124 added lines; last commit 2026-10-25 20:24 +0530.
  - It already defines `NetworkCapabilities { youtube: boolean; spotify: boolean; mediaBytes: boolean; fileSystem: boolean }` and `AudioCandidate.evidence: string[]`.
  - Its `SOURCE_IDS` list still includes `jiosaavn`.
- `feat/1.9-connect-extension`:
  - 11 commits locally (HEAD `fcc0dc8`, 2026-10-25 20:47 +0530), plus uncommitted work in its worktree. The pushed branch is older (`cf94bb2`).
  - Rules:
    - InnerTube requests get the host's own YouTube Origin and Referer, and preflights get the other YouTube origin.
    - googlevideo gets ACAO on media and XHR, and a YouTube Origin on preflights only.
    - Five Spotify rules and a Last.fm rule.
    - Every rule strips cookies.
  - It also has the Spotify session bridge, and it hard-codes `PRODUCTION_ORIGINS = ['https://fxm-music.pages.dev']`.
- `feat/5.3-site`:
  - 4 commits.
  - Its copy says Spotify is "built in and on", that the web app plays only free sources without Connect, and that downloading from YouTube Music takes FXM Connect.
- `feat/7.1-desktop-shell`: 5 commits on top of `97fe265`. It is a Tauri 2 shell whose app-wide CSP allows `'wasm-unsafe-eval'` but not `'unsafe-eval'`.
- `feat/6.1-android-shell`: no commits yet.
- Everything else is todo.
- `develop` moved from `7eaac4e` to `97fe265`, which rewrote 2.6 and 4.1. The changes below build on that text.

### 11.1 Remove

| ID | Title | Branch | Why |
|---|---|---|---|
| 8.6 | Spotify write-back | `feat/8.6-spotify-write` | Write operations add automation, account risk and legal exposure for little value |
| 1.5, 3.5, 6.5 | Spotify provider, account sync, Android login | — | Only if Decision 1 is C or D: they leave FXM's repository. Under B they stay, changed as in 11.3 |

### 11.2 Add

**1.10 Opaque-origin transport (Lite tier)** · branch `feat/1.10-sandbox-transport` · depends on 1.2 · scope `packages/platform/src/sandbox/**`, `apps/web/sandbox/innertube.html`, `apps/web/sandbox/userhost.html`

Contents:
- Implements 1.2's `SandboxTransport` interface.
- **`innertube.html`:**
  - Published at `/sandbox/innertube.html` and served with a CSP that starts with `sandbox allow-scripts` (table in 2.8). It is therefore opaque however it is loaded, and Connect's rules, which are scoped to the FXM origin, never match its requests.
  - FXM also frames it with `sandbox="allow-scripts"` (no `allow-same-origin`).
- **Message checks.** Inside the sandbox:
  - accept messages only when `event.origin` is an FXM origin (primary or mirror) and `event.source` is the parent;
  - reply only to that origin.

  No `frame-ancestors`: it checks every ancestor, so it would break the embed when a third-party site frames it (5.2).
- **The allowlist:**
  - hosts: `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com`;
  - paths: `/youtubei/v1/{search,next,browse,player,music/get_search_suggestions}`;
  - POST only, CORS-simple shape, `credentials: 'omit'`, a size cap and a timeout.
- **`userhost.html`:** the same hardening with `connect-src https:`. It makes GET-only, size-capped fetches to hosts the user typed in Settings: an Invidious instance, and a secret source under Decision 1 B.
- `detectCapabilities()` reports `youtube: 'simple'` only after a live self-test succeeds. The remote config has a kill switch.
- Every call draws on the request budget (1.2).

Done when:
- **Mock tests.** Playwright tests in Chromium and Firefox run against a mock that answers `ACAO: null` to simple POSTs and 403 to preflights and named origins. They show that:
  - allowlisted calls succeed;
  - other hosts and paths are refused;
  - preflighted request shapes fail with a typed error.
- **Capped-URL fallback.** A mock VISIONOS URL that returns 403 past 1 MiB to a `bytes=0-` request makes the test page's `<audio>` fail. The harness then falls back to the itag 18 URL and plays it.
- **Hardening:**
  - the test server serves both documents with the sandbox header;
  - a page on another origin that frames `innertube.html` without the attribute finds `self.origin === 'null'` inside it, and its messages get no reply;
  - the document can't fetch any other host.
- **Live test.** An `FXM_LIVE=1` browser test, run from a residential connection, does a YouTube Music search and a VISIONOS `/player` call through the sandbox. `<audio>` reaches `playing` in Chromium, and the Firefox result is recorded.
- **Manual test.** A full-length Lite playback of one song in Chromium and Firefox (and Safari if available), with the date and browser versions noted in the package README.
- The kill switch disables the tier.

**1.11 YouTube resolver: deciphered, attested and SABR rungs (experimental)** · branch `feat/1.11-youtube-advanced-rungs` · depends on 1.2, 1.4, 1.9, 2.2 · scope `packages/sources/src/youtube/stream/advanced/**`, `packages/player/src/engines/mse/**`, `packages/platform/src/evaluator/**`, `apps/web/sandbox/eval.html`

Contents:
- **An isolated evaluator,** with one interface on every platform:
  - **Web:** `eval.html` at `/sandbox/eval.html`, with the CSP `sandbox allow-scripts; default-src 'none'; script-src '<build hash>' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'`, and the same message checks as 1.10.
  - **Desktop:** Tauri applies one app-wide CSP to its asset protocol, and a meta CSP can only tighten it. So the evaluator runs in a second, hidden webview, loaded from a custom URI scheme whose Rust handler sets its own CSP. That webview is granted no Tauri capabilities. To verify: that Tauri leaves custom-scheme responses alone.
  - **Android:** a separate WebView instance created by the native plugin (NewPipe's PoTokenWebView pattern). It has its own meta CSP and a message channel through native code.
  - **Fallback:** if a native route fails, accept `'unsafe-eval'` in that app's CSP while these rungs are experimental, and record it in the README. The main web app's CSP never gains `'unsafe-eval'`.
- **BotGuard networking.** BotGuard makes no network calls of its own (`connect-src 'none'`). The parent relays its Create and GenerateIT calls through the platform fetch.
- **A tv_samsung-style TVHTML5 context** (device make and model, OS fields, `signatureTimestamp`), with youtubei.js signature and `n` deciphering in the evaluator.
- **MWEB and WEB_REMIX** with a web PO token minted by bgutils-js in the evaluator.
- **WEB over SABR** with googlevideo's `SabrStream` and a MediaSource engine built on 2.2's engine interface.
- Per-rung flags in the remote config, all shipped off.
- Under Decision 1 C, 8.3's plugins reuse the evaluator.

Done when:
- **Direct-URL rungs** (tv_samsung, MWEB, WEB_REMIX): each has an `FXM_LIVE=1` test that resolves a known song and gets 206 for a range in the last 64 KB of the file.
- **SABR rung:** 30 s of MediaSource playback of a known song in Chromium with Connect.
- The evaluator passes fixture tests on all three platforms, and the main web app's CSP has no `'unsafe-eval'`.
- Rungs that fail stay off, with the failure recorded in the package README.
- Fixture tests cover rung selection.

**1.12 Matching evaluation: labelled set, report and Auto switch** · branch `test/1.12-matching-eval` · depends on 1.2, 1.3, 1.6, 1.7 · scope `packages/core/src/matching/eval/**`

Contents:
- **A recorder** (`FXM_LIVE=1`) that captures inputs and YouTube Music candidate pages for at least 200 held-out tracks plus a calibration split.
  - It runs through the shared budget as bulk work: at least 5 s apart, about 3 hours for the full set.
- **Inputs:**
  - **Spotify-style metadata** from an Exportify-style CSV the owner exports: titles with Spotify's suffixes, durations, and ISRCs where present. Under Decision 1 B, the metadata can come from 1.5 instead.
  - Under C, FXM's repository has no Spotify API recorder. If no such CSV can be made, use MusicBrainz metadata and record that this slice doesn't test Spotify's title style.
  - **A slice that doesn't use Spotify:** rows from the owner's "Download your data" export (no duration), and MusicBrainz exact and fuzzy inputs.
- **Labels** (exact, equivalent, wrong):
  - drafted from ISRC hits and "Provided to YouTube by" descriptions; agents may pre-label;
  - then the owner hand-reviews the ambiguous rows. Estimate: 2–3 hours, for about 30–50 ambiguous tracks at about 3 minutes each, plus a 10 % spot check.
- **Categories:** mainstream, long-tail, regional, cross-script, classical, re-recordings, compilations, Spotify Singles, ISRC squatters, data-export rows.
- **Report, per category:**
  - Auto rate, wrong Auto plays and Suggest rate;
  - MusicBrainz exact-path coverage;
  - what the ISRC-miss cap costs in Auto rate.

Done when:
- The labelled set and the report are committed, and CI replays them offline from fixtures.
- The Auto band is a setting that the matching config turns on only if the held-out report shows zero wrong Auto plays and at least 85 % Auto on mainstream tracks, with thresholds tuned on the calibration split only. Otherwise the setting ships off and M1 is Suggest-only.

**1.13 Signed config and resolver module** · branch `feat/1.13-signed-updates` · depends on 1.2, 1.3, 1.4 · scope `packages/platform/src/updates/**`, `packages/sources/src/youtube/module/**`, `scripts/sign-*`

Contents:
- **Config signing.** Sign and verify the config (ed25519, for example with minisign). The public key is compiled into each build. Versions only increase; unsigned or older configs are rejected.
- **Fetching.** Try a list of config and module URLs in order (primary, then mirror).
- **The resolver module.** The YouTube glue is packaged as a versioned module.
  - Desktop and Android verify it and load it from a verified `blob:` URL. In those builds only, `script-src` gains `blob:`.
  - They keep the last good version and fall back to the bundled copy.
  - The platform host allowlists still apply.
- **F-Droid build flag:**
  - the module stays off until the user opts in, with the wording F-Droid's policy requires;
  - FXM's own update check is off.
- **Smoke tests.** `make live-smoke`, plus a documented local schedule (launchd or cron) for the owner's machine. CI's `FXM_LIVE=1` jobs are marked advisory.

Done when:
- Tests cover bad signatures, rollback attempts, unreachable hosts and fallbacks.
- In a desktop build, a module update fixes a deliberately broken bundled parser without an app update.

**R.4a Positioning rules and public copy** · branch `docs/r4a-positioning` · depends on nothing · scope `README.md`, the intros in `docs/**`, `apps/web` strings, `docs/LEGAL.md` (rules section)

Contents:
- **The rules:**
  - no "ad-free YouTube", no "free Spotify Premium", no "download any song" or "download any track";
  - no YouTube or Spotify logos, brand colours or "Spot…" names;
  - no "Spotify built in" under Decision 1 C or D;
  - describe FXM neutrally, for example "no ads from FXM".
- **Fix now:**
  - the README bullets "Play practically any song from YouTube Music, ad-free", "Spotify built in" and "Download any track";
  - ARCHITECTURE's intro: "download any track" and "Spotify-quality recommendations".
- **Review items for other stages.** The rules become review items for every stage that writes public text:
  - 1.9 (extension descriptions);
  - 5.3 (site copy);
  - 7.1 (bundle descriptions);
  - later, the store listings (R.2, R.3).

Done when: the rules are in `docs/LEGAL.md`, the README and docs comply, and the owner has signed off on the wording.

**R.4b Legal and takedown readiness** · branch `docs/r4b-legal-readiness` · depends on 0.4, 5.3, R.4a · scope `docs/LEGAL.md`, `apps/site/src/pages/legal/**`, `apps/site/public/.well-known/security.txt`, `.github/workflows/mirror.yml`

Contents:
- A non-affiliation and user-responsibility notice, and a contact address.
- **A takedown playbook:**
  - remove only the targeted module and keep FXM online;
  - use GitHub's counter-notice route;
  - keep contacts at EFF, SFLC.in and GitHub's Developer Defense Fund.
- A clean-room log of where each protocol fact came from. It covers YouTube facts, and Spotify facts only under B.
- A Git mirror on GitLab.com, through push mirroring with a project token.
- **Owner actions and secrets:**
  - a GitLab account and project, and the secret `GITLAB_MIRROR_TOKEN`;
  - a Netlify account and site, and the secrets `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` (used by 2.8);
  - the signing key pair: the public key committed, the private key kept off CI or in an environment that needs the owner's approval;
  - GitHub secret scanning and push protection turned on.

Done when:
- The notices are live on the site and in the README.
- `LEGAL.md` holds the playbook and the clean-room log.
- The mirror workflow passes on `develop`.
- The owner has confirmed every account and secret.

### 11.3 Modify

**1.1 Core domain model** (in progress; these changes are breaking, so make them before it merges)
- `NetworkCapabilities.youtube: boolean` becomes `'none' | 'simple' | 'full'`.
- `NetworkCapabilities.spotify: boolean`:
  - is removed under Decision 1 C or D. Plugins declare their hosts, and the platform reports whether user-approved hosts are reachable.
  - Under A or B it becomes a reachability value, `'unreachable' | 'anonymous' | 'account'`. It never encodes the user's on/off choice, which lives in settings.
- `AudioCandidate` keeps `evidence: string[]` and gains `signals: { isrcVerified: boolean; releaseId?: string; releaseYear?: number; label?: string; sourceAlbumMatch: boolean }`.
- `StreamOption` gains `fullLength` (`'verified' | 'unverified' | 'capped'`) and `media` (`'audio' | 'muxed-video'`).
- `modePolicy` accepts a song-for-video link.
- `SourceId` becomes extensible for plugin sources (8.3), and drops `jiosaavn`, which revision 2 removed.
- Quality tiers never label YouTube audio "lossless".
- Downstream stages that consume these types: 1.2, 1.7, 1.10, 1.12, 2.3, 2.4, 2.5, 2.6, 2.7, 3.2, 5.2.

Done when: as before (90 % coverage, full TSDoc), with the new fields documented.

**1.2 Platform transports** · depends on 1.1 · scope `packages/platform/**` except `src/sandbox/**`, `src/updates/**` and `src/evaluator/**`
- `toSimpleInnerTubeRequest()` is used on every path.
- **Web routing:**
  - InnerTube goes to Connect when present, otherwise to a `SandboxTransport` (the interface plus a fake are in 1.2; 1.10 implements it), otherwise `Unsupported`.
  - googlevideo bytes and Last.fm station JSON go through Connect only.
- **The shared request budget** (`createRequestBudget()`): an hourly cap, priority classes, bulk spacing, a pause on `LOGIN_REQUIRED` or 429, and a persisted pause state.
- **Tauri contract:** InnerTube gets `Origin: ''` or a YouTube Origin, and headers go only in `init.headers`.
- **Capacitor contract:** the OkHttp plugin only.
- Connect detection also reports "was present, now missing".

Done when:
- Unit tests prove that no header that triggers a preflight survives the adapter.
- Routing tests cover all three tiers against the fake sandbox.
- Budget tests with a fake clock show that a 1,000-track import stays under the cap, gives way to playback, pauses on `LOGIN_REQUIRED` and resumes.

**1.3 YouTube metadata provider** · depends on 1.1
- Use the CORS-simple request shape.
- Use server-issued visitorData only: `sw.js_data` where readable, otherwise `responseContext.visitorData`. Never locally generated sessions.
- In Music mode, take album track lists from the album's audio playlist (`browse VL` + `OLAK5uy_…`), not `next` over it.
- Read song-for-video links from album pages (`MPTC` + ATV ID, aligned by position).
- Set `hl`/`gl` from the user's locale.
- The config loader validates a schema and a host allowlist. 1.13 adds signature checks.

Done when:
- Fixtures cover classification, mode filtering, MPTC pairing, the OLAK path and the request shape.
- The live smoke test passes from Node using the CORS-simple shape.

**1.4 YouTube stream resolver: direct rungs** (retitled) · depends on 1.3 · scope `packages/sources/src/youtube/stream/**` except `stream/advanced/**`
- The ladder becomes VISIONOS, then ANDROID muxed itag 18 (labelled "AAC from video"). ANDROID_VR and IOS stay in the config but are off.
- **Probing:**
  - where bytes are readable, probe the last 64 KB before accepting a URL;
  - for Lite, return the URL unprobed with a flag, so 2.3 uses the media-element probe.
- On `LOGIN_REQUIRED`, refresh visitorData once, then move to the next rung, and report the bot check to the budget.
- **Unavailable states** with fixtures: age-restricted, "made for kids", live and premiere.
- An `FXM_LIVE=1` test of itag 18 on a known "made for kids" ID, run before any routing of kids videos to it.
- Reject mismatched `videoId`s. Keep per-rung health and flags in the remote config.

Done when:
- With `FXM_LIVE=1` from Node, a YouTube Music song resolves to a VISIONOS URL that passes the end-of-file probe, and to an itag 18 URL when VISIONOS is disabled.
- Fixtures cover capped URLs (403 past 1 MiB), `LOGIN_REQUIRED`, the unavailable states and mismatched IDs.

**1.5 Spotify provider** (Decision 1 B only; removed from FXM under C or D)
- Off in official builds: CI builds with the flag off, and only local builds turn it on.
- No pre-filled secret source. The user pastes JSON or a URL, which is fetched through `userhost.html` on the web.
- Failure UX and fixtures as in section 3.3.
- A browser User-Agent on native transports, and a typed error for `403 Client/request not allowed`.
- The desktop account token comes from a Rust command; Android uses the OkHttp plugin.
- Each hash is sourced from Spotify's own web-player chunks into the clean-room log before coding.
- `getAlbum` is added to the anonymous live smoke test.
- The web bridge is a separate add-on. The hashes ship in the provider's own config.
- ISRC, label and date come from `metadata/4`, lazily. Never call `api.spotify.com/v1`.
- Lazy single-flight token refresh; `fetchPlaylist` with offset 0 and limit 50.

Done when:
- A live smoke test from Node with a browser User-Agent covers search, artist, album, related artists, track and artist radio, and ISRC lookup.
- Fixtures cover the 401, 403-UA, 412, 429 and secret-failure paths.
- A bundle check shows that official builds contain no Spotify code.

**1.6 Free and lossless sources**
- **MusicBrainz:**
  - drop the User-Agent requirement in browsers, where page JS can't set it in Chromium; desktop and Android send a descriptive User-Agent;
  - keep 1 request per second;
  - add the exact URL-relationship lookup, and the fuzzy recording search as a hint only.
- **Jamendo:**
  - call it only for explicit searches or "prefer lossless", and cache the results;
  - add a "quota used up" state and a field for the user's own `client_id`;
  - check its API terms on a shared ID before shipping.

**1.7 Matching engine**
- The ISRC gate checks the top 5 results, plus the unfiltered top-result card. Every check must pass on each item (section 6.1), with one retry.
- Add the re-recording guard's four triggers (section 6.2) and the no-duration mode.
- Apply the album, year and label tie-break after the 1.0 cap.
- Prefer song-for-video links over scoring.
- Description fetches draw on the budget, for the top 2 candidates only.
- **Golden set additions:**
  - the three held-out failures, replayed with the ISRC step off;
  - the ISRC misses (compilation-only, Spotify Singles);
  - ISRC squatters (GBAYE0601696, QMFMF2447070);
  - same-title covers near the right length;
  - other songs by the same artist near the right length.

Done when:
- The golden set shows zero wrong Auto plays and at least 85 % Auto on its mainstream cases.
- The three replays end in Suggest or the right recording.
- Squatters, covers and same-artist filler never pass the gate.

**1.9 FXM Connect** (in progress; it needs changes before its first release)
- Correct the plan's description. Connect:
  - rewrites the Origin on every InnerTube request, using the host's own YouTube origin;
  - sends the other YouTube origin on preflights;
  - rewrites the Origin on googlevideo requests only for preflights.
- Add the mirror origin to `PRODUCTION_ORIGINS` before Connect's first release (the owner picks the name; section 10).
- **Spotify parts:**
  - under Decision 1 C or D, remove the five Spotify rules, the `spotify` and `spotify-server-time` features, the session bridge, its options toggle and the Spotify host permissions;
  - under B, move them into a separate bridge add-on with its own ID, built only in local builds.
- Keep cookie stripping and the Last.fm rule.

Done when: the e2e test passes for both origins, and under C or D the manifest has no Spotify host permission.

**2.3 Playback policy** · depends on 2.2, 1.4, 1.7
- **Probing:**
  - where bytes are readable, use the HTTP probe;
  - in Lite, or after a CORS failure, use the media element's first request (section 4.2);
  - either way, fall back to itag 18, then re-resolve.
- Suggest-band matches play only after an explicit user action. Queues skip them and mark them "needs review".
- **URL cache:**
  - keyed by network;
  - flushed on `online`, `offline` and connection-change events;
  - a 403 on a cached URL drops every cached URL.
- Smart Replace fires only on video-level signals. Pins are never deleted automatically.

Done when: tests with fake sources and fake clocks cover:
- the capped-URL fallback on both probe paths;
- re-resolving and resuming at expiry;
- the flush on network change and the flush on a 403 for a cached URL;
- the Smart Replace triggers and the protection of pins;
- queues skipping Suggest items.

**2.4 Search and browse UI** · depends on 2.1, 1.2, 1.3
- Show YouTube results whenever `youtube` is `'simple'` or `'full'`.
- Hide download and EQ on YouTube items in `'simple'`.
- Show a provider source switch only under Decision 1: after the user enables Spotify under A or B, or once a provider is installed under C (M2).

Done when: component tests cover the three tiers.

**2.5 Now playing and queue panel**
- The queue panel shows Suggest items as "needs review", with a one-tap batch review and the "Play best guesses" setting.

**2.6 Library** (moved from "No change"; builds on `97fe265`'s ordering rewrite)
- Match cache:
  - keyed by the source track ID and the mode;
  - it stores the band, signals, evidence, `userPinned` and a timestamp;
  - a Suggest-band guess is never stored as confirmed;
  - pins are never deleted automatically.
- Store import progress, so imports can resume (3.6).

Done when: migrations and tests cover these fields.

**2.7 Tiers, onboarding and install guides** (retitled) · depends on 2.1, 1.2, 1.6, 1.9, **1.10**
- Three tiers (Free only, Lite marked experimental, Full), each with a "what you're missing" panel.
- Detect a disabled or blocked Connect, and point to the desktop app or the APK.
- **Install guides:**
  - Firefox Add-ons;
  - Edge Add-ons, if listed;
  - Chromium unpacked: Developer mode must stay on, updates are manual, and managed browsers may block it;
  - the desktop app;
  - the APK, for Chrome on Android.
- Safari and iPhone: free sources and Lite only (unverified).

Done when: Playwright tests with fakes cover each tier, the prompt for an outdated extension, and the disabled-Connect path.

**2.8 Static deploy** · depends on 2.4, 2.5, 2.6, 2.7, 5.3, R.1, R.4a, R.4b, **1.10**, **1.12** (the report committed, not a pass)
- `make dist` composes:
  - the site at `/`;
  - the app at `/app/`;
  - the embed at `/embed/`;
  - the sandbox documents at `/sandbox/`;
  - a generated `_headers` file.
- The same build deploys to Cloudflare Pages and to the Netlify mirror.
- Owner actions:
  - Cloudflare: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
  - Netlify: `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`.
- Header rules, one source for both hosts:

| Rule (path) | Headers | Why |
|---|---|---|
| Each site page, listed one by one (`/`, `/privacy/`, `/disclaimer/`, `/legal/*`, `/404.html`), and `/_astro/*` | The site's CSP (owned by 5.3), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` | One rule per page, so no rule overlaps `/app/`, `/embed/` or `/sandbox/`, and no rule needs `/*` |
| `/app/*` | `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://coverartarchive.org https://archive.org https://*.archive.org https://*.mzstatic.com https://*.jamendo.com https://lastfm.freetls.fastly.net; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://www.last.fm https://musicbrainz.org https://coverartarchive.org https://archive.org https://*.archive.org https://api.jamendo.com https://lrclib.net https://api.listenbrainz.org https://labs.api.listenbrainz.org https://ws.audioscrobbler.com https://itunes.apple.com https://sponsor.ajay.app; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`, plus the same `Referrer-Policy` and `nosniff` | See the notes below the table |
| `/embed/*` | As `/app/*`, but without `frame-ancestors` | Any site may embed the player. Lite still works inside third-party pages, because the sandbox documents set no `frame-ancestors` |
| `/sandbox/innertube.html` | `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-…'; connect-src https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com; base-uri 'none'; form-action 'none'` | `sandbox` makes it opaque however it is loaded. The inline script's hash is computed at build |
| `/sandbox/eval.html` | `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-…' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'` | The only document with `'unsafe-eval'` |
| `/sandbox/userhost.html` | `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-…'; connect-src https:; base-uri 'none'; form-action 'none'` | GET only, to hosts the user typed in |

  Notes on the `/app/*` rule:
  - The line is about 1,000 characters, under the 2,000-character limit.
  - `'wasm-unsafe-eval'` is there for ffmpeg.wasm in its worker.
  - `media-src https:` covers googlevideo, Internet Archive's redirect hosts (`ia*.us.archive.org`), Jamendo's storage hosts and a user's Invidious proxy. Page script can't read media responses.
  - `no-referrer`: today, googlevideo requests from the page carry `Referer: https://fxm-music.pages.dev/` (measured), which would let YouTube single out FXM traffic. googlevideo serves requests that have no Referer (measured).
  - 1.11 adds the BotGuard hosts when its rungs ship.
  - Spotify hosts appear only in local builds under B.

- **Why no rules overlap.**
  - On Cloudflare, a request inherits every matching rule's headers, and a header applied twice is joined with commas. Two CSPs would both be enforced, and `eval.html` couldn't evaluate.
  - Netlify documents neither how matching rules combine nor a way to remove a header.
  - So no two rules may match the same path. Cloudflare's `! Header` removal is not relied on.

Done when:
- **Playback with Connect.** `https://fxm-music.pages.dev/app/` with FXM Connect plays a YouTube Music song in both modes.
- **Playback in Lite.** Without Connect, Lite plays one in Chromium, or the result is recorded if Lite's kill switch is on at the time.
- **Free sources.** An Internet Archive track and a Jamendo track play on the deployed site, with and without Connect.
- **Header checks.** A script fetches each path on both hosts and confirms exactly one `Content-Security-Policy` header with the expected directives, and that googlevideo requests carry no Referer.
- **Sandbox checks on the deployed site** (Playwright):
  - `eval.html` evaluates a test function;
  - `innertube.html` can't fetch outside its three hosts;
  - a page on another origin that frames either document without the `sandbox` attribute gets an opaque document whose messages are ignored.
- **Mirror.** The Netlify mirror passes all of the above.
- **No Spotify.** Under every Decision 1 option except A, a bundle check shows the official builds contain no Spotify code.

→ **M1 / `v0.1.0`**

**3.2 Recommendation providers**
- Spotify radio, related artists and home only under Decision 1 A or B, or from an external provider under C.
- Last.fm station items are handled as in section 5, rule 9, within the budget.
- ListenBrainz's similar artists, which need no key, by default.
- In Music mode, YouTube Music radio is seeded with the ATV ID.

**3.5 Spotify account connect** (Decision 1 B only; removed under C or D)
- A second opt-in, after the Spotify opt-in, with the account-risk notice. It goes through the bridge add-on, and is read-only.

Done when (added): a manual live test in Chrome and Firefox, with third-party cookies allowed and blocked, is documented.

**3.6 Imports**
- **Spotify's "Download your data" JSON** is first-class and needs no Spotify provider:
  - its rows go through the MusicBrainz exact path, then no-duration mode if that fails;
  - its streaming history becomes 3.1 listening signals.
- Exportify-style CSV.
- Spotify URL imports only under A or B, or through a provider under C.
- Imports are resumable, paced by the budget, and use the review list.

**4.1 Download manager**
- YouTube-sourced downloads are gated by Decision 2.
- Byte fetches are single-range GETs, so they trigger no preflight.
- On the web, a googlevideo redirect means retrying with a fresh resolution.
- Downloads are never offered in Lite.

**4.2 Conversion and tagging** (moved from "No change"; Decision 2)
- Use a custom LGPL, audio-only ffmpeg.wasm build under 25 MiB, hosted with the site. The stock core is GPL-2.0-or-later and 30.7 MiB.
- Extract itag 18's audio by remuxing it with mp4box.js, not ffmpeg.

Done when: CI checks that the wasm file is under 25 MiB and that its licence is LGPL.

**5.2 Embeddable mini-player** · depends on 2.3, **1.10**
- Use the Lite tier for YouTube when Connect is absent; otherwise, free sources plus an install hint.
- The embed's CSP lets any site frame it.

Done when (added): the embed plays in Lite inside a test page on another origin.

**5.3 Landing page** (in progress; copy only)
- In `Features.astro` and `Faq.astro`, replace "without the extension, only free sources" with a description of the Lite tier, marked experimental.
- Under Decision 1 C or D, drop the "Spotify, built in" section, `SpotifyDemo`, and the Spotify mentions in the hero, the "Get FXM" section and "How it works".
- Under Decision 2 B, drop "downloading from YouTube Music takes FXM Connect".
- Follow R.4a.

**6.2 Android native fetch**
- An OkHttp plugin only, with streaming bodies, abort and binary safety. No `CapacitorHttp.request` stopgap.
- Its own cookie jar.
- A browser User-Agent for Spotify (under B only), and the per-host Origin policy.
- The client is shared with Media3.

Done when:
- On an emulator or a device, a YouTube Music search and a VISIONOS resolve that passes the end-of-file probe both succeed (plus a Spotify search under B).
- Unit tests show that a WebView cookie for `youtube.com` never appears on a native request.

**6.3 Native player**
- A Media3 `MediaSessionService` running as a `mediaPlayback` foreground service.
  - Whether this keeps the process out of Android 14+'s cached-app freezer, and with it the JS re-resolution callbacks working, is an inference that this stage must test.
- A deeper resolved queue, budget permitting (URLs last about 6 h), plus re-resolution through JS while it is alive.
- Plain GETs for VISIONOS URLs.
- Re-resolve on 403, and flush on a network change.

Done when:
- 30 minutes of screen-off playback across track boundaries work on a real device.
- Playback continues after the WebView renderer is killed (adb), and after the 2–3-item queue runs out, either from the deeper queue or by restarting the resolver.

**6.6 Signed APK release**
- Follows Decision 3.
- Document Android's 2027 flow: "Install anyway" on every install; updates fail when the flow is off; ADB is exempt.
- Keep an offline backup of the signing key.
- Record how to register F-Droid's re-signing key.
- The 1.13 module reduces how often the APK must be updated.

**7.2 Desktop native fetch**
- InnerTube gets `Origin: ''`, which removes the header, or `https://www.youtube.com`, never the webview origin.
- A browser User-Agent for YouTube web endpoints, and for Spotify under B only.
- Headers only in `init.headers`. `scopeRedirects` on.
- Server-issued visitorData.
- Follow plugins-workspace PR #3703 (per-URL header config), so `unsafe-headers` can be dropped later.

Done when: in a hidden window on macOS, Windows and Linux:
- a YouTube Music search succeeds;
- a VISIONOS URL is resolved through plugin-http with server-issued visitorData and passes the end-of-file probe;
- that track plays to the end in the Tauri app.

This closes the gap described in section 4.3.

**7.3 Desktop playback**
- `<audio src>` only for URLs that passed the probe.
- Codec chosen by `canPlayType` (AAC on macOS before 15.4).
- Document "Unknown app" in Windows media controls (WebView2 bug #2236).

Done when: three consecutive full tracks play with the window hidden on each OS, including WebView2 and WebKitGTK.

**7.4 Desktop downloads + Spotify login**
- Downloads per Decision 2.
- The Spotify login window only under B, where a Rust command returns only the token.

**7.5 Desktop release**
- No Homebrew cask unless the app is notarized.
- Windows signing through SignPath Foundation or OSSign once accepted. Otherwise unsigned, with docs for SmartScreen and Smart App Control.

**7.6 Desktop trust** · depends on 7.5, **1.11**
- Apply to SignPath Foundation and OSSign after the first public release, with Certum's open-source certificate as the paid fallback.
- The Microsoft Store is not a free signing route: it re-signs only MSIX, and Tauri emits MSI/NSIS.
- Apple notarization per Decision 3.
- The PO-token work moves to 1.11.
- Keep the EQ path (MediaSource, or a localhost stream from Rust).

**8.3 Plugin system**
- **Under Decision 1 C**, 8.3 moves into M2, depends on 1.1, 1.2 and 1.11's evaluator, and works like this:
  - **Installing:** only from a URL the user types or a file the user picks. The manifest gives the plugin ID, version, declared hosts and SHA-256. The install screen shows the host list and a third-party notice. FXM lists no plugins.
  - **Running:** the code runs only in the isolated evaluator. On the web, its requests come from an opaque origin with no FXM cookies or storage. On desktop and Android, they go through the native transport within the approved host list.
  - **Limits:** no cookie or login access. Artwork reaches the main document as `blob:` URLs, so no provider hosts appear in its CSP.
  - **Updates:** explicit approval for each update. In F-Droid builds, the opt-in uses the wording F-Droid's policy requires.
- **Under A, B or D:** as before, in M7.

**R.2 Extension store channels** (retitled) · branch `ci/r2-extension-stores` · depends on R.1 · scope the extension jobs in `.github/workflows/release.yml`, `apps/extension/store/**`
- AMO unlisted signing in CI, then a listed submission (`data_collection_permissions`; source upload if code is bundled). The listing has no Spotify parts.
- An Edge Add-ons submission.
- No Chrome Web Store submission by default.
- Under B, the Spotify bridge add-on is never submitted.

Done when: the signed XPI is attached to a release, and the AMO and Edge outcomes are recorded in `apps/extension/README.md`.

**R.3 More channels**
- Homebrew only with notarization.
- F-Droid with the NonFreeNet anti-feature. Plugins and the resolver module are opt-in there, and FXM's own update check is off.
- winget and Flathub as planned.

### 11.4 Cross-cutting rules

- **Decision 1 (Spotify)** applies to 1.1, 1.5, 1.9, 2.4, 2.8 (the bundle check), 3.2, 3.5, 3.6, 5.3, 6.5, 7.4, 8.3, R.2 and ARCHITECTURE §11.
- **Decision 2 (YouTube downloads)** applies to 4.1, 4.2, 6.4, 7.4 and 5.3's copy.
- **Decision 3** applies to 6.6, 7.5, 7.6 and R.3.
- **If Decision 1 is C,** 8.3 depends on 1.1, 1.2 and 1.11's evaluator, and joins M2.
- **Until Decision 1 is made,** in-progress work takes the C shape: no Spotify in 1.1's types or in 1.9's rules. B can add it back.
- **R.4a's rules** apply to every stage that writes public text.

### 11.5 No change

- 1.8, 2.2, 3.3, 3.4, 4.3, 4.4, 5.1, 6.1, 7.1, 8.1, 8.2, 8.4, 8.5 and R.1 keep their scope.
- 3.1 also keeps its scope; 3.6 feeds it imported history through 3.1's event API.
- 6.4 keeps its scope, subject to 11.4.
- 6.5 keeps its scope under B and is removed under C or D.

### 11.6 Milestones and waves

- **M1** becomes "Phases 1–2 except 1.11 and 1.13 (and except 1.5 under C or D), plus 5.3, R.1, R.4a and R.4b".
- **M1 result:**
  - The web app plays YouTube Music songs in Music or Music + Video mode with FXM Connect, plus free sources, lyrics and a library.
  - Lite works at least in Chromium, unless its kill switch is on.
  - Matches auto-play only if 1.12 passed; otherwise M1 is Suggest-only.
  - There is no Spotify under C.
  - The landing page and its mirror are live.
- **M2 under C:** 8.3's provider plugins join Phase 3.

| Wave | Stages |
|---|---|
| 1 (running) | 1.1, 1.9, 5.3, 6.1, 7.1; R.4a can start now |
| 2 | 1.2, 1.3, 1.6, 1.7, 1.8, 2.2, 2.6, R.1, R.4b (once 5.3 lands); 1.5 only under B |
| 3 | 1.4, 1.10, 1.12, 2.4, R.2 |
| 4 | 1.11, 1.13, 2.3, 2.7 |
| 5 | 2.5 |
| 6 | 2.8 → M1 |

### 11.7 Matching ARCHITECTURE.md corrections

| Section | Correction |
|---|---|
| Intro | Drop "download any track" and "Spotify-quality recommendations"; use R.4a's wording |
| §1 | Web app row: replace "Without the extension, only free sources play" with the Lite tier (experimental) plus free sources. FXM Connect row: no Spotify. Add the mirror host. Under C or D, add "Spotify integration in FXM's own code" to the non-goals |
| §2 | The FXM column's metadata row follows Decision 1. Replace "16 of 16" in the matching row |
| §3 YouTube | Add the opaque-origin finding, and replace "a plain web page can't search YouTube or resolve streams". Only VISIONOS serves full files; ANDROID_VR and IOS are capped; `<audio>` works only for URLs served in full. Invidious is intermittent |
| §3 Spotify | Follow Decision 1. Under C or D, keep only "Spotify is not part of FXM" and the reason, and remove the protocol details from the public repository. "The owner accepts this for a personal-use project" no longer holds |
| §3 Platforms | The forced Tauri origins and UA; Capacitor's process-wide cookie jar; the Android 14 freezer (inference); Edge's laxer enforcement; the macOS Safari route. State that Tauri was verified component by component (in a WKWebView harness for media and background behaviour), not end to end |
| §4 | Song↔video links are missing from `/next` and search, but album pages carry them. Add the OLAK audio-playlist rule |
| §5 diagram | Add the sandbox path (web app → sandbox document → InnerTube), the mirror host and the signed config. Drop the Spotify edges under C or D |
| §7.2 | The new capability, candidate and signal types (1.1) |
| §8 | Add a Lite column to the capability matrix. Spotify rows follow Decision 1. Add the shared request budget |
| §9 | Describe 1.9's real rules: requests carry the host's own YouTube origin, preflights the other one, googlevideo is rewritten on preflights only. Remove the Spotify rows under C or D. Add the mirror origin |
| §10 | The new ladder; the end-of-file probe and Lite's media-element probe; the unavailable states; the request budget; the signed config and resolver module; CI live runs as advisory |
| §11 | Rewrite per Decision 1. Under every option, remove the write-back plan (8.6 is removed) |
| §12 | The ISRC gate with every check required; the ISRC-miss cap; demotion on conflicting release facts; no-duration mode; the Auto setting tied to 1.12. Replace "16 of 16" with the fresh 9 of 16. Key the cache by source track ID and mode, not ISRC. MusicBrainz exact path vs fuzzy hint |
| §14 | itag 18 remux with mp4box.js; an LGPL audio-only ffmpeg build under 25 MiB |
| §15 | Data-export imports in no-duration mode; Spotify URL imports per Decision 1 |
| §16 | Signing, Store, Homebrew and OSSign facts; the static and Git mirrors; the secrets list (add the GitLab and Netlify tokens; signing keys kept off CI) |
| §17 | The sandbox documents and their CSPs; plugins in the evaluator; SponsorBlock disclosure; `Referrer-Policy: no-referrer` |
| §18 | New risk rows: AMO disabling Connect; code fixes on desktop and Android; site hijack; bulk-import bot checks; Jamendo quota. Legal likelihood raised |
| §19 | D12: Connect is no longer "the only way" to reach YouTube from a static page. D14 follows Decision 1, D15 Decision 2. D16: replace "16/16" with the fresh numbers. D18: Invidious returns as an opt-in rung. Add D19 (Lite tier, experimental), D20 (CORS-simple InnerTube shape everywhere), D21 (signed config and resolver module), D22 (a static mirror that supports per-path headers) |

---

## 12. Evidence table

| Claim | Verdict | Source |
|---|---|---|
| Spotify pathfinder and spclient echo any Origin (including `null`) with credentials; `/api/token` and `/api/server-time` send no ACAO; a plain page can't mint a web-player token | Partially true. Corrected: the official OAuth token endpoint is CORS-open (PKCE), but Development Mode (Premium owner, 5 users, since February/March 2026) makes it impractical. clienttoken allowlists `open.spotify.com` | Live curl and Edge/Chrome 156 runs, 2026-10-25; Spotify February 2026 migration guide |
| An anonymous web-player token works for search, track, playlist, artist overview, 40 related artists, track and artist radio and a generic home, without client-token | Partially true. Corrected: pathfinder answers non-browser UAs (curl, okhttp, Dalvik, python-requests, custom) with 403 | Two independent live runs, 2026-10-25; plugin HEAD `e05ca8e` (2026-10-20) |
| `/api/token` responses say use is "not permitted under the Spotify Developer Terms and Developer Policy, and applicable law" | Confirmed (error bodies nest it under `error.extra._notes`). Account risk comes from the User Guidelines, and only with cookie login | Live, 2026-10-25; Spotify Terms, 2026-09-04 |
| ISRCs are available from Spotify itself through `spclient metadata/4` with the anonymous token | Confirmed: 15 of 15 and 8 of 8 tracks | Live, 2026-10-25 |
| `api.spotify.com/v1` is unusable with web-player tokens | Confirmed: 429 even after `Retry-After` | Live, 2026-10-25 |
| Only library and curation hashes were found in Spotify's own bundle | Confirmed: `applyCurations`, `fetchLibraryTracks`, `areEntitiesInLibrary`, `libraryV3`, `isCurated`. No read-operation hash has been sourced from Spotify's files | `web-player.f954508a.js`, fetched 2026-10-25 |
| The Spotube plugin is AGPL-3.0-or-later; the MIT `spotify-gql-client` is stale and built on `/v1` | Partially true: AGPL §5(c) covers the whole distributed work; versions before 2026-07-25 had no licence | Repo at `e05ca8e`; PR #76 (2026-07-25) |
| A Spotify cease-and-desist is unlikely while the project is small | Refuted as a guide. Letters to spotify-secrets (2025-10-10) and to the Echo player's Spotify extension (2026-10-15), and the SpotiFLAC takedown (2026-10-20). Spotube's 2025 letter matched FXM's combination exactly. Enforcement is selective (spotDL, SimpMusic and the separately maintained plugin are untouched) and targets whoever publishes the code | Author's blog, 2025-10-11; letter PDF linked from a fork's README (not independently verified); Android Authority, 2026-10-21; Spotube commits `0326630`, `43ddf90` |
| FXM must not host or fetch TOTP secrets; Spotify belongs in a separate repository with a different maintainer | Adopted as Decision 1's recommendation (C) | Both legal verdicts on the Spotify letter risk, 2026-10-25 |
| A public gist raw file is readable from a page | Confirmed: `Access-Control-Allow-Origin: *`, also for `Origin: null`; `CORP: cross-origin` | Measured on a public sample gist, 2026-10-25 |
| A plain page cannot call InnerTube | Refuted for CORS-simple POSTs from an opaque origin. From a sandboxed iframe: `/search` and `/player` in Chrome 156, Edge 156 and Firefox 158; `/next` and `/browse` with `Origin: null` via curl and Node only. One Python probe got 403 from music with `Origin: null`. Undocumented | Five verification runs, 2026-10-25 |
| Lite playback works in browsers | Partly shown, within the 64 KB cap: VISIONOS played 0.66 s in Edge; Chrome played an IOS URL (a capped client); Firefox reached metadata only; Safari and iOS untested; no full-length run | BY-02 and F06 verdicts, 2026-10-25 |
| InnerTube answers foreign and extension origins with 403, and no Origin or a YouTube Origin with 200 | Confirmed | The same runs; a real MV3 service worker in Chrome 156 |
| What `feat/1.9` does today | From source: InnerTube requests get the host's own YouTube Origin and Referer, preflights the other YouTube origin; googlevideo gets ACAO, and a YouTube Origin on preflights only; Spotify rules and session bridge; cookies stripped; `PRODUCTION_ORIGINS = ['https://fxm-music.pages.dev']`; a googlevideo redirect leaves bytes unreadable | `feat/1.9-connect-extension` at `fcc0dc8` (2026-10-25): `apps/extension/src/rules.ts`, `config.ts` |
| What `feat/1.1` defines | From source: boolean `youtube` and `spotify` capabilities; `evidence: string[]`; `SOURCE_IDS` still includes `jiosaavn`; 9 commits, 3,124 lines | `feat/1.1-core-model` at `2583d95` (2026-10-25) |
| googlevideo sends `CORP: cross-origin` and ACAO only to YouTube origins; `<audio src>` plays; fetch, MediaSource and Web Audio need a bridge | Confirmed. Web Audio outputs silence; `crossorigin` gives error 4 | Live runs plus Edge/Chrome/Firefox, 2026-10-25; Web Audio Editor's Draft, 2026-09-09 |
| VISIONOS, ANDROID_VR and IOS give PO-token-free direct audio | Partially true. Corrected: only VISIONOS serves full files. ANDROID_VR and IOS return 403 past about 1 MiB and on `bytes=0-`; MWEB and WEB_REMIX return 403 at 2 MiB without a PO token | Several verification runs, 2026-10-25; yt-dlp `fa98866` (2026-10-23), PR #17461 |
| VISIONOS needs a real session | Confirmed, with nuance: synthetic sessions worked 1 of 4 times, server-issued ones 4 of 4; "made for kids" videos unavailable | F05 verdicts, 2026-10-25; yt-dlp #17871 (2026-10-20) |
| "Made for kids" videos play through itag 18 | Untested. NewPipe served them as 360p muxed in June (`82b7e41`) and says they can no longer be played after it dropped the ANDROID client (`9ed62db`, 2026-08-06) | NewPipeExtractor commits |
| Bloomee plays the ANDROID client's itag 18 today, and its TV fallback is dead | Partially true: TV fails even with a `signatureTimestamp`; ANDROID_VR is no longer in Bloomee's chain | bloom-factory `e072dab` (2026-08-20) plus live runs |
| Bloomee survives breakages through hot-updated plugins | Partially true: auto-update was broken from 2026-03 to 2026-05-29; no rollback; no signature checks | BloomeeTunes commits `f282ee9`, `407351d`, `e52d538` |
| Desktop `<audio>` plays googlevideo URLs directly | Partially true: only URLs served in full (VISIONOS). Shown in a Swift WKWebView harness serving `tauri://localhost` (64 KB), not in Tauri. Capped URLs fail on the first request in WKWebView and Chromium | WKWebView and Edge 156 runs, 2026-10-25 |
| Tauri's plugin-http works as youtubei.js's `fetch` with `unsafe-headers` and an Origin override | Partially true: in the Tauri app, search and `/player` returned 200, but no stream was resolved through it (`LOGIN_REQUIRED` from a locally generated session). Spotify rejects the plugin's default UA; headers must go in `init` | plugin-http 2.8.3 source (2026-10-14); probes, 2026-10-25 |
| Now Playing, media keys and hidden playback work on macOS | Confirmed in a Swift WKWebView host, not in Tauri. WebView2 and WebKitGTK not run | Native-apps F4, 2026-10-25 |
| Stream URLs are IP-bound and expire after about 6 h | Confirmed, including by a second-IP test | BY-02 verification, 2026-10-25 |
| Public Piped and Invidious instances are unusable | Partially true: Piped is dead; Invidious intermittently serves proxied Opus from one API instance | Runs on 2026-10-25; Invidious PR #5630 (`disable_abusable_api`) |
| A DNR Origin rewrite plus ACAO lets a page reach InnerTube, preflights included | Partially true: same-host preflights return 400. CORS-simple requests or a cross-host preflight Origin work, which is what `feat/1.9` now does. Chrome's fetch drops a custom UA. The Safari bridge is unverified | Chrome 156 and Firefox 158, 2026-10-25 |
| Web PO tokens can be minted in a page on a third-party origin | Not re-verified; acceptance by googlevideo untested | Original run, 2026-10-25; bgutils-js 4.0.3 (2026-08-04) |
| An ISRC search on YouTube Music returns the exact recording at #1 | Partially true: original run 16/16; fresh runs 9/16 at #1, 6/16 at #2, 1 missing. Misses for compilation-only and Spotify Singles ISRCs. Ranking varies between runs. Matches the ISRC, not the release. ISRCs shared by unrelated tracks: GBAYE0601696 → Waw\*mart, QMFMF2447070 → Lil dexxy (Deezer) | Two verification runs, 2026-10-25 |
| The text scorer is safe to auto-play without an ISRC | Partially true: 15/15 and zero wrong in sample. On the live held-out set, at least 1 and probably 2 wrong Auto plays on same-artist re-recordings; the rivals guard alone would not catch "The Twist". The classical guard is load-bearing | Verification runs, 2026-10-25 |
| Anonymous sessions have no song-to-video links | Partially true: none in `/next` (current clients); album pages expose OMV-to-ATV links through `MPTC` (40 of 40 rows); `/next` over an album queue returns official videos | Verification runs, 2026-10-25 |
| The global Capacitor HTTP patch is unsafe for providers | Confirmed, with additions: a process-wide `CookieHandler` backed by the WebView's jar also affects `CapacitorHttp.request`; Android 14+ freezes cached apps | Capacitor 8.5.3 source; AOSP freezer doc (2026-10-09) |
| Cloudflare Pages `_headers`: matching rules combine | Confirmed: a request "will inherit all rules' headers"; a header applied twice is joined with commas; `! Header` removes one; up to 100 rules; 2,000 characters per line | developers.cloudflare.com, updated 2026-08-25 |
| Cloudflare Pages file limits | 25 MiB per file; 20,000 files on the free plan | developers.cloudflare.com, updated 2026-09-05 |
| Netlify supports the same headers file | Same `_headers` format; how matching rules combine and header removal are undocumented | docs.netlify.com, updated 2025-12-01 [stale?] |
| The stock ffmpeg.wasm core fits Pages and the LGPL rule | Refuted: `@ffmpeg/core` 0.12.10 is GPL-2.0-or-later and its wasm is 32,232,419 bytes | npm registry and unpkg, 2026-10-25 |
| mp4box.js can replace ffmpeg for the itag 18 remux | Licence and release confirmed: BSD-3-Clause, 2.4.1 (2026-06-19). Remux not yet built | npm registry, 2026-10-25 |
| Jamendo's free tier is enough for a shared public ID | Unclear: up to 35,000 API requests per month for non-commercial apps, shared by every user of one ID; terms on sharing unchecked | developer.jentially.com is wrong — developer.jamendo.com (undated) |
| F-Droid allows downloaded code | Only with explicit opt-in consent that explains it bypasses F-Droid's checks | f-droid.org Inclusion Policy (undated) |
| Mozilla can act on self-distributed add-ons | Confirmed: policies apply "regardless of how they are distributed"; Mozilla "may reject or block affected versions or entire add-ons"; blocked add-ons are disabled with no user override | extensionworkshop.com, 2026-04-30; blocking-process page, 2021 [stale?] |
| SponsorBlock can be queried without revealing the video | Confirmed: `/api/skipSegments/<4-hex sha256 prefix>` → 200 with `ACAO: *`. Data "CC BY-NC-SA 4.0 unless you have explicit permission" | Measured, and sponsor.ajay.app/database, 2026-10-25 |
| OS code signing is the only paid part of distribution, and is free through SignPath or the Microsoft Store | Partially true: the Store re-signs only MSIX (Tauri emits MSI/NSIS); OSSign is also free; Homebrew requires passing Gatekeeper since 2026-09-01; Azure signing excludes individuals outside the US and Canada | Microsoft Learn (2026-08-29, 2026-08-24); Homebrew 6.0.0 (2026-06-11) |
| The Chrome Web Store refuses such extensions, Edge has identical rules, and Safari is unavailable | Partially true: Edge's enforcement is laxer in practice; macOS Safari is reachable through Developer ID (USD 99/yr) | CWS troubleshooting page (2026-07-20); Edge Add-ons API (2026-10-25); Safari 18.4 notes [stale?] |
| Android developer verification restricts sideloading from 2027 | Confirmed by both verifiers. An unregistered app shows "Install anyway" on every install, and updates fail when the advanced flow is off | developer.android.com FAQ (2026-09-30), guides (2026-10-23) |
| The legal risk of YouTube extraction is low to medium | Partially true, and rising. Germany's BGH made the youtube-dl ruling final (October 2025, per the Uberspace side); §1201 rulings in N.D. Cal. (2026-01-23), S.D.N.Y. (2026-04-15) and D. Mass. (2026-08-18); IFPI's request on yt-dlp (2026-09-29). Cox v. Sony (2026-03-25) doesn't cover §1201 | Court dockets; TorrentFreak; GFF |
| The public README overstates FXM | Confirmed: on the public `develop` branch it says "Play practically any song from YouTube Music, ad-free" and "Download any track" | `README.md` at `97fe265`; the GitHub API reports the repository as public |
| Spotube's stable app has been broken since May 2026, and its VISIONOS fix is unmerged | Not re-verified (user and PR reports) | Spotube issues #3041, #3149; PR #3150 (2026-10-18) |
| Last.fm's station JSON is keyless, returns YouTube IDs and has no CORS | Not re-verified (one run) | Bloomee report, 2026-10-25 |
| MusicBrainz is CORS-open, but its User-Agent policy can't be met from Chromium page JS | Confirmed | Headless Edge 156 run, 2026-10-25; MusicBrainz rate-limiting doc [stale? 2012 rules] |
| Smart App Control blocks unsigned apps with no per-app override | Confirmed | Microsoft Smart App Control FAQ (2026) |