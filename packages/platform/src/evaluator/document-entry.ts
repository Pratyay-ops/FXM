/**
 * The script of `apps/web/sandbox/eval.html`: it starts the evaluator in that document. `build.ts`
 * bundles it, with bgutils-js, into the document's one inline script.
 *
 * A framed document starts only where its `sandbox` policy made its origin opaque: `self.origin`
 * is then `'null'`, while `location.origin` still names FXM's. Cloudflare Pages also serves the
 * document at percent-encoded paths, which no `_headers` rule reaches (stage 2.8's `make dist`
 * checks for this test), and any page may frame it there. A top-level document is the desktop or
 * Android app's, which drives it through its webview's own script evaluation: on Android it runs
 * at `https://www.youtube.com`, which BotGuard's attestation needs, so it must start there too.
 *
 * @module
 */

import { startEvaluatorDocument } from './document'

if (window.parent === window || self.origin === 'null') startEvaluatorDocument(window)
