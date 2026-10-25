# @fxm/web

The FXM web player: a React app served from `/app/`, installable as an app with its own window (a PWA, see [Installable app](#installable-app-pwa)), and the shell of the Android and desktop apps. Everything runs in the browser: there is no FXM backend.

Stage 2.1 built the **shell**: routing, layout, design system, settings and placeholder pages. Search results, playback and the library plug into it in later stages; stage 5.1 made it installable.

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
scripts/run.sh pnpm --filter @fxm/web e2e          # smoke test (navigation, Back, settings across reloads, keyboard focus, no overflow at 320 px) and the PWA test (e2e/pwa.spec.ts)
scripts/run.sh pnpm --filter @fxm/web screenshots  # every page at 320/768/1280/1920 px in both themes, plus Music + Video and forced colors, and the PWA's states at 320/768/1280 px, in apps/web/screenshots/
scripts/run.sh pnpm --filter @fxm/web icons        # re-render the app icons in public/ from pwa/icons.ts
```

Every run builds this checkout and starts its own `vite preview` on port 4173 with `--strictPort`. If the port is busy, for example with another worktree's preview, the run fails instead of testing that server: set `FXM_E2E_PORT` to a free port (not 6000, which Chromium refuses to load). Screenshots and Playwright output are gitignored. Service workers are blocked in every spec except `e2e/pwa.spec.ts`, which runs its tests one at a time because it publishes new versions of `dist/sw.js` (and puts the original back when it ends).

The PWA spec's two tests that really install FXM (into a temporary browser profile with its own home folder) run on Linux, where CI runs them, and elsewhere only with `FXM_E2E_INSTALL=1`: an install also registers the app with the operating system. They uninstall it afterwards, and on macOS make LaunchServices forget the app, even when a test fails or times out. Screenshot runs skip them.

## Layout

```
index.html              viewport, theme-color, inline SVG favicon, iOS Home Screen icon and name, theme script
                        that runs before the first paint (the PWA plugin adds the manifest link at build time)
public/                 app icons (rendered by scripts/render-icons.ts, committed)
pwa/                    build-time PWA config: base, manifest, service worker options, icon art, host needs
scripts/                render-icons.ts
src/
  main.tsx              starts the service worker and the install offer, creates the browser router and renders <App>
  app/                  App (providers), routes, router, query client, error screens, 404
  components/
    layout/             AppLayout, Sidebar, TopBar, BottomNav, SearchField, RouteAnnouncer, route metadata
    media/              collection header, card/track/video placeholders
    ui/                 design-system pieces: buttons, IconButton, SegmentedControl, Tabs,
                        RangeSlider, Skeleton, EmptyState, ErrorState, Artwork, Logo
  features/<name>/      one folder per feature: home, search, library, album, artist,
                        playlist, now-playing, player (bar, controls, store), settings, pwa
  lib/                  small helpers (class names, safe storage, media queries, seeds)
  styles/               index.css (base, components, utilities) and tokens.css (design tokens)
  test/                 Vitest setup and the renderApp() helper
e2e/                    Playwright smoke test, PWA test and screenshot capture
```

Later stages own their feature folders (`features/search`, `features/now-playing`, `features/library`, …, see [PLAN.md](../../docs/PLAN.md)), so the shell rarely needs to change.

## How it works

- **Routing:** React Router 7 in data mode (`createBrowserRouter`, library mode, no framework plugin), which is what makes `errorElement` and lazy route modules work. The basename is `import.meta.env.BASE_URL` unchanged (`base: '/app/'` in `vite.config.ts`): with the trailing slash, links to Home point at `/app/`, which Vite serves (`/app` is a 404 there). Home and Search ship with the shell; the other pages are lazy chunks. React Router 8 needs Node 22.22+, newer than the toolchain's Node, so it is a later upgrade.
- **Layout:** desktop (1024 px+) has the sidebar, top bar and player bar; tablets (768–1023 px) get an icon rail; phones (< 768 px) get a top bar with the page title, a mini player and a tab bar. The page scrolls with the window, so mobile browser bars collapse and `<ScrollRestoration>` works. Bottom bars pad for `env(safe-area-inset-bottom)`. `--shell-top` and `--shell-bottom` (in `styles/index.css`) hold the height the bars cover; `html` uses them as `scroll-padding`, so keyboard focus never lands behind a bar. Page content and the top bar row share `max-w-page`.
- **State:** Zustand. `features/settings/settings-store.ts` persists `{ catalogMode, theme }` to `localStorage` under `fxm.settings.v1`; invalid or unreadable data falls back to the defaults, and other open tabs follow changes. `features/player/player-store.ts` is placeholder UI state: every control responds, nothing plays. TanStack Query is set up with no queries yet.
- **Theme:** dark by default, plus light and system. `data-theme` on `<html>` switches the tokens; the inline script in `index.html` applies the saved theme before React loads (a content security policy must allow it by hash).
- **Errors:** page errors render inside the shell with "Try again" (`RouteError`); a broken shell falls back to a full-page error, and `AppErrorBoundary` wraps everything. Error screens are announced to screen readers (`role="alert"`).
- **Accessibility:** a skip link focuses `<main>` without touching the history, `RouteAnnouncer` tells screen readers which page a link opened, and forced colors (Windows High Contrast) keep sliders, segmented controls and tabs readable.

## Installable app (PWA)

[vite-plugin-pwa](https://vite-pwa-org.netlify.app/) builds the manifest and a Workbox service worker from `pwa/`; the browser side is `src/features/pwa/`.

**Manifest** (`pwa/manifest.ts`). The id, start URL and scope are `/app/`; the id names the installed app, so it never changes. The app opens in its own window (`standalone`), on desktop with Window Controls Overlay (`display_override`). Icons: 192 and 512 px, plain and maskable (`pwa/icons.ts` draws them from the logo mark; `pnpm icons` renders the PNGs in `public/`), plus `apple-touch-icon.png` for iOS. Shortcuts open Search and the library. `launch_handler` (`focus-existing`) brings an open FXM window to the front instead of starting a second player, and `useLaunchQueue` opens the page the launch asked for inside it, so the music keeps playing.

**Service worker** (`pwa/options.ts`).

- **Shell only.** It precaches the build's HTML, scripts, styles and icons (and the manifest), so the player opens without a connection, and answers navigations inside `/app/` with the cached `index.html`. There is no runtime caching: audio, googlevideo, the music services' APIs, artwork and everything else go to the network untouched and are never stored. A precached file may be at most 2 MiB; a bigger chunk fails the build, so split it or leave it out of `PRECACHE_PATTERNS`.
- **Scope `/app/`.** The site (`/`), the embed (`/embed/`) and the sandbox documents (`/sandbox/`) are outside it.
- **Updates ask first.** A new version installs in the background and waits. The update toast offers "Reload" (`applyUpdate`, which activates it) or "Not now" (the new version starts the next time FXM opens), because reloading stops the music. Once the new version takes over, every open FXM window and tab reloads into it, whichever one the user chose Reload in: the old pages' code belongs to the old version, whose files the new one deletes. "Not now" holds until a newer version arrives (Workbox reports one waiting version twice, 200 ms apart). An open window asks the site for a new version every hour (`registerServiceWorker` in `service-worker.ts`).
- **Headers are part of the version.** The worker answers navigations with its stored copy of `index.html`, and with the headers that copy came with, the CSP among them. It stores the page again only when the page's precache revision changes, so the build folds the host's `/app/*` header rule into that revision (`headersRevision` in `pwa/host.ts`, `revisionPageWithHeaders` in `pwa/options.ts`): a deploy that changes only the headers still ships a new worker and the update toast.
- **No inline script.** `main.tsx` registers the worker from the bundle, and the Workbox runtime is inlined into `sw.js`, so the page's CSP needs nothing new beyond allowing `'self'` for the worker, the manifest, the icons and the shell download (`pwa/host.ts`).
- **Web only.** `build:mobile` and `build:desktop` use base `/`, which turns the plugin off: the Android and desktop apps load the app from their package and get no service worker or manifest. `make dev` has no service worker either.

**Install offer.** Chromium offers to install FXM with `beforeinstallprompt`; `listenForInstallPrompt` keeps the offer (which also stops Chrome on Android from showing its own banner over the player). While there is one:

- from 768 px, the top bar shows an "Install app" pill (`install-button.tsx`);
- on phones, the Home page shows a card with Install and Not now (`install-card.tsx`), so the top bar keeps its room for the page title, also with large text;
- Settings → App → Install app has an Install button (`install-setting.tsx`). Without an offer it says how to install in this browser: Share → Add to Home Screen on iPhone and iPad, File → Add to Dock in Safari on a Mac.

The icon is a screen with an arrow with a mouse and a square with a plus on touch screens, never the plain down arrow, which reads as "download". "Not now", or closing the browser's install dialog, puts the top bar's and the Home page's offer off for 30 days (`snoozeInstallOffer`, stored under `fxm.pwa.v1`); Settings still offers it. A used offer removes its button, so focus moves first: to the top bar's Settings link, the page, or the setting's help text, which then says that FXM is installed. Only the web build shows any of this (`isInstallableWebApp` in `web-app.ts`): the Android and desktop apps are installed already.

**Title bar** (`title-bar.ts`). In an installed desktop window with Window Controls Overlay, the page draws the title bar, and the top bar is it: the browser draws only the window buttons, on the left on macOS and on the right elsewhere. While the overlay shows, `useTitleBar` sets `data-titlebar` and the window buttons' insets (`--titlebar-left`, `--titlebar-right`, from `getTitlebarAreaRect()`) on `<html>`. The end of `styles/index.css` then makes the top bar and the sidebar's logo row drag the window (their links, buttons and search box stay clickable), pads the top bar's row and moves the sidebar's logo clear of the window buttons (the icon rail's logo makes way for buttons on the left), and keeps the skip link below the top bar (`--overlay-top`). The user can switch the overlay off from the window's title bar; all of that then goes.

**Update toast** (`update-toast.tsx`). A landmark ("App update") in a live region, above the player. On a phone's Now Playing, whose own controls take the bottom of the screen, it shows below the top bar instead (`fullScreen`, from `AppLayout`). Escape works like "Not now", and both give focus back to where it came from, or to the page. Its buttons wrap with large text.

**Media keys** (`media-keys.ts`). `useMediaKeys` connects the app's player to the Media Session with `connectMediaSession` from `@fxm/player`: the keyboard's media keys, headset buttons, the lock screen and the system's media controls play, pause, skip and seek, and show the track.

**Not merged yet.** Stage 5.1 started before two stages it touches; each touch-point is one small interface with a stand-in, which the integration step replaces:

| Touch-point | Where | Stand-in until then |
|---|---|---|
| The app's player (2.5), for the media keys | `appPlayerSource` in `src/features/pwa/integration.ts` | No player, so the Media Session stays unconnected |
| Now Playing on phones (2.5), for the update toast | `<PwaShell fullScreen>` in `AppLayout`: pass 2.5's full-screen flag | `pathname === '/now-playing'`, the condition that hides the mini player |
| The static host's headers (2.8) | `pwa/host.ts`: the CSP directives and the files that must not be cached for long | The `/app/*` policy from PLAN.md §2.8 (`PLANNED_APP_CSP`) |
| The `/app/*` header rule (2.8), in the page's precache revision | `APP_HEADERS` in `pwa/host.ts`, which `vite.config.ts` hashes: 2.8 hands the build the rule its `_headers` generator writes (or its hash) | The same PLAN.md §2.8 rule, with `Referrer-Policy` and `X-Content-Type-Options` |

**Tests.** Unit tests cover the manifest, the plugin options, the icons, the host's CSP and header revision, registration and updates (other windows, repeated reports), the install offer, card, snooze and hints, the web-build check, the title bar, launches, the update toast (landmark, Escape, focus) and the media keys. `e2e/pwa.spec.ts` checks in Chromium that FXM is installable (no installability errors, the real install offer; with installs on, an install through the DevTools protocol and a launch that opens its page in the open window without a reload), that the shell opens offline, that only shell files are cached and media and API requests pass the service worker by, and the update flow: a first visit and a returning one reload once into the new version, "Not now" holds, and other tabs follow. It also checks that the update toast keeps clear of the player controls at 320 px, and Window Controls Overlay with the window buttons on either side at 480, 768 and 1280 px: the top bar drags the window, nothing clickable sits under the buttons, and the skip link shows below the title bar.

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
