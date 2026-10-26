# The web app's browser tests

Playwright tests of the web app in Chromium, headless and muted. None of them is part of `make check`. There are three kinds:

| What | Against | Run with | In CI |
|---|---|---|---|
| The specs in this folder (`*.spec.ts`): smoke, Now playing, the tiers, playback, downloads, local files, SponsorBlock, the PWA, screenshots | `vite preview` of this checkout, built with the development fakes (`playwright.config.ts`) | `scripts/run.sh pnpm --filter @fxm/web e2e` ([apps/web/README.md](../README.md#run-it)) | no |
| **The critical flows** (`flows/*.e2e.ts`, plus the specs' tests tagged `@flow`) | `make dist`'s `dist/pages`, served the way Cloudflare Pages serves it, with its real `_headers` (`flows/playwright.config.ts`) | `make e2e` | the E2E workflow |
| **The performance budgets** (`budgets/*.budget.ts`) | the same `make dist` output, and the bundle inventory it keeps in `dist/inventory/` | `make budgets` | the E2E workflow |

The embeddable player has its own browser tests in `embed/` (`e2e:embed`, [src/embed/README.md](../src/embed/README.md#tests)).

Every run is offline but for this machine: Chromium resolves no other host (`--host-resolver-rules`), and every request that leaves the app's origin is answered by the test, from the providers' recorded fixtures (`fake-services.ts` and the composition root's fake network, `src/app/services/testing/fake-network.ts`), so a request no test answers fails instead of reaching a music service. Nothing makes a sound: Chromium runs with `--mute-audio`, and the media elements the app plays are muted too (`trackMediaElements` in `playing.ts`). Playback is proven by the media element, never by ear: a `playing` event, a position past the start, and time in its `played` ranges, which only real playback adds.

## The critical flows

`make e2e` runs `make dist`, then the flows against it. The first run installs Playwright's Chromium into `.tools/playwright`. It serves `dist/pages` on `http://127.0.0.1:6700` with the Pages stand-in of `scripts/build-dist` (`src/pages-server.ts`); the embed's page on another site uses the next ports, one per worker. Every port is strict: a busy one fails the run rather than test another server. Set `FXM_E2E_PORT` to move them, and `FXM_PAGES_DIR` to test another composed folder, such as an unzipped release.

```sh
make e2e                                                                    # make dist, then every flow
scripts/run.sh pnpm --filter @fxm/web e2e:flows                             # the flows only, against the last make dist
scripts/run.sh pnpm --filter @fxm/web e2e:flows -- library                  # one file
scripts/run.sh pnpm --filter @fxm/web exec playwright show-trace test-results/flows/<test>/trace.zip
```

Against `make dist` the app runs under its deployed policies, the Lite tier frames the real sandbox document with its own `sandbox` policy, and the PWA and the embed are the deployed ones. So the flows also catch what `vite preview` can't, such as a policy that blocks a host, or the first visit of a browser whose Lite check passes before FXM Connect answers (below).

| Flow | Test | What it proves |
|---|---|---|
| First visit and onboarding, each tier | `connect.spec.ts`, "the tiers" | Full (a fake FXM Connect): no Lite check, no notice. Lite (the real sandbox document; InnerTube answers its opaque origin): one CORS-simple check, marked experimental, the onboarding page and Home's intro. Free (YouTube refuses the sandbox): what is missing and how to add FXM Connect |
| | `playback.spec.ts`, Full and Lite | The shell paints at once and never offers the install while FXM Connect, or a slow Lite check, answers late |
| Search and play, YouTube Music through the stream ladder | `playback.spec.ts` | Full: VISIONOS after the end-of-file probes, Next, and the next song when one ends. Lite: every InnerTube call from the sandbox document, no probe |
| | `flows/ladder.e2e.ts` | The top rung capped: Full's probe meets the cap and itag 18 (ANDROID) plays after its own probe; in Lite the media element's refused request is the probe, and itag 18 plays |
| Search and play, Internet Archive | `playback.spec.ts`, Free | A phone in the Free tier plays Internet Archive's tracks, then the next one, and never contacts YouTube beyond the refused Lite check |
| Next, previous and reordering the queue | `flows/queue.e2e.ts` | Next and Previous while music plays, Previous restarting a song more than 3 s in, a song moved to the top from the keyboard playing next |
| | `now-playing.spec.ts` | A saved queue restored after a reload, reordered by dragging and by the keyboard, the order kept across a reload |
| The library | `flows/library.e2e.ts` | A like from the player bar, a new playlist from a song's menu and the play in Recently played, around a song that really played; a backup saved as a file and restored into another browser profile, which gets all three back |
| | `smoke.spec.ts` | A playlist's custom order, made by keyboard and by the menu, kept across a reload |
| Synced lyrics | `flows/lyrics.e2e.ts` | The current line follows the media element's position, and a tap on a line seeks there (LRCLIB answered with lyrics timed for the tone the song streams as) |
| | `now-playing.spec.ts` | The restored song's lyrics, and seeking to a line |
| Home's shelves | `flows/home.e2e.ts` | A first visit picks artists, Home builds Quick picks and the other shelves from the recommendation sources' recorded answers, and a song plays from a shelf |
| A download in its original format | `flows/downloads.e2e.ts` | Internet Archive's FLAC lands in the Origin Private File System byte for byte, labelled FLAC, and plays from there while Internet Archive no longer answers |
| | `downloads.spec.ts` | A YouTube download left unfinished continues when FXM Connect answers late |
| An M3U import | `flows/import.e2e.ts` | The playlist exists at once, its songs are matched on YouTube Music in the background, the sure match is confirmed in one tap and the unknown song skipped |
| Settings across a reload | `smoke.spec.ts` | The catalog mode and the theme |
| The PWA's update toast | `pwa.spec.ts` | The service worker controls `/app/` and the shell opens offline; a new version waits for the user, and Reload brings it in |
| The embed on another site | `flows/embed.e2e.ts` | The deployed embed, with the real providers, inside a page on another origin: it plays a YouTube Music song in Lite through the sandbox document nested in it, says so to the page, and violates none of the `/embed/*` policy |

A test in a spec is a critical flow when it is tagged `@flow` (`test('…', { tag: '@flow' }, …)`); the flows config runs those tests too (project `specs`), and `e2e/target.ts` tells a spec which server it runs against. Add a flow by tagging a spec's test when that test already covers it, or with a file in `flows/` when none does.

**Found and fixed by the flows (2026-10-26):** against `make dist`, which serves the sandbox document, Lite's check can pass before FXM Connect answers, so for a moment the tier is Lite. The search page then showed the Lite note's "Get FXM Connect" to a browser that has it (`playback.spec.ts`, "paints the shell at once, and never offers the install, when FXM Connect answers late"). The note now waits while the sources say `detecting` (`features/search/catalog/lite-note.tsx`).

## Performance budgets

`make budgets` runs `make dist`, then measures its app and fails when a number is over its budget (`budgets/budgets.ts`). Each run prints a table, attaches the numbers to the test as JSON, and in CI adds the tables to the job summary.

| Budget | What is measured | How |
|---|---|---|
| `entry` | The entry chunk, the script `index.html` starts | The file, compressed as Cloudflare serves it |
| `initial` | Everything `index.html` loads before the app runs: the entry chunk, the chunks it imports (transitively) and the stylesheet | make dist's bundle inventory, which lists each chunk's modules and imports |
| `youtube` | What the YouTube provider adds to the first load: its chunk, the stream resolver's module host and youtubei.js, which the provider loads with `import()`, with the chunks they import that the first load doesn't | The same, from the modules that start each feature (`GROUPS`); a feature whose root moves into the entry chunk fails the run, so it can't stop loading lazily unnoticed |
| `home` | Home's shelves and onboarding, which the Home page loads after the shell | The same |
| `downloads` | The download queue, its database and the worker that writes the files | The same. Today the queue's code is in the first load (`features/downloads/hooks.ts` and `menu.ts` import it into the shell), so it counts in `initial` too |
| `firstLoad` | A first visit of `/app/` until the network is idle, without the service worker | The bytes the server sent, in Chromium |
| `firstVisit` | The same visit with the service worker, whose install downloads the whole app shell for offline use | The same |
| `lcp`, `cls`, `inp` | Largest Contentful Paint of that visit, Cumulative Layout Shift and Interaction to Next Paint of it and of a few taps and some typing after it (Search, the search box, Settings, the theme twice, Library, Home) | The browser's own performance entries, computed as web-vitals does (`budgets/vitals.ts`); the median of five visits |

**Sizes are bytes on the wire.** Cloudflare Pages compresses on the fly: on 2026-10-26 the app's 442,397-byte entry chunk came from `develop.fxmusic.pages.dev` as 137,475 bytes of brotli, which brotli at quality 4 matches (137,452 bytes; quality 5 gives 129,199, gzip -9 138,391). So the budgets count brotli at quality 4.

**The timings' profile** is Lighthouse's mobile default, a mid-range phone (Moto G Power) on Slow 4G, applied as Chrome DevTools throttles: 412×823 px at 1.75×, a CPU four times slower than the machine's, 562.5 ms of latency per request, 1.47 Mbit/s down and 675 kbit/s up. The page comes over HTTP/2 and TLS (a self-signed certificate) with brotli, as from Cloudflare, from a front in `budgets/server.ts` before the Pages stand-in: over the stand-in's plain HTTP/1.1 the 39 files of the first load would queue for six connections. The test checks that every timed visit really used HTTP/2. The visit starts in the Free tier, since Lite's check can't reach YouTube offline, with no service worker. The run starts the stand-in on port 6710 and the fronts on 6711 (HTTP/2) and 6712 (HTTP/1.1, for the service worker's visit, which Chromium refuses on an untrusted certificate); `FXM_BUDGETS_PORT` moves all three. One worker, so nothing else competes for the CPU while it measures.

These are lab numbers on a stand-in, for catching regressions: real phones and networks vary, and Cloudflare's edge is closer than 150 ms to most visitors. Most of the first visit's LCP is the network's: on the Mac below, the median was 5.8 s, 5.3 s with the CPU at full speed and 1.4 s with the network at full speed.

### Baseline (2026-10-26)

Measured on `develop` at 33c1f23 with this stage's changes, in Playwright 1.64.0's Chromium 156.0.8078.4, headless. Sizes are the same everywhere: CI's build had the same files, byte for byte. Timings depend on the machine, so the timing budgets come from CI's runner, where they gate: E2E run 40316662161, on GitHub's `ubuntu-latest`.

| Budget | CI (`ubuntu-latest`) | macOS 15.5, Apple silicon, busy with other work | Budget |
|---|---|---|---|
| `entry` | 137.5 kB (442.4 kB on disk) | the same | 150 kB |
| `initial` | 307.2 kB, 39 files (959.4 kB on disk) | the same | 335 kB |
| `youtube` | 198.4 kB, 4 files (760.0 kB on disk) | the same | 220 kB |
| `home` | 24.7 kB, 7 files (69.0 kB on disk) | the same | 27.5 kB |
| `downloads` | 13.0 kB, 3 files (35.1 kB on disk), 2 of them in the first load | the same | 14.5 kB |
| `firstLoad` | 411.6 kB, 67 requests | the same | 455 kB |
| `firstVisit` | 1,502.1 kB, 222 requests | the same | 1,650 kB |
| `lcp` | 5,424 ms (5,412 to 5,500 ms) | 5,804 ms (5,784 to 5,876 ms) | 6,500 ms |
| `cls` | 0.000 | 0.000 | 0.02 |
| `inp` | 80 ms (72 to 80 ms) | 144 ms (136 to 152 ms) | 150 ms |

The largest paint is the intro of Home's first-visit content in the Free tier (`p.mt-2.text-text-muted`, "FXM plays the YouTube Music catalog, and…"), which loads with the lazy Home chunk. The size budgets leave about 10 % of headroom, LCP about 20 %. INP's budget stays under 200 ms, the line web-vitals calls good, and above what a busy Mac measures, so a local run doesn't fail on the machine's load; CLS's allows a small shift where there is none today.

### When a budget fails

Look at what grew: the table names the files of each budget, and the JSON attached to the test lists every one. Keep code out of the first load with `import()`, and out of a feature's chunk if it doesn't need it. If the growth is worth it, raise the budget in `budgets/budgets.ts` and the baseline above in the same change, and say why in the commit. When a feature's root module moves or is renamed, update `GROUPS`.

## In CI

`.github/workflows/e2e.yml` runs on every push and pull request, apart from `make check` (`ci.yml`), so that stays fast: `make dist`, Playwright's Chromium (the runner has the libraries it needs), the flows, then the budgets, which run even when a flow failed so both report. Its time budget: 15 minutes for the flows and 12 for the budgets as step limits, Playwright's own limits of 12 and 10 minutes inside them, and 30 for the job. Each failed test is retried once, in CI only; a test that needs the retry is reported as flaky. On a failure the job uploads `apps/web/test-results/`, with the traces of the flows.
