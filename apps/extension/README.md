# FXM Connect

FXM Connect is the optional companion browser extension of the FXM web app (`https://fxmusic.pages.dev/app/`). It only lets the FXM web app reach music services from your own browser.

## Why it exists

FXM hosts nothing: no server, no gateway, no proxy. The web app is a static site, so everything happens in your browser. Browsers, however, stop a web page from reading responses from other sites unless those sites allow it with CORS headers, and the music services FXM uses do not:

- YouTube's InnerTube API (`www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com`) answers any foreign `Origin` with HTTP 403 and no CORS headers.
- googlevideo media servers send the audio to anyone, so a plain `<audio src>` plays. They only send `Access-Control-Allow-Origin` to YouTube origins, though, and `fetch()`, downloads and MediaSource need it.
- Spotify's `open.spotify.com/api/token` and `/api/server-time` send no CORS headers. Last.fm's station JSON doesn't either.

FXM Connect fixes this with a fixed list of declarativeNetRequest (DNR) rules that rewrite a few request and response headers, only for requests the FXM pages make, only to these services. All YouTube and Spotify logic stays in the web app, so when YouTube changes something, FXM is fixed by redeploying the static site. The extension needs no update for that. Its only Spotify-specific code is the bridge (below): an always-on, cookie-free server-time relay and the optional login token.

## What it does

1. **Header rules.** These are static rules generated from [`src/rules.ts`](src/rules.ts). Every rule only applies to requests started by an FXM page (`initiatorDomains`). Each response gets `Access-Control-Allow-Origin` set to the exact FXM origin, never `*`. Preview deployments on sub-domains such as `<hash>.fxmusic.pages.dev` are not FXM pages: the content script doesn't run there, and the rules leave their requests alone.

   | Service | Request change | Response change |
   |---|---|---|
   | `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com` | `Origin` and `Referer` set to `https://www.youtube.com` (`https://music.youtube.com` for YouTube Music). Preflights (`OPTIONS`) get the other YouTube origin, the one InnerTube accepts them from | ACAO, `Access-Control-Allow-Methods`, `-Allow-Headers` (InnerTube headers), `-Expose-Headers: content-length`, `-Max-Age: 600` |
   | `*.googlevideo.com` | `Origin` set to `https://www.youtube.com` on preflights (`OPTIONS`) only | ACAO, `Access-Control-Expose-Headers: content-length, content-range, accept-ranges, content-type` |
   | `open.spotify.com/api/token`, `/api/server-time` | `Origin` and `Referer` set to `https://open.spotify.com` | ACAO, allowed methods and Spotify headers, `-Max-Age: 600` |
   | `api-partner.spotify.com`, `spclient.wg.spotify.com` | none | ACAO, allowed methods and Spotify headers, `-Max-Age: 600` |
   | `www.last.fm/player/station/*` | none | ACAO |

   On top of that, every rule removes the `Cookie` request header and the `Set-Cookie` and `Access-Control-Allow-Credentials` response headers. The FXM page therefore never sends or changes your cookies for these services, and these rules never make it act as your logged-in account: only the optional Spotify login (item 3) does that, after you turn it on. No rule sets `Access-Control-Allow-Credentials`.

