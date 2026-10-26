# The Lite tier's sandbox documents (stage 1.10)

The experimental Lite tier gives a browser without FXM Connect YouTube Music: search, browse, radio and ad-free playback, with nothing to install. It works because InnerTube, YouTube's internal API, answers CORS-simple POSTs from an **opaque origin** with `Access-Control-Allow-Origin: null`, and refuses only their preflights (measured 2026-10-25, [research memo §2.4](../../../../docs/research/2026-10-25-userside-memo.md)). A page can send such requests from a sandboxed document. Google documents none of this, so the tier turns on only after a live self-test, and a remote kill switch turns it off ([ARCHITECTURE.md §8](../../../../docs/ARCHITECTURE.md#8-platforms-and-network-transports)).

This folder implements stage 1.2's `SandboxTransport` with two static documents:

| Document | Published at | Sends | Its policy's `connect-src` |
|---|---|---|---|
| [`innertube.html`](../../../../apps/web/sandbox/innertube.html) | `/sandbox/innertube.html` | CORS-simple `POST`s to InnerTube's five API paths on its three hosts | `https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com` |
| [`userhost.html`](../../../../apps/web/sandbox/userhost.html) | `/sandbox/userhost.html` | `GET` and `HEAD` without any header to hosts the user added in Settings: an Invidious instance, the Spotify secret source (1.5) | `https:` |

## Using it

```ts
import { createKillSwitchStore, createPlatform, createSandboxTransport } from '@fxm/platform'

const killSwitches = createKillSwitchStore() // { lite: true } from the remote config turns the tier off
const platform = await createPlatform({
  sandbox: createSandboxTransport(), // frames nothing until the first request
  killSwitches,
  userHosts: () => settings.userHosts,
})
platform.capabilities.subscribe(render) // youtube: 'simple' once the self-test passed, unless switched off
await platform.lite?.check({ force: true }) // Settings → Diagnostics: run the self-test again
```

Providers notice nothing: `platform.transport.fetch` sends their InnerTube calls through `innertube.html` in the CORS-simple shape (`toSimpleInnerTubeRequest`), and requests to user hosts through `userhost.html`. With FXM Connect present, InnerTube goes through the page instead and the documents are never framed.

The package exports `createSandboxTransport` with its option and handle types, the errors (`SandboxRefusedError`, `SandboxFailedError`, `isSandboxError`) and the documents' policies (`sandboxDocumentPolicy`, `sandboxDocumentHeader`). The protocol and the allowlists stay inside the package.

### The self-test

The self-test sends one YouTube Music search-suggestion request (`defaultSelfTestRequest()`, the smallest call on the allowlist); `selfTestRequest` takes another request, or a function that builds one, such as one from the YouTube provider's config, so the client version stays current. It resolves with what InnerTube's answer, or the failure, says about the sandbox:

| What happened | Result |
|---|---|
| A 2xx answer with a JSON object that has a `responseContext` | `pass` |
| Any other HTTP error status (400, 403, 404, …) or an unusable body (HTML, an error object, a response over the cap) | `refused` |
| A network failure once the document had loaded: a CORS refusal looks like one, and the document's load showed that the FXM origin is reachable | `refused`, unless `navigator.onLine` is `false`: then `unreachable` |
| A request the checks refuse, a document of another protocol, a document URL on another origin | `refused`: retrying can't help |
| HTTP 429 or 5xx, a timeout, a redirect, a document that did not load, a document that is not the one framed (wrong token), a self-test request that could not be built | `unreachable`: the Lite tier tries again later |

