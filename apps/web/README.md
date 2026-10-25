# @fxm/web

The FXM web player: a React app served from `/app/`, which later also becomes the installable web applet (stage 5.1) and the shell of the Android app (stage 6.1). Everything runs in the browser: there is no FXM backend.

Stage 2.1 built the **shell**: routing, layout, design system, settings and placeholder pages. Stage 2.6 added the **library** (playlists in an order the user controls, likes, follows, history, backups) on IndexedDB. Stage 4.4 added **local files**: music on the device, read where it is, listed in the Library and in search and played through the player core. Search results and playback plug into it in later stages.

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
scripts/run.sh pnpm --filter @fxm/web e2e          # smoke test: navigation, Back, settings across reloads, keyboard focus, no overflow at 320 px, playlist order by keyboard and mouse across reloads; local files read and played in Chromium
scripts/run.sh pnpm --filter @fxm/web screenshots  # every page at 320/768/1280/1920 px in both themes, plus Music + Video and forced colors, in apps/web/screenshots/
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
  db/                   the library database: schema and migrations, repository, live-query
                        hooks, ordering, match cache, backups (see src/db/README.md)
  features/<name>/      one folder per feature: home, search, library, album, artist,
                        playlist, now-playing, player (bar, controls, store), settings
  lib/                  small helpers (class names, safe storage, media queries, seeds)
  styles/               index.css (base, components, utilities) and tokens.css (design tokens)
  test/                 Vitest setup and the renderApp() helper
e2e/                    Playwright smoke test and screenshot capture; fixtures/ holds a library backup to restore
```

Later stages own their feature folders (`features/search`, `features/now-playing`, `features/library`, …, see [PLAN.md](../../docs/PLAN.md)), so the shell rarely needs to change.

## How it works

- **Routing:** React Router 7 in data mode (`createBrowserRouter`, library mode, no framework plugin), which is what makes `errorElement` and lazy route modules work. The basename is `import.meta.env.BASE_URL` unchanged (`base: '/app/'` in `vite.config.ts`): with the trailing slash, links to Home point at `/app/`, which Vite serves (`/app` is a 404 there). Home and Search ship with the shell; the other pages are lazy chunks. React Router 8 needs Node 22.22+, newer than the toolchain's Node, so it is a later upgrade.
- **Layout:** desktop (1024 px+) has the sidebar, top bar and player bar; tablets (768–1023 px) get an icon rail; phones (< 768 px) get a top bar with the page title, a mini player and a tab bar. The page scrolls with the window, so mobile browser bars collapse and `<ScrollRestoration>` works. Bottom bars pad for `env(safe-area-inset-bottom)`. `--shell-top` and `--shell-bottom` (in `styles/index.css`) hold the height the bars cover; `html` uses them as `scroll-padding`, so keyboard focus never lands behind a bar. Page content and the top bar row share `max-w-page`.
- **State:** Zustand. `features/settings/settings-store.ts` persists `{ catalogMode, theme }` to `localStorage` under `fxm.settings.v1`; invalid or unreadable data falls back to the defaults, and other open tabs follow changes. `features/player/player-store.ts` is placeholder UI state: every control responds, nothing plays. TanStack Query is set up for data from the network, with no queries yet.
- **Library:** IndexedDB through Dexie, in `src/db/` (its [README](src/db/README.md) has the schema, migrations and why orders are stored as they are). Pages read with live queries (`src/db/hooks.ts`), so every view of a playlist, the sidebar and the like buttons update together, in every tab. `features/library/` holds the Library page (`/library?tab=…`: Playlists, Liked songs, Downloads, Artists, Albums, Recently played), the page of a local playlist (`/playlist/local:playlist:…`, chosen by `app/playlist-route.tsx`; other sources' playlists stay with `features/playlist`), the sidebar's playlists and the backup dialog.
- **Local files:** `features/local-files/` (its [README](src/features/local-files/README.md) has the details) lists the music files of a folder the browser keeps access to (Chromium's File System Access API, the handle in IndexedDB) or of files chosen through a file input, with tags and covers from music-metadata, in the Library's Local files tab (`/library?tab=local`) and as "On this device" on the search page. They play through the player core from object URLs; FLAC, ALAC and WAV are labelled lossless, nothing else is. Its own database, `fxm-local-files`, stays out of backups.
- **Ordering:** every playlist, Liked songs and Downloads included, and the list of playlists keep a custom order the user controls: drag and drop on dnd-kit (pointer, touch and keyboard: Space picks a row up, the arrow keys move it, Space drops it, Escape cancels), Move up, down, to top and to bottom in each row's menu, multi-select moves, **Shuffle order** (a permanent random order, with Undo until the next change) and sort views by title, artist, album, date added or duration that "Save as custom order" makes permanent. In the sidebar a row drags by itself (with the mouse after a few pixels, by a long press on touch); its menu has the moves. Long lists skip the drag animations, and their rows re-render only when their own data changes.
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
- Tests use `renderApp(path)` from `src/test/render.tsx`, which renders the real providers and routes with a memory router. Stores, `localStorage` and the library database (fake-indexeddb) are reset after every test. Behaviour that depends on the browser history (basename, back and forward, the skip link) is tested with the real browser router in `src/app/router.test.tsx`.
- Read and write the library only through the repository: `getLibrary()` for writes, the hooks in `src/db/hooks.ts` for reads. Never open Dexie tables directly. Seed tests with `getLibrary()`, or use `testRepo()` and `track()` from `src/test/library-fixtures.ts`. happy-dom lays nothing out, so drag-and-drop tests give rows positions first (see `stubRowLayout` in `features/library/library-page.test.tsx`).
