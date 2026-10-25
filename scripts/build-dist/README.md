# @fxm/deploy: make dist and the deploy checks

`make dist` composes everything Cloudflare Pages serves at `https://fxm-music.pages.dev` into one folder, `dist/pages/`, and the deploy workflow uploads that folder (docs/PLAN.md, stage 2.8). There are no Pages Functions and no Worker: only static files and a generated `_headers` file.

```
dist/pages/
├── index.html, privacy.html, disclaimer.html, 404.html, robots.txt, sitemap…, _astro/   the site (apps/site)
├── .well-known/security.txt                                                          the site's public/ (R.4)
├── app/              the web app (apps/web, base /app/), plus app/404.html for its client-side routes
├── embed/            the embeddable player (5.2), once it exists
├── sandbox/          innertube.html and userhost.html (1.10), eval.html (1.11), once they exist
├── third-party-notices.txt
└── _headers          one Content-Security-Policy per path
```

## Commands

Run them from the repository root.

| Command | What it does |
|---|---|
| `make dist` | Builds the site and the app, composes `dist/pages/` and runs every check below. Takes a few seconds once the dependencies are installed |
| `scripts/run.sh pnpm --filter @fxm/deploy preview` | Serves `dist/pages/` the way Cloudflare Pages does (redirects, 404 pages, `_headers`) at `http://127.0.0.1:5800` (`FXM_PREVIEW_PORT` to change it; the port is strict) |
| `scripts/run.sh pnpm --filter @fxm/deploy check:headers <url>` | The header check of a deployment (below), for example `https://develop.fxm-music.pages.dev` |
| `scripts/run.sh pnpm --filter @fxm/deploy e2e` | The browser checks: against `FXM_DEPLOY_URL` if set, otherwise against `dist/pages/` served on port 5800. Needs Chromium from `.tools/playwright` (`scripts/run.sh pnpm --filter @fxm/deploy exec playwright install chromium`) |

`make test` runs this package's unit tests with everything else; they need no network and no build.

## What make dist does