2. **Presence handshake.** A content script on the FXM pages runs at `document_start`. It sets `data-fxm-connect="<version>"` on `<html>` and answers a ping (see [For the web app](#for-the-web-app)).

3. **Spotify bridge.** The background makes two requests for the FXM page, both to open.spotify.com, and returns only the HTTP status and the JSON body. Together they are limited to about ten a minute. Everything else is rejected.

   - **Server time, always on.** `GET https://open.spotify.com/api/server-time`, without credentials, whenever an FXM page asks: Spotify's web-player tokens need Spotify's clock. It needs no setting, also serves private windows and isn't tied to any account.
   - **Your Spotify login (optional, off by default).** Cross-site cookies are not sent on the page's own requests, so only the extension can get a token for your Spotify login. If you turn on **Use my Spotify login from this browser** on the options page, the FXM page can ask FXM Connect for one. The background then makes one request: `GET https://open.spotify.com/api/token`. It forwards only the query parameters `reason`, `productType`, `totp`, `totpServer` and `totpVer`, each validated, and sends your browser's existing open.spotify.com cookies (`credentials: 'include'`).

   In Firefox, turning the login on also asks for Firefox's consent to share authentication information. The Firefox manifest declares `authenticationInfo` as optional data collection, the options page requests it with `permissions.request()`, and the background serves tokens only while Firefox reports it as granted ([`src/consent.ts`](src/consent.ts)). Withdrawing the consent in `about:addons` turns the login off, and turning the login off gives the consent back. Firefox's prompt says "Share authentication information with extension developer": here the developer's code that gets the token is the FXM web app in the same browser, and no server receives it, as the options page explains.

   The token request always carries the cookies of the browser's normal windows, because one background serves every tab. So it is refused for pages in private (incognito) windows and Firefox container tabs, where you may be signed in to another Spotify account or none.

   The toggle lives in IndexedDB in the extension's own origin, which only the options page and the background can open. It is deliberately not in `storage.local`: content scripts can write that, so code running in a compromised FXM page renderer could switch your Spotify login on by itself. The content script can't even read the toggle; it asks the background whether to announce the `spotify-login` feature.

The options page (click the toolbar button, or open the extension's options) shows the version, the allowed FXM pages, the Spotify toggle and a link to FXM.

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Applies the static header rules in `rules.json`. FXM Connect has no `webRequest`, so it can't see or change any traffic beyond what those rules describe. |
| `storage` | Keeps the bridge's rate-limit counter in `storage.session` (in memory, cleared when the browser closes). The Spotify toggle is in the extension's IndexedDB instead, out of content scripts' reach. |
| `https://fxmusic.pages.dev/*` | Runs the presence content script there. Browsers also require host access to the page that starts a request before DNR may modify its headers. |
| `https://www.youtube.com/*`, `https://music.youtube.com/*`, `https://youtubei.googleapis.com/*` | YouTube and YouTube Music InnerTube API (search, browse, player data) |
| `https://*.googlevideo.com/*` | YouTube media bytes |
| `https://open.spotify.com/*` | Spotify web token and server time (the rules only touch `/api/token` and `/api/server-time`) |
| `https://api-partner.spotify.com/*`, `https://spclient.wg.spotify.com/*` | Spotify's GraphQL (pathfinder) and spclient APIs |
| `https://www.last.fm/*` | Keyless Last.fm recommendation stations (the rule only touches `/player/station/`) |

There is no `<all_urls>`, no `cookies`, `tabs`, `scripting` or `webRequest` permission, and no `externally_connectable`.

## Privacy

- **Nothing goes to FXM.** FXM Connect has no analytics, no telemetry and no servers. It stores one setting (in its own IndexedDB) and a rate-limit counter (in `storage.session`) in your browser. If the browser clears the extension's site data, the setting returns to off.
- **One piece of personal data, only if you opt in.** With the Spotify login on, FXM Connect passes the token of your Spotify login to the FXM page in the same browser, which uses it only for its requests to Spotify. That is the only personal data it handles, so the Firefox manifest declares `data_collection_permissions: { required: ["none"], optional: ["authenticationInfo"] }` and the Edge listing declares authentication information.
- **No cookies read.** FXM Connect has no `cookies` permission and never reads, stores or forwards cookies. Its rules strip cookies from the FXM page's requests to these services. The one exception is the opt-in Spotify bridge. There the browser itself attaches your open.spotify.com cookies to the single token request, exactly as it does on open.spotify.com, and FXM Connect hands the page only the token response.
- **No remote code.** Everything that runs ships inside the extension, as readable, unminified files built from this folder. There is no `eval` and no downloaded script. A strict content security policy (`default-src 'none'`) limits the options page and the background to their own scripts, styles and images, and lets them connect to `https://open.spotify.com` only, so the browser itself stops FXM Connect from contacting any other server.
- **Only FXM pages.** The content script and the bridge check the exact origin and that a message comes from the page itself. Other sites get nothing, and the rules ignore requests they start.

## Install

Each GitHub release carries FXM Connect in these files:

| File | For |
|---|---|
| `fxm-connect-firefox-<version>.xpi` | Firefox 140 or later and Firefox for Android 142 or later. Signed by Mozilla, so it stays installed. Releases have it while AMO signing runs in the unlisted channel ([Store channels](#store-channels)) |
| `fxm-connect-chromium-<version>.zip` | Chrome, Edge, Brave and other Chromium browsers, version 120 or later, loaded unpacked |
| `fxm-connect-firefox-<version>.zip` | Unsigned: for review, or for a temporary install in Firefox, which removes it when it restarts. A release's `.xpi` has the same files |

Each of them also holds the repository's `LICENSE` (Apache-2.0) and FXM Connect's [`NOTICE`](NOTICE), which says that it bundles no third-party code.

FXM Connect is not in the Chrome Web Store and isn't submitted there by default: its policy bans extensions that facilitate unauthorized streaming or downloading, and names YouTube downloads as a common reason for rejection. Its store channels are Firefox Add-ons and Edge Add-ons; [Store channels](#store-channels) has their status.

**Firefox (version 140 or later)**

1. Download `fxm-connect-firefox-<version>.xpi` from the release.
2. In Firefox, open `about:addons`, click the gear button, choose **Install Add-on From File…** and pick the file. Dropping the file onto a Firefox window works too.
3. Firefox lists the sites FXM Connect may access. Click **Add**.
4. Open or reload `https://fxmusic.pages.dev/app/`.

Firefox doesn't update an add-on installed from a file by itself while no listed version exists: until FXM Connect is listed on Firefox Add-ons, install each new release's `.xpi` the same way. Your settings stay. Once a listed version is out, Firefox finds it on addons.mozilla.org by the add-on's ID and updates copies installed from a file too (Mozilla, "Distributing an add-on yourself", checked 2026-10-26). The listed channel is therefore how FXM Connect gets automatic updates, security fixes included. Until then, the web app's prompt for an outdated FXM Connect (stage 2.7) is the reminder to update.

**Firefox for Android (version 142 or later)**

1. Download `fxm-connect-firefox-<version>.xpi` on the phone.
2. In Firefox, open **Settings → About Firefox** and tap the Firefox logo five times. This shows **Install extension from file** in Settings.
3. Back in **Settings**, tap **Install extension from file**, pick the file and tap **Add**.
4. Open or reload `https://fxmusic.pages.dev/app/`.

These are Mozilla's steps for self-distributed add-ons. FXM Connect hasn't been tried on a phone yet (2026-10-26). Once it is listed on Firefox Add-ons, Android users can install it from there.

**Firefox, from a release without an `.xpi`**

Releases have no `.xpi` before AMO signing is set up, and none once FXM Connect is listed on Firefox Add-ons: then install it from addons.mozilla.org instead. Otherwise, a temporary install works:

1. Download `fxm-connect-firefox-<version>.zip`.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick the zip.
3. Open or reload `https://fxmusic.pages.dev/app/`.

Firefox removes temporary add-ons when it restarts, so repeat step 2 after a restart. If FXM does not detect the extension, open `about:addons` → FXM Connect → **Permissions** and allow access to the listed sites.

**Chrome, Edge, Brave and other Chromium browsers (version 120 or later)**

1. Download `fxm-connect-chromium-<version>.zip` and unzip it into a folder you keep. The browser loads the extension from there.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
4. Open or reload `https://fxmusic.pages.dev/app/`.

Keep Developer mode on: Chrome 134 and later turn unpacked extensions off while it is off. To update, unzip the new release over the same folder and click the reload button on the extension's card. Browsers managed by an organization may block unpacked extensions. Once FXM Connect is on Edge Add-ons, Edge users can install it from there instead.

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
| `spotify-login` | The user turned on **Use my Spotify login from this browser** (in Firefox: and consented) and the tab is a normal one, so token requests are served |

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
- **Spotify:** the token and server-time endpoints, pathfinder and spclient accept preflights, so these headers work: `authorization`, `content-type`, `client-token`, `app-platform`, `spotify-app-version`, `accept`. For a token of the user's own login, use the bridge.
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
| `login-disabled` | The Spotify toggle is off (for localhost pages of the dev build: or its localhost toggle is), or in Firefox the user withdrew the consent to share authentication information |
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
scripts/run.sh pnpm --filter @fxm/extension lint:firefox   # AMO's linter on dist/firefox
```

`make build` (and so `make check`) builds the release variant too. Load `dist/chromium` with **Load unpacked**, or `dist/firefox/manifest.json` with **Load Temporary Add-on**.

**Dev build.** It also allows `http://localhost:5173` (the Vite dev server) and `http://localhost:4173` (`vite preview`) as FXM origins. It goes to `dist/dev/`, apart from the release files in `dist/`, and its zips end in `-dev`. Never publish it.

Those are Vite's default ports, so the dev build treats any app served there as FXM: other projects, their dependencies and any local tool that binds the ports. Its options page warns about this. Localhost pages only get your Spotify login if you also turn on **Also let localhost pages use my Spotify login**, which only the dev build shows. Keep that off, or use a separate browser profile for development.

The dev build's own parts of the options page (its badge, that warning and the localhost toggle) are marked `data-dev` in `src/options/options.html`, and the release build leaves them out (`scripts/options-page.ts`), so its page names no localhost origin. `options.ts` looks them up only in the dev build.

DNR matches the page that starts a request by host name only, not port, so each localhost origin gets its own static ruleset. When an FXM page opens on one of them, the background enables that origin's ruleset and disables the other, and the content script holds back its replies, the pong included, until the switch is done. So requests the app sends after the pong get the rules; requests sent earlier may not. If both are open at once, the most recently loaded one gets the CORS rules.

**Tests.** Unit tests (Vitest, offline) cover the rule generation, both manifests, message validation, the bridge, Firefox's consent, the settings store, the rate limit, the icons and the zips, and they make a release build in a temporary folder to check its zips: `LICENSE` and `NOTICE` in both, scripts bundled from `src/` alone, and an options page without the dev build's parts. The end-to-end test loads `dist/chromium` into Playwright's Chromium in the new headless mode. A local HTTPS mock on port 5240 (`FXM_CONNECT_E2E_PORT` to change it) reproduces the measured behaviour of every host the rules cover: the three InnerTube hosts, googlevideo (including redirects), `open.spotify.com`, pathfinder, `spclient` and Last.fm, plus `clienttoken`, which no rule touches. Chromium's `--host-resolver-rules` points the real host names, `fxmusic.pages.dev` included, at it, so the DNR rules apply as they do online and nothing reaches the network. The test builds the extension first, installs Chromium into `.tools/playwright` on the first run, and needs `openssl` for the throwaway certificate. `make test` does not run it.

**Keep the FXM host permissions exact.** DNR's `initiatorDomains` also matches sub-domains, so `fxmusic.pages.dev` alone would cover every preview deployment. Browsers only modify headers for a request when the extension has host access to the page that started it as well (the e2e test checks this in Chromium; MDN documents it for Firefox, and a manual run in Firefox 158 confirmed it), and FXM Connect only asks for `https://fxmusic.pages.dev/*`. Adding a pattern such as `https://*.fxmusic.pages.dev/*` would quietly widen every rule to all sub-domains; a unit test refuses it.

**Layout.**

| Path | What |
|---|---|
| `src/config.ts` | FXM origins (the single list), names and the pong's features |
| `src/rules.ts` | Typed CORS rule specs and the ruleset generator |
| `src/manifest.ts` | Chromium and Firefox manifests |
| `src/content-script.ts`, `src/content.ts` | Presence handshake and bridge relay |
| `src/bridge.ts`, `src/background.ts` | Background: Spotify bridge, login status, rate limit, dev ruleset switching |
| `src/settings.ts` | The Spotify toggle in IndexedDB, in the extension's own origin |
| `src/consent.ts` | Firefox's consent for the Spotify login (optional data collection) |
| `src/messages.ts` | Message protocol and validation |
| `src/options/` | Options page |
| `scripts/build.ts` | Build: Vite bundles, manifests, rulesets, icons (the FXM mark, rendered at build time), the licence files and zips |
| `scripts/options-page.ts` | The options page each build ships: the release build drops the elements marked `data-dev` |
| `NOTICE` | The notice every build ships next to the repository's `LICENSE` |
| `e2e/` | Playwright end-to-end test and the HTTPS mock |
| `store/` | Store listings and the release workflow's store jobs ([Store channels](#store-channels)) |

## Store channels

FXM Connect reaches people through GitHub Releases, Firefox Add-ons (AMO) and Edge Add-ons. The release workflow (`.github/workflows/release.yml`) does the store work for every release. The owner sets up the accounts once, which includes publishing Edge's first version by hand; after that one-time setup, only the workflow submits FXM Connect. Both stores' accounts and API keys are free.

| Channel | How | Status (2026-10-26) |
|---|---|---|
| GitHub Releases | Every release attaches the two zips, and the signed `.xpi` while AMO signing runs in the unlisted channel | Every release |
| Firefox Add-ons, unlisted | Before the release is published, the **Signed Firefox add-on** job has AMO sign the release's Firefox zip for self-distribution, and the release attaches the `.xpi` | Ready, waiting for the owner's AMO API keys. Nothing signed yet |
| Firefox Add-ons, listed | With `AMO_CHANNEL` set to `listed`, the **Firefox Add-ons listing** job submits each published release to the public listing, with the listing texts, the notes for reviewers and the source code. Releases then attach no `.xpi`: Firefox users install and update FXM Connect from addons.mozilla.org | Not submitted yet |
| Edge Add-ons | The owner publishes the first version in Partner Center. From then on the **Edge Add-ons submission** job submits each published release | Not submitted yet. Edge's written rules match the Chrome Web Store's, but it enforces them less strictly; acceptance is unproven |
| Chrome Web Store | Not submitted by default ([Install](#install) says why). An attempt would cost USD 5 once | Not submitted, by decision |

Record each store's outcome in this table, with the date: accepted, rejected (and why) or removed.

### Protect the store keys

A store key lets whoever holds it publish versions of FXM Connect. Mozilla signs the versions uploaded with the AMO key, and a listed version reaches every Firefox user as an update. So the keys don't go into repository secrets, which a workflow run from any pushed branch can read. They go into a GitHub environment that only runs on `main` can use. Set it up once, before adding any key (owner):

1. On GitHub, open **Settings → Environments → New environment**, name it `stores` and click **Configure environment**.
2. Under **Deployment branches and tags**, choose **Selected branches and tags**, click **Add deployment branch or tag rule**, enter `main` (ref type: branch) and save.
3. Under **Required reviewers**, add yourself, and leave **Prevent self-review** off so that you can approve your own releases. Every release then waits for your approval before a store job starts, so a pull request merged into `main` by mistake, or by a tool, can't reach the keys on its own.
4. Keep `main` protected. The `Protect main` ruleset must require a pull request before merging and block force pushes, with nobody on its bypass list: anyone who can push to `main` directly can run any workflow on it.
5. Turn on two-step authentication for both store accounts. AMO requires it for its Developer Hub; keep the recovery codes safe, because Mozilla can't restore a locked account. For the Microsoft account, turn on two-step verification at https://account.microsoft.com/security.

The store jobs name the environment, so a release run creates an empty `stores` environment if it doesn't exist yet. An environment without the branch rule lets every branch read its secrets, so do steps 1 to 3 before adding a key.

Anyone with admin rights on the repository can change the environment and the ruleset, so keep those rights to yourself. Scripts and agents that push branches and open pull requests for you need a token without admin rights: a fine-grained token with write access to Contents, Pull requests and Workflows, and no Administration or Deployments access, can neither loosen these rules nor approve a store job.

**If a key leaks,** replace it at once and set the new one in the `stores` environment:

- **AMO:** open https://addons.mozilla.org/developers/addon/api/key/ and click **Revoke and regenerate credentials**. Then check the add-on's versions in the Developer Hub and disable any version you didn't submit.
- **Edge:** in Partner Center, open **Microsoft Edge → Publish API** and click **Create API credentials** for a new key, and remove the leaked one where the page offers it (a key also stops working at the expiry date the page shows). Then check the extension's submissions for any you didn't make.

### Firefox Add-ons

**Set up signing (owner, once).** After [Protect the store keys](#protect-the-store-keys):

1. Sign in at https://addons.mozilla.org/developers/ with a Mozilla account, creating one if needed, and accept the Firefox Add-on Distribution Agreement. If AMO asks for a display name for your developer profile, set one.
2. Open https://addons.mozilla.org/developers/addon/api/key/ and click **Generate new credentials**. AMO shows a **JWT issuer** (such as `user:12345678:123`) and a **JWT secret**. It shows the secret only once.
3. Add them as secrets of the `stores` environment, never as repository secrets: on GitHub, **Settings → Environments → stores → Add environment secret**, or from the repository folder:

   ```sh
   scripts/run.sh gh secret set AMO_API_KEY --env stores      # paste the JWT issuer
   scripts/run.sh gh secret set AMO_API_SECRET --env stores   # paste the JWT secret
   ```

4. That is all for unlisted signing. The next release's **Signed Firefox add-on** job signs FXM Connect, and the release attaches `fxm-connect-firefox-<version>.xpi`. The first signing creates the add-on in your AMO account, unlisted, so it has no public page. Its ID is `fxm-connect@fxmusic.pages.dev`: never change it, because Firefox treats an add-on with another ID as a different add-on.
5. Install the signed file in Firefox ([Install](#install)) and check that the web app finds FXM Connect. Then record the outcome above, and update the site:
   - turn on `AVAILABLE.firefox` in `apps/site/src/config.ts`. The copy it switches is written: the Firefox install steps and notes in `GetFxm.astro`, the FAQ's browser and phone answers, and on the privacy page the install sentence and a sentence saying that Firefox checks addons.mozilla.org for updates;
   - change the `updated` date of the privacy page (`apps/site/src/pages/privacy.astro`), whose FXM Connect section changes with the flag;
   - the site still suggests no card to Android visitors (`apps/site/src/lib/platform.ts`, whose comment says that FXM Connect can't be added to a phone's browser). Once FXM Connect works on Firefox for Android (step 1 of the listed submission below), make it suggest the web card to Firefox on Android and update that comment.

**What the jobs do.** The bundles job runs AMO's linter (`web-ext lint`, the same linter AMO runs on every upload) on the release's Firefox zip, with no store key around, and passes on whether it found anything. The **Signed Firefox add-on** job then works only with `AMO_CHANNEL` unlisted (the default), both keys set and a clean lint; a lint finding fails it, and with it the release. It uploads the zip exactly as the release attaches it, creates the version with the version's metadata from `store/listing.ts` and attaches the source code for AMO's reviewers (`git archive` of the release commit, since the scripts are built with Vite). Then it waits up to 20 minutes for the signature: AMO signs unlisted versions automatically, usually within minutes. Finally it checks that the signed file holds the zip's files and Mozilla's signature, and nothing else, and passes it to the publish job, which checksums and attests it with the other files.

The jobs that hold the keys install nothing. They run Node and the store scripts of the release commit (`store/firefox.ts` and `store/amo.ts`), which call AMO's API with Node's own `fetch` and `crypto`: the same calls `web-ext sign` makes. So no third-party code ever sees the keys. Their plan steps learn only whether each key is set; only the step that submits gets the values.

**Re-runs and failures.** AMO accepts each version number once, in either channel, and never again, even after the version is deleted. So the jobs first ask AMO for the version. On a re-run they carry on with the version AMO has (waiting for it, fetching it, or attaching the source code a failed run left out) instead of submitting it again. If AMO hasn't signed an unlisted version after 20 minutes, the job fails and the release waits for it: re-run the failed jobs later. To release without the signed add-on, set the repository variable `AMO_CHANNEL` to `off` and re-run. An unlisted version signed for a release that then failed stays in AMO, but reaches nobody: it has no public page and no update path.

**The listed submission.** Move to it soon after unlisted signing works, because copies installed from the `.xpi` get updates only from a listed version ([Install](#install)):

1. Install the signed `.xpi` on Firefox for Android ([Install](#install)) and check that the web app detects FXM Connect. The manifest's `gecko_android` key declares Firefox for Android support, so the listing will offer FXM Connect there. If it doesn't work, remove `gecko_android` from `src/manifest.ts` before the listed submission and note why here.
2. Read the listing texts: `store/listing/summary.txt`, `store/listing/description.md` and `store/listing/reviewer-notes.txt`, and the categories, license and links in `store/listing.ts`. Every listed version sends them, so AMO's listing follows this folder.
3. Set the repository variable `AMO_CHANNEL` to `listed`: **Settings → Secrets and variables → Actions → Variables → New repository variable**, or `scripts/run.sh gh variable set AMO_CHANNEL --body listed`. The next release's version number must be new to AMO: a version already signed unlisted can't be listed.
4. Once the next release is published, the **Firefox Add-ons listing** job submits its version to the listing. AMO checks it automatically and may approve it within minutes; a reviewer may look at it later, or before approving it. The job doesn't wait for that. Firefox users get the version from AMO once it is approved, and from then on releases attach no `.xpi`.
5. In AMO's Developer Hub, check the listing and add screenshots if you like. Optionally add a short privacy policy (AMO hosts it as Markdown text) that links to https://fxmusic.pages.dev/privacy#fxm-connect.
6. Record the outcome above. If AMO rejects the version, its email says why: fix it in a new version, or set `AMO_CHANNEL` back to `unlisted`.
7. Once AMO has approved a listed version, update the site: the Firefox install steps in `GetFxm.astro` (install from addons.mozilla.org instead of the `.xpi`) and its note that FXM Connect doesn't update itself, the FAQ's browser answer, and on the privacy page the install sentence and the hosting paragraph (Firefox gets FXM Connect and its updates from addons.mozilla.org, under Mozilla's privacy policy). Then change the privacy page's `updated` date.

**Data collection.** The Firefox manifest declares `data_collection_permissions: { required: ["none"], optional: ["authenticationInfo"] }`. FXM Connect sends nothing to its developer, but the opt-in Spotify login hands the token of the user's Spotify login to the FXM page, and Mozilla's policies count data handled outside the add-on. So Firefox asks for consent when the user turns the login on ([What it does](#what-it-does)), and AMO's listing shows authentication information as optional data collection.

**Source code for reviewers.** The archive is the whole repository at the release commit, and `store/listing/reviewer-notes.txt` says how to rebuild the extension from it: `scripts/setup.sh --frozen-lockfile --filter @fxm/extension`, then `scripts/run.sh pnpm --filter @fxm/extension build`, with Node.js 22. A clean copy of the repository rebuilt `dist/firefox` byte for byte this way on 2026-10-26.

### Edge Add-ons

**Set up (owner, once).** After [Protect the store keys](#protect-the-store-keys):

1. Register as a Microsoft Edge extension developer in Partner Center (https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd) with a Microsoft account.
2. Click **Create new extension** and upload `fxm-connect-chromium-<version>.zip` from the latest release.
3. Fill in **Availability** (public, all markets), **Properties**, **Privacy** and the **Store listing** with the texts this prints, and upload the logo it draws. In **Privacy**, declare authentication information as the printed text says: the opt-in Spotify login hands a login token to the FXM page.

   ```sh
   scripts/run.sh pnpm --filter @fxm/extension --silent store:listing edge <version>
   scripts/run.sh pnpm --filter @fxm/extension --silent store:listing logo fxm-logo.png   # 300 x 300
   ```

4. Click **Publish** and paste the notes for certification from the same text. Certification takes up to seven business days. Record the outcome above. If Edge accepts FXM Connect, update the site: the Edge install steps in `GetFxm.astro` (install from Edge Add-ons instead of the zip), the FAQ's browser answer, and on the privacy page the install sentence and the hosting paragraph (Edge gets FXM Connect from Microsoft's store). Then change the privacy page's `updated` date.
5. For the release workflow's updates: in Partner Center, open **Publish API**, click **Enable** next to "enable the new experience", then **Create API credentials**. Add three secrets to the `stores` environment (**Settings → Environments → stores → Add environment secret**, or `scripts/run.sh gh secret set <name> --env stores`): `EDGE_PRODUCT_ID` (the **Product ID** on the extension's overview page), `EDGE_CLIENT_ID` (the **Client ID**) and `EDGE_API_KEY` (the **API key**). The Publish API page shows when the key expires: create a new one and update `EDGE_API_KEY` before then.

**What the job does.** After the release is published, the **Edge Add-ons submission** job uploads the release's Chromium zip as the draft's package and submits the draft for certification, with the notes for testers. Like the Firefox jobs, it installs nothing and runs only Node and the store scripts. It doesn't wait for the outcome. If Edge is still reviewing an earlier version, the new package waits in the draft and the job warns: publish it in Partner Center after that review, or let the next release submit it. Without the three secrets the job only says that they are missing.

### Store files

| Path | What |
|---|---|
| `store/listing/summary.txt` | AMO's summary: 250 characters at most, without links |
| `store/listing/description.md` | Both stores' description. AMO renders its Markdown; Edge gets plain text |
| `store/listing/reviewer-notes.txt` | Notes for AMO's reviewers and Edge's testers, including how to rebuild from source |
| `store/listing.ts` | AMO's categories, license and links, Edge's properties, privacy answers and permission justifications; prints Edge's fields and draws the logo |
| `store/firefox.ts`, `store/amo.ts`, `store/xpi.ts` | The Firefox jobs: AMO's linter, the AMO settings, the calls to AMO's API (upload, version, source code, signature, download), re-runs and the check of the signed file |
| `store/edge.ts` | The Edge submission job (Edge Add-ons API v1.1) |
| `store/actions.ts` | The jobs' annotations, step outputs and job summary in GitHub Actions |

**Keep the listing current.** The texts say that the web app's home feed uses YouTube Music's and Spotify's radio and Last.fm's stations, and that song radio comes in a later FXM version. The web app's Spotify account connection (stage 3.5) shipped: the description and the notes say what it does with the login bridge, and the notes say how a reviewer can try it. When FXM ships song radio (stage 3.4), update `description.md`, `reviewer-notes.txt`, the login toggle's help on the options page (`src/options/options.html`) and the permission justifications in `store/listing.ts`.

The tests in `store/` keep the texts within the stores' limits and the trademark rules (services named in plain text, no lookalike names) and check them against the code: the login is off by default, the server time needs no setting, both share about ten requests a minute, and the manifest declares the data collection the texts describe. They also run the jobs against fake stores, offline, and run AMO's linter over a zip laid out like the release's Firefox zip. To try the Firefox jobs without contacting AMO, build the extension and run:

```sh
make extension
scripts/run.sh pnpm --filter @fxm/extension --silent store:firefox lint --zip apps/extension/dist/fxm-connect-firefox-<version>.zip
scripts/run.sh pnpm --filter @fxm/extension --silent store:firefox submit --channel unlisted --version <version> --zip apps/extension/dist/fxm-connect-firefox-<version>.zip --out dist/amo --dry-run
```
