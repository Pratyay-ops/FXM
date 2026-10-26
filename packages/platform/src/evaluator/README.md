# The isolated evaluator (`src/evaluator/`)

Stage 1.11. Some of YouTube's stream rungs need code FXM must not run in its own pages: YouTube's player script, whose functions decipher stream URLs, and Google's BotGuard, which mints web PO tokens. The evaluator runs them in a document that can't reach FXM's pages, storage or the network, with **one interface on every platform**:

```ts
import { createSandboxEvaluator } from '@fxm/platform'

const evaluator = createSandboxEvaluator() // the web; createTauriEvaluator, createCapacitorEvaluator elsewhere
evaluator.origin // 'https://fxmusic.pages.dev', known before the document starts
await evaluator.ready() // { kind: 'web', version: 2, origin: 'https://fxmusic.pages.dev' }
await evaluator.evaluate('return args.a + args.b', { a: 1, b: 2 }) // 3
await evaluator.evaluate(playerScript, inputs, { key: 'player:cbcfbf2f' }) // compiled once, then only args
const snapshot = await evaluator.botguardSnapshot({ interpreter, program, globalName, pageConfig })
const [token] = await evaluator.mintWebPoTokens(integrityToken, [videoId])
evaluator.dispose()
```

| Member | What it does |
|---|---|
| `origin` | The origin the document runs at, known without starting it: the page's origin on the web, `fxm-eval://localhost` on desktop, `https://www.youtube.com` on Android. `ready()` refuses a document that reports another one |
| `ready()` | Starts the document (once for every caller) and resolves with its kind, protocol version and origin. A caller's `signal` stops only its own wait, never the start the others share |
| `evaluate(source, args, { key? })` | Runs `source` as the body of an async function of `args` and resolves with its result, which must be JSON. With a `key`, the document keeps the compiled function (8 at most) and later calls send only `args`; a document that forgot it gets it again |
| `botguardSnapshot(challenge)` | Loads BotGuard's interpreter and program (fetched by the caller) with bgutils-js (MIT), and resolves with BotGuard's snapshot, which the caller exchanges for an integrity token at Google's `GenerateIT` |
| `mintWebPoTokens(integrityToken, bindings)` | Mints one web PO token per content binding (a video ID) with that integrity token and the session of the last snapshot |

Failures are `EvaluatorError`s, `FxmError`s that keep the precise reason as `evaluatorCode`: `Unsupported` when the document can't run (`unavailable`, `closed`), `Network` for a timeout (20 s per call, 15 s to start), and `Parse` for what the document reports (`script-error`, `not-json`, `unknown-key`, `bad-request`, `botguard-unavailable`, `botguard-failed`, `no-botguard-session`).

**A document that fails is replaced.** One that doesn't start in time is stopped (its iframe or webview goes, and nothing keeps polling it), and so is one after a call that timed out (a script that hangs), that is gone, or that can't be reached: the next call starts a new document. Each call stops what the port does for it (such as reading the mailbox) as soon as it times out or its caller cancels. Request ids start from a random number, so two hosts that reach one document (a desktop window that outlived a reload of the page) never take each other's answers.

**BotGuard has no network of its own**: the document's policy allows no connections (`connect-src 'none'`), so it can't `fetch`, open a socket or load anything. The caller fetches the challenge and the integrity token through the platform's `fetch` and hands them in; `@fxm/sources`' experimental rungs do that (`youtube/stream/advanced/botguard.ts`). A policy can't stop a document from navigating itself, though, and the URL of a navigation can carry data out: the hosts can only refuse it (desktop, Android) or see it and stop the document at once (the web, below).

## The hosts

