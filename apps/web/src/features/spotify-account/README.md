# Spotify account (stage 3.5)

**Settings → Spotify account** connects the user's own Spotify account, through the browser's Spotify login and FXM Connect's opt-in session bridge, and keeps a **read-only** copy of it in the library: the account's liked songs, its playlists, and its personal home for Home's Spotify sections. FXM never writes to Spotify. The Spotify provider's logged-in calls are [`@fxm/sources/spotify`](../../../../../packages/sources/src/spotify/README.md); this folder is the app around them.

The Android app logs in through a window of its own instead ([below](#the-android-app-stage-65), stage 6.5). The desktop app gets its login with stage 7.4; until then its Settings say so.

## What the user gets

- **Opt-in, off by default.** "Connect your account" opens a notice first, which says what FXM reads and keeps, that the token stays in memory, and plainly that **Spotify's User Guidelines forbid accessing Spotify by automated means, with suspension or termination as the remedy**, and that no case is known of an account actioned for this kind of read-only use. Nothing is loaded or sent before the user accepts it; Cancel is focused.
- **FXM Connect's login switch.** The bridge stays off until the user turns on "Use my Spotify login from this browser" in FXM Connect's options (in Firefox, Firefox also asks to share authentication information). Until then the section says how, and **Try again** detects FXM Connect again (it doesn't announce option changes) and checks the login.
- **Status** in words: connected as whom; checking; no Spotify login in this browser (with a link to open.spotify.com, and a note that the browser may keep Spotify's cookies from FXM Connect); a private window or container tab, where FXM Connect never uses the login; Spotify switched off or out of reach; the check failing (the network, FXM Connect answering too late). Then what the last sync did ("Last synced 5 minutes ago: Liked songs on Spotify (1,234 songs) and 12 playlists.") or what it is doing ("Syncing your playlists: 3 of 12…"), and why a sync failed: Spotify asked FXM to slow down, its web player's secret stopped working, it answered in a way this version doesn't understand, the network, or the library's storage.
- **Sync now**, and **Disconnect**: it forgets the token at once and stops syncing. The copies stay in the library as ordinary playlists, unless the user ticks "Also remove the synced playlists you haven't changed". The dialog reminds them that FXM Connect's own option can be turned off too.

## How the sync works (`sync.ts`)

- **Copies.** Each playlist in the account's library gets a library playlist of its own, and the liked songs one more, **Liked songs on Spotify** (FXM's own Liked songs stay the user's). New copies go to the end of the list of playlists, in Spotify's order, with Spotify's name, description and cover.
- **IDs from what they copy** (`ids.ts`): `local:playlist:spotify-<Spotify ID>` for a playlist, `local:playlist:spotify-liked-<account key>` for the liked songs. A copy that comes back from a backup, from another device through library sync (8.4), or from an account the browser was signed in to before, is **adopted**, never made twice.
- **One way, three ways** (`merge.ts`). Each sync brings in what changed on Spotify since the last sync, the **base**, and keeps what the user changed in the copy: their own order (a new song goes right after the song Spotify has before it, or first, as new likes do), songs they added or took out, a name they gave it. An adopted copy gets what Spotify has and it lacks; nothing is removed from it.
- **Recommendations.** Like an import's playlists (stage 3.6), the copies count toward the listening affinity as songs added when they were copied, so a new library has something to recommend from.
- **Never deletes a copy by itself.** A copy the user deleted stays deleted (and isn't read again); a playlist that leaves the account's library keeps its copy, which the sync stops following.
- **Little traffic.** A playlist whose `revisionId` didn't change isn't read again; liked songs whose newest page and count didn't change neither. Pages are a second apart. A sync reads at most 10,000 liked songs, 500 playlists and 10,000 tracks of a playlist (`SYNC_LIMITS`), and says when it stopped short. A typical sync after the first makes five requests or so.
- **Another account.** When the browser's login is another Spotify account than the copies follow, the sync stops following the old copies (they stay) and follows the new account's. Accounts are told apart by a hash of the user name (`accountKeyOf`); the user name itself is never stored.
- **The personal home** is read with the account's token only (`getAccountHome`, never the generic home) and kept in the library, so Home shows Spotify's sections at once and without a request: Home's view of the account (`forHome.sections`) serves the kept home while it is younger than half an hour, then reads it again, and falls back to one up to a week old when Spotify can't be reached.
- **Its state** lives in the library's settings (`spotify-account.*`, `state.ts`): which account the copies follow, and per copy the base, Spotify's revision, its name, and whether the user changed the copy since the sync last wrote it. Clearing or restoring the library takes it along. It never uses a `sync.` key, so it stays on the device, and every row is checked field by field when read, since backups bring rows back.
- Each copy's state is saved as soon as the copy is done, so a sync cut short (a closed tab, an error) keeps what it did and the next one goes on from there.

## When it runs (`runtime.ts`)

Right after Connect (in the background: Disconnect stays possible meanwhile), when the app opens and the last sync is older than six hours, every half hour while it stays open if one is due, and on Sync now. One tab at a time: a Web Lock (`fxm-spotify-account-sync`), and the other tabs see the result through the library. The choice is followed by every open tab: a Disconnect in one stops the account in all, a running sync included.

## Tokens

The Spotify provider keeps the account's token in memory only, and asks FXM Connect's bridge for it, about once an hour. Nothing here ever holds it: `localStorage` keeps only the opt-in (`fxm.spotify-account.v1`, `{ optedIn }`), the library keeps the copies and the state, and neither URLs nor logs carry a token. Disconnect makes the provider forget the token at once. The browser test checks storage, IndexedDB, the URL and the console for the token.

The Spotify TOTP secret, which every token request needs, comes from the community sources the provider names. In the deployed app it goes through the sandboxed `/sandbox/userhost.html` (stage 1.10), so no new host enters the app's policy; `make dev`, which doesn't serve that document and has no policy, fetches it directly (`secret-fetch.ts`, which the composition root uses for the app's provider too).

## The Android app (stage 6.5)

There is no browser login to borrow in the Android app: it keeps a Spotify login of its own, made in its own login window ([`apps/mobile/android/fxm-spotify`](../../../../mobile/android/fxm-spotify/README.md)), and the platform's login source has that window (`spotifyLoginWindowOf(platform.spotifySession)`, which `servicesFrom` passes on as `services.loginWindow`). The sync, its state and Home are the same as on the web; only the login differs:

- **Connect** shows a notice of its own: Spotify's own login page opens in a window of FXM's, FXM never sees the password, keeps the login Spotify gives that window encrypted on the phone and uses it only to ask for a token, which stays in memory; Google and Facebook don't allow signing in there. Then, with no login kept yet, the login window opens at once (`runtime.connect()` → `runtime.login()`), and once it closes the login is checked and the first sync starts.
- **The check asks the window first** (`loginState`), and so does Home's `status`: without a kept login the account is `logged-out` (Home: not connected) at once, without a request to Spotify or the secret's source. A kept login that Spotify no longer accepts (an anonymous token comes back) is `logged-out` too.
- **Log in to Spotify** takes the place of Try again while logged out: it opens the window again (one at a time), then checks and syncs at once, so the copies follow a login of another account right away. A window that can't open, or a login that can't be kept, says so ("FXM couldn't open its Spotify login window…"), and so does a window that doesn't open on this phone after all ("FXM can't open its Spotify login window on this phone").
- **A WebView without profiles** can't keep Spotify's cookies apart from the app's own WebView, so the window never opens there: the account is `unsupported`, and Settings asks to update Android System WebView, then Try again.
- **Disconnect logs out** too: the kept login and its key are deleted and the window's profile wiped (`loginWindow.logout()`). Disconnect goes on if that fails, and its result says whether a login is still kept (`loginKept`, from the logout's answer or, when it failed, from asking the window again): the message then says "Disconnected, but FXM couldn't delete its Spotify login on this phone" instead of "Disconnected and logged out…". The copies stay as on the web.
- **Log out of Spotify** while the account is off: the runtime's state says whether the app keeps a login (`loginKept`), and Settings offers to delete one a Disconnect couldn't (`runtime.logout()`), also after a restart. For that, Settings builds the runtime on Android even while the account is off; it only asks the window, a question to the app that sends nothing. Connect would use a kept login again.

The token, as on the web, stays in the provider's memory; the cookie never reaches the page at all. The checks on a phone are in [fxm-spotify's README](../../../../mobile/android/fxm-spotify/README.md#checks-on-a-device).

## Wiring (`start.ts`, `services.ts`)

`main.tsx` calls `startSpotifyAccount()`: it gives Home its view of the account and loads nothing unless the account is connected. The app has one Spotify provider, the composition root's (stage 2.9, `app/services/app-services.ts`): it is created with `isAccountEnabled: spotifyAccountOptedIn`, reads the secret through the platform's user-host document in a browser (`secret-fetch.ts`, shared with this folder), and serves search and the account alike. The runtime takes it with the root's `spotify()`; only where the root has none (it couldn't start) does `loadAppSpotifyAccountServices()` build a provider of its own over the app's platform (`getAppPlatform()`, stage 2.7). Another shell, or a test, can hand in services with `setAppSpotifyAccountServices`.

| Touch-point | Today | Later |
|---|---|---|
| Home's Spotify sections (3.3) | `appHomeServices` gets `spotifyAccount: spotifyAccountForHome` at start | Keep it when Home's services are wired in (`app/services/README.md`, the 3.3 row): Home asks `status`, then `sections` (stage 3.5's addition to its seam), and asks at all only once its `sources` follow the platform |
| Android login (6.5) | Done: the platform's login source is the app's login window, `services.loginWindow`; Connect and Log in open it, Disconnect logs out of it | — |
| Desktop login (7.4) | `capabilities.spotify` is `anonymous` there, and Settings says the app's own login comes later | Its login window gives the platform a `spotifySession`; if that source also offers a `SpotifyLoginWindow`, the Android flow above applies as it is, with the desktop's copy |
| Capabilities in Settings | The connection store of 2.7 (`useConnection`) | Unchanged |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/features/spotify-account   # unit tests, offline
scripts/run.sh pnpm --filter @fxm/web e2e:spotify-account              # the browser test (below)
```

- **Unit tests** (part of `make test`): the three-way merge and placement (`merge.test.ts`, 10,000 songs at once), the IDs and account keys, the state and kept home read back from damaged rows, the sync against the **real library** (fake IndexedDB) and a fake account (`sync.test.ts`: first sync, nothing changed, Spotify's changes with the user's kept, deep unlikes, items Spotify can't name, deleted copies, playlists leaving and coming back, adoption, another account, limits, a missing user name, a playlist vanishing mid-sync, failures and resuming, the home failing, cancelling, Disconnect with and without removal), the runtime (`runtime.test.ts`: off by default, Connect, FXM Connect's switch, no login, refusals told apart, a failed check, Spotify off or out of reach, scheduling, the Web Lock, failures, Disconnect during a sync and from another tab, Home's view), the Android app's login window (`login-window.test.ts`: the window asked first, by the check and by Home, Connect opening it, a login kept while the account is off, closed without a login, one window for two taps, a window that fails, no profiles, a kept login Spotify refuses, Disconnect logging out, a logout that fails and the later Log out, logging out while connected), the services' wiring of the platform's login window (`services.test.ts`), the Settings section in the rendered app (`spotify-account-settings.test.tsx`, and `spotify-account-settings-android.test.tsx` for the Android app's notice, Log in, failures, a window that can't open, no profiles, Disconnect, a Disconnect that couldn't log out and Log out of Spotify while the account is off), the secret's `fetch` and the stored choice.
- **The browser test** (`apps/web/e2e/spotify-account/`, Playwright, not part of `make check`): `make dist`'s production layout under its `_headers`, served as Cloudflare Pages serves it, on `https://fxmusic.pages.dev`, with the **development build of FXM Connect** loaded into Chromium, and a made-up Spotify, all on one local HTTPS server on port 6600 (`FXM_SPOTIFY_E2E_PORT`; strict). Chromium's host rules send every real host name there, so FXM Connect's rules and bridge work as online, and nothing else resolves. It connects through the notice, FXM Connect's options and Try again, checks that the token request went through the bridge with the session cookie and nothing else the page sent to Spotify carried one, that the sync only read (with the account's token), the copies in the library (a private playlist's too), Sync now after changes on Spotify, Disconnect, and that no token reached storage, IndexedDB, the URL or the console. It runs that with **third-party cookies allowed**, then the login with Chrome's **"Block third-party cookies"** (checking first that the page's own third-party cookies are blocked), with the session cookie `SameSite=None` and `SameSite=Lax`, and once without a login. `FXM_E2E_DEBUG=1` prints the timeline of a connect.

  **Result, 2026-10-26** (Chromium 156.0.8078.4, Playwright 1.64.0, macOS): all four pass, in two consecutive full runs without a retry. With third-party cookies blocked, FXM Connect's request still carries the session, whatever its `SameSite`: Chromium doesn't count an extension's request to a host it has permission for as a third-party one. In earlier runs on the same machine, at a load average near 58, the bridge's answer took about 2 s to come back through FXM Connect, and twice longer than the check waited: the section reports that as a failed check with Try again, and the test then tries again, as a user would (at most twice, and it logs each retry).

## Manual test with a real account (owner)

The plan's "done when": a manual live test in **Chrome and Firefox**, with **third-party cookies allowed and blocked**. FXM has no Spotify account of its own, so the logged-in calls (`fetchLibraryTracks`, `libraryV3`, `fetchPlaylist` with the account, `profileAttributes`, the personal `home`) are confirmed only against the shapes of Spotify's own web player so far. This test confirms them live. It reads only: nothing changes in the Spotify account.

**Prepare (once).**

1. From this repository: `make setup`, then `FXM_EXTENSION_DEV=1 make extension`. The development build of FXM Connect is in `apps/extension/dist/dev/chromium` and `apps/extension/dist/dev/firefox`; it also serves `http://localhost:5173`, the dev server.
2. Run `make dev` and keep it running. FXM is at `http://localhost:5173/app/`.
3. Use a **separate browser profile** for the test in each browser (Chrome: profile menu → Add → Continue without an account; Firefox: `about:profiles` → Create a New Profile), as FXM Connect's README advises for its development build.

**Chrome** (record the version from `chrome://version`).

1. In the test profile, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked** and pick `apps/extension/dist/dev/chromium`.
2. Open `https://open.spotify.com` and sign in to the Spotify account.
3. Open FXM Connect's options (its toolbar button, or **Details → Extension options**): turn on **Use my Spotify login from this browser**, then **Also let localhost pages use my Spotify login**.
4. **Third-party cookies allowed:** in `chrome://settings/cookies`, choose **Allow third-party cookies**.
5. Open `http://localhost:5173/app/settings`. Under **Sources**, Spotify is **On**. Under **Spotify account**, select **Connect your account**, read the notice, select **Connect**.
6. Expect **Connected as** with the account's display name, then **Last synced just now: Liked songs on Spotify (N songs) and M playlists.** Check N against the account's liked songs and M against the playlists in its library (Spotify counts folders and podcasts separately; FXM copies playlists only).
7. Open **Library → Playlists**: **Liked songs on Spotify** (newest first), and a copy of each playlist, a private one and a "Made for you" one (if saved) included. Open one and compare it with Spotify.
8. In Spotify (another tab), like a song and add a song to one of the playlists. In FXM, **Settings → Spotify account → Sync now**. Expect the new like at the top of the copy, and the new song in the playlist's copy.
9. Open DevTools: **Application → Local storage** holds `fxm.spotify-account.v1` with only `optedIn`; **Application → IndexedDB** and **Console** show no access token (Spotify's tokens are long strings that start with `B`); the address bar holds none.
10. **Third-party cookies blocked:** in `chrome://settings/cookies`, choose **Block third-party cookies**, reload FXM, and select **Sync now** (or Disconnect, then Connect again). Expect it still connected and syncing.
11. **Disconnect** (leave the box unticked): expect **Disconnected. Your library keeps what FXM synced.** The copies stay in the library. Reload: the section offers **Connect your account** again.

**Firefox** (record the version from `about:support`).

1. In the test profile, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on…** and pick `apps/extension/dist/dev/firefox/manifest.json`. In `about:addons` → FXM Connect → **Permissions**, allow access to the listed sites.
2. Sign in at `https://open.spotify.com`.
3. In FXM Connect's options, turn on **Use my Spotify login from this browser** (Firefox asks to share authentication information: allow it), then **Also let localhost pages use my Spotify login**.
4. **Third-party cookies allowed:** Settings → Privacy & Security → Enhanced Tracking Protection → **Custom**, untick **Cookies**. Do steps 5 to 9 of Chrome, with Firefox's DevTools (**Storage** tab).
5. **Third-party cookies blocked:** the same Custom setting with **Cookies: All cross-site cookies**, then reload FXM and **Sync now**. Also try **Standard** (Total Cookie Protection, Firefox's default).
6. **Disconnect**, as in Chrome.

**If a step fails,** note the step and what Settings says. In DevTools → Network, filter `pathfinder` and keep the failing request's response (it holds the account's playlists, not a token; leave out the `Authorization` header). `Spotify answered in a way this version of FXM doesn't understand` means a logged-in call's shape differs from the web player's: the response says how.

**Results** (fill in):

| Browser and version | Third-party cookies | Connected | Counts match | Sync now picks up changes | Token only in memory | Disconnect | Date, notes |
|---|---|---|---|---|---|---|---|
| Chrome | Allowed | | | | | | |
| Chrome | Blocked | | | | | | |
| Firefox | Allowed (Custom, no cookie blocking) | | | | | | |
| Firefox | Blocked (all cross-site cookies) | | | | | | |
| Firefox | Standard (Total Cookie Protection) | | | | | | |

Once it passes, the provider's library calls can lose their `@experimental` marks (`packages/sources/src/spotify/provider.ts`) and the clean-room log can note the live confirmation.

## Files

| File | What |
|---|---|
| `spotify-account-settings.tsx` | Settings → Spotify account: the status, the notice, Sync now, Disconnect |
| `context.tsx` | How the section reaches the choice, the runtime and the library (tests pass their own) |
| `account-store.ts` | The opt-in, in `localStorage`, followed across tabs |
| `runtime.ts` | The login check, when to sync, the Web Lock, Disconnect, Home's view |
| `sync.ts` | The sync, and forgetting it on Disconnect |
| `merge.ts` | The three-way merge of a copy |
| `state.ts`, `home.ts` | The sync's state and the kept home in the library, read back field by field |
| `ids.ts` | The copies' IDs, the settings keys, the account key |
| `services.ts`, `start.ts` | The seam to the provider, the platform and the library; start-up and Home's view |
| `secret-fetch.ts` | How the web app reads Spotify's TOTP secret: the sandboxed user-host document, or directly in `make dev` |
| `testing.ts` | A fake account, fake services and Web Locks |