1. **Builds each part** into `dist/.staging/`: the site with `apps/site`'s own config plus hidden source maps (`site.astro.config.mjs`), the app with `vite build --sourcemap hidden`. The embed and the sandbox documents come from stages that haven't merged yet; `src/later-stages.ts` holds those touch-points, and they are skipped while they don't exist.
2. **Lists the bundled npm packages** from the source maps (every source under `node_modules/`) and from `/*! name vX.Y.Z` banners in stylesheets, such as Tailwind's base styles. It fails when one is GPL or AGPL, has no licence, or has a licence that isn't SPDX (ARCHITECTURE.md §17 and §18), and when JavaScript ships without a source map, because then nobody knows what it contains. After a human review, `LICENCE_OVERRIDES` in `src/licenses.ts` can record a licence a package doesn't declare.
3. **Composes** the parts under their paths, refusing two parts that write the same file, and copies each single-page app's `index.html` to its `404.html`. Source maps are never deployed: they would publish the build machine's paths.
4. **Writes `third-party-notices.txt`** with every bundled package, its licence and its licence files.
5. **Writes `_headers`** and checks it: at most 100 rules, no line over 2,000 characters, no two rules matching one path, and every path a file is served at matched by exactly one rule. It reads the file back with a parser that follows Cloudflare's, so the file means exactly the rules it generated.
6. **Checks the privacy page**: every host a policy names must belong to a service in `APP_SERVICES`, and `privacy.html` must list that service.
7. **Refuses** `_worker.js`, `_routes.json`, `_redirects` and `functions/`, more than 20,000 files and files over 25 MiB (Cloudflare Pages' limits).

Only then does `dist/pages/` replace the previous build.

## Header rules

Cloudflare gives a request the headers of every `_headers` rule that matches it and joins a header two rules set with a comma, which would enforce two policies at once. So no two rules match the same path, and none uses `/*`. Every rule sets `Content-Security-Policy`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

| Files | Rule | Policy (`src/policies.ts`) |
|---|---|---|
| `app/**` | `/app/*` | `appPolicy()`: the policy in docs/PLAN.md, with the hash of the app's inline theme script |
| `embed/**` | `/embed/*` | `appPolicy({ embeddable: true })`: the same without `frame-ancestors` |
| `sandbox/<doc>.html` | `/sandbox/<doc>` and `/sandbox/<doc>.html` | `SANDBOX_DOCUMENTS`: `sandbox allow-scripts`, the document's inline script by hash, and its hosts |
| each other `.html` page | its path and its `.html` path, such as `/privacy` and `/privacy.html` | `sitePagePolicy()`: that page's own inline scripts and styles by hash, its own files |
| `_astro/**`, `.well-known/**` | `/_astro/*`, `/.well-known/*` | `STATIC_FILE_POLICY`: nothing allowed |
| each other file | its path | `STATIC_FILE_POLICY` |

Things Cloudflare does that the rules account for (from wrangler 4.149's copy of the Pages asset server, read 2026-10-26, and confirmed on a real deployment the same day):

- **Pages serves `x.html` at `/x`** and answers `/x.html` with a 308 redirect, `/index.html` and `/app` too. A sandbox document framed as `/sandbox/innertube.html` therefore ends up at `/sandbox/innertube`, which must carry the sandbox policy: each document gets a rule for both paths. The plan lists the 404 page as `/404.html`; it is served at `/404`.
- **`_redirects` rules win over files.** A rule such as `/app/* /app/index.html 200` would send the app's own scripts back as HTML. Pages serves the nearest `404.html` for a path no file answers, so the app's routes get `app/404.html`, a copy of its `index.html`, with status 404; the app reads the URL and shows the page.
- **Headers apply to the request path**, so a 404 under `/app/` gets the app's policy. A path no rule matches, such as a mistyped page at the root, gets the site's 404 page with Cloudflare's defaults (`Referrer-Policy: strict-origin-when-cross-origin`) and no policy; it is a static page with nothing to protect.

### When a stage adds a service

A stage that makes the web app contact a new service adds it to `APP_SERVICES` in `src/policies.ts`, with its `connect` and `img` hosts and its name exactly as the privacy page lists it, and adds it to `apps/site/src/pages/privacy.astro` (docs/PLAN.md, Definition of done). 4.2 adds `WASM_UNSAFE_EVAL` to `APP_SCRIPT_EXTRAS`. Nothing else changes; `make dist` fails if the page misses the service.

## Deploying

`.github/workflows/deploy.yml` runs `make dist` on every push. A push to `develop` deploys to the preview at `https://develop.fxm-music.pages.dev`; a push to `main`, which only release pull requests and hotfixes reach, deploys to production at `https://fxm-music.pages.dev`. `workflow_dispatch` redeploys a branch by hand.

- **Owner setup:** a free Cloudflare account and two repository secrets, `CLOUDFLARE_API_TOKEN` (a token with Account > Cloudflare Pages > Edit) and `CLOUDFLARE_ACCOUNT_ID`.
- **The Pages project** is `fxm-music`, with `main` as its production branch, deployed by direct upload (`wrangler pages deploy`). The first deploy creates it. Use Pages, not Workers, even though Cloudflare's dashboard and wrangler suggest Workers for new static projects; since wrangler 4.108 an AI agent running `wrangler pages` on its own machine is redirected to Workers unless the project exists, which is one more reason deploys run only in CI.
- **The token** is only in the deploy job, which runs nothing but `scripts/build-dist-wrangler/deploy.sh` and wrangler. wrangler is pinned with its own lockfile in `scripts/build-dist-wrangler/` (a separate pnpm root, so `make setup` never downloads its 200 MB of binaries) and installed without a cache.
- **After each deploy** the verify job runs the header check and the browser checks against the new deployment's own address. On a project's first deploy it first waits for that address to answer: the certificate for a new project's sub-domains arrived 2.5 minutes after its first deploy (measured 2026-10-26).
- **If the project can't be created**, Cloudflare answers with its generic error 8000000. On 2026-10-26 that happened for `fxm-music` only, while the same account and token created other projects, which points at the name being taken inside the account: a Worker named `fxm-music`, or a deleted Pages project of that name. Free the name in the dashboard (Workers & Pages) or ask Cloudflare support with the error's cf-ray, then re-run the workflow. `FXM_PAGES_PROJECT` makes `deploy.sh` use another project, to try the pipeline without touching `fxm-music`.

### Checking a deployment

- **Header check** (`src/check-headers.ts`): fetches every path `dist/pages/` serves, every `.html` path that redirects, and a client-side route of each app, without following redirects. Each response must carry exactly one `Content-Security-Policy` line, the one `_headers` gives that path (with the expected directives), plus `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, each once, and the expected status. It also checks that sandbox documents carry `sandbox allow-scripts` and that only the evaluator allows `'unsafe-eval'`.
- **Browser checks** (`e2e/deployed.e2e.ts`): the site's pages and the app render with no policy violation; googlevideo requests from the app (and the embed) carry no Referer, both from a media element and from `fetch` (answered by the test, so nothing reaches YouTube); the sandbox documents are opaque however they are loaded, reach only their hosts, and ignore messages from a page on another origin that frames them without the `sandbox` attribute. The sandbox checks skip themselves until 1.10 deploys the documents.

### Previews and FXM Connect

FXM Connect trusts only `https://fxm-music.pages.dev` (plus localhost in its dev build), so the develop preview runs without it: free sources and Lite only. Adding the exact preview origin to the dev build is possible but not done: DNR's `initiatorDomains` also matches sub-domains, so the production ruleset would need `excludedInitiatorDomains` for the preview first, and every develop merge would gain the dev build's trust. Test FXM Connect with its dev build against `vite preview` on port 4173, and on production after a release.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | `make dist` |
| `src/compose.ts` | Builds the parts, runs the checks, writes `dist/pages/` |
| `src/parts.ts` | The site and the app; `src/later-stages.ts`: the embed (5.2) and the sandbox documents (1.10, 1.11) |
| `src/policies.ts` | Every policy, and the services the web app contacts |
| `src/rules.ts` | Files → `_headers` rules, and their validation |
| `src/headers-file.ts` | Writing, reading and matching `_headers` as Cloudflare does |
| `src/html.ts` | The small HTML tokenizer behind the hashes |
| `src/csp.ts` | Policy values and hashes |
| `src/licenses.ts` | Bundled packages, licence checks, the notices file |
| `src/privacy.ts` | The privacy page check |
| `src/pages-server.ts` | The local stand-in for Cloudflare Pages |
| `src/check-headers.ts` | The header check of a deployment |
| `src/testing.ts` | Fakes for the tests, including the later stages' parts |
| `e2e/deployed.e2e.ts` | The browser checks |
| `../build-dist-wrangler/` | wrangler, its lockfile and `deploy.sh` (CI only) |