| Platform | Host | Document | Channel |
|---|---|---|---|
| Web | `createSandboxEvaluator` (`web.ts`) | `/sandbox/eval.html#<nonce>` in a hidden iframe with `sandbox="allow-scripts"` (no `allow-same-origin`), served with its own policy | A `MessageChannel` the document opens. The host takes only the hello that echoes the nonce it chose for this start, from its iframe, with an opaque origin (`'null'`: a document with a real origin was not sandboxed, and the host refuses it). That hello hands over the document's end of the channel, and every request and answer goes over it, never through the window. A second `load` of the iframe means its document was replaced (by a script in it, or by an ancestor page, which may navigate its descendants): the host stops it at once, and the replacement has neither the nonce nor the channel |
| Desktop | `createTauriEvaluator({ invoke })` (`tauri.ts`) | The app's `fxm-evaluator` plugin (`apps/desktop/src-tauri/src/evaluator.rs`) opens a hidden webview window on its own scheme, `fxm-eval://localhost/eval.html`, served with the document's policy. The window may show that document only (no navigation away, no new window), and `eval` refuses one that shows anything else. No capability names that window, so its page can call no command: none of the plugins', and none of the app's own (stage 7.2's), which the app's access-control manifest puts behind permissions too; a test fails if an app command appears without it. It is destroyed with the main window, so closing that window still quits the app | The mailbox, read with the plugin's `eval` command (`eval_with_callback`). Each `open` makes a new window |
| Android | `createCapacitorEvaluator({ plugin, html })` (`capacitor.ts`) | The app's `FxmEvaluator` plugin (`apps/mobile/android/.../evaluator/EvaluatorPlugin.java`) creates a separate WebView, never attached to the screen, and loads the document, if it is the one the app was built with (its SHA-256, `EvaluatorDocument.java`), with `https://www.youtube.com/` as its base URL and network loads blocked. It refuses every navigation and new window, and runs in a WebView profile of its own (`fxm-evaluator`), cleared when it opens and closes, so its scripts never see a cookie of the app's other WebViews; without profile support it doesn't open. All of an app's WebViews share one renderer: if it dies, the plugin destroys the evaluator's WebView and restarts the activity instead of letting Android kill the app, and a mailbox read that hangs for 15 s ends the renderer | The mailbox, read with `evaluateJavascript` |
| Tests | `createInProcessEvaluator()` (`@fxm/platform/testing`) | None: the document's runtime in the test's own realm. It isolates nothing | Direct, through JSON |

The desktop and Android ports share `mailbox.ts`: the native side only runs a short script in its webview and returns the value as JSON text, and all of the protocol (handing over a request, collecting its answer, timeouts) is TypeScript. Each read is a round trip through the native bridge, so the port reads only while a call waits for its answer.

**The origin matters to BotGuard.** On 2026-10-26, BotGuard earned an integrity token only in a document at `https://www.youtube.com` (see `@fxm/sources`' [experimental rungs](../../../sources/src/youtube/stream/advanced/README.md)). The Android WebView's base URL gives it that; the web's opaque `eval.html` and the desktop's `fxm-eval:` document can't have it, so deciphering works on every platform but PO tokens only on Android. `origin` tells the rungs which without starting anything.

The app's own policy never gains `'unsafe-eval'`, on the web or on desktop: only the evaluator document's does.

## The document (`apps/web/sandbox/eval.html`)

One HTML file whose only script is inline, built from `document-entry.ts` (with `document.ts`, `runtime.ts`, `protocol.ts`, `messages.ts` and bgutils-js) by `build.ts`. Its `<meta>` policy:

```
default-src 'none'; script-src 'sha256-…' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'
```

The web deployment (stage 2.8's `_headers`) and the desktop scheme serve it with `sandbox allow-scripts; ` in front of that, which makes its origin opaque however it is loaded (a `<meta>` policy can't carry `sandbox`). `pnpm --filter @fxm/platform build:evaluator` rewrites the file and the Android plugin's pin of it (`EvaluatorDocument.java`), and prints that header; `build.test.ts` fails while either committed file is out of date.

It picks its channel when it starts:

- **Framed** (it has a parent): it opens a `MessageChannel` and sends its hello, with the nonce of its URL's fragment and one end of the channel, to its parent at the FXM origin only, the origin its own URL names. From then on it hears requests only on its end of the channel; nothing that reaches its window is acted on. A page on another site that frames it, with or without the `sandbox` attribute, gets neither the hello nor the channel. Where the hello goes is stage 1.10's message check, in `messages.ts` until 1.10 merges: then its check replaces that file's function.
- **Mailbox** (a top-level page in a native webview): it exposes a frozen `window.__fxmEvaluator` with `hello` (its announcement, as JSON), `receive(request)` and `take(id)`. The document has no bridge object and calls nothing: the host reads from it.

A framed document starts only where its `sandbox` policy made its origin opaque (`self.origin === 'null'`, in `document-entry.ts`): Cloudflare Pages also serves it at percent-encoded paths, which no `_headers` rule reaches, and any page may frame it there. Stage 2.8's `make dist` refuses a sandbox document whose script doesn't make that test. A top-level document always starts: it is a native app's, and on Android it runs at `https://www.youtube.com` on purpose.

The runtime captures `Function`, `JSON`, the async function constructor and its channel when it starts, so a script that replaces those globals changes nothing about later requests.

## Tests

```sh
scripts/run.sh pnpm vitest run packages/platform/src/evaluator
FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/platform/src/evaluator/eval.browser.test.ts
```

The unit tests cover the protocol, the runtime (with a stand-in for BotGuard from `@fxm/platform/testing`, driven through the real bgutils-js), the host's timeouts, restarts and key handling, a shared start that one caller cancels, both document channels, the web port (nonce, channel, a replaced document) and the desktop and Android ports (polling that stops after a timeout or a failed start). `eval.browser.test.ts` loads the committed `eval.html` in Playwright's Chromium with the header policy, framed by a page running the real web host, with every request answered locally: it evaluates there, finds `fetch`, `localStorage` and the parent's DOM blocked and its own origin opaque, runs the stand-in BotGuard, is ignored by a page on another site that frames it without the attribute, is stopped when its own script or an ancestor page on another site navigates its frame (the new page gets nothing after that, and its forged hello and answers are ignored), and works as a mailbox at YouTube's origin, as the Android plugin loads it.

**Still to check on the platforms themselves:** that Tauri serves the `fxm-eval:` responses as the plugin writes them, policy included, that the window's navigation guard holds and that closing the main window quits the app with the evaluator window open (the desktop's Rust tests cover the handler and the guard's rules, not a running app); and, on an Android device, the evaluator WebView: its profile, the blocked navigations, the activity restart after its renderer dies, and the renderer's end after a hung read.
