# @fxm/deploy: make dist and the deploy checks

`make dist` composes everything Cloudflare Pages serves at `https://fxmusic.pages.dev` into one folder, `dist/pages/`, and the deploy workflow uploads that folder (docs/PLAN.md, stage 2.8). Each release ships the same folder as `fxm-web-<version>.zip`, for [self-hosting](#self-hosting). There are no Pages Functions and no Worker: only static files and a generated `_headers` file.

```
dist/pages/
├── index.html, privacy.html, disclaimer.html, 404.html, robots.txt, sitemap…, _astro/   the site (apps/site)
├── .well-known/security.txt                                                          the site's public/ (R.4)
├── app/              the web app (apps/web, base /app/), plus app/404.html for its client-side routes
│   └── ffmpeg/       4.2's LGPL ffmpeg core for the app's conversions (tools/ffmpeg-wasm)
├── embed/            the embeddable player (5.2: apps/web's embed, base /embed/), plus embed/404.html for its paths
├── sandbox/          innertube.html and userhost.html (1.10), eval.html (1.11), once they exist
├── third-party-notices.txt
└── _headers          one Content-Security-Policy per path
```

## Commands

Run them from the repository root.

| Command | What it does |
|---|---|
| `make dist` | Builds the site, the app and the embed, composes `dist/pages/` and runs every check below. Takes a few seconds once the dependencies are installed |
| `scripts/run.sh pnpm --filter @fxm/deploy preview` | Serves `dist/pages/` the way Cloudflare Pages does (redirects, 404 pages, `_headers`) at `http://127.0.0.1:5800` (`FXM_PREVIEW_PORT` to change it; the port is strict) |
| `scripts/run.sh pnpm --filter @fxm/deploy check:headers <url>` | The header check of a deployment (below), for example `https://develop.fxmusic.pages.dev` |
| `scripts/run.sh pnpm --filter @fxm/deploy e2e` | The browser checks: against `FXM_DEPLOY_URL` if set, otherwise against `dist/pages/` (or the folder in `FXM_PAGES_DIR`) served on port 5800, with a second local origin on 5801 and up. Needs Chromium from `.tools/playwright` (`scripts/run.sh pnpm --filter @fxm/deploy exec playwright install chromium`) |

`make test` runs this package's unit tests with everything else, `deploy.sh`'s among them; they need no network and no build.

## What make dist does

1. **Builds each part** into `dist/.staging/`: the site with `apps/site`'s own config plus hidden source maps and the bundle inventory (`site.astro.config.mjs`), the app the same way (`app.vite.config.ts`, with `vite build --sourcemap hidden`), its workers with the bundle inventory too (`src/dist-configs.ts`), and the embed as the app (`embed.vite.config.ts`). No build reads `.env` files: every build variable comes from the environment `make dist` runs in, where the policies read them too ([Jamendo](#jamendo)). The embed and the sandbox documents come from other stages through `src/later-stages.ts`, which skips what doesn't exist yet. Then **the ffmpeg core** (stage 4.2, `src/ffmpeg-core.ts`): the core built from tools/ffmpeg-wasm, copied into the app at `app/ffmpeg/`, from `FXM_FFMPEG_CORE_DIR` (the deploy workflow downloads the ffmpeg-wasm job's artifact there) or from `.tools/` after `make ffmpeg-wasm` (which the release workflow runs before `scripts/release-build.sh`). In CI, or with `FXM_REQUIRE_FFMPEG_CORE=1`, make dist fails without it; locally it composes without it and says that this dist can't convert.
2. **Lists the bundled npm packages**: from the source maps (every source under `node_modules/`), from the bundle inventory (`src/bundle-inventory.ts`: the stylesheets, fonts, images and WebAssembly a build takes from packages, which source maps don't show, and the modules in each chunk, the workers' included), from `/*! name vX.Y.Z` banners in stylesheets, such as Tailwind's base styles, and for the sandbox documents, which have no source maps, from the `//#region <path>` markers Rolldown leaves in their unminified scripts (1.11's `eval.html` bundles bgutils-js). A source that a map names but that is no file must be accounted for: a Vite plugin's virtual module maps to the package whose code it is through `VIRTUAL_MODULES` (vite-plugin-pwa's `virtual:pwa-register`, behind the app's `registerSW`), and only Workbox's generated service worker entry and the bundler's own runtime need no package. The app's workers get source maps that name their sources where the check finds them (`src/worker-source-maps.ts`; 4.2's conversion worker bundles mp4box.js). It fails when:
   - a package's licence is not on the list FXM accepts (`ACCEPTED_LICENCES` in `src/licenses.ts`: permissive licences, MPL-2.0, LGPL, and licences for fonts and data). GPL and AGPL, in any spelling (`GPL-3.0`, `GPLv3`, `AGPL3`), never pass. Anything else, such as a missing licence, `BSD` (not an SPDX id), SSPL or a non-commercial licence, passes only after a human review recorded in `LICENCE_OVERRIDES`;
   - a package that FXM may ship only under the LGPL shares a chunk with other code, in the app's build or in a worker's: the LGPL lets FXM ship a library only where people can replace it, so its modules must sit in chunks of their own (a Vite `manualChunks` entry puts them there), next to the bundler's runtime at most, and it can't be inlined into a sandbox document;
   - a package ships no licence text: no licence file (`LICENSE`, `LICENCE.md`, `LICENSE-MIT`, `LICENSE_APACHE-2.0`, `COPYING`, `NOTICE` and the like; SPDX metadata such as `LICENSE.spdx` doesn't count), and no review in `REVIEWED_LICENCE_TEXTS` saying what covers it. Today that is `@bufbuild/protobuf` and `@tauri-apps/plugin-http`, which FXM uses under the Apache License 2.0. A review is keyed by the package's name and records the facts it rests on: the version reviewed, its licence expression, and what the notices of its files must still say (Google's BSD-3-Clause notice in `@bufbuild/protobuf`). A later version passes while those facts hold, so a routine Dependabot update stays green; when one changes, `make dist` names it and fails until a human reviews the package again;
   - a source map names code that is neither FXM's own file, a package's file, a mapped virtual module, Workbox's entry nor the bundler's runtime, so a new plugin's client code can't ship unattributed; or a sandbox document's region marker names a package file that isn't installed;
   - JavaScript ships without a source map, because then nobody knows what it contains. The one exception is a chunk that the bundle inventory shows holds only the bundler's own runtime (`BUNDLER_RUNTIME_MODULES`: Rolldown's helpers, Vite's preload helper), which comes from no source file and so has no map;
   - WebAssembly ships that no npm package supplied, such as a binary copied into `public/`, unless its SHA-256 is in `REVIEWED_BINARIES` (the stock ffmpeg core is GPL, ARCHITECTURE.md §17);
   - the ffmpeg core fails its own checks instead of these (a part's `prebuilt` files, `Part.prebuilt`): its manifest must be complete, its files (with the licence texts of its parts in `licenses/`) the ones the manifest names, built from the current recipe, each under 25 MiB, with an LGPL licence from FFmpeg's configure and no GPL or non-free flag (`coreProblems` in tools/ffmpeg-wasm/core-build.ts). Its entry in the notices names every part, its source and SHA-256, FFmpeg's configure line and how to replace the core, links the recipe at the commit being built (GITHUB_SHA in CI, else git's `HEAD`), and carries those licence texts in full (`coreNotice`). The core never ships without that entry: a notice that can't be written fails make dist;
   - a part without source maps (the sandbox documents) inlines code with a licence banner, or more than 64 KiB of it. The region markers don't lift these limits: they only show which packages the code holds. A test (`src/licenses.test.ts`) reads the committed `eval.html` and expects its markers to name bgutils-js, so a minified evaluator bundle, which would keep none, can't drop bgutils-js from the notices unseen.
3. **Composes** the parts under their paths, refusing two parts that write the same file, and copies each single-page app's `index.html` to its `404.html`. Source maps and inventories are never deployed: they would publish the build machine's paths.
4. **Writes `third-party-notices.txt`**, which names the parts that hold third-party code and lists every bundled package: its licence, the parts that contain it, its licence files, and the copyright and licence comments its bundled files open with where they add to those files, by naming another holder or a licence the package's own doesn't offer (`src/notices.ts`, which the signed YouTube module's banner uses too), such as Google's BSD-3-Clause notice on `@bufbuild/protobuf`'s varint code, or the 0BSD notice of the tslib copy inside `@tauri-apps/api`. After the packages come the entries of the files FXM builds itself from pinned recipes (`Part.prebuilt`): the ffmpeg core's (`coreNotice`). A package that `REVIEWED_LICENCE_TEXTS` covers with the Apache License 2.0 says so, and the file then ends with that licence's text (the repository's `LICENSE`). The site's footer links to it (`NOTICES_PATH` in `apps/site/src/config.ts`).
5. **Writes `_headers`** and checks it: at most 100 rules, no line over 2,000 characters, no two rules matching one path, every path a file is served at matched by exactly one rule, and every policy keeping its promises (sandbox documents opaque, `'unsafe-eval'` only in the evaluator, no `'unsafe-inline'` scripts, `frame-ancestors 'none'` except for the embed and the sandbox documents), and every rule sending the opener policy and a `Permissions-Policy` that turns off only features FXM never uses. Every service host in `APP_SERVICES` must be a plain HTTPS host. It reads the file back with a parser that follows Cloudflare's, so the file means exactly the rules it generated.
6. **Adds each page's policy in a meta element**, with `<meta name="referrer" content="no-referrer">`, to every page of the site and every document of the apps: for the paths Pages serves them at that no rule reaches (below). The sandbox documents must bring their own.
7. **Gives the app's page a new precache revision** in its service worker, `app/sw.js` (`src/service-worker.ts`): a fingerprint of the final `app/index.html` and of the `/app/*` rule, in place of the build's, which can know neither. The worker serves its stored copy of the page with the headers it came with, so a deploy that changes only the rule still reaches installed apps.
8. **Checks the privacy page**: every host a policy names must belong to a service in `APP_SERVICES`, and `privacy.html` must list that service.
9. **Refuses** `_worker.js`, `_routes.json`, `_redirects` and `functions/`, file names with `%`, more than 20,000 files and files over 25 MiB (Cloudflare Pages' limits).

Only then does `dist/pages/` replace the previous build.

## Header rules

Cloudflare gives a request the headers of every `_headers` rule that matches it and joins a header two rules set with a comma, which would enforce two policies at once. So no two rules match the same path, and none uses `/*`. Every rule sets `Content-Security-Policy`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, as docs/PLAN.md's table asks, and two more headers (`COMMON_HEADERS` in `src/policies.ts`):

- **`Cross-Origin-Opener-Policy: same-origin`**: a page opened at top level keeps no tie to a page of another site that opened it, or that it opens; neither can reach the other's window. Browsers ignore it in frames, so the embed and the sandbox documents work inside other pages as before. The embed counts on it when a page opens a player in a new window: that page could otherwise count the player's frames and tell whether the visitor has FXM Connect ([apps/web/src/embed/README.md](../../apps/web/src/embed/README.md)).
- **`Permissions-Policy`** turns off only features FXM never uses: `camera`, `microphone`, `geolocation`, `payment`, `usb`, `serial`, `bluetooth`, `hid` and `midi`. It never turns off `autoplay`, `fullscreen`, `picture-in-picture` or `screen-wake-lock`, which a player may use, and the media keys go through the Media Session API, which no policy controls. `make dist` and the header check refuse a policy that turns off anything else.

| Files | Rule | Policy (`src/policies.ts`) |
|---|---|---|
| `app/**` | `/app/*` | `appPolicy()`: the policy in docs/PLAN.md, with the hash of the app's inline theme script, the hosts of the services later stages added, and two differences: workers only from the app's own origin, and Jamendo's hosts only in a build with its client_id ([Jamendo](#jamendo)). 4.2 adds `'wasm-unsafe-eval'`, for the conversion worker, and the exact hosts the app reads covers from (`appConnect`) |
| `embed/**` | `/embed/*` | `appPolicy({ embeddable: true })`: the same without `frame-ancestors`, and without what only the app needs (4.2's `'wasm-unsafe-eval'` and cover hosts) |
| `sandbox/<doc>.html` | `/sandbox/<doc>` and `/sandbox/<doc>.html` | `SANDBOX_DOCUMENTS`: `sandbox allow-scripts`, the document's inline script by hash, and its hosts |
| each other `.html` page | its path and its `.html` path, such as `/privacy` and `/privacy.html` | `sitePagePolicy()`: that page's own inline scripts and styles by hash, its own files |
| `_astro/**`, `.well-known/**` | `/_astro/*`, `/.well-known/*` | `STATIC_FILE_POLICY`: nothing allowed |
| each other file | its path | `STATIC_FILE_POLICY` |

Two notes on what the `/app/*` policy allows (`src/policies.ts`):

- **`https://youtubei.googleapis.com` is reserved.** No client in the bundled YouTube config uses it today, but the signed YouTube config, which the desktop and Android apps fetch from the site and the web app gets by redeploy (stage 1.13), can move a client there without an app release. So `connect-src`, the `innertube.html` policy, FXM Connect and the platform's host table keep it (`INNERTUBE_HOSTS`).
- **`worker-src 'self'`, without the plan's `blob:`.** Every worker the app starts is a file of its own build: the service worker, the downloads' storage worker, and stage 4.2's conversion worker. 4.2's ffmpeg core is built without threads (`--disable-pthreads`), so it starts no worker from a `blob:` URL (checked on its branch on 2026-10-26). A stage that needs one adds `blob:` to `WORKER_SOURCES`, with why.

Things Cloudflare does that the rules account for (from wrangler 4.149's copy of the Pages asset server, read 2026-10-26, and confirmed on a real deployment the same day):

- **Pages serves `x.html` at `/x`** and answers `/x.html` with a 308 redirect, `/index.html` and `/app` too. A sandbox document framed as `/sandbox/innertube.html` therefore ends up at `/sandbox/innertube`, which must carry the sandbox policy: each document gets a rule for both paths. The plan lists the 404 page as `/404.html`; it is served at `/404`.
- **Pages decodes a path to find its file, but no `_headers` rule can match a path with an encoded letter.** `/priv%61cy` serves `privacy.html`, `/%61pp/` the app and `/sandbox/innertub%65` a sandbox document, and browsers send such paths as written. Cloudflare matches rules against the request path as sent, but normalizes each rule's own path first: it decodes the escapes of letters, digits and `-._~`, and ignores a path with an invalid escape (measured on two deployments, 2026-10-26: a rule `/zza%41` applied to `/zzaA` but not to `/zza%41`; `/%25*` applied to `/%2561pp/` but not to `/%61pp/`; `/%*` and `/:name%*` applied to nothing). A placeholder rule that matched such paths would also match the real ones. So these paths get Cloudflare's defaults, and the documents protect themselves:
  - every page of the site and every document of the apps carries its policy in a meta element, all of it but `frame-ancestors` and `sandbox`, which only a header can set, and `<meta name="referrer" content="no-referrer">`. `make dist` adds both to the composed copies. The app renders nothing at such a path (its router finds no route), so the missing `frame-ancestors` exposes no interface;
  - every sandbox document carries its own policy in a meta element and does nothing unless `self.origin` is `'null'`, which only its `sandbox` policy makes it.
  
  Cloudflare merges repeated slashes first (`//privacy` gets `/privacy`'s rule), and no file name may contain `%`.
- **`_redirects` rules win over files.** A rule such as `/app/* /app/index.html 200` would send the app's own scripts back as HTML. Pages serves the nearest `404.html` for a path no file answers, so the app's routes get `app/404.html`, a copy of its `index.html`, with status 404; the app reads the URL and shows the page.
- **Headers apply to the request path**, so a 404 under `/app/` gets the app's policy. A path no rule matches, such as a mistyped page at the root, gets the site's 404 page with Cloudflare's defaults (`Referrer-Policy: strict-origin-when-cross-origin`) and no policy; it is a static page with nothing to protect.

### The sandbox documents

`make dist` holds each sandbox document (1.10's `innertube.html` and `userhost.html`, 1.11's `eval.html`) to a contract, listed in `src/later-stages.ts`: one inline script, which its policy allows by hash; the same policy without `sandbox` in a `<meta http-equiv="Content-Security-Policy">` before that script, so a copy served without these headers (at an encoded path, or from the release zip on another host) keeps its hosts and hash; a script that does nothing unless `self.origin === 'null'` (not `location.origin`, which still names FXM's origin in a sandboxed document); and no inline code that looks bundled (a licence banner, or more than 64 KiB), because the part has no source maps. A document that bundles npm packages keeps its script unminified, with the bundler's `//#region <path>` markers, from which `make dist` attributes those packages, such as the bgutils-js modules in `eval.html`; the markers don't lift the banner and size limits. `make dist` can only check that the origin test is there; the browser checks confirm on each deployment that a document at an encoded path stays inert. 1.10's documents make the test in the line that starts their script (`packages/platform/src/sandbox/tools/render.ts`).

### When a stage adds a service

A stage that makes the web app contact a new service adds it to `APP_SERVICES` in `src/policies.ts`, with its `connect` and `img` hosts and its name exactly as the privacy page lists it, and adds it to `apps/site/src/pages/privacy.astro` (docs/PLAN.md, Definition of done). Hosts only the web app reads bytes from, never the embed, go in a service's `appConnect`, by their exact names and only once measured to allow it (`connect-src` lets page script read what it fetches): 4.2's cover art, which the app fetches from YouTube's and Spotify's cover hosts (`i.ytimg.com`, `lh3.googleusercontent.com`, `yt3.ggpht.com`, `yt3.googleusercontent.com`, `i.scdn.co`) to embed in saved files, while `img-src` keeps the wildcards. `APP_SCRIPT_EXTRAS` holds `'wasm-unsafe-eval'` (4.2), for the conversion worker that compiles the ffmpeg core; it too is the app's only, and `appPolicy()` refuses `'unsafe-eval'` and `'unsafe-inline'`. Nothing else changes but the tests that pin the list: the policy `src/policies.test.ts` expects for `/app/*` takes the new hosts too (8.2 added ListenBrainz's and Last.fm's to `LATER_CONNECT_HOSTS`, and 8.4 GitHub's, as the plan's policy row doesn't print them), and the privacy pages of `src/privacy.test.ts` and `src/compose.test.ts` that miss one service list the new one. `make dist` fails if the page misses the service. A service the app offers only with some build configuration names that variable in `requires`, and builds without it leave its hosts out (`offeredServices`), as for Jamendo below.

### Jamendo

Jamendo's API needs a `client_id`, and FXM's public one would be shared by every user, which Jamendo's terms leave unclear, so the owner confirms with Jamendo first ([its README](../../packages/sources/src/jamendo/README.md#turning-jamendo-on-owner)). Until then the build leaves Jamendo out, behind one switch: the GitHub Actions variable `FXM_JAMENDO_CLIENT_ID`, which `deploy.yml` passes to `make dist` and `release.yml` to the release build (whose web zip is `make dist`'s folder) as `VITE_FXM_JAMENDO_CLIENT_ID`. `make dist` builds the site and the app with it and writes the policies from it, so everything follows it together:

| | Variable empty (v0.1.0) | Variable set |
|---|---|---|
| Web app | registers no Jamendo provider, and its copy names Internet Archive alone (`apps/web/src/lib/free-sources.ts`) | registers Jamendo and names it |
| Landing page | `AVAILABLE.jamendo` off: the free-music sentences name Internet Archive, the places that name Jamendo say it is coming soon | `AVAILABLE.jamendo` on |
| Privacy page | lists Jamendo, contacted only once it is on | lists Jamendo as contacted |
| `/app/*` policy | no `https://*.jamendo.com` (Jamendo's `requires` in `APP_SERVICES`) | `https://*.jamendo.com` in `connect-src` and `img-src` |

Locally: `VITE_FXM_JAMENDO_CLIENT_ID=<client_id> make dist`. `make dist` builds the site, the app and the embed without reading `.env` files (`envDir: false`, `src/dist-configs.ts`), so a client_id kept in `apps/web/.env.local` for `make dev` never reaches a `make dist` build: the app, the site and the policies all read the one environment `make dist` runs in.

## Deploying

`.github/workflows/deploy.yml` runs `make dist` on every push. Only `develop` and `main` deploy:

- **develop** deploys to the preview at `https://develop.fxmusic.pages.dev`, and the verify job checks it.
- **main**, which only release pull requests reach (they must pass `make check`), deploys first to a candidate at `https://main-candidate.fxmusic.pages.dev`. The verify job checks the candidate, and only then does the promote job deploy the same folder to production, `https://fxmusic.pages.dev` (Pages uploads no file twice). A last job checks production's headers.
- **A push to main whose version has no GitHub Release yet** also waits for that release before the promotion: the release job polls GitHub for it for up to 30 minutes (`scripts/release-wait.sh`), with no more than read access, while the release workflow builds and publishes it from the same push. That is the merge of a release pull request, and any later push to main while the release is still missing, for example after its run failed: the release workflow then publishes the version from the newer commit. So the site, which links to the latest release, never points at an older one, or at an empty Releases page before v0.1.0. A release that takes longer, for example while Firefox Add-ons signs FXM Connect, leaves production at the previous version: re-run the deploy workflow's failed jobs once the release is published. A push whose version is out already promotes after one request to GitHub.
- `workflow_dispatch` redeploys `develop` or `main` by hand; on any other branch it only runs `make dist`.

The deploy jobs run in GitHub environments, `preview` for develop and `production` for main, and `deploy.sh` refuses any other branch, and any branch but the one its run was started for.

**The secrets today.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live only in the GitHub environments `preview`, which only `develop` may use, and `production`, which only `main` may use, with no repository copies (checked 2026-10-26). So only a run for `develop` or `main` can read them: a pushed branch whose workflow asked for them gets nothing, and can't publish over the one origin FXM Connect trusts.

**What is set up** (by the owner, on 2026-10-26):

- a free Cloudflare account, and an API token with Account > Cloudflare Pages > Edit;
- the GitHub environments `preview`, limited to the branch `develop`, and `production`, limited to `main`, each holding `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, with no repository copies of them. Neither has a required reviewer; one is optional, and on `production` would approve both the candidate and the promotion. A new fork sets them up with the GitHub CLI (`scripts/run.sh gh …` in the repository, with the fork's name in place of `Pratyay-ops/FXM`):

  ```sh
  policy='{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
  gh api -X PUT repos/Pratyay-ops/FXM/environments/preview --input - <<<"$policy"
  gh api -X POST repos/Pratyay-ops/FXM/environments/preview/deployment-branch-policies -f name=develop -f type=branch
  gh api -X PUT repos/Pratyay-ops/FXM/environments/production --input - <<<"$policy"
  gh api -X POST repos/Pratyay-ops/FXM/environments/production/deployment-branch-policies -f name=main -f type=branch
  gh secret set CLOUDFLARE_API_TOKEN --env preview      # each one asks for the value
  gh secret set CLOUDFLARE_ACCOUNT_ID --env preview
  gh secret set CLOUDFLARE_API_TOKEN --env production
  gh secret set CLOUDFLARE_ACCOUNT_ID --env production
  gh secret delete CLOUDFLARE_API_TOKEN                 # last, the repository copies
  gh secret delete CLOUDFLARE_ACCOUNT_ID
  ```

  An environment's secret wins over a repository secret of the same name, so a repository that starts with repository secrets keeps deploying at every step.

Still recommended: `develop` protected, by required pull requests or restricted pushers. It isn't yet (checked 2026-10-26), and Cloudflare can't limit a token to one branch, so a develop run could still deploy production.

More about the deploy:

- **The Pages project** is `fxmusic`, with `main` as its production branch, deployed by direct upload (`wrangler pages deploy`). The first deploy creates it. Use Pages, not Workers, even though Cloudflare's dashboard and wrangler suggest Workers for new static projects; since wrangler 4.108 an AI agent running `wrangler pages` on its own machine is redirected to Workers unless the project exists, which is one more reason deploys run only in CI.
- **The token** is only in the deploy and promote jobs, which run nothing but `scripts/build-dist-wrangler/deploy.sh` and wrangler. wrangler is pinned with its own lockfile in `scripts/build-dist-wrangler/` (a separate pnpm root, so `make setup` never downloads its 200 MB of binaries) and installed without a cache. Before uploading, `deploy.sh` checks that the project's production branch is `main`, and after it that the deployment landed in the expected environment.
- **After each deploy** the verify job runs the header check and the browser checks against the new deployment's own address. On a project's first deploy it first waits for that address to answer: the certificate for a new project's sub-domains arrived 2.5 minutes after its first deploy (measured 2026-10-26).
- **If the project can't be created**, Cloudflare answers with its generic error 8000000. That is how the first name was refused on 2026-10-26, while the same account and token created other projects: the name was taken (ARCHITECTURE.md D24), so FXM uses `fxmusic`. `FXM_PAGES_PROJECT` makes `deploy.sh` use another project, to try the pipeline without touching `fxmusic`.

### Checking a deployment

- **Header check** (`src/check-headers.ts`): fetches every path `dist/pages/` serves, every `.html` path that redirects and a client-side route of each app, without following redirects. Each response must carry exactly one `Content-Security-Policy` line, the one `_headers` gives that path (with the expected directives), plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin` and the `Permissions-Policy`, each once as `_headers` gives it, and the expected status. The policies must keep the promises `make dist` checks (above). Each document must also carry its policy in a meta element, at its own paths and at paths with one character percent-encoded, where no rule applies.
- **Browser checks** (`e2e/deployed.e2e.ts`): the site's pages and the app render with no policy violation; the app, opened in a new window by a page of another site, keeps no tie to it, and Chromium reports the features the `Permissions-Policy` turns off as off and the player's as on; googlevideo requests from the app (and the embed) carry no Referer, both from a media element and from `fetch` (answered by the test, so nothing reaches YouTube), also from the app at `/%61pp/`. For the sandbox documents: `innertube.html` is opaque, reaches its three hosts, and only its policy stops a request to a fourth that would answer; framed by a page on another origin without the `sandbox` attribute, each document loads (not an error page), runs, stays opaque and ignores that page's messages; at a percent-encoded path, where its `sandbox` doesn't apply, it stays inert. Each framing page gives the document a token in its URL's fragment, as the app's transport does: without one, 1.10's script serves nobody anyway, and the checks would prove nothing. The checks of a document skip themselves while it isn't deployed, such as 1.11's `eval.html`.

### Lite on the deployed site

The site turns on `AVAILABLE.lite` (`apps/site/src/config.ts`) only once Lite plays a song on the deployed site in Chromium (docs/PLAN.md, 2.8), and turns it off while Lite's kill switch is on. `e2e/lite.e2e.ts` is that check: in a browser without FXM Connect, the Lite self-test passes, a YouTube Music search returns songs, and a song reaches `playing` with its `currentTime` advancing for at least 10 s, within 10 YouTube requests. Every request the page makes to YouTube's hosts and googlevideo counts, and one past the budget is refused and fails the check; thumbnails are answered locally, the `player` requests of songs the app prefetches are refused before they reach YouTube, and every media element is muted. It reaches YouTube for real, so it runs only when asked, from a residential connection, and never retries:

```sh
FXM_LIVE=1 FXM_DEPLOY_URL=https://develop.fxmusic.pages.dev scripts/run.sh pnpm --filter @fxm/deploy exec playwright test lite
```

It passed on **2026-10-26** (04:18 to 04:25 UTC) against `https://develop.fxmusic.pages.dev/app/`, which served stage 2.9's build, from a residential connection in India, in Playwright 1.64.0's Chromium 156.0.8078.4, headless, with `--mute-audio`, a temporary profile and no extension, on macOS 15.5 (arm64). Lite's kill switch was off. The app said "This browser passed Lite's check" and Diagnostics "Check passed"; searching "Blitzkrieg Bop Ramones" returned 20 songs; "Blitzkrieg Bop" played from googlevideo, muted, its `currentTime` going from 0.3 s to 12.4 s in 12.1 s; five requests reached YouTube (two `music/get_search_suggestions`, the self-test's and the search box's, one `search`, one `player` and one `videoplayback`), and no policy was violated. So `AVAILABLE.lite` is on. Once the check counted every request this way, it passed again against the develop preview on **2026-10-26** at 07:01 UTC, in the same browser and setup, in 17 s.

### Autoplay in the Lite tier

The site turns on `AVAILABLE.radio` (`apps/site/src/config.ts`) since autoplay (stage 3.4, endless radio) kept a queue going in the composed app. `e2e/radio.e2e.ts` is that check: in a browser without FXM Connect, in the Lite tier, the last song of a search's results plays, so nothing is up next; autoplay adds four songs like it, marked "Autoplay" in the queue, with its switch on; and after Next the first of them plays, "Playing from Autoplay", from googlevideo, muted, its `currentTime` advancing for at least 5 s, all within 15 YouTube requests. It counts and refuses requests as the Lite check does, and also refuses the `player` requests of the songs the app prefetches after autoplay's first. It reaches YouTube for real, so it runs only when asked (`FXM_LIVE=1`), from a residential connection, and never retries. Without `FXM_DEPLOY_URL` it runs against `make dist`'s `dist/pages/`, served the way Cloudflare Pages would; the JSON reporter shows its result (the songs, and the requests that reached YouTube):

```sh
make dist
FXM_LIVE=1 FXM_PREVIEW_PORT=6540 scripts/run.sh pnpm --filter @fxm/deploy exec playwright test radio --reporter=json
```

It passed on **2026-10-26** at 09:12 UTC against `make dist`'s build of `feat/3.4-autoplay` (develop with stage 2.9b's wiring, plus 3.4), served by `src/pages-server.ts` on `127.0.0.1:6540`, from a residential connection in India, in Playwright 1.64.0's Chromium 156.0.8078.4, headless, with `--mute-audio`, a temporary profile and no extension, on macOS 15.5 (arm64), in 15 s. The app passed Lite's check, autoplay added four songs after the search's last one, and the first of them played from its radio, within the budget, with no policy violated. So `AVAILABLE.radio` is on. Once 3.4 is merged, run it against the develop preview too (`FXM_DEPLOY_URL=https://develop.fxmusic.pages.dev`).

### Previews and FXM Connect

FXM Connect trusts only `https://fxmusic.pages.dev` (plus localhost in its dev build), so the develop preview runs without it: free sources and Lite only. Adding the exact preview origin to the dev build is possible but not done: DNR's `initiatorDomains` also matches sub-domains, so the production ruleset would need `excludedInitiatorDomains` for the preview first, and every develop merge would gain the dev build's trust. Test FXM Connect with its dev build against `vite preview` on port 4173, and on production after a release.

## Self-hosting

Each GitHub Release has this folder as `fxm-web-<version>.zip`: `scripts/release-build.sh` runs `make dist` on the release commit and zips `dist/pages/` as it is, so the zip holds exactly what `https://fxmusic.pages.dev` serves, `_headers`, `third-party-notices.txt` and `.well-known/` included. Check the download as the release notes describe, then serve it from any static host:

- **At the root of a site**, such as `https://music.example.org/`, over HTTPS (or on `localhost`): browsers run the app's service worker, which opens the app without a connection, and offer Web Crypto, which some features use, only in a secure context. The pages refer to `/app/`, `/_astro/` and `/sandbox/` from the root, so a sub-folder such as `https://example.org/fxm/` doesn't work.
- **With the headers in `_headers`.** Cloudflare Pages and Netlify read the file as it is. Any other host (nginx, Caddy, Apache, a CDN in front of a bucket) must send the same headers on the same paths: each rule in the file is a path (a final `*` stands for the rest of the path) followed by its headers, and no two rules match one path ([Header rules](#header-rules) explains them). Take them from the zip you serve: the policies carry the hashes of that build's inline scripts, so they change between releases. Without the headers, each page still applies its policy from a meta element, but nothing stops other sites from framing it (`frame-ancestors`), the sandbox documents lose their `sandbox` policy, and no file gets `X-Content-Type-Options: nosniff`.
- **Answering paths as Cloudflare Pages does.** Pages serves each `x.html` at `/x` (the site links to `/privacy` and `/disclaimer`), and answers a path no file serves with the nearest `404.html`, so the app's routes, such as `/app/library`, get `app/404.html`, a copy of the app's `index.html`. Netlify also serves `x.html` at `/x`, but on its own uses only the root `404.html`: add a `_redirects` file with the line `/app/* /app/404.html 404`, which Netlify applies only where no file answers. Cloudflare Pages needs no such file, and there `_redirects` rules win over files.
- **Caching as Cloudflare Pages does.** Pages sends every file with `Cache-Control: public, max-age=0, must-revalidate` and an `ETag`, so a browser checks with the host before it uses its copy. Neither browsers nor a CDN in front of your host may keep `/app/sw.js`, `/app/manifest.webmanifest` and `/app/index.html` for long (`PWA_REVALIDATE_PATHS` in `apps/web/pwa/host.ts`): they announce a new version, so with a long `max-age` (nginx's `expires max`, say) or `immutable`, installed copies of the app can stay on an old version. Only the files in `/app/assets/` and `/_astro/`, whose names carry a content hash, may be cached for long.
- **With `third-party-notices.txt`.** The licences of the bundled packages (MIT, ISC and others) require their notices in every copy, so keep the file with the others.

A copy on another origin runs without FXM Connect, which trusts only `https://fxmusic.pages.dev`: free sources and Lite only, as on the develop preview. `robots.txt`, the sitemaps and `.well-known/security.txt` name `fxmusic.pages.dev`; edit them for your site or delete them.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | `make dist` |
| `src/compose.ts` | Builds the parts, runs the checks, writes `dist/pages/` |
| `src/parts.ts` | The site and the app; `src/later-stages.ts`: the embed (5.2) and the sandbox documents (1.10, 1.11) |
| `site.astro.config.mjs`, `app.vite.config.ts` | The site's and the app's own configs, plus source maps and the bundle inventory, without `.env` files (`src/dist-configs.ts`) |
| `src/bundle-inventory.ts` | The Vite plugin that records which files a build takes from where, and the modules in each chunk |
| `src/worker-source-maps.ts` | The Vite plugin that makes the app's workers' source maps name their sources where the licence check finds them |
| `src/ffmpeg-core.ts` | 4.2's ffmpeg core as a part of the app, with its own checks and notice |
| `src/policies.ts` | Every policy, the promises they keep, and the services the web app contacts |
| `src/rules.ts` | Files → `_headers` rules, and their validation |
| `src/headers-file.ts` | Writing, reading and matching `_headers` as Cloudflare does |
| `src/html.ts` | The small HTML tokenizer behind the hashes |
| `src/csp.ts` | Policy values and hashes |
| `src/licenses.ts` | Bundled packages, licence checks, the notices file |
| `src/notices.ts` | A package's licence files and the notices of its bundled files, shared with the YouTube module's build |
| `src/worker-source-maps.ts` | The Vite plugin that makes the workers' source maps name their sources where the licence check finds them |
| `src/privacy.ts` | The privacy page check |
| `src/service-worker.ts` | The page's precache revision in the app's service worker |
| `src/pages-server.ts` | The local stand-in for Cloudflare Pages |
| `src/check-headers.ts` | The header check of a deployment |
| `src/testing.ts` | Fakes for the tests, including the later stages' parts |
| `src/deploy-script.test.ts` | `deploy.sh`'s tests, with stand-ins for wrangler and curl |
| `e2e/deployed.e2e.ts` | The browser checks |
| `e2e/lite.e2e.ts` | The live Lite check behind the site's `AVAILABLE.lite` (`FXM_LIVE=1` only) |
| `e2e/radio.e2e.ts` | The live autoplay check behind the site's `AVAILABLE.radio` (`FXM_LIVE=1` only) |
| `../build-dist-wrangler/` | wrangler, its lockfile and `deploy.sh` (CI only) |
