# FXM Connect

FXM Connect is the optional companion browser extension of the FXM web app (`https://fxm-music.pages.dev/app/`). It only lets the FXM web app reach music services from your own browser.

## Why it exists

FXM hosts nothing: no server, no gateway, no proxy. The web app is a static site, so everything happens in your browser. Browsers, however, stop a web page from reading responses from other sites unless those sites allow it with CORS headers, and the music services FXM uses do not:

- YouTube's InnerTube API (`www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com`) answers any foreign `Origin` with HTTP 403 and no CORS headers.
- googlevideo media servers send the audio to anyone, so a plain `<audio src>` plays. They only send `Access-Control-Allow-Origin` to YouTube origins, though, and `fetch()`, downloads and MediaSource need it.
- Spotify's `open.spotify.com/api/token`, `/api/server-time` and `clienttoken.spotify.com` send no CORS headers. Last.fm's station JSON doesn't either.

FXM Connect fixes this with a fixed list of declarativeNetRequest (DNR) rules that rewrite a few request and response headers, only for requests the FXM pages make, only to these services. All YouTube and Spotify logic stays in the web app, so when YouTube changes something, FXM is fixed by redeploying the static site. The extension needs no update for that.

## What it does

1. **Header rules.** These are static rules generated from [`src/rules.ts`](src/rules.ts). Every rule only applies to requests started by an FXM page (`initiatorDomains`). Each response gets `Access-Control-Allow-Origin` set to the exact FXM origin, never `*`. Preview deployments on sub-domains such as `<hash>.fxm-music.pages.dev` are not FXM pages: the content script doesn't run there, and the rules leave their requests alone.

   | Service | Request change | Response change |
   |---|---|---|
   | `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com` | `Origin` and `Referer` set to `https://www.youtube.com` (`https://music.youtube.com` for YouTube Music). Preflights (`OPTIONS`) get the other YouTube origin, the one InnerTube accepts them from | ACAO, `Access-Control-Allow-Methods`, `-Allow-Headers` (InnerTube headers), `-Expose-Headers: content-length`, `-Max-Age: 600` |
   | `*.googlevideo.com` | `Origin` set to `https://www.youtube.com` on preflights (`OPTIONS`) only | ACAO, `Access-Control-Expose-Headers: content-length, content-range, accept-ranges, content-type` |
   | `open.spotify.com/api/token`, `/api/server-time`, `clienttoken.spotify.com` | `Origin` and `Referer` set to `https://open.spotify.com` | ACAO, allowed methods and Spotify headers, `-Max-Age: 600` |
   | `api-partner.spotify.com`, `spclient.wg.spotify.com` | none | ACAO, allowed methods and Spotify headers, `-Max-Age: 600` |
   | `www.last.fm/player/station/*` | none | ACAO |

   On top of that, every rule removes the `Cookie` request header and the `Set-Cookie` and `Access-Control-Allow-Credentials` response headers. The FXM page therefore never sends or changes your cookies for these services and can never act as your logged-in account. No rule sets `Access-Control-Allow-Credentials`.

