# @fxm/web

The FXM web player: a React app served from `/app/`, installable as an app with its own window (a PWA, see [Installable app](#installable-app-pwa)), and the shell of the Android and desktop apps. Everything runs in the browser: there is no FXM backend.

Stage 2.1 built the **shell**: routing, layout, design system, settings and placeholder pages. Stage 2.5 added **playback**: the app's player, Now playing with its stream badge and version switcher, the queue panel and synced lyrics (see [Playback, Now playing, queue and lyrics](#playback-now-playing-queue-and-lyrics)). Stage 2.6 added the **library** (playlists in an order the user controls, likes, follows, history, backups) on IndexedDB. Stage 4.4 added **local files**: music on the device, read where it is, listed in the Library and in search and played through the player core. Stage 5.1 made it installable. Stage 8.7 added opt-in [SponsorBlock skipping](#sponsorblock-skipping-the-non-music-parts-of-videos) in Music + Video mode.

Search and the album, artist and playlist pages (stage 2.4), with the app's single place for music sources (providers, tier and the Spotify switch) and the fake catalog for development and tests, are described in [src/features/search/README.md](src/features/search/README.md).

Stage 2.9 makes it play: the composition root in `src/app/services` builds the real providers and stream lifecycle on the app's one platform (stage 2.7's), connects them to the app's player and plugs them into those pages (see [Playing music](#playing-music) and [its README](src/app/services/README.md)).

## Run it

From the repository root (tools run through `make` or `scripts/run.sh`, see [DEVELOPMENT.md](../../docs/DEVELOPMENT.md)):

| Command | What it does |
|---|---|
| `make dev` | Dev server at http://localhost:5173/app/ |
| `make test` | Unit tests (Vitest + happy-dom), together with every other package |
| `make check` | Lint, typecheck, test and build: what every change must pass |
| `scripts/run.sh pnpm --filter @fxm/web build` | Production build in `apps/web/dist/` |
| `scripts/run.sh pnpm --filter @fxm/web preview` | Serve the build at http://localhost:4173/app/ |

End-to-end tests and screenshots use Playwright and are **not** part of `make check`. Install Chromium once (it lands in `.tools/playwright/`):

```sh
scripts/run.sh pnpm --filter @fxm/web exec playwright install chromium
scripts/run.sh pnpm --filter @fxm/web e2e          # smoke test (navigation, Back, settings across reloads, keyboard focus, no overflow at 320 px, playlist order by keyboard and mouse across reloads, menus by keyboard, also with reduced motion, focus when rows leave a list, sidebar confirmations on any page), Now playing (saved queue, lyrics, reordering, review, phone and laptop layouts), local files (read and played in Chromium), the PWA test (e2e/pwa.spec.ts) and the tiers (connect.spec.ts)
scripts/run.sh pnpm --filter @fxm/web screenshots  # every page at 320/768/1280/1920 px in both themes, Now playing in use at 320/768/1280 (lyrics, versions, queue, move buttons, review, a song that can't play), plus Music + Video, forced colors, the library restored from a backup, search and browse with the fake catalog, and the PWA's states at 320/768/1280 px, in apps/web/screenshots/
scripts/run.sh pnpm --filter @fxm/web icons        # re-render the app icons in public/ from pwa/icons.ts
```

`e2e/playback.spec.ts` runs with them: search, play and the next track through the real composition in Chromium, with every request outside the app answered from recorded fixtures and the streams played as short WAV tones. Every run builds this checkout and starts its own `vite preview` on port 4173 with `--strictPort`. If the port is busy, for example with another worktree's preview, the run fails instead of testing that server: set `FXM_E2E_PORT` to a free port (not 6000, which Chromium refuses to load). Screenshots and Playwright output are gitignored. Service workers are blocked in every spec except `e2e/pwa.spec.ts`, which runs its tests one at a time because it publishes new versions of `dist/sw.js` (and puts the original back when it ends).

The PWA spec's two tests that really install FXM (into a temporary browser profile with its own home folder) run on Linux, where the app's shortcut stays in that home folder, and elsewhere only with `FXM_E2E_INSTALL=1`: an install also registers the app with the operating system. They uninstall it afterwards, and on macOS make LaunchServices forget the app, even when a test fails or times out. Screenshot runs skip them.

## Layout

```
index.html              viewport, theme-color, inline SVG favicon, iOS Home Screen icon and name, theme script
                        that runs before the first paint (the PWA plugin adds the manifest link at build time)
public/                 app icons (rendered by scripts/render-icons.ts, committed)
pwa/                    build-time PWA config: base, manifest, service worker options, icon art, host needs
scripts/                render-icons.ts
src/
  main.tsx              starts the service worker and the install offer, creates the browser router and renders <App>,
                        then loads the music services beside it
  app/                  App (providers), routes, router, query client, error screens, 404;
                        services/: the composition root (platform, providers, lifecycle,
                        and the policy and play buttons of the app's player)
  components/
    layout/             AppLayout, Sidebar, TopBar, BottomNav, SearchField, RouteAnnouncer, route metadata
    media/              collection header, card/track/video placeholders
    ui/                 design-system pieces: buttons, IconButton, SegmentedControl, Tabs,
                        RangeSlider, Skeleton, EmptyState, ErrorState, Artwork, Logo
  db/                   the library database: schema and migrations, repository, live-query
                        hooks, ordering, match cache, backups (see src/db/README.md)
  features/<name>/      one folder per feature: home, search, library, album, artist,
                        playlist, now-playing (page, the app's player, stream badge),
                        queue (panel, review list, saving), lyrics, player (bar, mini
                        player, controls), settings, signals (records the player's plays),
                        sponsorblock (skipping, its setting and offer), downloads, pwa,
                        connect (tiers, onboarding, Diagnostics: see its README),
                        scrobble (ListenBrainz, Last.fm)
  lib/                  small helpers (class names, safe storage, media queries, seeds)
  styles/               index.css (base, components, utilities) and tokens.css (design tokens)
  test/                 Vitest setup and the renderApp() helper
e2e/                    Playwright smoke test, Now playing and SponsorBlock tests (with now-playing-seed.ts), local files test (with local-files-fixture.ts), PWA test and screenshot capture; fixtures/ holds a library backup to restore
```

Later stages own their feature folders (`features/search`, `features/now-playing`, `features/library`, …, see [PLAN.md](../../docs/PLAN.md)), so the shell rarely needs to change.

## How it works

- **Routing:** React Router 7 in data mode (`createBrowserRouter`, library mode, no framework plugin), which is what makes `errorElement` and lazy route modules work. The basename is `import.meta.env.BASE_URL` unchanged (`base: '/app/'` in `vite.config.ts`): with the trailing slash, links to Home point at `/app/`, which Vite serves (`/app` is a 404 there). Home and Search ship with the shell; the other pages are lazy chunks. React Router 8 needs Node 22.22+, newer than the toolchain's Node, so it is a later upgrade.
- **Layout:** desktop (1024 px+) has the sidebar, top bar and player bar; tablets (768–1023 px) get an icon rail; phones (< 768 px) get a top bar with the page title, a mini player and a tab bar, except on Now playing, which fills the screen (`data-full-screen` on `<main>` drops the bars' room from `--shell-bottom`). The page scrolls with the window, so mobile browser bars collapse and `<ScrollRestoration>` works. Bottom bars pad for `env(safe-area-inset-bottom)`. `--shell-top` and `--shell-bottom` (in `styles/index.css`) hold the height the bars cover; `html` uses them as `scroll-padding`, so keyboard focus never lands behind a bar. Page content and the top bar row share `max-w-page`.
- **State:** Zustand. `features/settings/settings-store.ts` persists `{ catalogMode, theme }` to `localStorage` under `fxm.settings.v1`; invalid or unreadable data falls back to the defaults, and other open tabs follow changes. `features/player/player-store.ts` is the player bar's view of the app's player (seconds, `isPlaying`), with actions that drive it; the like button reads and saves likes in the library. TanStack Query holds search and browse results (`features/search/queries.ts`), the lyrics and the alternative versions.
- **Platform:** `features/connect/start.ts`, called from `main.tsx`, creates the app's one platform from `@fxm/platform` (`getAppPlatform()`: FXM Connect, the Lite tier's sandbox, the request budget) and keeps the tier in a store that the onboarding page (`/connect`), the shell's notices and Settings → Diagnostics read. Builds made with `VITE_FXM_FAKES=on`, as the Playwright config makes, include the development fake mode ([its README](src/features/connect/README.md)).
- **Library:** IndexedDB through Dexie, in `src/db/` (its [README](src/db/README.md) has the schema, migrations and why orders are stored as they are). Pages read with live queries (`src/db/hooks.ts`), so every view of a playlist, the sidebar and the like buttons update together, in every tab. `features/library/` holds the Library page (`/library?tab=…`: Playlists, Liked songs, Downloads, Artists, Albums, Recently played), the page of a local playlist (`/playlist/local:playlist:…`, chosen by `app/playlist-route.tsx`; other sources' playlists stay with `features/playlist`), the sidebar's playlists and the backup dialog. Its links to followed artists, albums and playlists use the helpers of `features/search/catalog/links.ts` (`playlistPath` in `features/library/paths.ts` picks the right address for any playlist), and a link from those helpers to a local playlist (`/playlist/local:<id>`) moves to the library's address. Confirmations and failures of library actions (`showStatus` in `features/library/status.tsx`) show in the app's one toast, `FeedbackToast` from `features/search/feedback.tsx`, which the shell renders above the player on every page, so an action taken in the sidebar is confirmed wherever the user is.
- **Listening signals:** every play, like and playlist add counts toward an on-device affinity for tracks, artists and tags, which the recommendations rank with (stage 3.1; `src/db/README.md` has the details). The library records likes and playlist adds as it saves them. `features/signals/play-recorder.ts` records plays: the app's player connects it where it is created (`connectPlayRecorder(player)` in `features/now-playing/playback.ts`), and it saves each play when it ends, with the time actually listened, whether it completed (at least half heard) or was skipped, the queue's context and the stream. It keeps checkpoints in `localStorage`, so a page killed in the background loses no play: the next start records them. It also announces each play as it starts and ends (`features/signals/play-events.ts`), for features that follow the listening.
- **Scrobbling** (stage 8.2, opt-in): Settings → Scrobbling connects a ListenBrainz or Last.fm account, and the songs the player plays then go to that profile, with a queue in IndexedDB for when the device is offline or a service is down. `main.tsx` starts it with `startScrobbling()`, which loads and sends nothing until an account is connected. See [features/scrobble/README.md](src/features/scrobble/README.md).
- **Downloads** (stage 4.1): `features/downloads/` runs the download queue of [`@fxm/downloads`](../../packages/downloads/README.md) in the tab that holds a Web Lock, keeps the files in the Origin Private File System (written by a worker) and their records in a second IndexedDB database, `fxm-downloads`, and keeps the Downloads playlist in step. The library's Downloads tab shows the queue, its progress and a storage meter; song menus offer "Download". Its offline store lets the player play downloads first. See [its README](src/features/downloads/README.md).
- **Local files:** `features/local-files/` (its [README](src/features/local-files/README.md) has the details) lists the music files of a folder the browser keeps access to (Chromium's File System Access API, the handle in IndexedDB) or of files chosen through a file input, with tags and covers from music-metadata, in the Library's Local files tab (`/library?tab=local`) and as "On this device" on the search page. They play through the player core from object URLs; FLAC, ALAC and WAV are labelled lossless, nothing else is. Its own database, `fxm-local-files`, stays out of backups.
- **Ordering:** every playlist, Liked songs and Downloads included, and the list of playlists keep a custom order the user controls: drag and drop on dnd-kit (pointer, touch and keyboard: Space picks a row up, the arrow keys move it, Space drops it, Escape cancels), Move up, down, to top and to bottom in each row's menu, multi-select moves, **Shuffle order** (a permanent random order, with Undo until the next change) and sort views by title, artist, album, date added or duration that "Save as custom order" makes permanent. In the sidebar a row drags by itself (with the mouse after a few pixels, by a long press on touch); its menu has the moves. Long lists skip the drag animations, and their rows re-render only when their own data changes.
- **Theme:** dark by default, plus light and system. `data-theme` on `<html>` switches the tokens; the inline script in `index.html` applies the saved theme before React loads (a content security policy must allow it by hash).
- **Errors:** page errors render inside the shell with "Try again" (`RouteError`); a broken shell falls back to a full-page error, and `AppErrorBoundary` wraps everything. Error screens are announced to screen readers (`role="alert"`).
- **Accessibility:** a skip link focuses `<main>` without touching the history, `RouteAnnouncer` tells screen readers which page a link opened, and forced colors (Windows High Contrast) keep sliders, segmented controls and tabs readable. Menus take focus once they are shown and give it back to their button; when a row leaves a list (removed, unliked, unfollowed, deleted), the next row keeps focus.

## Installable app (PWA)

[vite-plugin-pwa](https://vite-pwa-org.netlify.app/) builds the manifest and a Workbox service worker from `pwa/`; the browser side is `src/features/pwa/`.

**Manifest** (`pwa/manifest.ts`). The id, start URL and scope are `/app/`; the id names the installed app, so it never changes. The app opens in its own window (`standalone`), on desktop with Window Controls Overlay (`display_override`). Icons: 192 and 512 px, plain and maskable (`pwa/icons.ts` draws them from the logo mark; `pnpm icons` renders the PNGs in `public/`), plus `apple-touch-icon.png` for iOS. Shortcuts open Search and the library. `launch_handler` (`focus-existing`) brings an open FXM window to the front instead of starting a second player, and `useLaunchQueue` opens the page the launch asked for inside it, so the music keeps playing.

**Service worker** (`pwa/options.ts`).

- **Shell only.** It precaches the build's HTML, scripts, styles and icons (and the manifest), so the player opens without a connection, and answers navigations inside `/app/` with the cached `index.html`. There is no runtime caching: audio, googlevideo, the music services' APIs, artwork and everything else go to the network untouched and are never stored. A precached file may be at most 2 MiB; a bigger chunk fails the build, so split it or leave it out of `PRECACHE_PATTERNS`.
- **Scope `/app/`.** The site (`/`), the embed (`/embed/`) and the sandbox documents (`/sandbox/`) are outside it.
- **Updates ask first.** A new version installs in the background and waits. The update toast offers "Reload" (`applyUpdate`, which activates it) or "Not now" (the new version starts the next time FXM opens), because reloading stops the music. Once the new version takes over, every open FXM window and tab reloads into it, whichever one the user chose Reload in: the old pages' code belongs to the old version, whose files the new one deletes. "Not now" holds until a newer version arrives (Workbox reports one waiting version twice, 200 ms apart). An open window asks the site for a new version every hour (`registerServiceWorker` in `service-worker.ts`).
- **Headers are part of the version.** The worker answers navigations with its stored copy of `index.html`, and with the headers that copy came with, the CSP among them. It stores the page again only when the page's precache revision changes, so the build folds the host's `/app/*` header rule into that revision (`headersRevision` in `pwa/host.ts`, `revisionPageWithHeaders` in `pwa/options.ts`): a deploy that changes only the headers still ships a new worker and the update toast.
- **No inline script.** `main.tsx` registers the worker from the bundle, and the Workbox runtime is inlined into `sw.js`, so the page's CSP needs nothing new beyond allowing `'self'` for the worker, the manifest, the icons and the shell download (`pwa/host.ts`).
- **A source map for make dist.** The worker's source map follows the build's: `vite build` writes none, and `make dist` (stage 2.8), which builds with hidden source maps, reads `sw.js.map` to list the Workbox packages in `sw.js` and deploys no map. Workbox names that map's sources relative to the folder the build runs in and points `sw.js` at the map; `serviceWorkerSourceMap` (`pwa/source-map.ts`) makes the sources relative to the map and, for hidden maps, removes the pointer.
- **Web only.** `build:mobile` and `build:desktop` use base `/`, which turns the plugin off: the Android and desktop apps load the app from their package and get no service worker or manifest. `make dev` has no service worker either.

**Install offer.** Chromium offers to install FXM with `beforeinstallprompt`; `listenForInstallPrompt` keeps the offer (which also stops Chrome on Android from showing its own banner over the player). While there is one:

- from 768 px, the top bar shows an "Install app" pill (`install-button.tsx`);
- on phones, the Home page shows a card with Install and Not now (`install-card.tsx`), so the top bar keeps its room for the page title, also with large text;
- Settings → App → Install app has an Install button (`install-setting.tsx`). Without an offer it says how to install in this browser: Share → Add to Home Screen on iPhone and iPad, File → Add to Dock in Safari on a Mac.

The icon is a screen with an arrow with a mouse and a square with a plus on touch screens, never the plain down arrow, which reads as "download". "Not now", or closing the browser's install dialog, puts the top bar's and the Home page's offer off for 30 days (`snoozeInstallOffer`, stored under `fxm.pwa.v1`); Settings still offers it. A used offer removes its button, so focus moves first: to the top bar's Settings link, the page, or the setting's help text, which then says that FXM is installed. Only the web build shows any of this (`isInstallableWebApp` in `web-app.ts`): the Android and desktop apps are installed already.

**Title bar** (`title-bar.ts`). In an installed desktop window with Window Controls Overlay, the page draws the title bar, and the top bar is it: the browser draws only the window buttons, on the left on macOS and on the right elsewhere. While the overlay shows, `useTitleBar` sets `data-titlebar` and the window buttons' insets (`--titlebar-left`, `--titlebar-right`, from `getTitlebarAreaRect()`) on `<html>`. The end of `styles/index.css` then makes the top bar and the sidebar's logo row drag the window (their links, buttons and search box stay clickable), pads the top bar's row and moves the sidebar's logo clear of the window buttons (the icon rail's logo makes way for buttons on the left), and keeps the skip link below the top bar (`--overlay-top`). The user can switch the overlay off from the window's title bar; all of that then goes.

**Update toast** (`update-toast.tsx`). A landmark ("App update") in a live region, above the player and the cards SponsorBlock stacks there (`--shell-cards`, stage 8.7). On a phone's Now Playing, whose own controls take the bottom of the screen, it shows below the top bar instead (`fullScreen`, from `AppLayout`). The app's confirmations (`FeedbackToast`) show in the same spot above the player: while the update toast is there, it keeps its height plus a gap in `--update-toast-space` on `<html>`, and confirmations rise by as much, so neither covers the other. Escape works like "Not now", and both give focus back to where it came from, or to the page. Its buttons wrap with large text.

**Media keys.** The app's player (`features/now-playing/playback.ts`, stage 2.5) connects to the Media Session with `connectMediaSession` from `@fxm/player`, in the installed app too: the keyboard's media keys, headset buttons, the lock screen and the system's media controls play, pause, skip and seek, and show the track. The PWA adds no second connection.

**Stand-ins for stage 2.8.** Stage 5.1 started before stage 2.8 (static deploy) merged, and touches it in two places; each is one small stand-in, which an integration step points at the rule 2.8 generates (`appPolicy()` in `scripts/build-dist/src/policies.ts`):

| Touch-point | Where | Stand-in until then |
|---|---|---|
| The static host's headers (2.8) | `pwa/host.ts`: the CSP directives and the files that must not be cached for long | The `/app/*` policy from PLAN.md §2.8 (`PLANNED_APP_CSP`) |
| The `/app/*` header rule (2.8), in the page's precache revision | `APP_HEADERS` in `pwa/host.ts`, which `vite.config.ts` hashes: 2.8 hands the build the rule its `_headers` generator writes (or its hash) | The same PLAN.md §2.8 rule, with `Referrer-Policy` and `X-Content-Type-Options` |

**Tests.** Unit tests cover the manifest, the plugin options, the icons, the host's CSP and header revision, the service worker's source map, registration and updates (other windows, repeated reports), the install offer, card, snooze and hints, the web-build check, the title bar, launches, the update toast (landmark, Escape, focus, Now Playing, SponsorBlock's cards, room for confirmations), and that the media keys reach the app's player. `e2e/pwa.spec.ts` checks in Chromium that FXM is installable (no installability errors, the real install offer; with installs on, an install through the DevTools protocol and a launch that opens its page in the open window without a reload), that the shell opens offline, that only shell files are cached and media and API requests pass the service worker by, and the update flow: a first visit and a returning one reload once into the new version, "Not now" holds, and other tabs follow. It also checks that the update toast keeps clear of the player controls at 320 px, of SponsorBlock's offer and of the app's confirmations, and Window Controls Overlay with the window buttons on either side at 480, 768 and 1280 px: the top bar drags the window, nothing clickable sits under the buttons, and the skip link shows below the title bar.

## Conventions

**Adding a page**

1. Create `src/features/<name>/<name>-page.tsx` exporting a named component, e.g. `export function QueuePage()`.
2. Add a route in `src/app/routes.tsx` with a `handle` and the *function* form of `lazy` (React Router mutates the object form after the first load, which breaks a second router in tests):
   ```tsx
   {
     path: 'queue',
     handle: page('Queue'), // or tab('…') for a top-level tab: logo instead of "back" on phones
     lazy: () => import('../features/queue/queue-page').then((m) => ({ Component: m.QueuePage })),
   },
   ```
   The handle's title feeds the document title and the phone top bar.
3. Start the page with `<PageTitle hideOnPhone>` when its title only repeats the phone top bar; otherwise render your own `<h1>`. Every page has exactly one `<h1>`.
4. Add a case to the route table in `src/app/routes.test.tsx`, and the path to `e2e/smoke.spec.ts` and `e2e/screenshots.spec.ts`.

**Code**

- File names are kebab-case (`now-playing-page.tsx`); exports are named.
- Import the router from `react-router` only (not `react-router/dom`): under Vitest the two entries can load different builds, and hooks then lose the router context.
- Use semantic color tokens (`bg-surface`, `text-text-muted`, `border-border`, `text-accent`, …) from `styles/tokens.css`; the default Tailwind palette is switched off. New colors need a value in both themes and an entry in the contrast test (`styles/tokens.test.ts`).
- Don't override a component's own classes through `className` (two `size-*` or `text-*` classes on one element win by CSS order, not by intent). Components expose props instead, such as `IconButton size="custom"`, `Artwork rounded="lg"` or `Skeleton` without a default radius.
- Icon-only buttons need a `label` (it becomes `aria-label`); toggles use `pressed` (`aria-pressed`). Touch targets stay at least 44 px below 1024 px and on touch screens (`size-touch`). Focus rings come from the global `:focus-visible` style; don't remove outlines. Scroll boxes clip rings, so give them a little padding, and draw rings inside elements that touch the screen edge (`focus-visible:-outline-offset-4`).
- Selection shown only by a fill disappears in forced colors: add a `forced-colors:` style in system colors (see `SegmentedControl` and `Tabs`).
- Respect reduced motion: transitions and animations are shortened globally, skeletons stop shimmering. That rule gives every property a 0.01 ms transition, `visibility` included, so something shown by removing `visibility: hidden` stays hidden for a few frames, and `focus()` on it does nothing: hide what must take focus right away with `opacity` (see `MenuPopup`).
- Respect the catalog mode wherever results appear: `useSettingsStore((s) => s.catalogMode)`. Music shows catalog songs only; Music + Video also shows videos, played as music.
- Read sources, the tier and the Spotify switch from the sources module (`useSourcesSnapshot()` in `features/search`), never from a provider or the platform directly, and link to album, artist and playlist pages with `albumPath`, `artistPath` and `playlistPath`.
- Tests use `renderApp(path)` from `src/test/render.tsx`, which renders the real providers and routes with a memory router. Stores, `localStorage` and the library database (fake-indexeddb) are reset after every test. Behaviour that depends on the browser history (basename, back and forward, the skip link) is tested with the real browser router in `src/app/router.test.tsx`.
- Read and write the library only through the repository: `getLibrary()` for writes, the hooks in `src/db/hooks.ts` for reads. Never open Dexie tables directly. Seed tests with `getLibrary()`, or use `testRepo()` and `track()` from `src/test/library-fixtures.ts`. happy-dom lays nothing out, so drag-and-drop tests give rows positions first (see `stubRowLayout` in `features/library/library-page.test.tsx`).

## Playback, Now playing, queue and lyrics

Stage 2.5. Three feature folders, plus the player bar and mini player in `features/player/`, which show the same player.

### The app's player (`features/now-playing/playback.ts`)

One `Player` facade from [`@fxm/player`](../../packages/player/README.md) for the whole app, created on first use:

- it plays through the `DirectAudioEngine` and gets its streams from the playback policy (below);
- it starts in the catalog mode of the settings and follows it (`setCatalogMode`);
- it shows the current track in the system media controls (`connectMediaSession`);
- it records each play in the library's listening history (`connectPlayRecorder`, stage 3.1; `recordPlays: false` leaves it out, as `setupTestPlayback()` does);
- it saves the queue, the position, the volume and mute in `localStorage` and puts them back, paused, after a reload (`features/queue/queue-storage.ts`): `fxm.queue.v1`, written shortly after each change, and `fxm.playback.v1`, written every few seconds while playing, on pauses and seeks and when the page is hidden. What comes back goes through `restoreQueue`. A queue longer than 1,000 songs is saved as a window around the current one. If storage is full, the saved queue is removed rather than left behind, so a reload never puts back an older one. The position carries its item's `uid`: it is put back only on that item, and never past its end.

Components read it with `usePlayerState(selector)` (the selector returns a value from the state or a primitive), `useCurrentItem()` and `usePlayerEvent(type, handler)`. Event handlers call `getPlayer()`'s methods directly, so playback starts inside the user's gesture. Other features queue music the same way: `getPlayer().setQueue(tracks, { context, startIndex, shuffle })`, `playNext(tracks)`, `addToQueue(tracks)`.

The player bar and the mini player follow it too: Play, Previous, Next, Seek and Like are off while the queue is empty, and the seek slider seeks when its thumb is let go (or on each key press), not on every step of a drag. When playback stops on a problem (`PlayerState.error`), both bars say "Couldn’t play" instead of the artists, and `PlaybackAnnouncer` (`features/now-playing/playback-problem.tsx`, in the app layout) tells screen readers why, in a polite live region, on every page. The big play button of the library's playlist pages (`/playlist/local:playlist:…`, and the shell's old `/playlist/liked`, …) stays a placeholder until they play the playlist (see the table below); the album, artist and playlist pages of stage 2.4 have their own.

### Now playing (`features/now-playing/`)

- The track leads the page: its title is the main heading on screen (the page's `<h1>` is for screen readers), and from 768px the cover is also sized by the window's height, so the title, the badge and "Not the right version?" sit above the player bar on a laptop.
- On phones it fills the screen: no tab bar or mini player, and the top bar's back arrow leaves. The controls sit under the title, with **Lyrics** and **Queue** buttons that bring their panel up from below.
- **Stream badge** (`stream-label.ts`, `stream-info.tsx`): the format and the source of what plays, such as "Opus · YouTube Music" or "AAC from 360p video · YouTube Music". Next to it, as plain text, the match for audio found for another catalog's track: "Matched from Spotify · 0.93" (an official video playing its song in Music mode: "Song version"). The badge opens the stream details: format and bitrate, quality tier, file type, source, and for a match what it matched, the confidence and the evidence. Names are plain words, never logos or brand colours ([LEGAL.md](../../docs/LEGAL.md)).
- **"Not the right version?"** (`version-switcher.tsx`) on matched audio: the current version, the ranked alternatives, and a search for the song. A pick becomes the audio of every queue item of that track (`setCandidate`, which switches the playing one at the same position), and the policy pins it.
- **A best guess** waiting for review shows "Is this the right version?" with the guess itself (title, artists, source, match, its length next to the original's), "It’s right", "Play it" (until it has played) and the switcher. Once it is approved, the focus moves to "Not the right version?".
- Why playback stopped, in words, with "Try again", under the controls (`playback-problem.tsx`). On phones it scrolls into view when it appears while the lyrics or the queue are on screen.

### Queue panel (`features/queue/`)

- The current song and the songs up next, in play order, with "Playing from …" and Clear. Selecting a row plays it; X removes it (focus moves to the next row). The current song shows "Needs review" or "Best guess" like the others, and "Couldn’t play" when it couldn’t.
- **Reordering** (`use-drag-reorder.ts`): drag a row's handle with a mouse, a pen or a finger (the handle has `touch-action: none`; the window scrolls near the bars), or focus the handle and press the arrow keys, Home or End. Or, with no dragging at all (WCAG 2.5.7), select the handle: **Play next**, **Up** and **Down** show under the row, one tap per move (selecting the handle again, or Escape, hides them). Each move is announced, and the focus stays on the control that made it.
- **Needs review** (`review-store.ts`, `review-actions.ts`, `review-dialog.tsx`, `best-guess.tsx`): tracks whose audio is only a Suggest-band match, each with its best guess, as the playback policy reports them. Rows say "Needs review" (skipped) or "Best guess" (playing it anyway). The notice above the queue has "Approve all", which approves every best guess in one tap and moves the ones the queue skipped (and never played) up to play next, and "Review", which lists them with their guesses to play, approve one by one or swap for other versions; an approval moves the focus to the next row's "Approve". Selecting a row that needs review plays its best guess once, without approving it. The list is saved with the queue (`fxm.queue-review.v1`) and follows it: tracks that leave the queue leave the list, and a new catalog mode starts it over.
- **"Play best guesses"** (off by default) lets Suggest-band matches play without review. It sits in the review notice and the review dialog, is saved with the review list and passed to the policy.
- The first 100 songs up next show, then "Show all".

### Lyrics (`features/lyrics/`)

- From LRCLIB through the provider of stage 1.8 (`@fxm/sources/lrclib`), one instance for the app, with the page's `fetch` and no cookies (`lyrics-source.ts`). LRCLIB answers every origin, so lyrics work on every tier. They are looked up only while the lyrics tab shows, once per lookup (TanStack Query, keyed on what LRCLIB gets, the duration in whole seconds), and for the next track when the current one nears its end.
- What is looked up is what plays: a matched track keeps its own names, and takes the duration of its match only when that is more than 2 s off (closer, LRCLIB finds the same lyrics); an official video playing its song looks up the song. While the player is still finding the match of the current track, the lookup waits for it, and the next track's lookup waits until it plays. If a lookup still changes for the same song, the lyrics on screen stay until the new ones arrive.
- **Synced lyrics** highlight the line being sung (and, with enhanced LRC, the words sung so far) and keep it in view; the other lines are dimmed, and a hover only tints a line. The position moves on between the player's reports every animation frame, outside React state: only the lines that change re-render. Selecting a line plays from there (**tap to seek**). The lines are one Tab stop (the current one, or the one in focus): the arrow keys, Home and End move between them. Scrolling the lyrics, or keyboard focus on a line, pauses the following ("Current line" brings it back). On phones the box is at most half the screen, and a swipe at its end goes on to the page.
- Plain lyrics show as text, with a note; no lyrics, loading and errors (LRCLIB busy, offline) have their own states. The lyrics credit LRCLIB.

### Where unmerged stages plug in

Each touch-point with a stage that wasn't merged when 2.5 was built sits behind one module, so integration changes only that module:

| Stage | Module | Today | Integration |
|---|---|---|---|
| 2.3 Playback policy | `features/now-playing/playback-policy.ts` | Wired by stage 2.9: `createAppPolicy()` follows the policy the composition root connects (`connectAppPolicy`): its stream lifecycle as the `resolver`, its Suggest-band reports (`onNeedsReview`), the matching engine's `alternatives`, the match cache's `pin` (2.6) and "Play best guesses" | Done |
| 2.4 Search and browse | `features/now-playing/browse-links.ts` | Searches link to `/search?q=`; artist, album and playlist names are plain text | `entityPath(id)` returns 2.4's page for an entity |
| 2.6 Library | `PlayPauseButton appearance="cta"` in `features/player/controls.tsx` | A placeholder that toggles itself, apart from the queue, on the library's playlist pages (2.4's pages have their own play buttons) | The library's playlist pages play the playlist, with Pause only while the queue's `context` is that page's |
| 2.6 Library | `LikeButton` in `features/player/controls.tsx` | Merged: 2.6's like button (`LibraryLikeButton`), given `useCurrentItem()?.track`, off while nothing plays | Done |
| 1.2 Platform | `lyricsContext()` in `features/lyrics/lyrics-source.ts` | The page's `fetch` (LRCLIB is CORS-friendly) | The platform's context, so desktop and Android use their native HTTP |
| 1.2 Platform | `sponsorBlockContext()` in `features/sponsorblock/sponsorblock-source.ts` (8.7) | The page's `fetch` (SponsorBlock is CORS-friendly) | The platform's context, as for lyrics |
| 2.8 Deploy | The `/app/*` CSP (8.7) | No CSP outside the deploy | `connect-src` must allow `https://sponsor.ajay.app` (PLAN.md lists it under 2.8's notes) |

### SponsorBlock: skipping the non-music parts of videos

Stage 8.7, in `features/sponsorblock/`. Opt-in and off by default.

- **What it skips:** SponsorBlock's `music_offtopic` segments ("Non-Music Section": intros, skits, outros) of **videos playing as themselves in Music + Video mode**. Never songs, never in Music mode (`skippableVideoId` from `@fxm/sources/sponsorblock`). While skipping is off, SponsorBlock is asked nothing.
- **Privacy:** only the first four hex characters of the videoId's SHA-256 hash leave the device, so SponsorBlock can't tell which video plays ([the client's README](../../packages/sources/src/sponsorblock/README.md)). The requests use the page's `fetch` without cookies (`sponsorblock-source.ts`).
- **Skipping** (`skipping.ts`): the player's segment skipper (`connectSegmentSkipper` in `@fxm/player`), connected by the app's playback, asks `segmentsFor` for each track and again whenever the setting or the catalog mode changes.
- **The skip notice** (`sponsorblock-notices.tsx`): each skip shows what it passed, "Skipped the intro", "Skipped the outro" or "Skipped a non-music part", with the track, Undo (it goes back, and that part plays this time) and Dismiss. It stays for as long as Undo works, which is until the track changes or starts over or the user moves playback (the skipper's `undoexpire`), so nobody has to race a timer to undo. An outro's notice has no Undo, since the track ended, and closes by itself after 8 s, counted only while neither the pointer nor focus is on it. It sits above the player bar (phones: above the mini player), except on Now playing on phones, where `InlineSkipNotice` puts it under the player controls and the Lyrics and Queue buttons, so it covers none of them and moves none of them when it appears. Undo and Dismiss hand keyboard focus back to where it came from (else to the main content), also when a newer skip replaces the card.
- **The setting** (`sponsorblock-store.ts`, `fxm.sponsorblock.v1`): `enabled`, `offered` (the user chose, by the offer or the switch) and `offerShown`, all `false` at first, synced across tabs. Settings → Playback has the switch, what it does, how it keeps what plays private and the data's licence (`sponsorblock-setting.tsx`).
- **The offer** (`sponsorblock-notices.tsx`): "Skip non-music parts of videos?", with Turn on and No thanks, above the player bar (phones: above the mini player, as just the title, one sentence and the buttons). Only the first Music + Video session that shows it does, until answered: a sessionStorage mark (`fxm.sponsorblock.offer-session`) keeps it across reloads in that session, while `offerShown` keeps later sessions from showing it. Not on Settings, which has the switch, nor on Now playing, whose controls stay clear, nor in a window too short for it (under 24rem, e.g. a phone held sideways): it waits for a page or window with room. It scrolls rather than grows past the bars. Answering hands focus back and shows "Skipping is on" or "Skipping stays off" with where to change it, for 8 s.
- **The app's toast** (`FeedbackToast` in `features/search/feedback.tsx`) rises above the cards while any shows: they set the height they cover as `--shell-cards` on the root, so a confirmation never hides the offer's buttons or Undo.
- **Screen readers** hear each skip and each answer through one polite live region (`role="status"`, named SponsorBlock), wherever the card itself shows.
- **Credit:** SponsorBlock's data is CC BY-NC-SA 4.0. "Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 from sponsor.ajay.app", with both links, shows under the switch and in Settings → About.

`features/sponsorblock/testing.ts` has `setupTestSponsorBlock(handler)`, a fake client the test setup removes after each test, and `testVideo` and `testSegment`. `e2e/sponsorblock.spec.ts` checks the offer, the first-session rule and the switch in a real browser, and plays the seeded music video with SponsorBlock answered by a route: the lookup goes by hash prefix only, and on 320 and 390 px phones the notice sits under Now playing's controls, which stay tappable, with focus handed back after Undo, and the app's toast stays clear of the offer.

### Tests

`features/now-playing/testing.ts` has the helpers: `setupTestPlayback()` (the app's player on a `FakeEngine` and a `FakePolicy`, whose `resolver` is a `FakeResolver` and which reports best guesses with `reportNeedsReview`), `setupTestLyrics(handler)`, `spotifyTrack`, `testCandidate` and `syncedLyrics`. The test setup resets the player, the review list and the lyrics provider after every test. `e2e/now-playing.spec.ts` checks in a real browser, from the saved state in `e2e/now-playing-seed.ts` (made-up songs, inline SVG artwork, LRCLIB answered by a route): the restored queue, the lyrics and their keyboard use, seeking, drag, keyboard and one-tap reordering, the review and its focus, the layout on a laptop, a 390 px phone (full screen, a problem in view) and a 320 px phone with a long title and three artists, and "Couldn’t play" in the mini player.

## Playing music

`main.tsx` renders the shell at once and starts the app's services (`src/app/services`, stage 2.9) beside it, from a chunk of their own: first the app's player (stage 2.5) gets their playback policy and becomes the player behind the catalog pages' play buttons, then they wait for the app's one platform, which stage 2.7's `startConnect()` creates beside the first render (FXM Connect's answer takes a few milliseconds; without it, the Lite tier's self-test a moment longer), then the providers join the sources registry, and "Add to playlist" lists the library's playlists. While FXM Connect's marker is on the page but it hasn't answered yet, the pages say "Connecting to FXM Connect…" rather than offering to install it. Provider code loads on first use; YouTube's starts loading as soon as the platform can reach it. What each tier gets and where the stages still to merge plug in are in [the services README](src/app/services/README.md). The development-only fake catalog (`?fake=full` and the like) still replaces all of it for its tab, where the app's player plays local files only.

The player bar, the mini player, Now playing, the queue panel and the system media controls all show that one player, local files included, and the stream lifecycle follows the audio quality chosen in Settings.

### Check it locally with FXM Connect

1. `make extension FXM_EXTENSION_DEV=1`, then load `apps/extension/dist/dev/chromium` as an unpacked extension (Developer mode on, "Load unpacked"). The development build lets `http://localhost:5173` and `http://localhost:4173` use it.
2. `make dev`, then open http://localhost:5173/app/search?q=blitzkrieg%20bop.
3. Play a song: it plays through VISIONOS (or itag 18) after the end-of-file probe. Pick "Internet Archive" in "Search in" and play a track there too.

Without the extension the same page is the Free tier: YouTube Music shows how to reach it, and Internet Archive still plays.

### Manual run with FXM Connect (2026-10-26)

Run by the stage 2.9 agent on 2026-10-26 (IST), from a residential connection in India, against the real services. The FXM Connect development build (`make extension FXM_EXTENSION_DEV=1`) was loaded into Playwright's Chromium 156.0.8078.4 in new headless mode with a temporary profile. The dev server ran on port 6400 (`vite --port 6400 --strictPort`) rather than 5173, because other worktrees share that machine, so the build's `http://localhost:5173` origin was rewritten to `:6400` in a throwaway copy of `apps/extension/dist/dev/chromium`. Headless Chromium has no sound device, so nothing was heard: what played is shown by the media element's events, its position moving in real time (sampled every 15 s), and the bytes received (DevTools protocol).

That run used this stage's interim player, now removed; [the second run](#second-run-after-taking-in-develop-2026-10-26) checks the same services with stage 2.5's player.

| | YouTube Music | Internet Archive |
|---|---|---|
| Search | "ramones blitzkrieg bop" (YouTube Music) | "nine inch nails ghosts" (Internet Archive in "Search in") |
| Played | "Blitzkrieg Bop", Ramones: VISIONOS's AAC 140 after both end-of-file probes (Opus 251 and AAC 140) answered 206. One `bytes=0-` request, answered 206, delivered the whole 2,178,857-byte file; `playing` after 0.5 s, position 15, 30 … 120 s at the 15 s samples, `ended` at 134.5 of 134.5 s | "1 Ghosts I", Nine Inch Nails: the 320 kbps MP3, after the `archive.org/download` redirect. 20 s of play, then a seek to 12 s before the end (a `bytes=6258688-` request, 206), `ended` at 168.7 s |
| Next track | 30 s before the end the lifecycle resolved the next three songs (3 `/player` calls, 6 probes) and the second `<audio>` preloaded the next one (Opus 251); it played the moment the first ended: "Blitzkrieg Bop (From "Jimmy Neutron: Boy Genius")", Geek Music | "2 Ghosts I", preloaded, played the moment the first ended |
| Requests | YouTube: 7 (`sw.js_data`, then one suggestions call, one search and four `/player` calls to InnerTube). googlevideo: 10, 4.86 MB | archive.org: 1 search, 4 item metadata, the files (about 9 MB with the cover art) |

Seen along the way, for later stages:

- The first YouTube attempt stopped about a minute in, when the page searched again by itself: most likely the dev server reloading it after a file edit in `apps/web`. The run above had no edits.
- After a page load, this development build answered FXM Connect's ping later than the platform's 800 ms wait (it switches to the localhost origin's ruleset first, and its service worker may be asleep), so the page showed the Free tier's "Search needs YouTube Music access" for about 3 s before it switched to the Full tier by itself. The release build has one origin and switches nothing. Since the review of this stage, the page says "Connecting to FXM Connect…" while it waits (up to 5 s), and `e2e/playback.spec.ts` checks that with an answer 1.5 s late.
- The ladder chose AAC 140 over Opus 251 for this song: it ranks by average bitrate, the decision stage 1.4's README leaves open, and this Chromium plays AAC.

### Second run, after taking in `develop` (2026-10-26)

Run on 2026-10-26 (IST) by the integration of this stage with `develop`, from the same connection, against the real services, to check the app with stage 2.5's player: the production build (`vite preview --port 6400 --strictPort`) and FXM Connect's development build rebuilt from the merged tree, in a throwaway copy whose `http://localhost:5173` origin and ruleset were renamed to `:6400`, in Playwright's Chromium 156.0.8078.4 in new headless mode with a temporary profile and `--mute-audio`. The position was sampled every 5 s.

| | YouTube Music | Internet Archive |
|---|---|---|
| Search | "ramones blitzkrieg bop" (YouTube Music) | "nine inch nails ghosts" (Internet Archive in "Search in") |
| Played | "Blitzkrieg Bop", Ramones: AAC (itag 140), at 5.1, 10.1, 15.1 and 20.1 s; the player bar showed "Blitzkrieg Bop", "Ramones", 0:20 of 2:14 | "1 Ghosts I", Nine Inch Nails: the 320 kbps MP3, at 5, 10 and 15 s; the player bar showed its title, artist and 0:14 of 2:48 |
| Next track, from Next in the player bar | "The KKK Took My Baby Away (1999 Remaster)", AAC (itag 140), at 5.1 and 10.2 s | "2 Ghosts I", the 320 kbps MP3, at 5.2 and 10.2 s |
| Requests | YouTube: 5 (`sw.js_data`, one suggestions call, one search, two `/player` calls). googlevideo: 6, 4.88 MB | archive.org: 1 search, 4 item metadata, the files and their covers (9.2 MB). YouTube: none |

The system media controls (`navigator.mediaSession`) and the player bar named the playing track each time, which the interim player's bar never did.