Only `refused` is kept for the session ([the Lite tier's gate](../../README.md#the-lite-tier)); a cancelled self-test rejects with the signal's reason.

**The request budget.** The sandbox transport draws nothing itself. The web transport draws one slot for every InnerTube call it routes here, and the Lite tier's gate one for the self-test, so every call counts once ([the budget](../../README.md#the-request-budget)). User hosts are not YouTube and draw nothing.

## How a document is opaque

Three things make each document's origin opaque, so its requests carry `Origin: null` and no cookies, and FXM Connect's rules, which are scoped to the FXM origin, never match them:

1. **The header.** The server sends each document with a policy that starts with `sandbox allow-scripts` (no `allow-same-origin`), whoever loads it. `sandboxDocumentPolicy()` and `sandboxDocumentHeader()` build it, exactly as the table in [PLAN.md stage 2.8](../../../../docs/PLAN.md#28-static-deploy) gives it.
2. **The frame.** The page frames it with `sandbox="allow-scripts"`.
3. **The `<meta>` policy** inside each document repeats the header's policy without `sandbox` (a `<meta>` policy may not carry it), so a server that sends no header, such as a dev server, still can't let the document fetch other hosts.

The policies have no `frame-ancestors`: it checks every ancestor, so it would break Lite inside the embeddable player on other sites (5.2).

## The protocol

Version `2` (`SANDBOX_PROTOCOL`):

1. The page frames the document with a fresh 128-bit random **token** as the URL's fragment: `innertube.html#<32 hex digits>`. Only a document loaded at that URL can read it, and fragments never leave the browser.
2. The document posts `hello` (the protocol, which document it is, the token) to its parent, **addressed to the FXM origin only**: the origin of its own URL, which is where FXM serves it. A document's own origin is opaque, but its URL still says where it came from. At top level, framed by another site, or loaded without a token, it says nothing and serves nobody.
3. The page accepts a `hello` only from its own frame's window, only from an opaque origin (`event.origin === 'null'`) and only with its token, then posts `connect` with a `MessagePort`. An opaque origin has no name to address, so this one message goes to `'*'`. It carries no token.
4. The document takes the port only when the `connect` comes from its parent (`event.source`) at the FXM origin (`event.origin`), in its protocol, and only the first time. Its first message on the port is `ready` with the token.
5. The page sends nothing on the port until that `ready` arrives with the token. Requests (`request`, `abort`) and replies (`response`, `error`) then travel on the port, which only the page holds: replies never go to any other window.

The document marks its `<html>` with `data-fxm-sandbox="listening"` while it listens, so a test or a diagnostic can tell a document that ignored a message from one whose script never ran.

**What the checks protect.** A sandbox document can do nothing a page on any site couldn't do from its own sandboxed frame, so the checks keep FXM's traffic and answers private rather than guard a privilege: no other site can use FXM's documents, read what they answer, or feed the app answers.

The token closes the one way around the frame checks. A site that frames an FXM page (the embeddable player, 5.2) can navigate the page's sandbox frame to a document of its own (`frames[0][0].location = …`), which then has an opaque origin in the right frame, as the real document would. Without the token, such a document, put there before the handshake, would get the page's requests, and could read them and answer them falsely. It can't produce the token, so its `hello` is refused, and the page frames a new document for the next request. If the swap lands between the real document's `hello` and the page's `connect`, the other document gets the port but not the token, so the page sends it nothing. After the handshake a swap only breaks the frame: every message travels on the port.

Pages that create the transport should still forbid other frames with `frame-src 'self'`, as FXM's `/app/*` and `/embed/*` rules do ([2.8](../../../../docs/PLAN.md#28-static-deploy)): then another site can't even put a document of its own into the frame, and can at most send it to another FXM URL, which breaks it. Breaking it is always possible for a site that frames FXM, which can also remove the frame. The web app's dev server sends no policy, which the browser tests reproduce.

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
| Redirects | Never followed (`redirect: 'manual'`): a redirect fails with `redirect`, or with `network` where it carries no CORS headers, and nothing reaches a second host | The same, which matters here: the policy allows any HTTPS host, so a followed redirect could lead the user's IP address anywhere |
| Always | `credentials: 'omit'`, `mode: 'cors'`, `referrerPolicy: 'no-referrer'` | The same |

A page may ask for a shorter timeout or a smaller cap per document (`createSandboxTransport({ innerTube: { timeoutMs, maxResponseBytes } })`), never for more. The policy names hosts, not paths, so it is the script's allowlist that keeps paths out; the policy keeps the document from reaching any other host even if the script were bypassed.

## Errors

Every error keeps the document's reason as `sandboxCode` (`isSandboxError(error, code)`). Refusals are `TransportError`s, like the other transports' refusals, and failures once sent are `Network` or `Parse` `FxmError`s. InnerTube's own HTTP errors (400, 403, 429, …) are not errors here: they come back as responses, and the transport reports a 429 to the budget.

| `sandboxCode` | Why | Error |
|---|---|---|
| `bad-request` | Malformed: no absolute URL, no string body for a `POST`, a body on a `GET` | `SandboxRefusedError`: `TransportError` `bad-request` (`Unsupported`) |
| `forbidden-host` | Not HTTPS to an allowed host, credentials in the URL, or a port where none is allowed | The same |
| `forbidden-path` | A path outside the allowlist | The same |
| `forbidden-method` | A CORS-safelisted method the document does not send | The same |
| `forbidden-header` | Any header on a user-host request | The same |
| `preflight` | A header or method that would make the browser send a preflight, which InnerTube refuses from an opaque origin | The same |
| `request-too-large` | A request body over 1 MiB | The same |
| `redirect` | The host answered with a redirect, which the document does not follow | `SandboxRefusedError`: `TransportError` `redirect` (`Unsupported`) |
| `too-large` | A response over its cap | `SandboxFailedError`: `Parse` |
| `timeout` | No complete response in time; also a document that does not load or stops answering | `SandboxFailedError`: `Network` |
| `network` | The request failed: offline, CORS refused it (also a redirect without CORS headers), the document's policy blocked it; also a document in the frame that is not the one framed | `SandboxFailedError`: `Network` |

A document that does not finish its handshake within 10 s, or stops answering a request 5 s after its own timeout, is removed; the next request frames a new one, with a new token. `dispose()` removes the frames; requests waiting for a document, in flight or made later reject with an `Unsupported` `FxmError`.

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
FXM_LIVE=1 FXM_FULL_PLAYBACK=1 scripts/run.sh pnpm --filter @fxm/platform test:e2e   # one song to its end
```

- **Unit tests** (`*.test.ts`, part of `make test`) run the document's script against a fake page (`testing.ts`) whose window messages follow the browser's rules for `origin` and `source`, with Node's real `MessageChannel`. They cover the handshake against documents that say hello without the token, with a guessed one, or that took the port in the real document's place.
- **Browser tests** (`e2e/`, Playwright, Chromium and Firefox; not part of `make test`) send every request through one local proxy on port 5510 (`FXM_SANDBOX_E2E_PORT` to change it). The proxy serves the FXM origin, another site and the mocks over HTTPS with a throwaway certificate, and refuses every other host, so the mock tests never reach the internet. The mocks answer as InnerTube, googlevideo and an Invidious instance did when measured: `Access-Control-Allow-Origin: null` for simple POSTs from `null`, 403 for preflights and named origins, media without CORS, and a capped URL that answers 403 past 1 MiB.
- **The live test** (`FXM_LIVE=1`, from a residential connection) tunnels InnerTube and googlevideo to YouTube and still serves the FXM origin from this checkout. It plays a song as the app will: the self-test, a YouTube Music search with stage 1.3's provider, then stage 1.4's stream resolver (its VISIONOS `/player` request and its formats) and core's `pickStream` among the formats the browser plays, all through the platform's `fetch` and so through the sandbox, then a few seconds of `<audio>`: three InnerTube calls per browser. `FXM_FULL_PLAYBACK=1` plays the song to its end instead. Its record holds no URL, visitorData or host name.

What the browser tests show, in both browsers:

| Done-when of stage 1.10 | Test |
|---|---|
| Allowlisted calls succeed | `send allowlisted calls from an opaque origin…`: every path on every host, each with `Origin: null`, `text/plain`, no cookie and no referrer, one budget slot each |
| Other hosts and paths are refused | `refuse other hosts and paths…`: by the page's check, by the document's own check, and by the policy when the script is bypassed |
| Preflighted shapes fail with a typed error | `fail preflighted request shapes…`: `SandboxRefusedError` `preflight` (a `TransportError`) from both checks, and the mock's 403 to such a preflight when the checks are bypassed |
| Capped-URL fallback | `a capped VISIONOS URL fails <audio>…`: the browser's first request (`bytes=0-`) gets 403, `<audio>` fails, and the itag 18 URL plays |
| Both documents are served with the sandbox header | `are served with the sandbox header…`: opaque even at top level |
| Another site that frames a document without the attribute gets an opaque, silent document | `framed by another site…`: `self.origin === 'null'`, the script listens, and nothing answers |
| The document can't fetch any other host | `refuse other hosts and paths…`, and `never follow a user host's redirect…`: the second host never even gets a connection |
| The handshake holds against a framing site | `keep a framed FXM page's requests when the framing site swaps the sandbox document`: an FXM page without a policy, framed by another site that swaps the page's sandbox frame for its own document before the handshake; the request fails, the other document gets no port and no request, and the next request works |
| The kill switch disables the tier | `make Lite depend on the self-test…`: no self-test, no frame, no InnerTube call while it is on |

## Test record

The browser tests and the live tests ran on **2026-10-26** (Indian Standard Time; 04:06–04:13 IST is 22:36–22:43 UTC on 2026-10-25) on macOS 15.5 (arm64), from a residential connection in India, with Playwright 1.64.0's browsers, headless, audio muted, protocol 2.

| | Chromium 156.0.8078.4 | Firefox 157.0 | Safari |
|---|---|---|---|
| Mock tests (13) | Pass | Pass | Not tested |
| Self-test (`music/get_search_suggestions`) | 200: `youtube: 'simple'` | 200: `youtube: 'simple'` | Not tested |
| YouTube Music search (1.3's provider) | 5 songs: "Blitzkrieg Bop" | The same | Not tested |
| 1.4's resolver, VISIONOS `/player` on `www.youtube.com` | 5 options from the `visionos` rung; `pickStream` took AAC 140 (`unverified`, as nothing is probed in Lite) | The same | Not tested |
| `<audio>` reaches `playing` | Yes, after 0.8 s | Yes, after 0.7 s | Not tested |
| Full-length playback ("Blitzkrieg Bop", 2:14) | Played to `ended`: 134.5 of 134.5 s, in 136 s | Played to `ended`: 134.5 of 134.5 s, in 136 s | Not tested |
| InnerTube calls per run | 3 (self-test, search, `/player`) | 3 | — |

An earlier run, at 02:40 IST the same day with protocol 1 and a hand-built VISIONOS `/player` call (before 1.4 merged), gave the same results with Opus 251, also played to its end in both browsers. 1.4's ranking puts AAC 140 first for this song, as its README explains ("Opus 251 before AAC 140" is pending there).

**Safari** is not tested: driving it needs `safaridriver --enable`, a system setting this stage doesn't change, and Playwright's WebKit is not Safari (and isn't installed here). Lite stays unverified in Safari and on iOS.

For Lite, this answers [ARCHITECTURE.md's 64 KB rule](../../../../docs/ARCHITECTURE.md): a VISIONOS URL resolved through the sandbox played to its last second in both browsers, not just its first 64 KB. The YouTube facts behind these runs are in the [YouTube clean-room log](../../../sources/src/youtube/CLEAN-ROOM.md#the-lite-tier-opaque-origins-stage-110), and the browser behaviour the documents rely on in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## For the stages after this one

- **2.7 (tiers, onboarding):** pass `createSandboxTransport()` to `createPlatform`, run `platform.lite.check({ force: true })` from Settings → Diagnostics, and show `platform.lite.state` there; `isSandboxError(error)` and its `sandboxCode` tell why a request failed.
- **2.8 (deploy):** `apps/web/sandbox/*.html` are the files to publish at `/sandbox/`; `sandboxDocumentHeader(kind, html)` gives the header each needs (2.8 computes the same policy itself). Keep `frame-src 'self'` on `/app/*` and `/embed/*`. Cloudflare Pages redirects `*.html` paths to their extension-less form by default: check that the header rules match the path that is finally served (browsers keep the URL's fragment, and so the token, across a redirect). The web app's dev server doesn't serve the documents yet: until it does, Lite needs a build served with them.
- **1.13 (remote config):** the config needs a `killSwitches.lite` field for `createPlatform({ killSwitches })`.
- **2.9 (app wiring):** give `selfTestRequest` the YouTube provider's own client version.
- **2.3 (playback policy):** the capped-URL fallback here is a test harness (`e2e/harness/harness.ts`). The real one is 2.3's: in Lite, a media error or a stall before `playing` fails the probe, then itag 18, then a new resolution.

## Layout

| Path | What |
|---|---|
| `document.ts` | The documents' script, the protocol and the allowlists (`checkSandboxRequest`) |
| `transport.ts` | `createSandboxTransport()`: the page's side |
| `errors.ts` | `SandboxRefusedError`, `SandboxFailedError` |
| `csp.ts` | The documents' policies and script hashes |
| `index.ts` | The public part, which `src/index.ts` exports |
| `testing.ts` | The fake page for the unit tests |
| `tools/` | `render.ts` and `build.ts`: generate the documents (Node) |
| `e2e/` | The browser tests: `network.ts` (proxy and mocks), `harness/` (the test page's script), `sandbox.e2e.ts`, `live.e2e.ts` |
| `CLEAN-ROOM.md` | The browser behaviour this folder relies on |
