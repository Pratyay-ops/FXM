# @fxm/site

The FXM landing page, served at `https://fxm-music.pages.dev/`. It explains what FXM is and sends people to the web app at `/app/` and to the downloads on GitHub Releases. It is a static [Astro](https://astro.build) site with no client-side framework.

## Commands

Run them from the repository root. `scripts/run.sh` loads the isolated toolchain from `.tools/` (see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)).

| Command | What it does |
|---|---|
| `scripts/run.sh pnpm --filter @fxm/site dev` | Dev server with live reload on `http://localhost:4321` (add `--port <n>` to change it) |
| `scripts/run.sh pnpm --filter @fxm/site build` | Static build into `apps/site/dist/`, then the build check (below) |
| `scripts/run.sh pnpm --filter @fxm/site preview` | Serve the build locally |
| `scripts/run.sh pnpm --filter @fxm/site e2e` | Browser checks: axe in both themes, 320 px layout, skip link, menu, tap targets, device detection |
| `scripts/run.sh pnpm --filter @fxm/site screenshots` | Every page at 320, 768 and 1280 px in both themes, plus the open phone menu, saved to `apps/site/screenshots/` |
| `scripts/run.sh pnpm --filter @fxm/site images` | Re-render `favicon-32.png`, `apple-touch-icon.png` and `og.png` from `public/favicon.svg` |

`make check` covers the site: Biome lint, `tsc`, the unit tests and the build with its check. The `e2e`, `screenshots` and `images` scripts need Chromium from `.tools/playwright` and are not part of it. They build the site and serve it on `FXM_E2E_PORT` (default 4321).

Ports are strict: the dev and preview servers fail instead of moving to another port. When Astro detects a coding agent, `astro dev` and `astro preview` start in the background; stop them with `astro dev stop` and `astro preview stop` (from `apps/site`).

## How it is built

| | |
|---|---|
| Pages | `src/pages/`: `/`, `/privacy`, `/disclaimer`, the 404 page and `robots.txt`. Each page builds to a file (`dist/privacy.html`), which Cloudflare Pages serves at `/privacy` |
| Layout | `src/layouts/Base.astro` holds the `<head>` (title, description, canonical URL, Open Graph and Twitter tags, icons, theme colour), the skip link, header and footer. `Document.astro` wraps the text pages |
| Sections | `src/components/`, one per home page section. The product illustrations (`PlayerMockup`, `demos/`) are HTML and CSS; the songs and artists in them are made up |
| Design | Every colour, space and radius is a variable in `src/styles/tokens.css`, along with the type scale, shadows and motion, using the same semantic colour names as the web app. The player illustration sizes itself in em so it scales like an image; it uses the em steps in the same file. Fixed sizes of single components (icon tiles, artwork) stay in the components. Dark by default, light through `prefers-color-scheme`, one violet accent. System fonts, no web fonts |
| JavaScript | None by default, and every page works without it. Two small inline module scripts enhance it: `GetFxm.astro` suggests the download card for the visitor's device (only apps that are out), and `Header.astro` closes the phone menu after a link is chosen, on Escape and on a click elsewhere. Without them, the Download button shows all three cards and the menu closes from its own button |
| Navigation | The header shows its links from 48rem (768 px). Below that they sit behind a menu button, a `<details>` element, so the menu needs no JavaScript |
| Components | `Icon` and `ComingSoon` pass on the parent's `data-astro-cid-*` attribute, so a parent's scoped styles (such as `.highlights svg`) reach them. A new component that a parent styles must do the same |
| Constants | `src/config.ts`: the site URL, the `/app/` path, the GitHub links and `AVAILABLE`, the map of what is released |

Content rules:

- Mention YouTube, Spotify and other services in plain text only: never their logos, brand colours or lookalike names.
- Mark anything that is not released yet as "Coming soon", and don't promise more than the apps do. What is released lives in one place, `AVAILABLE` in `src/config.ts`; the "Coming soon" badges (`ComingSoon.astro`), the download cards and their buttons, the device suggestion and the sentences that mention unreleased features all read it. When a stage ships a feature, flip its flag, then search for `AVAILABLE.<name>` to review the copy around it.
- Spotify is on by default wherever FXM can reach it (docs/ARCHITECTURE.md §11), so describe it as built in and switchable, not as opt-in.
- FXM Connect only adjusts headers on the web app's own requests; the web app makes the requests. Don't describe the extension as fetching or playing anything.
- When the apps start talking to a new service, add it to the privacy page and change its `updated` date.
- Astro 7 removes line breaks around elements by default (`compressHTML: 'jsx'`), which glues words together when the formatter wraps a line at a link. The site uses `compressHTML: true` (normal HTML whitespace) instead.
- Biome formats `.astro` files with its experimental full support (`biome.json`). If `make lint` still reports formatting right after `make format`, run `make format` once more.

## Checks

- **Build check** (`src/lib/build-check.ts`, run by `src/integrations/build-check.ts` after every build). The build fails when a page has no `lang`, viewport, title, description, canonical URL matching its route, or Open Graph and Twitter tags; when an internal link or `#fragment` doesn't resolve; when a `target="_blank"` link lacks `rel="noopener noreferrer"`; when a script, stylesheet or icon comes from another site; when headings skip a level, ids repeat, images lack `alt`, link text is empty or generic, or words are glued to a link; and when the sitemap or `robots.txt` doesn't match the pages.
- **Unit tests** (`src/**/*.test.ts`, part of `make test`): the build check, URL helpers, device detection (which never suggests an unreleased app), the flag-driven sentences in `src/lib/copy.ts`, and WCAG AA contrast of every colour pair in both themes.
- **Browser checks** (`e2e/smoke.spec.ts`): axe (WCAG 2.2 AA and best practices) on every page in both themes, no horizontal scrolling at 320 px, the skip link, the colour scheme, reduced motion, the phone menu (opens, closes after a link and on Escape) and the header links at 768 and 1280 px, 44 px tap targets on phones, and the device suggestion (only released apps, nothing on phones while no app is out).

## Deploying with the web app

The site and the web app (`apps/web`) are deployed together to the Cloudflare Pages project `fxm-music`. `make dist` (stage 2.8) builds both into `dist/pages/`, the site at `/` and the app at `/app/`, and writes the `_headers` file; [scripts/build-dist/README.md](../../scripts/build-dist/README.md) has the details.

- Links to `/app/` are not checked by the build check (`EXTERNAL_PATHS` in `src/config.ts`), because the web app is not part of this build.
- `404.html` at the root belongs to the site: Cloudflare Pages serves it with status 404 for unknown paths. The web app answers its client-side routes with `app/404.html`, a copy of its `index.html` that `make dist` writes. A `_redirects` rule can't do this: on Pages, redirects win over files, so it would catch the app's scripts too.
- `robots.txt` and the sitemap belong to the site. Add `/app/` to the sitemap there if the web app should be indexed.
- Each page gets its own Content-Security-Policy, which allows its inline `<style>` blocks and module scripts by hash. `make dist` fails when a page gains something a hash can't allow: a `style` attribute, an inline event handler, a `javascript:` link, or a script or stylesheet from another site.
- `make dist` also checks this site's privacy page: every service whose hosts the web app's policy allows must be in its list of services.
