# @fxm/site

The FXM landing page, served at `https://fxm-music.pages.dev/`. It explains what FXM is and sends people to the web app at `/app/` and to the downloads on GitHub Releases. It is a static [Astro](https://astro.build) site with no client-side framework.

## Commands

Run them from the repository root. `scripts/run.sh` loads the isolated toolchain from `.tools/` (see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)).

| Command | What it does |
|---|---|
| `scripts/run.sh pnpm --filter @fxm/site dev` | Dev server with live reload on `http://localhost:4321` (add `--port <n>` to change it) |
| `scripts/run.sh pnpm --filter @fxm/site build` | Static build into `apps/site/dist/`, then the build check (below) |
| `scripts/run.sh pnpm --filter @fxm/site preview` | Serve the build locally |
| `scripts/run.sh pnpm --filter @fxm/site e2e` | Browser checks: axe in both themes, 320 px layout, skip link, device detection |
| `scripts/run.sh pnpm --filter @fxm/site screenshots` | Every page at 320, 768 and 1280 px in both themes, saved to `apps/site/screenshots/` |
| `scripts/run.sh pnpm --filter @fxm/site images` | Re-render `favicon-32.png`, `apple-touch-icon.png` and `og.png` from `public/favicon.svg` |

`make check` covers the site: Biome lint, `tsc`, the unit tests and the build with its check. The `e2e`, `screenshots` and `images` scripts need Chromium from `.tools/playwright` and are not part of it. They build the site and serve it on `FXM_E2E_PORT` (default 4321).

Ports are strict: the dev and preview servers fail instead of moving to another port. When Astro detects a coding agent, `astro dev` and `astro preview` start in the background; stop them with `astro dev stop` and `astro preview stop` (from `apps/site`).

## How it is built

| | |
|---|---|
| Pages | `src/pages/`: `/`, `/privacy`, `/disclaimer`, the 404 page and `robots.txt`. Each page builds to a file (`dist/privacy.html`), which Cloudflare Pages serves at `/privacy` |
| Layout | `src/layouts/Base.astro` holds the `<head>` (title, description, canonical URL, Open Graph and Twitter tags, icons, theme colour), the skip link, header and footer. `Document.astro` wraps the text pages |
| Sections | `src/components/`, one per home page section. The product illustrations (`PlayerMockup`, `demos/`) are HTML and CSS; the songs and artists in them are made up |
| Design | Every colour, size, space and radius is a variable in `src/styles/tokens.css`, using the same semantic colour names as the web app. Dark by default, light through `prefers-color-scheme`, one violet accent. System fonts, no web fonts |
| JavaScript | None by default. One small inline module script in `GetFxm.astro` suggests the download card for the visitor's device; without it, the Download button shows all three cards |
| Constants | `src/config.ts`: the site URL, the `/app/` path and the GitHub links |

Content rules:

- Mention YouTube, Spotify and other services in plain text only: never their logos, brand colours or lookalike names.
- Mark anything that is not released yet as "Coming soon", and don't promise more than the apps do.
- When the apps start talking to a new service, add it to the privacy page and change its `updated` date.
- Astro 7 removes line breaks around elements by default (`compressHTML: 'jsx'`), which glues words together when the formatter wraps a line at a link. The site uses `compressHTML: true` (normal HTML whitespace) instead.
- Biome formats `.astro` files with its experimental full support (`biome.json`). If `make lint` still reports formatting right after `make format`, run `make format` once more.

## Checks

- **Build check** (`src/lib/build-check.ts`, run by `src/integrations/build-check.ts` after every build). The build fails when a page has no `lang`, viewport, title, description, canonical URL matching its route, or Open Graph and Twitter tags; when an internal link or `#fragment` doesn't resolve; when a `target="_blank"` link lacks `rel="noopener noreferrer"`; when a script, stylesheet or icon comes from another site; when headings skip a level, ids repeat, images lack `alt`, link text is empty or generic, or words are glued to a link; and when the sitemap or `robots.txt` doesn't match the pages.
- **Unit tests** (`src/**/*.test.ts`, part of `make test`): the build check, URL helpers, device detection, and WCAG AA contrast of every colour pair in both themes.
- **Browser checks** (`e2e/smoke.spec.ts`): axe (WCAG 2.2 AA and best practices) on every page in both themes, no horizontal scrolling at 320 px, the skip link, the colour scheme, reduced motion and the device suggestion.

## Deploying with the web app

The site and the web app (`apps/web`) are deployed together to the Cloudflare Pages project `fxm-music`. Stage 2.8 (static deploy) composes one `dist/` folder:

```
dist/
├── index.html, privacy.html, disclaimer.html, 404.html   ← apps/site/dist
├── robots.txt, sitemap-index.xml, sitemap-0.xml
├── favicon.svg, favicon-32.png, apple-touch-icon.png, og.png, _astro/
├── app/                                                  ← the web app (apps/web, base /app/)
└── embed/                                                ← the embeddable mini-player (stage 5.2)
```

Notes for that stage:

- Links to `/app/` are not checked by the build check (`EXTERNAL_PATHS` in `src/config.ts`), because the web app is not part of this build.
- `404.html` at the root belongs to the site: Cloudflare Pages serves it with status 404 for unknown paths. The web app needs its own fallback for its client-side routes, such as a `_redirects` rule `/app/* /app/index.html 200`.
- `robots.txt` and the sitemap belong to the site. Add `/app/` to the sitemap there if the web app should be indexed.
- The site uses a few small inline `<style>` blocks and one inline module script. The Content Security Policy in `_headers` must allow them by hash, or allow `'unsafe-inline'` for styles.