2. **Presence handshake.** A content script on the FXM pages runs at `document_start`. It sets `data-fxm-connect="<version>"` on `<html>` and answers a ping (see [For the web app](#for-the-web-app)).

3. **Spotify session bridge (optional, off by default).** Cross-site cookies are not sent on the page's own requests, so only the extension can get a token for your Spotify login. If you turn on **Use my Spotify login from this browser** on the options page, the FXM page can ask FXM Connect for one. The background then makes one request: `GET https://open.spotify.com/api/token`. It forwards only the query parameters `reason`, `productType`, `totp`, `totpServer` and `totpVer`, each validated, and sends your browser's existing open.spotify.com cookies (`credentials: 'include'`). It returns only the HTTP status and the JSON body (the token). It also relays `GET https://open.spotify.com/api/server-time`, without credentials. Bridge requests are limited to about ten a minute. Everything else is rejected.

   The token request always carries the cookies of the browser's normal windows, because one background serves every tab. So it is refused for pages in private (incognito) windows and Firefox container tabs, where you may be signed in to another Spotify account or none.

   The toggle lives in IndexedDB in the extension's own origin, which only the options page and the background can open. It is deliberately not in `storage.local`: content scripts can write that, so code running in a compromised FXM page renderer could switch your Spotify login on by itself. The content script can't even read the toggle; it asks the background whether to announce the `spotify-login` feature.

The options page (click the toolbar button, or open the extension's options) shows the version, the allowed FXM pages, the Spotify toggle and a link to FXM.

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Applies the static header rules in `rules.json`. FXM Connect has no `webRequest`, so it can't see or change any traffic beyond what those rules describe. |
| `storage` | Keeps the bridge's rate-limit counter in `storage.session` (in memory, cleared when the browser closes). The Spotify toggle is in the extension's IndexedDB instead, out of content scripts' reach. |
| `https://fxm-music.pages.dev/*` | Runs the presence content script there. Browsers also require host access to the page that starts a request before DNR may modify its headers. |
| `https://www.youtube.com/*`, `https://music.youtube.com/*`, `https://youtubei.googleapis.com/*` | YouTube and YouTube Music InnerTube API (search, browse, player data) |
| `https://*.googlevideo.com/*` | YouTube media bytes |
| `https://open.spotify.com/*` | Spotify web token and server time (the rules only touch `/api/token` and `/api/server-time`) |
| `https://clienttoken.spotify.com/*`, `https://api-partner.spotify.com/*`, `https://spclient.wg.spotify.com/*` | Spotify client token, GraphQL (pathfinder) and spclient APIs |
| `https://www.last.fm/*` | Keyless Last.fm recommendation stations (the rule only touches `/player/station/`) |

There is no `<all_urls>`, no `cookies`, `tabs`, `scripting` or `webRequest` permission, and no `externally_connectable`.

## Privacy

- **No data collection.** FXM Connect has no analytics, no telemetry and no servers. It stores one setting (in its own IndexedDB) and a rate-limit counter (in `storage.session`) in your browser. If the browser clears the extension's site data, the setting returns to off. The Firefox manifest declares `data_collection_permissions: { required: ["none"] }`.
- **No cookies read.** FXM Connect has no `cookies` permission and never reads, stores or forwards cookies. Its rules strip cookies from the FXM page's requests to these services. The one exception is the opt-in Spotify bridge. There the browser itself attaches your open.spotify.com cookies to the single token request, exactly as it does on open.spotify.com, and FXM Connect hands the page only the token response.
- **No remote code.** Everything that runs ships inside the extension, as readable, unminified files built from this folder. There is no `eval` and no downloaded script. A strict content security policy (`default-src 'none'`) limits the options page and the background to their own scripts, styles and images, and lets them connect to `https://open.spotify.com` only, so the browser itself stops FXM Connect from contacting any other server.
- **Only FXM pages.** The content script and the bridge check the exact origin and that a message comes from the page itself. Other sites get nothing, and the rules ignore requests they start.

## Install

Until FXM Connect is signed on the Chrome Web Store and AMO, install it from a GitHub release. Each release has `fxm-connect-chromium-<version>.zip` and `fxm-connect-firefox-<version>.zip`.

**Chrome, Edge, Brave and other Chromium browsers (version 120 or later)**

1. Download `fxm-connect-chromium-<version>.zip` and unzip it into a folder you keep. The browser loads the extension from there.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
4. Open or reload `https://fxm-music.pages.dev/app/`.

To update, unzip the new release over the same folder and click the reload button on the extension's card.

**Firefox (version 140 or later)**

1. Download `fxm-connect-firefox-<version>.zip`.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick the zip.
3. Open or reload `https://fxm-music.pages.dev/app/`.

Firefox removes temporary add-ons when it restarts, so repeat step 2 after a restart until FXM Connect is signed on AMO. If FXM does not detect the extension, open `about:addons` → FXM Connect → **Permissions** and allow access to the listed sites.

## For the web app

### Detecting FXM Connect

The content script runs before any page script, so `document.documentElement.dataset.fxmConnect` holds the version as soon as the app starts. To confirm and learn the features, post a ping, and wait for the pong before the first request to a music service: in the dev build the pong only comes once that origin's rules are active (see [Development](#development)).

```ts
function detectFxmConnect(timeoutMs = 500): Promise<{ version: string; features: string[] } | null> {
  if (!document.documentElement.dataset.fxmConnect) return Promise.resolve(null)
  return new Promise((resolve) => {
    const done = (value: { version: string; features: string[] } | null) => {
      clearTimeout(timer)
      removeEventListener('message', onMessage)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return
      if (event.data?.type === 'fxm-connect:pong') done(event.data)
    }
    addEventListener('message', onMessage)
    postMessage({ type: 'fxm-connect:ping' }, location.origin)
  })
}
```

The pong lists `features`:

| Feature | Meaning |
|---|---|
| `youtube` | InnerTube CORS rules |
| `googlevideo` | Media CORS rules |
| `spotify` | Spotify CORS rules |
| `lastfm` | Last.fm station CORS rule |
| `spotify-server-time` | The bridge relays `/api/server-time` |
| `spotify-login` | The user turned on **Use my Spotify login from this browser** and the tab is a normal one, so token requests are served |

### Making requests

Always fetch with `credentials: 'omit'`. Credentialed requests fail, because the rules strip `Access-Control-Allow-Credentials`, and they never carry cookies anyway.

- **InnerTube:** requests may send `Content-Type: application/json` and the headers YouTube's web clients use: `authorization`, `x-goog-visitor-id`, `x-youtube-client-name`, `x-youtube-client-version`, `x-goog-api-format-version`, `x-origin`, `x-youtube-bootstrap-logged-in` and `x-browser-validation`. These trigger a CORS preflight. InnerTube rejects a preflight whose `Origin` is foreign or missing (403) or the host's own origin (400), but accepts the *other* YouTube origin. So FXM Connect gives preflights to `www.youtube.com` the origin `https://music.youtube.com` and the reverse (`youtubei.googleapis.com` accepts either). CORS-simple requests work too and save the preflight round trip, so prefer them where the extra headers aren't needed: send `POST` with the JSON as a plain string body (`fetch` labels it `text/plain;charset=UTF-8`, which InnerTube parses as JSON), with the client name, client version and visitor data in `context.client` and options such as `prettyPrint=false` in the URL.

  ```ts
  const response = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    credentials: 'omit',
    body: JSON.stringify({ context: { client: { clientName, clientVersion, visitorData } }, query }),
  })
  ```

- **googlevideo:** `GET` with a single `Range: bytes=start-end` header (CORS-safelisted, so no preflight) or a `&range=` query is readable. Requests that need a preflight, such as a `POST` with a protobuf body, work too, because only the preflight gets a YouTube `Origin`. googlevideo then answers 204 with its own allow lists. A plain `<audio src>` plays even without the extension. Add `crossorigin="anonymous"` (which needs the extension) only when Web Audio must read the samples.
- **googlevideo redirects to another host stay unreadable.** googlevideo sometimes answers a media request with a 302 to another `rr…---sn-….googlevideo.com` host (the new URL carries `cms_redirect=yes`). After a redirect to another origin, the browser sends the next request with `Origin: null` and only accepts `Access-Control-Allow-Origin: null`. No rule can send that without breaking the requests that weren't redirected, so `fetch()`, MediaSource, download and `crossorigin` reads of such a URL fail with a network error. Treat that failure as retryable: resolve the stream URL again, or fall back to a plain `<audio src>`, which follows redirects without CORS. How often live range requests get such a redirect has not been measured yet.
- **Spotify:** the token and server-time endpoints, clienttoken, pathfinder and spclient accept preflights, so these headers work: `authorization`, `content-type`, `client-token`, `app-platform`, `spotify-app-version`, `accept`. For a token of the user's own login, use the bridge.
- **Last.fm:** `GET https://www.last.fm/player/station/...` JSON.

### Bridge messages

The page posts messages to its own window (`postMessage(message, location.origin)`) and listens for replies with the same `id` (a string of up to 64 characters `[A-Za-z0-9_.:-]`, or a non-negative integer).

| Request | Reply |
|---|---|
| `{ type: 'fxm-connect:ping' }` | `{ type: 'fxm-connect:pong', version, features }` |
| `{ type: 'fxm-connect:spotify-token', id, params }` | `{ type: 'fxm-connect:response', id, status, json }` |
| `{ type: 'fxm-connect:spotify-server-time', id }` | `{ type: 'fxm-connect:response', id, status, json }` |

`params` may only contain `reason` and `productType` (letters, digits, `_` and `-`, up to 32 characters), `totp` and `totpServer` (6 to 10 digits) and `totpVer` (1 to 4 digits), all as strings. `json` is the parsed response body, or `null` if it was not JSON. Any failure answers `{ type: 'fxm-connect:error', id, code }`:

| `code` | Meaning |
|---|---|
| `bad-request` | Malformed message, unexpected field or parameter outside the allow-list |
| `unsupported` | Unknown `fxm-connect:` message type |
| `login-disabled` | The Spotify toggle is off |
| `private-tab` | The page is in a private (incognito) window or a Firefox container tab, where the browser's normal Spotify login does not apply |
| `rate-limited` | More than 10 bridge requests in the last minute |
| `network-error` | The request failed (offline, DNS, TLS or a redirect) |
| `timeout` | No answer within 10 seconds |
| `too-large` | Response larger than 64 KiB |
| `unavailable` | The extension's background could not be reached (for example, it was just updated: reload the page) |
| `internal` | FXM Connect failed unexpectedly, for example because it could not read its settings. Retrying later may help |

## Development

```sh
make extension                      # release build: dist/chromium, dist/firefox and both zips
FXM_EXTENSION_DEV=1 make extension  # dev build: dist/dev/chromium, dist/dev/firefox, dist/dev/*-dev.zip
make test                           # unit tests (part of make check)
scripts/run.sh pnpm --filter @fxm/extension test:e2e   # end-to-end test in Chromium
```

`make build` (and so `make check`) builds the release variant too. Load `dist/chromium` with **Load unpacked**, or `dist/firefox/manifest.json` with **Load Temporary Add-on**.

**Dev build.** It also allows `http://localhost:5173` (the Vite dev server) and `http://localhost:4173` (`vite preview`) as FXM origins. Those are Vite's default ports, so the dev build treats any app served there as FXM: other projects, their dependencies and any local tool that binds the ports. Its options page says so, and localhost pages only get your Spotify login if you also turn on **Also let localhost pages use my Spotify login**, which only the dev build shows. Keep that off, or use a separate browser profile for development. The dev build goes to `dist/dev/` and its zips end in `-dev`, apart from the release zips in `dist/`; never publish it. DNR matches the page that starts a request by host name only, not port, so each localhost origin gets its own static ruleset. When an FXM page opens on one of them, the background enables that origin's ruleset and disables the other, and the content script holds back its replies, the pong included, until the switch is done. So requests the app sends after the pong get the rules; requests sent earlier may not. If both are open at once, the most recently loaded one gets the CORS rules.

**Tests.** Unit tests (Vitest, offline) cover the rule generation, both manifests, message validation, the bridge, the rate limit, the icons and the zips. The end-to-end test loads `dist/chromium` into Playwright's Chromium in the new headless mode. A local HTTPS mock on port 5240 (`FXM_CONNECT_E2E_PORT` to change it) reproduces the measured behaviour of every host the rules cover: the three InnerTube hosts, googlevideo (including redirects), `open.spotify.com`, `clienttoken`, pathfinder, `spclient` and Last.fm. Chromium's `--host-resolver-rules` points the real host names, `fxm-music.pages.dev` included, at it, so the DNR rules apply as they do online and nothing reaches the network. The test builds the extension first, installs Chromium into `.tools/playwright` on the first run, and needs `openssl` for the throwaway certificate. `make test` does not run it.

**Keep the FXM host permissions exact.** DNR's `initiatorDomains` also matches sub-domains, so `fxm-music.pages.dev` alone would cover every preview deployment. Browsers only modify headers for a request when the extension has host access to the page that started it as well (verified in Chromium by the e2e test, and documented on MDN for Firefox), and FXM Connect only asks for `https://fxm-music.pages.dev/*`. Adding a pattern such as `https://*.fxm-music.pages.dev/*` would quietly widen every rule to all sub-domains; a unit test refuses it.

**Layout.**

| Path | What |
|---|---|
| `src/config.ts` | FXM origins (the single list), names and the toggle's storage key |
| `src/rules.ts` | Typed CORS rule specs and the ruleset generator |
| `src/manifest.ts` | Chromium and Firefox manifests |
| `src/content-script.ts`, `src/content.ts` | Presence handshake and bridge relay |
| `src/bridge.ts`, `src/background.ts` | Background: Spotify bridge, login status, rate limit, dev ruleset switching |
| `src/settings.ts` | The Spotify toggle in IndexedDB, in the extension's own origin |
| `src/messages.ts` | Message protocol and validation |
| `src/options/` | Options page |
| `scripts/build.ts` | Build: Vite bundles, manifests, rulesets, icons (the FXM mark, rendered at build time) and zips |
| `e2e/` | Playwright end-to-end test and the HTTPS mock |

Signing and store listings (Chrome Web Store, AMO) come in a later stage.
