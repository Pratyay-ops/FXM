# @fxm/web

The FXM web player: a React app served from `/app/`, which later also becomes the installable web applet (stage 5.1) and the shell of the Android app (stage 6.1). Everything runs in the browser: there is no FXM backend.

This stage (2.1) is the **shell**: routing, layout, design system, settings and placeholder pages. Search results, playback and the library plug into it in later stages.

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
scripts/run.sh pnpm --filter @fxm/web e2e          # smoke test: navigation, settings across reloads, no overflow at 320 px
scripts/run.sh pnpm --filter @fxm/web screenshots  # every page at 320/768/1280 px, dark and light, in apps/web/screenshots/
```

Both build the app and start `vite preview` on port 4173. Set `FXM_E2E_PORT` to use another port; a preview server already running on that port is reused. Screenshots and Playwright output are gitignored.

## Layout

```
index.html              viewport, theme-color, inline SVG favicon, theme script that runs before the first paint
src/
  main.tsx              creates the browser router and renders <App>
  app/                  App (providers), routes, router, query client, error screens, 404
  components/
    layout/             AppLayout, Sidebar, TopBar, BottomNav, SearchField, route metadata
    media/              collection header, card/track/video placeholders
    ui/                 design-system pieces: buttons, IconButton, SegmentedControl, Tabs,
                        RangeSlider, Skeleton, EmptyState, ErrorState, Artwork, Logo
  features/<name>/      one folder per feature: home, search, library, album, artist,
                        playlist, now-playing, player (bar, controls, store), settings
  lib/                  small helpers (class names, safe storage, media queries, seeds)
  styles/               index.css (base, components, utilities) and tokens.css (design tokens)
  test/                 Vitest setup and the renderApp() helper
e2e/                    Playwright smoke test and screenshot capture
```

Later stages own their feature folders (`features/search`, `features/now-playing`, `features/library`, …, see [PLAN.md](../../docs/PLAN.md)), so the shell rarely needs to change.

## How it works

- **Routing:** React Router 7 in data mode (`createBrowserRouter`, library mode, no framework plugin), which is what makes `errorElement` and lazy route modules work. The basename comes from `import.meta.env.BASE_URL` (`base: '/app/'` in `vite.config.ts`). React Router 8 needs Node 22.22+, newer than the toolchain's Node, so it is a later upgrade.
- **Layout:** desktop (1024 px+) has the sidebar, top bar and player bar; tablets (768–1023 px) get an icon rail; phones (< 768 px) get a top bar with the page title, a mini player and a tab bar. The page scrolls with the window, so mobile browser bars collapse and `<ScrollRestoration>` works. Bottom bars pad for `env(safe-area-inset-bottom)`.
- **State:** Zustand. `features/settings/settings-store.ts` persists `{ catalogMode, theme }` to `localStorage` under `fxm.settings.v1`; invalid or unreadable data falls back to the defaults, and other open tabs follow changes. `features/player/player-store.ts` is placeholder UI state: every control responds, nothing plays. TanStack Query is set up with no queries yet.
- **Theme:** dark by default, plus light and system. `data-theme` on `<html>` switches the tokens; the inline script in `index.html` applies the saved theme before React loads (a content security policy must allow it by hash).
- **Errors:** page errors render inside the shell with "Try again" (`RouteError`); a broken shell falls back to a full-page error, and `AppErrorBoundary` wraps everything.

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
- Icon-only buttons need a `label` (it becomes `aria-label`); toggles use `pressed` (`aria-pressed`). Touch targets stay at least 44 px below 1024 px and on touch screens (`size-touch`). Focus rings come from the global `:focus-visible` style; don't remove outlines.
- Respect reduced motion: transitions and animations are shortened globally, skeletons stop shimmering.
- Respect the catalog mode wherever results appear: `useSettingsStore((s) => s.catalogMode)`. Music shows catalog songs only; Music + Video also shows videos, played as music.
- Tests use `renderApp(path)` from `src/test/render.tsx`, which renders the real providers and routes with a memory router. Stores and `localStorage` are reset after every test.
