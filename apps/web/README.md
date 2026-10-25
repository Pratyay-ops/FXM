# @fxm/web

The FXM web player: a React app served from `/app/`, which later also becomes the installable web applet (stage 5.1) and the shell of the Android app (stage 6.1). Everything runs in the browser: there is no FXM backend.

Stage 2.1 built the **shell**: routing, layout, design system, settings and placeholder pages. Stage 2.5 added **playback**: the app's player, Now playing with its stream badge and version switcher, the queue panel and synced lyrics (see [Playback, Now playing, queue and lyrics](#playback-now-playing-queue-and-lyrics)). Stage 8.7 added opt-in [SponsorBlock skipping](#sponsorblock-skipping-the-non-music-parts-of-videos) in Music + Video mode. Search results and the library plug in with their own stages.

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
scripts/run.sh pnpm --filter @fxm/web e2e          # smoke test (navigation, Back, settings across reloads, keyboard focus, no overflow at 320 px) and Now playing (saved queue, lyrics, drag and keyboard reordering, review)
scripts/run.sh pnpm --filter @fxm/web screenshots  # every page at 320/768/1280/1920 px in both themes, Now playing in use at 320/768/1280, plus Music + Video and forced colors, in apps/web/screenshots/
```

Every run builds this checkout and starts its own `vite preview` on port 4173 with `--strictPort`. If the port is busy, for example with another worktree's preview, the run fails instead of testing that server: set `FXM_E2E_PORT` to a free port. Screenshots and Playwright output are gitignored.

## Layout

```
index.html              viewport, theme-color, inline SVG favicon, theme script that runs before the first paint
src/
  main.tsx              creates the browser router and renders <App>
  app/                  App (providers), routes, router, query client, error screens, 404
  components/
    layout/             AppLayout, Sidebar, TopBar, BottomNav, SearchField, RouteAnnouncer, route metadata
    media/              collection header, card/track/video placeholders
    ui/                 design-system pieces: buttons, IconButton, SegmentedControl, Tabs,
                        RangeSlider, Skeleton, EmptyState, ErrorState, Artwork, Logo
  features/<name>/      one folder per feature: home, search, library, album, artist,
                        playlist, now-playing (page, the app's player, stream badge),
                        queue (panel, review list, saving), lyrics, player (bar, mini
                        player, controls), settings, sponsorblock (skipping, its setting
                        and offer)
  lib/                  small helpers (class names, safe storage, media queries, seeds)
  styles/               index.css (base, components, utilities) and tokens.css (design tokens)
  test/                 Vitest setup and the renderApp() helper
e2e/                    Playwright smoke test, Now playing and SponsorBlock tests (with
                        now-playing-seed.ts) and screenshot capture
```

Later stages own their feature folders (`features/search`, `features/now-playing`, `features/library`, …, see [PLAN.md](../../docs/PLAN.md)), so the shell rarely needs to change.

## How it works

- **Routing:** React Router 7 in data mode (`createBrowserRouter`, library mode, no framework plugin), which is what makes `errorElement` and lazy route modules work. The basename is `import.meta.env.BASE_URL` unchanged (`base: '/app/'` in `vite.config.ts`): with the trailing slash, links to Home point at `/app/`, which Vite serves (`/app` is a 404 there). Home and Search ship with the shell; the other pages are lazy chunks. React Router 8 needs Node 22.22+, newer than the toolchain's Node, so it is a later upgrade.
- **Layout:** desktop (1024 px+) has the sidebar, top bar and player bar; tablets (768–1023 px) get an icon rail; phones (< 768 px) get a top bar with the page title, a mini player and a tab bar. The page scrolls with the window, so mobile browser bars collapse and `<ScrollRestoration>` works. Bottom bars pad for `env(safe-area-inset-bottom)`. `--shell-top` and `--shell-bottom` (in `styles/index.css`) hold the height the bars cover; `html` uses them as `scroll-padding`, so keyboard focus never lands behind a bar. Page content and the top bar row share `max-w-page`.
- **State:** Zustand. `features/settings/settings-store.ts` persists `{ catalogMode, theme }` to `localStorage` under `fxm.settings.v1`; invalid or unreadable data falls back to the defaults, and other open tabs follow changes. `features/player/player-store.ts` is the player bar's view of the app's player (seconds, `isPlaying`), with actions that drive it; its `liked` is a placeholder until the library (2.6). TanStack Query holds the lyrics and the alternative versions.
- **Theme:** dark by default, plus light and system. `data-theme` on `<html>` switches the tokens; the inline script in `index.html` applies the saved theme before React loads (a content security policy must allow it by hash).
- **Errors:** page errors render inside the shell with "Try again" (`RouteError`); a broken shell falls back to a full-page error, and `AppErrorBoundary` wraps everything. Error screens are announced to screen readers (`role="alert"`).
- **Accessibility:** a skip link focuses `<main>` without touching the history, `RouteAnnouncer` tells screen readers which page a link opened, and forced colors (Windows High Contrast) keep sliders, segmented controls and tabs readable.

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
- Respect reduced motion: transitions and animations are shortened globally, skeletons stop shimmering.
- Respect the catalog mode wherever results appear: `useSettingsStore((s) => s.catalogMode)`. Music shows catalog songs only; Music + Video also shows videos, played as music.
- Tests use `renderApp(path)` from `src/test/render.tsx`, which renders the real providers and routes with a memory router. Stores and `localStorage` are reset after every test. Behaviour that depends on the browser history (basename, back and forward, the skip link) is tested with the real browser router in `src/app/router.test.tsx`.

## Playback, Now playing, queue and lyrics

Stage 2.5. Three feature folders, plus the player bar and mini player in `features/player/`, which show the same player.

### The app's player (`features/now-playing/playback.ts`)

One `Player` facade from [`@fxm/player`](../../packages/player/README.md) for the whole app, created on first use:

- it plays through the `DirectAudioEngine` and gets its streams from the playback policy (below);
- it starts in the catalog mode of the settings and follows it (`setCatalogMode`);
- it shows the current track in the system media controls (`connectMediaSession`);
- it saves the queue, the position, the volume and mute in `localStorage` and puts them back, paused, after a reload (`features/queue/queue-storage.ts`: `fxm.queue.v1`, written shortly after each change, and `fxm.playback.v1`, written every few seconds while playing, on pauses and seeks and when the page is hidden). What comes back goes through `restoreQueue`.

Components read it with `usePlayerState(selector)` (the selector returns a value from the state or a primitive), `useCurrentItem()` and `usePlayerEvent(type, handler)`. Event handlers call `getPlayer()`'s methods directly, so playback starts inside the user's gesture. Other features queue music the same way: `getPlayer().setQueue(tracks, { context, startIndex, shuffle })`, `playNext(tracks)`, `addToQueue(tracks)`.

### Now playing (`features/now-playing/`)

- **Stream badge** (`stream-label.ts`, `stream-info.tsx`): the format and the source of what plays, such as "Opus · YouTube Music" or "AAC from 360p video · YouTube Music", and for audio found for another catalog's track the match, "Matched from Spotify · 0.93" (an official video playing its song in Music mode: "Song version"). The badge opens the stream details: format and bitrate, quality tier, file type, source, and for a match what it matched, the confidence and the evidence. Names are plain words, never logos or brand colours ([LEGAL.md](../../docs/LEGAL.md)).
- **"Not the right version?"** (`version-switcher.tsx`) on matched audio: the current version, the ranked alternatives, and a search for the song. A pick becomes the audio of every queue item of that track (`setCandidate`, which switches the playing one at the same position), and the policy pins it.
- **A best guess** waiting for review shows "Is this the right version?" with "It’s right" and the switcher.
- Why playback stopped (`PlayerState.error`), in words, with "Try again". Phones get the controls under the title; from 768px the player bar has them.

### Queue panel (`features/queue/`)

- The current song and the songs up next, in play order, with "Playing from …" and Clear. Selecting a row plays it; X removes it (focus moves to the next row).
- **Reordering** (`use-drag-reorder.ts`): drag a row's handle with a mouse, a pen or a finger (the handle has `touch-action: none`; the window scrolls near the bars), or focus the handle and press the arrow keys, Home or End. Each move is announced.
- **Needs review** (`review-store.ts`, `review-actions.ts`, `review-dialog.tsx`): tracks whose audio is only a Suggest-band match, each with its best guess, as the playback policy reports them. Rows say "Needs review" (skipped) or "Best guess" (playing it anyway). "Approve all" approves every best guess in one tap and moves the ones the queue already skipped up to play next; "Review" lists them to approve one by one or to pick other versions. Selecting a row that needs review plays its best guess once, without approving it. The list is saved with the queue (`fxm.queue-review.v1`) and follows it: tracks that leave the queue leave the list, and a new catalog mode starts it over.
- **"Play best guesses"** (off by default) lets Suggest-band matches play without review. It is saved with the review list and passed to the policy.
- The first 100 songs up next show, then "Show all".

### Lyrics (`features/lyrics/`)

- From LRCLIB through the provider of stage 1.8 (`@fxm/sources/lrclib`), one instance for the app, with the page's `fetch` and no cookies (`lyrics-source.ts`). LRCLIB answers every origin, so lyrics work on every tier. They are looked up only while the lyrics tab shows, once per track (TanStack Query), and for the next track when the current one nears its end.
- What is looked up is what plays: a matched track keeps its own names but takes the duration of its match; an official video playing its song looks up the song.
- **Synced lyrics** highlight the line being sung (and, with enhanced LRC, the words sung so far) and keep it in view. The position moves on between the player's reports every animation frame. Selecting a line plays from there (**tap to seek**). Scrolling the lyrics pauses the following for a few seconds ("Current line" brings it back).
- Plain lyrics show as text, with a note; no lyrics, loading and errors (LRCLIB busy, offline) have their own states. The lyrics credit LRCLIB.

### Where unmerged stages plug in

Each touch-point with a stage that wasn't merged when 2.5 was built sits behind one module, so integration changes only that module:

| Stage | Module | Today | Integration |
|---|---|---|---|
| 2.3 Playback policy | `features/now-playing/playback-policy.ts` | `createPendingPolicy()`: every resolution fails with `Unsupported` (nothing plays), no alternatives, no reports | `createAppPolicy()` returns 2.3's policy: its stream lifecycle as the `resolver`, its Suggest-band reports (`onNeedsReview`), the matching engine's `alternatives`, the match cache's `pin` (2.6) and "Play best guesses" |
| 2.4 Search and browse | `features/now-playing/browse-links.ts` | Searches link to `/search?q=`; artist, album and playlist names are plain text | `entityPath(id)` returns 2.4's page for an entity |
| 1.2 Platform | `lyricsContext()` in `features/lyrics/lyrics-source.ts` | The page's `fetch` (LRCLIB is CORS-friendly) | The platform's context, so desktop and Android use their native HTTP |
| 1.2 Platform | `sponsorBlockContext()` in `features/sponsorblock/sponsorblock-source.ts` (8.7) | The page's `fetch` (SponsorBlock is CORS-friendly) | The platform's context, as for lyrics |
| 2.8 Deploy | The `/app/*` CSP (8.7) | No CSP outside the deploy | `connect-src` must allow `https://sponsor.ajay.app` (PLAN.md lists it under 2.8's notes) |

### SponsorBlock: skipping the non-music parts of videos

Stage 8.7, in `features/sponsorblock/`. Opt-in and off by default.

- **What it skips:** SponsorBlock's `music_offtopic` segments ("Non-Music Section": intros, skits, outros) of **videos playing as themselves in Music + Video mode**. Never songs, never in Music mode (`skippableVideoId` from `@fxm/sources/sponsorblock`). While skipping is off, SponsorBlock is asked nothing.
- **Privacy:** only the first four hex characters of the videoId's SHA-256 hash leave the device, so SponsorBlock can't tell which video plays ([the client's README](../../packages/sources/src/sponsorblock/README.md)). The requests use the page's `fetch` without cookies (`sponsorblock-source.ts`).
- **Skipping** (`skipping.ts`): the player's segment skipper (`connectSegmentSkipper` in `@fxm/player`), connected by the app's playback, asks `segmentsFor` for each track and again whenever the setting or the catalog mode changes.
- **The skip notice** (`sponsorblock-notices.tsx`): each skip shows what it passed, "Skipped the intro", "Skipped the outro" or "Skipped a non-music part", with the track, Undo (it goes back, and that part plays this time) and Dismiss. It stays for as long as Undo works, which is until the track changes or starts over or the user moves playback (the skipper's `undoexpire`), so nobody has to race a timer to undo. An outro's notice has no Undo, since the track ended, and closes by itself after 8 s, counted only while neither the pointer nor focus is on it. It sits above the player bar (phones: above the mini player), except on Now playing on phones, where `InlineSkipNotice` puts it under the player controls so it covers none of them. Undo and Dismiss hand keyboard focus back to where it came from (else to the main content), also when a newer skip replaces the card.
- **The setting** (`sponsorblock-store.ts`, `fxm.sponsorblock.v1`): `enabled`, `offered` (the user chose, by the offer or the switch) and `offerShown`, all `false` at first, synced across tabs. Settings → Playback has the switch, what it does, how it keeps what plays private and the data's licence (`sponsorblock-setting.tsx`).
- **The offer** (`sponsorblock-notices.tsx`): "Skip non-music parts of videos?", with Turn on and No thanks, above the player bar (phones: above the mini player, as just the title, one sentence and the buttons). Only the first Music + Video session that shows it does, until answered: a sessionStorage mark (`fxm.sponsorblock.offer-session`) keeps it across reloads in that session, while `offerShown` keeps later sessions from showing it. Not on Settings, which has the switch, nor on Now playing, whose controls stay clear, nor in a window too short for it (under 24rem, e.g. a phone held sideways): it waits for a page or window with room. It scrolls rather than grows past the bars. Answering hands focus back and shows "Skipping is on" or "Skipping stays off" with where to change it, for 8 s.
- **Screen readers** hear each skip and each answer through one polite live region (`role="status"`, named SponsorBlock), wherever the card itself shows.
- **Credit:** SponsorBlock's data is CC BY-NC-SA 4.0. "Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 from sponsor.ajay.app", with both links, shows under the switch and in Settings → About.

`features/sponsorblock/testing.ts` has `setupTestSponsorBlock(handler)`, a fake client the test setup removes after each test, and `testVideo` and `testSegment`. `e2e/sponsorblock.spec.ts` checks the offer, the first-session rule and the switch in a real browser, and plays the seeded music video with SponsorBlock answered by a route: the lookup goes by hash prefix only, and on 320 and 390 px phones the notice sits under Now playing's controls, which stay tappable, with focus handed back after Undo.

### Tests

`features/now-playing/testing.ts` has the helpers: `setupTestPlayback()` (the app's player on a `FakeEngine` and a `FakePolicy`, whose `resolver` is a `FakeResolver` and which reports best guesses with `reportNeedsReview`), `setupTestLyrics(handler)`, `spotifyTrack`, `testCandidate` and `syncedLyrics`. The test setup resets the player, the review list and the lyrics provider after every test. `e2e/now-playing.spec.ts` checks the restored queue, the lyrics, seeking, drag and keyboard reordering and the review in a real browser, from the saved state in `e2e/now-playing-seed.ts` (made-up songs, inline SVG artwork, LRCLIB answered by a route).
