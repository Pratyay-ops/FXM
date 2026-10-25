# The isolated evaluator (`src/evaluator/`)

Stage 1.11. Some of YouTube's stream rungs need code FXM must not run in its own pages: YouTube's player script, whose functions decipher stream URLs, and Google's BotGuard, which mints web PO tokens. The evaluator runs them in a document that can't reach FXM's pages, storage or the network, with **one interface on every platform**:

```ts
import { createSandboxEvaluator } from '@fxm/platform'

const evaluator = createSandboxEvaluator() // the web; createTauriEvaluator, createCapacitorEvaluator elsewhere
await evaluator.ready() // { kind: 'web', version: 1, origin: 'https://fxm-music.pages.dev' }
await evaluator.evaluate('return args.a + args.b', { a: 1, b: 2 }) // 3
await evaluator.evaluate(playerScript, inputs, { key: 'player:cbcfbf2f' }) // compiled once, then only args
const snapshot = await evaluator.botguardSnapshot({ interpreter, program, globalName, pageConfig })
const [token] = await evaluator.mintWebPoTokens(integrityToken, [videoId])
evaluator.dispose()
```

| Method | What it does |
|---|---|
| `ready()` | Starts the document (once) and resolves with its kind, protocol version and **origin**, the location scripts in it see |
| `evaluate(source, args, { key? })` | Runs `source` as the body of an async function of `args` and resolves with its result, which must be JSON. With a `key`, the document keeps the compiled function (8 at most) and later calls send only `args`; a document that forgot it gets it again |
| `botguardSnapshot(challenge)` | Loads BotGuard's interpreter and program (fetched by the caller) with bgutils-js (MIT), and resolves with BotGuard's snapshot, which the caller exchanges for an integrity token at Google's `GenerateIT` |
| `mintWebPoTokens(integrityToken, bindings)` | Mints one web PO token per content binding (a video ID) with that integrity token and the session of the last snapshot |

Failures are `EvaluatorError`s, `FxmError`s that keep the precise reason as `evaluatorCode`: `Unsupported` when the document can't run (`unavailable`, `closed`), `Network` for a timeout (20 s per call, 15 s to start), and `Parse` for what the document reports (`script-error`, `not-json`, `unknown-key`, `bad-request`, `botguard-unavailable`, `botguard-failed`, `no-botguard-session`).

**BotGuard makes no network request of its own**: the document allows none (`connect-src 'none'`). The caller fetches the challenge and the integrity token through the platform's `fetch` and hands them in; `@fxm/sources`' experimental rungs do that (`youtube/stream/advanced/botguard.ts`).

## The hosts

| Platform | Host | Document | Channel |
|---|---|---|---|
| Web | `createSandboxEvaluator` (`web.ts`) | `/sandbox/eval.html` in a hidden iframe with `sandbox="allow-scripts"` (no `allow-same-origin`), served with its own policy | `postMessage`. The host takes answers only from its iframe and only while that iframe's origin is opaque (`'null'`): a document that answers with a real origin was not sandboxed, and the host refuses it |
| Desktop | `createTauriEvaluator({ invoke })` (`tauri.ts`) | The app's `fxm-evaluator` plugin (`apps/desktop/src-tauri/src/evaluator.rs`) opens a hidden webview window on its own scheme, `fxm-eval://localhost/eval.html`, served with the document's policy. No capability names that window, so its page can call no command | The mailbox, read with the plugin's `eval` command (`eval_with_callback`) |
| Android | `createCapacitorEvaluator({ plugin, html })` (`capacitor.ts`) | The app's `FxmEvaluator` plugin (`apps/mobile/android/.../evaluator/EvaluatorPlugin.java`) creates a separate WebView, never attached to the screen, and loads the document with `https://www.youtube.com/` as its base URL and network loads blocked | The mailbox, read with `evaluateJavascript` |
| Tests | `createInProcessEvaluator()` (`@fxm/platform/testing`) | None: the document's runtime in the test's own realm. It isolates nothing | Direct, through JSON |

The desktop and Android ports share `mailbox.ts`: the native side only runs a short script in its webview and returns the value as JSON text, and all of the protocol (handing over a request, collecting its answer, timeouts) is TypeScript.

**The origin matters to BotGuard.** On 2026-10-26, BotGuard earned an integrity token only in a document at `https://www.youtube.com` (see `@fxm/sources`' [experimental rungs](../../../sources/src/youtube/stream/advanced/README.md)). The Android WebView's base URL gives it that; the web's opaque `eval.html` and the desktop's `fxm-eval:` document can't have it, so deciphering works on every platform but PO tokens only on Android.

The app's own policy never gains `'unsafe-eval'`, on the web or on desktop: only the evaluator document's does.

## The document (`apps/web/sandbox/eval.html`)

One HTML file whose only script is inline, built from `document-entry.ts` (with `document.ts`, `runtime.ts`, `protocol.ts`, `messages.ts` and bgutils-js) by `build.ts`. Its `<meta>` policy:

```
default-src 'none'; script-src 'sha256-…' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'
```

The web deployment (stage 2.8's `_headers`) and the desktop scheme serve it with `sandbox allow-scripts; ` in front of that, which makes its origin opaque however it is loaded (a `<meta>` policy can't carry `sandbox`). `pnpm --filter @fxm/platform build:evaluator` rewrites the file and prints that header; `build.test.ts` fails while the committed file is out of date.

It picks its channel when it starts:

- **Framed** (it has a parent): it acts only on messages from its parent and from the FXM origin, the origin its own URL names, and replies only to that origin; a page on another site that frames it, with or without the `sandbox` attribute, is ignored. These are stage 1.10's message checks, in `messages.ts` until 1.10 merges: then its checks replace that file's two functions.
- **Mailbox** (a top-level page in a native webview): it exposes a frozen `window.__fxmEvaluator` with `hello` (its announcement, as JSON), `receive(request)` and `take(id)`. The document has no bridge object and calls nothing: the host reads from it.

The runtime captures `Function`, `JSON` and the async function constructor when it starts, so a script that replaces those globals changes nothing about later requests.

## Tests

```sh
scripts/run.sh pnpm vitest run packages/platform/src/evaluator
FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/platform/src/evaluator/eval.browser.test.ts
```

The unit tests cover the protocol, the runtime (with a stand-in for BotGuard from `@fxm/platform/testing`, driven through the real bgutils-js), the host's timeouts and key handling, both document channels, the web port and the desktop and Android ports. `eval.browser.test.ts` loads the committed `eval.html` in Playwright's Chromium with the header policy, framed by a page running the real web host, with every request answered locally: it evaluates there, finds `fetch`, `localStorage` and the parent's DOM blocked and its own origin opaque, runs the stand-in BotGuard, is ignored by a page on another site that frames it without the attribute, and works as a mailbox at YouTube's origin, as the Android plugin loads it.

**Still to check on the platforms themselves:** that Tauri serves the `fxm-eval:` responses as the plugin writes them, policy included (the desktop's Rust tests cover the handler, not a running app), and the Android WebView on a device.
