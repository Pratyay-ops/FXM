# The Lite tier's sandbox documents (stage 1.10)

The experimental Lite tier gives a browser without FXM Connect YouTube Music: search, browse, radio and ad-free playback, with nothing to install. It works because InnerTube, YouTube's internal API, answers CORS-simple POSTs from an **opaque origin** with `Access-Control-Allow-Origin: null`, and refuses only their preflights (measured 2026-10-25, [research memo §2.4](../../../../docs/research/2026-10-25-userside-memo.md)). A page can send such requests from a sandboxed document. Google documents none of this, so the tier turns on only after a live self-test, and a remote kill switch turns it off ([ARCHITECTURE.md §8](../../../../docs/ARCHITECTURE.md#8-platforms-and-network-transports)).

This folder implements stage 1.2's `SandboxTransport` with two static documents:

| Document | Published at | Sends | Its policy's `connect-src` |
|---|---|---|---|
| [`innertube.html`](../../../../apps/web/sandbox/innertube.html) | `/sandbox/innertube.html` | CORS-simple `POST`s to InnerTube's five API paths on its three hosts | `https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com` |
| [`userhost.html`](../../../../apps/web/sandbox/userhost.html) | `/sandbox/userhost.html` | `GET` and `HEAD` without any header to hosts the user added in Settings: an Invidious instance, the Spotify secret source (1.5) | `https:` |

## Using it

```ts
import { createPlatform, createSandboxTransport } from '@fxm/platform'

const platform = await createPlatform({
  sandbox: createSandboxTransport(), // frames nothing until the first request
  killSwitches: () => remoteConfig.killSwitches, // { lite: true } turns the tier off
  userHosts: () => settings.userHosts,
})
platform.capabilities.current.youtube // 'simple' once the self-test passed, unless switched off
await platform.lite?.check({ force: true }) // Settings → Diagnostics: run the self-test again
```

The self-test sends one YouTube Music search-suggestion request (`defaultSelfTestRequest()`, the smallest call on the allowlist) and passes when a JSON answer with a `responseContext` comes back. `selfTestRequest` takes another request, or a function that builds one, such as one from the YouTube provider's config, so the client version stays current.

Providers notice nothing: `platform.transport.fetch` sends their InnerTube calls through `innertube.html` in the CORS-simple shape (`toSimpleInnerTubeRequest`), and requests to user hosts through `userhost.html`. With FXM Connect present, InnerTube goes through the page instead and the documents are never framed.

**The request budget.** The sandbox transport draws nothing itself. The web transport draws one slot for every InnerTube call it routes here, and the Lite tier's gate one for the self-test, so every call counts once ([the budget](../../README.md#the-request-budget)). User hosts are not YouTube and draw nothing.

## How a document is opaque

Three things make each document's origin opaque, so its requests carry `Origin: null` and no cookies, and FXM Connect's rules, which are scoped to the FXM origin, never match them:

1. **The header.** The server sends each document with a policy that starts with `sandbox allow-scripts` (no `allow-same-origin`), whoever loads it. `sandboxDocumentPolicy()` and `sandboxDocumentHeader()` build it, exactly as the table in [PLAN.md stage 2.8](../../../../docs/PLAN.md#28-static-deploy) gives it.
2. **The frame.** The page frames it with `sandbox="allow-scripts"`.
3. **The `<meta>` policy** inside each document repeats the header's policy without `sandbox` (a `<meta>` policy may not carry it), so a server that sends no header, such as a dev server, still can't let the document fetch other hosts.

The policies have no `frame-ancestors`: it checks every ancestor, so it would break Lite inside the embeddable player on other sites (5.2).

## The protocol

1. The document posts `hello` (protocol `1`, which document it is) to its parent, **addressed to the FXM origin only**: the origin of its own URL, which is where FXM serves it. A document's own origin is opaque, but its URL still says where it came from. At top level, or framed by another site, the message goes nowhere.
2. The page accepts a `hello` only from its own frame's window and only from an opaque origin (`event.origin === 'null'`), then posts `connect` with a `MessagePort`. An opaque origin has no name to address, so this one message goes to `'*'`.
3. The document takes the port only when the `connect` comes from its parent (`event.source`) at the FXM origin (`event.origin`), with protocol `1`, and only the first time.
4. Requests (`request`, `abort`) and replies (`response`, `error`) then travel on the port, which only the page holds: replies never go to any other window.

The document marks its `<html>` with `data-fxm-sandbox="listening"` while it listens, so a test or a diagnostic can tell a document that ignored a message from one whose script never ran.

**What the checks protect.** A sandbox document can do nothing a page on any site couldn't do from its own sandboxed frame, so the checks keep FXM's traffic and answers private rather than guard a privilege: no other site can use FXM's documents, read what they answer, or feed the app answers. One gap is inherent: a page that embeds FXM's player (5.2) can navigate the embed's sandbox frame to a document of its own. Done before the handshake, that document passes the page's checks (it is in the right frame, with an opaque origin) and gets the embed's requests, so it could read them or answer them falsely. Done after the handshake, it only breaks the frame: every message travels on the port. The transport then frames a new document, which is exposed in the same way until its own handshake. Inside FXM's own app no other page can reach the frame, because `/app/*` refuses to be framed.

## What each document sends

Every request passes `checkSandboxRequest()` against the document's policy twice: on the page, so a refused request fails at once without framing anything, and in the document, which trusts nothing the page sends.

| | `innertube.html` | `userhost.html` |
|---|---|---|
| Hosts | `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com`, default port only | Any, over HTTPS, any port. The page decides which hosts the user added |
| Paths | `/youtubei/v1/{search,next,browse,player,music/get_search_suggestions}`, exactly | Any |
| Methods | `POST` | `GET`, `HEAD` |
| Headers | CORS-safelisted only (the Fetch standard's rules, as in `src/cors.ts`) | None |
| Request body | A string, at most 1 MiB | None |
| Response body | At most 8 MiB | At most 4 MiB |
| Timeout | 20 s for headers and body | 20 s |
| Redirects | Refused | Followed (the policy still allows only HTTPS) |
| Always | `credentials: 'omit'`, `mode: 'cors'`, `referrerPolicy: 'no-referrer'` | the same |

A page may ask for a shorter timeout or a smaller cap per document (`createSandboxTransport({ innerTube: { timeoutMs, maxResponseBytes } })`), never for more. The policy names hosts, not paths, so it is the script's allowlist that keeps paths out; the policy keeps the document from reaching any other host even if the script were bypassed.

## Errors

Refusals and failures reject with a `SandboxError`, an `FxmError` that keeps the document's reason as `sandboxCode`. InnerTube's own HTTP errors (400, 403, 429, …) are not errors here: they come back as responses, and the transport reports a 429 to the budget.

| `sandboxCode` | Why | `FxmError` code |
|---|---|---|
| `bad-request` | Malformed: no absolute URL, no string body for a `POST`, a body on a `GET` | `Unsupported` |
| `forbidden-host` | Not HTTPS to an allowed host, credentials in the URL, or a port where none is allowed | `Unsupported` |
| `forbidden-path` | A path outside the allowlist | `Unsupported` |
| `forbidden-method` | A CORS-safelisted method the document does not send | `Unsupported` |
| `forbidden-header` | Any header on a user-host request | `Unsupported` |
| `preflight` | A header or method that would make the browser send a preflight, which InnerTube refuses from an opaque origin | `Unsupported` |
| `too-large` | The request or the response is over its cap | `Parse` |
| `timeout` | No complete response in time; also a document that does not load or stops answering | `Network` |
| `network` | The request failed: offline, CORS refused it, the document's policy blocked it, or a refused redirect | `Network` |

A document that does not say `hello` within 10 s, or stops answering a request 5 s after its own timeout, is removed; the next request frames a new one.

## The documents are generated

`document.ts` is the script inside both documents, and the page imports the same constants and checks from it. It must stand alone: it imports nothing but types and uses only erasable TypeScript. `tools/render.ts` strips its types with Node's type stripping, which only blanks type syntax out, removes the blanks, and inlines the script with the `<meta>` policy that allows exactly that script by hash. After changing `document.ts`:

```sh
scripts/run.sh pnpm --filter @fxm/platform sandbox:build   # writes apps/web/sandbox/*.html
```

A unit test fails while the committed documents differ from what the build writes, and another runs each committed script in a fresh V8 realm to check that it works as a document.

## Tests

```sh
scripts/run.sh pnpm vitest run packages/platform/src/sandbox     # unit tests
scripts/run.sh pnpm --filter @fxm/platform test:e2e              # browser tests (mocks)
FXM_LIVE=1 scripts/run.sh pnpm --filter @fxm/platform test:e2e   # plus the live test
```

- **Unit tests** (`*.test.ts`, part of `make test`) run the document's script against a fake page (`testing.ts`) whose window messages follow the browser's rules for `origin` and `source`, with Node's real `MessageChannel`.
- **Browser tests** (`e2e/`, Playwright, Chromium and Firefox; not part of `make test`) send every request through one local proxy on port 5510 (`FXM_SANDBOX_E2E_PORT` to change it). The proxy serves the FXM origin, another site and the mocks over HTTPS with a throwaway certificate, and refuses every other host, so the mock tests never reach the internet. The mocks answer as InnerTube, googlevideo and an Invidious instance did when measured: `Access-Control-Allow-Origin: null` for simple POSTs from `null`, 403 for preflights and named origins, media without CORS, and a capped URL that answers 403 past 1 MiB.
- **The live test** (`FXM_LIVE=1`, from a residential connection) tunnels InnerTube and googlevideo to YouTube and still serves the FXM origin from this checkout. It runs the self-test, a YouTube Music search, one `next` and one `browse` call and a VISIONOS `/player` call through the sandbox, then plays the Opus URL for three seconds: about five InnerTube calls per browser. `FXM_LIVE=1 FXM_FULL_PLAYBACK=1` plays one song to its end instead (three calls per browser).

What the browser tests show, in both browsers:

| Done-when of stage 1.10 | Test |
|---|---|
| Allowlisted calls succeed | `send allowlisted calls from an opaque origin…`: every path on every host, each with `Origin: null`, `text/plain`, no cookie and no referrer, one budget slot each |
| Other hosts and paths are refused | `refuse other hosts and paths…`: by the page's check, by the document's own check, and by the policy when the script is bypassed |
| Preflighted shapes fail with a typed error | `fail preflighted request shapes…`: `SandboxError` `preflight` from both checks, and the mock's 403 to such a preflight when the checks are bypassed |
| Capped-URL fallback | `a capped VISIONOS URL fails <audio>…`: the browser's first request (`bytes=0-`) gets 403, `<audio>` fails, and the itag 18 URL plays |
| Both documents are served with the sandbox header | `are served with the sandbox header…`: opaque even at top level |
| Another site that frames a document without the attribute gets an opaque, silent document | `framed by another site…`: `self.origin === 'null'`, the script listens, and nothing answers |
| The document can't fetch any other host | `refuse other hosts and paths…` |
| The kill switch disables the tier | `make Lite depend on the self-test…`: no self-test, no frame, no InnerTube call while it is on |

## Test record

The browser tests and the live tests ran on **2026-10-26** (Indian Standard Time; 2026-10-25 after 21:10 UTC) on macOS 15.5 (arm64), from a residential connection in India, with Playwright 1.64.0's browsers, headless, audio muted.

| | Chromium 156.0.8078.4 | Firefox 157.0 | Safari |
|---|---|---|---|
| Mock tests (11) | Pass | Pass | Not tested |
| Self-test (`music/get_search_suggestions`) | 200: `youtube: 'simple'` | 200: `youtube: 'simple'` | Not tested |
| `search`, `next`, `browse` on `music.youtube.com` | 200, 200, 200 | 200, 200, 200 | Not tested |
| VISIONOS `/player` on `www.youtube.com` | `OK`, Opus itag 251 | `OK`, Opus itag 251 | Not tested |
| `<audio>` reaches `playing` | Yes, after 0.7 s | Yes, after 0.1 s | Not tested |
| Full-length playback ("Blitzkrieg Bop (2016 Remaster)", 2:14) | Played to `ended`: 134.5 of 134.5 s, in 135 s | Played to `ended`: 134.5 of 134.5 s, in 135 s | Not tested |

**Safari** is not tested: driving it needs `safaridriver --enable`, a system setting this stage doesn't change, and Playwright's WebKit is not Safari (and isn't installed here). Lite stays unverified in Safari and on iOS.

For Lite, this answers [ARCHITECTURE.md's 64 KB rule](../../../../docs/ARCHITECTURE.md): a VISIONOS URL resolved through the sandbox played to its last second in both browsers, not just its first 64 KB. The protocol facts behind these runs are in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## For the stages after this one

- **2.7 (tiers, onboarding):** pass `createSandboxTransport()` to `createPlatform`, and run `platform.lite.check({ force: true })` from Settings → Diagnostics.
- **2.8 (deploy):** `apps/web/sandbox/*.html` are the files to publish at `/sandbox/`; `sandboxDocumentHeader(kind, html)` gives the header each needs (2.8 computes the same policy itself). The web app's dev server doesn't serve them yet: until it does, Lite needs a build served with the documents.
- **1.3 (YouTube provider):** give `selfTestRequest` the provider's own client version; the remote config needs a `killSwitches.lite` field for `createPlatform({ killSwitches })`. The facts in `CLEAN-ROOM.md` belong in the YouTube log once it has merged.
- **1.4 (stream resolver):** the live test builds its own minimal VISIONOS `/player` call. Once 1.4 has merged, run it again with the resolver's request and format choice.
- **2.3 (playback policy):** the capped-URL fallback here is a test harness (`e2e/harness/harness.ts`). The real one is 2.3's: in Lite, a media error or a stall before `playing` fails the probe, then itag 18, then a new resolution.

## Layout

| Path | What |
|---|---|
| `document.ts` | The documents' script, the protocol and the allowlists (`checkSandboxRequest`) |
| `transport.ts` | `createSandboxTransport()`: the page's side |
| `errors.ts` | `SandboxError` |
| `csp.ts` | The documents' policies and script hashes |
| `testing.ts` | The fake page for the unit tests |
| `tools/` | `render.ts` and `build.ts`: generate the documents (Node) |
| `e2e/` | The browser tests: `network.ts` (proxy and mocks), `harness/` (the test page's script), `sandbox.e2e.ts`, `live.e2e.ts` |
| `CLEAN-ROOM.md` | The protocol facts this folder relies on |
